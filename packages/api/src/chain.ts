import { createPublicClient, createWalletClient, http, type Address } from 'viem';
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

export interface SettlementChain {
  readonly enabled: boolean;
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
    functionName: 'commitSeed' | 'settle',
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
