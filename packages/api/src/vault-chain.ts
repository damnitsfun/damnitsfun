import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEventLogs,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { competitionIdToBytes32 } from './commit';
import type { Config } from './config';

/**
 * On-chain client for DamnitsVault (sub-spec 24, T134).
 *
 * The staked-season counterpart to `tournament-chain.ts`, built to the same shape
 * on purpose: one `send()` helper, never rethrows, always returns `{ok, error}`,
 * and a disabled stub when the operator key or the vault address is missing — so a
 * deployment with no vault still registers agents, deals tables, settles them and
 * pays coins, with a logged failure and nothing stuck (DoD 9).
 *
 * As with entry fees, this arena never touches a player's key. A player deposits
 * from their OWN wallet and hands us a txHash, which {verifyDeposit} reads back
 * from the chain rather than trusting (D190).
 */

export const DAMNITS_VAULT_ABI = [
  {
    type: 'function',
    name: 'openSeason',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'seasonId', type: 'bytes32' },
      { name: 'depositWei', type: 'uint256' },
      { name: 'registrationCloseAt', type: 'uint256' },
      { name: 'resolveBy', type: 'uint256' },
      { name: 'yieldSource', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'seedPot',
    stateMutability: 'payable',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'closeRegistration',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'seasonId', type: 'bytes32' },
      { name: 'winners', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'resultRoot', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'exitStale',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'owed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // Both credit and pay `msg.sender`, which is exactly why sub-spec 26 needs no
  // contract change: the agent's custodial wallet is an ordinary sender (D207).
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getSeason',
    stateMutability: 'view',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [
      { name: 'depositWei', type: 'uint256' },
      { name: 'depositTotal', type: 'uint256' },
      { name: 'prizePot', type: 'uint256' },
      { name: 'shortfall', type: 'uint256' },
      { name: 'registrationCloseAt', type: 'uint256' },
      { name: 'resolveBy', type: 'uint256' },
      { name: 'yieldSource', type: 'address' },
      { name: 'resultRoot', type: 'bytes32' },
      { name: 'state', type: 'uint8' },
      { name: 'entrantCount', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'seasonId', type: 'bytes32', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const;

export interface ChainResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

/** What a claimed deposit turns out to be, once read back from the chain. */
export interface DepositCheck {
  ok: boolean;
  /** The wallet that actually paid — and therefore the one the refund goes to. */
  payer?: string;
  amountWei?: string;
  error?: string;
}

/** A season's money as the contract itself reports it. */
export interface VaultSeasonView {
  depositWei: string;
  depositTotalWei: string;
  prizePotWei: string;
  shortfallWei: string;
  registrationCloseAt: number;
  resolveBy: number;
  yieldSource: string;
  state: 'none' | 'registration' | 'staked' | 'resolved';
  entrantCount: number;
}

const STATES = ['none', 'registration', 'staked', 'resolved'] as const;

export interface VaultChain {
  readonly enabled: boolean;
  readonly contractAddress: string | null;
  /** Open a staked season and write both deadlines on chain, before anyone deposits. */
  openSeason(
    seasonId: string,
    depositWei: string,
    registrationCloseAt: number,
    resolveBy: number,
    yieldSource: string | null,
  ): Promise<ChainResult>;
  /**
   * Verify a claimed deposit by reading the chain: the tx must have hit OUR vault
   * and emitted Deposited for THIS season at THIS exact amount, otherwise any
   * txHash would buy a seat.
   */
  verifyDeposit(seasonId: string, txHash: string, expectedWei: string): Promise<DepositCheck>;
  /** Sponsor money into this season's prize pot. */
  seedPot(seasonId: string, amountWei: string): Promise<ChainResult>;
  /** Close registration and park the deposits in the yield source, in one tx. */
  closeRegistration(seasonId: string): Promise<ChainResult>;
  /** Refund every depositor, pay the winners, sweep the interest. */
  resolve(
    seasonId: string,
    winners: string[],
    amounts: bigint[],
    resultRoot: string,
  ): Promise<ChainResult>;
  /** The public exit. Works for anyone once `resolveBy` has passed. */
  exitStale(seasonId: string): Promise<ChainResult>;
  /** What the contract says about a season; null when it cannot be read. */
  readSeason(seasonId: string): Promise<VaultSeasonView | null>;
  /** What an address can withdraw right now; null when it cannot be read. */
  readOwed(address: string): Promise<string | null>;
  /**
   * Deposit into a staked season FROM the agent's own custodial wallet, so an
   * agent can enter unattended (sub-spec 26, D205). The counterpart to
   * `TournamentChain.payEntryAs`; `verifyDeposit` reads the payer back off the
   * Deposited event either way, so the seat is still earned by the chain and not
   * by our word for it.
   */
  depositAs(seasonId: string, privateKey: string, depositWei: string): Promise<ChainResult>;
  /**
   * Pull an agent's `owed` balance into its own wallet, signed with its custodial
   * key. `withdraw()` pays `msg.sender`, so this is the only way a refund owed to
   * a custodial wallet ever moves. `nothingOwed` distinguishes "already swept"
   * from a failure, which is what makes a re-run safe (D209).
   */
  withdrawAs(privateKey: string): Promise<ChainResult & { nothingOwed?: boolean }>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Headroom left for gas when checking an agent wallet can afford a deposit (D211). */
const GAS_BUFFER_WEI = 1_000_000_000_000_000n; // 0.001 tBNB

/** Used whenever the vault is not configured — every call is a clean no-op. */
export const DISABLED_VAULT_CHAIN: VaultChain = {
  enabled: false,
  contractAddress: null,
  async openSeason() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async verifyDeposit() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async seedPot() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async closeRegistration() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async resolve() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async exitStale() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async readSeason() {
    return null;
  },
  async readOwed() {
    return null;
  },
  async depositAs() {
    return { ok: false, error: 'vault chain disabled' };
  },
  async withdrawAs() {
    return { ok: false, error: 'vault chain disabled' };
  },
};

export function createVaultChain(
  config: Config,
  log: (message: string) => void = () => {},
): VaultChain {
  const { operatorPrivateKey, vaultContractAddress } = config;
  if (!operatorPrivateKey || !vaultContractAddress) {
    log('[vault] disabled — set OPERATOR_PRIVATE_KEY and VAULT_CONTRACT_ADDRESS to enable');
    return DISABLED_VAULT_CHAIN;
  }

  const key = operatorPrivateKey.startsWith('0x') ? operatorPrivateKey : `0x${operatorPrivateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const address = vaultContractAddress as Address;
  const transport = http(config.bscTestnetRpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  log(`[vault] enabled — contract ${address}, operator ${account.address}`);

  async function send(
    functionName: 'openSeason' | 'seedPot' | 'closeRegistration' | 'resolve' | 'exitStale',
    args: readonly unknown[],
    value?: bigint,
  ): Promise<ChainResult> {
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi: DAMNITS_VAULT_ABI,
        functionName,
        args: args as never,
        value,
      } as Parameters<typeof publicClient.simulateContract>[0]);
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      log(`[vault] ${functionName} ok — tx ${txHash}`);
      return { ok: true, txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[vault] ${functionName} FAILED — ${message}`);
      return { ok: false, error: message };
    }
  }

  const sid = (seasonId: string) => competitionIdToBytes32(seasonId);

  return {
    enabled: true,
    contractAddress: address,

    openSeason(seasonId, depositWei, registrationCloseAt, resolveBy, yieldSource) {
      return send('openSeason', [
        sid(seasonId),
        BigInt(depositWei),
        BigInt(registrationCloseAt),
        BigInt(resolveBy),
        (yieldSource ?? ZERO_ADDRESS) as Address,
      ]);
    },

    async verifyDeposit(seasonId, txHash, expectedWei) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt.status !== 'success') return { ok: false, error: 'transaction reverted' };
        if ((receipt.to ?? '').toLowerCase() !== address.toLowerCase()) {
          return { ok: false, error: 'transaction was not sent to this vault' };
        }

        const events = parseEventLogs({
          abi: DAMNITS_VAULT_ABI,
          eventName: 'Deposited',
          logs: receipt.logs,
        });
        const wanted = sid(seasonId).toLowerCase();
        const paid = events.find((e) => String(e.args.seasonId).toLowerCase() === wanted);
        if (!paid) return { ok: false, error: 'no deposit for this season in that tx' };
        if (paid.args.amount !== BigInt(expectedWei)) {
          return {
            ok: false,
            error: `deposited ${String(paid.args.amount)} wei, expected ${expectedWei}`,
          };
        }
        return { ok: true, payer: paid.args.player as string, amountWei: String(paid.args.amount) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    },

    seedPot(seasonId, amountWei) {
      return send('seedPot', [sid(seasonId)], BigInt(amountWei));
    },
    closeRegistration(seasonId) {
      return send('closeRegistration', [sid(seasonId)]);
    },
    resolve(seasonId, winners, amounts, resultRoot) {
      return send('resolve', [
        sid(seasonId),
        winners as Address[],
        amounts,
        resultRoot.startsWith('0x') ? resultRoot : `0x${resultRoot}`,
      ]);
    },
    exitStale(seasonId) {
      return send('exitStale', [sid(seasonId)]);
    },

    async readSeason(seasonId) {
      try {
        const r = (await publicClient.readContract({
          address,
          abi: DAMNITS_VAULT_ABI,
          functionName: 'getSeason',
          args: [sid(seasonId)],
        })) as readonly [
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          string,
          string,
          number,
          bigint,
        ];
        return {
          depositWei: String(r[0]),
          depositTotalWei: String(r[1]),
          prizePotWei: String(r[2]),
          shortfallWei: String(r[3]),
          registrationCloseAt: Number(r[4]),
          resolveBy: Number(r[5]),
          yieldSource: r[6],
          state: STATES[Number(r[8])] ?? 'none',
          entrantCount: Number(r[9]),
        };
      } catch {
        return null; // an unreachable RPC is a null, never a 500 (T137)
      }
    },

    async readOwed(addr) {
      try {
        const owed = (await publicClient.readContract({
          address,
          abi: DAMNITS_VAULT_ABI,
          functionName: 'owed',
          args: [addr as Address],
        })) as bigint;
        return String(owed);
      } catch {
        return null;
      }
    },

    async depositAs(seasonId, privateKey, depositWei) {
      // Its own client per call: the shared `walletClient` is bound to the
      // operator, and this deposit must come FROM the agent — the contract credits
      // `msg.sender`, and `verifyDeposit` reads that address straight back off the
      // Deposited event.
      const payer = privateKeyToAccount(privateKey as `0x${string}`);
      const wallet = createWalletClient({ account: payer, chain: bscTestnet, transport });
      const value = BigInt(depositWei);
      try {
        // Checked before simulating so an unfunded wallet gets an instruction
        // rather than viem's `insufficient funds for gas * price + value` (D211).
        const balance = await publicClient.getBalance({ address: payer.address });
        if (balance < value) {
          return {
            ok: false,
            error:
              `agent wallet ${payer.address} holds ${formatEther(balance)} tBNB, needs ` +
              `${formatEther(value)} for this refundable deposit plus a little for gas — fund ` +
              `it with at least ${formatEther(value + GAS_BUFFER_WEI)} from your own wallet`,
          };
        }
        const { request } = await publicClient.simulateContract({
          account: payer,
          address,
          abi: DAMNITS_VAULT_ABI,
          functionName: 'deposit',
          args: [sid(seasonId)],
          value,
        });
        const txHash = await wallet.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        log(`[vault] deposit ok — ${payer.address} staked ${value} wei, tx ${txHash}`);
        return { ok: true, txHash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[vault] deposit FAILED for ${payer.address} — ${message}`);
        return { ok: false, error: message };
      }
    },

    async withdrawAs(privateKey) {
      const holder = privateKeyToAccount(privateKey as `0x${string}`);
      const wallet = createWalletClient({ account: holder, chain: bscTestnet, transport });
      try {
        // Read first: `withdraw()` reverts on a zero balance, and a sweep that has
        // already run is a success, not a failure (D209). Reading also saves the
        // gas of a transaction that was always going to revert.
        const owed = (await publicClient.readContract({
          address,
          abi: DAMNITS_VAULT_ABI,
          functionName: 'owed',
          args: [holder.address],
        })) as bigint;
        if (owed === 0n) {
          log(`[vault] withdraw skipped — ${holder.address} is owed nothing`);
          return { ok: true, nothingOwed: true };
        }
        const { request } = await publicClient.simulateContract({
          account: holder,
          address,
          abi: DAMNITS_VAULT_ABI,
          functionName: 'withdraw',
          args: [],
        });
        const txHash = await wallet.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        log(`[vault] withdraw ok — ${holder.address} pulled ${owed} wei, tx ${txHash}`);
        return { ok: true, txHash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[vault] withdraw FAILED for ${holder.address} — ${message}`);
        return { ok: false, error: message };
      }
    },
  };
}
