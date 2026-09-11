import { createPublicClient, createWalletClient, http, parseEventLogs, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { seedAsBytes32, seedCommitment, sessionIdToBytes32 } from './commit';
import type { Config } from './config';

/**
 * On-chain settlement client (T13).
 *
 * Publishes each match's seed commitment before play and its reveal + result
 * hash after, so an outside observer can take the public event log and the
 * on-chain record and confirm the shuffle was not tampered with (FR-6.4).
 *
 * The operator key lives only in server config (§9) and is read once here. This
 * arena never asks an agent operator for key material: players pay their own
 * entry fees from their own wallets and hand us only a txHash.
 *
 * Every method is failure-tolerant by design. A chain outage must never corrupt
 * or block a finished game — the off-chain event log is the source of truth, and
 * the chain is an anchor we attach to it. Failures are reported, not thrown.
 */

export const DAMNITS_ESCROW_ABI = [
  {
    type: 'function',
    name: 'openSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'entryFeeWei', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    // Called by players from their OWN wallets (operator tooling in the demo
    // harness), never by the arena — the arena only verifies the resulting tx.
    type: 'function',
    name: 'payEntryFee',
    stateMutability: 'payable',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getSession',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [
      { name: 'players', type: 'address[]' },
      { name: 'entryFeeWei', type: 'uint256' },
      { name: 'pot', type: 'uint256' },
      { name: 'seedCommitHash', type: 'bytes32' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'state', type: 'uint8' },
      { name: 'winner', type: 'address' },
    ],
  },
  {
    type: 'function',
    name: 'commitSeed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'seedCommitHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'winner', type: 'address' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'seedReveal', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'verifySeed',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'seedReveal', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'EntryFeePaid',
    inputs: [
      { name: 'sessionId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SeedCommitted',
    inputs: [
      { name: 'sessionId', type: 'bytes32', indexed: true },
      { name: 'seedCommitHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionSettled',
    inputs: [
      { name: 'sessionId', type: 'bytes32', indexed: true },
      { name: 'winner', type: 'address', indexed: true },
      { name: 'resultHash', type: 'bytes32', indexed: false },
      { name: 'seedReveal', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export { seedAsBytes32, seedCommitment, sessionIdToBytes32 } from './commit';

export interface ChainResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

/** What an on-chain entry-fee payment turns out to be, once inspected. */
export interface EntryFeeCheck {
  ok: boolean;
  /** The address that actually sent the funds. */
  payer?: string;
  amountWei?: string;
  error?: string;
}

export interface SettlementChain {
  readonly enabled: boolean;
  /** Open a table on-chain and fix its fee, so players can pay into it. */
  openSession(sessionId: string, entryFeeWei: string): Promise<ChainResult>;
  /**
   * Verify a claimed entry-fee payment by reading the chain, rather than
   * trusting the txHash an agent hands us. Confirms the transaction succeeded,
   * hit OUR escrow, and emitted EntryFeePaid for THIS session with the right
   * amount — otherwise any random txHash would buy a seat.
   */
  verifyEntryFee(sessionId: string, txHash: string, expectedWei: string): Promise<EntryFeeCheck>;
  commitSeed(sessionId: string, seed: string): Promise<ChainResult>;
  settle(
    sessionId: string,
    winner: string | null,
    resultHash: string,
    seed: string,
  ): Promise<ChainResult>;
}

/** Used whenever the chain is not configured — every call is a clean no-op. */
export const DISABLED_CHAIN: SettlementChain = {
  enabled: false,
  async openSession() {
    return { ok: false, error: 'chain disabled' };
  },
  async verifyEntryFee() {
    return { ok: false, error: 'chain disabled' };
  },
  async commitSeed() {
    return { ok: false, error: 'chain disabled' };
  },
  async settle() {
    return { ok: false, error: 'chain disabled' };
  },
};

/**
 * Build a settlement client from config, or the disabled stub when the operator
 * key / contract address are absent. Sub-spec 04 and 06 run entirely without a
 * chain; wiring one in is additive.
 */
export function createSettlementChain(
  config: Config,
  log: (message: string) => void = () => {},
): SettlementChain {
  const { operatorPrivateKey, escrowContractAddress } = config;
  if (!operatorPrivateKey || !escrowContractAddress) {
    log('[chain] disabled — set OPERATOR_PRIVATE_KEY and ESCROW_CONTRACT_ADDRESS to enable');
    return DISABLED_CHAIN;
  }

  const key = operatorPrivateKey.startsWith('0x') ? operatorPrivateKey : `0x${operatorPrivateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const address = escrowContractAddress as Address;
  const transport = http(config.bscTestnetRpcUrl);

  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  log(`[chain] enabled — escrow ${address}, operator ${account.address}`);

  async function send(
    functionName: 'openSession' | 'commitSeed' | 'settle',
    args: readonly unknown[],
  ): Promise<ChainResult> {
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi: DAMNITS_ESCROW_ABI,
        functionName,
        // viem's simulate is strongly typed per function; the orchestrator's
        // dynamic call site is checked by the wrappers below instead.
        args: args as never,
      });
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      log(`[chain] ${functionName} ok — tx ${txHash}`);
      return { ok: true, txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Never rethrow: the off-chain record stands on its own.
      log(`[chain] ${functionName} FAILED — ${message}`);
      return { ok: false, error: message };
    }
  }

  return {
    enabled: true,

    openSession(sessionId, entryFeeWei) {
      return send('openSession', [sessionIdToBytes32(sessionId), BigInt(entryFeeWei)]);
    },

    async verifyEntryFee(sessionId, txHash, expectedWei) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt.status !== 'success') return { ok: false, error: 'transaction reverted' };
        if ((receipt.to ?? '').toLowerCase() !== address.toLowerCase()) {
          return { ok: false, error: 'transaction was not sent to this escrow' };
        }

        const events = parseEventLogs({
          abi: DAMNITS_ESCROW_ABI,
          eventName: 'EntryFeePaid',
          logs: receipt.logs,
        });
        const wanted = sessionIdToBytes32(sessionId).toLowerCase();
        const paid = events.find((e) => String(e.args.sessionId).toLowerCase() === wanted);
        if (!paid) return { ok: false, error: 'no entry-fee payment for this table in that tx' };
        if (paid.args.amount !== BigInt(expectedWei)) {
          return { ok: false, error: `paid ${String(paid.args.amount)} wei, expected ${expectedWei}` };
        }

        return { ok: true, payer: paid.args.player as string, amountWei: String(paid.args.amount) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    },

    commitSeed(sessionId, seed) {
      return send('commitSeed', [sessionIdToBytes32(sessionId), seedCommitment(seed)]);
    },
    settle(sessionId, winner, resultHash, seed) {
      const winnerAddress = (winner ?? '0x0000000000000000000000000000000000000000') as Address;
      return send('settle', [
        sessionIdToBytes32(sessionId),
        winnerAddress,
        resultHash.startsWith('0x') ? resultHash : `0x${resultHash}`,
        seedAsBytes32(seed),
      ]);
    },
  };
}

/**
 * Read an address's native balance (sub-spec 23, D180).
 *
 * Standalone rather than a method on `SettlementChain`, because it needs neither
 * an operator key nor a deployed escrow — a deployment with no settlement wiring
 * at all can still tell an agent what its own wallet holds.
 *
 * Best-effort by construction. This feeds `GET /agent/me`, which is on the
 * onboarding path `skill.md` sends every new agent down, so an RPC that is slow,
 * down or lying must degrade one FIELD rather than the endpoint. Every failure
 * resolves to `null`; nothing here throws.
 *
 * No cache. `/agent/me` is not polled the way `pending-actions` is, and caching
 * before there is traffic to justify it would be a guess — add one if a soak ever
 * shows this endpoint hot.
 */
/**
 * What `address` can collect from the tournament contract right now — the
 * pull-payment ledger `owed[address]`, filled by `settleCompetition` and emptied
 * by `withdraw()`.
 *
 * The profile page shows this beside a payout address so a winner is told there
 * is money waiting and can claim it with one click, instead of being expected to
 * find `withdraw()` on BscScan. Best-effort in the same way as
 * {@link readNativeBalance}: null on any failure, never an error, because it is
 * read on the profile's load path and a slow RPC must cost a badge, not a page.
 */
export async function readClaimable(
  config: Config,
  address: string,
  timeoutMs = 2000,
): Promise<string | null> {
  if (!config.tournamentContractAddress) return null;
  try {
    const client = createPublicClient({
      chain: bscTestnet,
      transport: http(config.bscTestnetRpcUrl, { timeout: timeoutMs, retryCount: 0 }),
    });
    const wei = await client.readContract({
      address: config.tournamentContractAddress as Address,
      abi: [
        {
          type: 'function',
          name: 'owed',
          stateMutability: 'view',
          inputs: [{ name: '', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ] as const,
      functionName: 'owed',
      args: [address as Address],
    });
    return wei.toString();
  } catch {
    return null;
  }
}

export async function readNativeBalance(
  config: Config,
  address: string | null,
  timeoutMs = 2000,
): Promise<string | null> {
  if (!address) return null;
  try {
    const client = createPublicClient({
      chain: bscTestnet,
      transport: http(config.bscTestnetRpcUrl, { timeout: timeoutMs, retryCount: 0 }),
    });
    const wei = await client.getBalance({ address: address as Address });
    return wei.toString();
  } catch {
    return null;
  }
}
