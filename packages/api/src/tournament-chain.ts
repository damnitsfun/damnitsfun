import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { competitionIdToBytes32 } from './commit';
import type { Config } from './config';

/**
 * On-chain client for DamnitsTournament (sub-spec 08, T21/T22/T23).
 *
 * The pooled-tournament counterpart to `chain.ts` (which drives the per-session
 * DamnitsEscrow). Where the escrow anchors each table's commit-reveal, this holds
 * a whole competition's money: entry buy-ins + sponsor seed accumulate into a
 * pool, and at season close the operator distributes it to the ranked winners
 * and the jackpot triggerer.
 *
 * The operator key lives only in server config (§9). This arena never touches an
 * agent's key: agents pay their OWN entry with their OWN wallet (T19) and hand us
 * a txHash, which {verifyEntry} reads back from the chain rather than trusting.
 *
 * Every method is failure-tolerant. A chain outage must never corrupt the
 * off-chain record — failures are reported, not thrown.
 */

export const DAMNITS_TOURNAMENT_ABI = [
  {
    type: 'function',
    name: 'openCompetition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'competitionId', type: 'bytes32' },
      { name: 'entryFeeWei', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    // Called by agents from their OWN wallet (T19), never by the arena.
    type: 'function',
    name: 'payEntry',
    stateMutability: 'payable',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'seedPool',
    stateMutability: 'payable',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'seedJackpot',
    stateMutability: 'payable',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'closeEntries',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleCompetition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'competitionId', type: 'bytes32' },
      { name: 'winners', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'jackpotWinner', type: 'address' },
      { name: 'jackpotAmount', type: 'uint256' },
      { name: 'resultRoot', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'rolloverJackpot',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fromCompetitionId', type: 'bytes32' },
      { name: 'toCompetitionId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getCompetition',
    stateMutability: 'view',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [
      { name: 'entryFeeWei', type: 'uint256' },
      { name: 'pool', type: 'uint256' },
      { name: 'jackpotPool', type: 'uint256' },
      { name: 'entrantCount', type: 'uint256' },
      { name: 'resultRoot', type: 'bytes32' },
      { name: 'state', type: 'uint8' },
    ],
  },
  {
    type: 'event',
    name: 'EntryPaid',
    inputs: [
      { name: 'competitionId', type: 'bytes32', indexed: true },
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

/** What a claimed entry payment turns out to be, once read back from the chain. */
export interface EntryCheck {
  ok: boolean;
  /** The address that actually paid the buy-in. */
  payer?: string;
  amountWei?: string;
  error?: string;
}

export interface TournamentChain {
  readonly enabled: boolean;
  readonly contractAddress: string | null;
  /** Open a competition on-chain and fix its buy-in, so agents can pay into it. */
  openCompetition(competitionId: string, entryFeeWei: string): Promise<ChainResult>;
  /**
   * Verify a claimed entry payment by reading the chain: the tx must have hit OUR
   * tournament contract and emitted EntryPaid for THIS competition with the right
   * amount, otherwise any txHash would buy a seat.
   */
  verifyEntry(competitionId: string, txHash: string, expectedWei: string): Promise<EntryCheck>;
  /** Sponsor money into the main prize pool (operator-funded seed). */
  seedPool(competitionId: string, amountWei: string): Promise<ChainResult>;
  /** Sponsor money into the jackpot side-pool. */
  seedJackpot(competitionId: string, amountWei: string): Promise<ChainResult>;
  /** End the season: stop entries + seeding. */
  closeEntries(competitionId: string): Promise<ChainResult>;
  /** Distribute the pool to the ranked winners and the jackpot to its triggerer. */
  settleCompetition(
    competitionId: string,
    winners: string[],
    amounts: bigint[],
    jackpotWinner: string | null,
    jackpotAmount: bigint,
    resultRoot: string,
  ): Promise<ChainResult>;
  /** Carry a residual jackpot from a settled competition into an open one. */
  rolloverJackpot(fromCompetitionId: string, toCompetitionId: string): Promise<ChainResult>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Used whenever the tournament chain is not configured — every call is a clean no-op. */
export const DISABLED_TOURNAMENT_CHAIN: TournamentChain = {
  enabled: false,
  contractAddress: null,
  async openCompetition() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async verifyEntry() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async seedPool() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async seedJackpot() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async closeEntries() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async settleCompetition() {
    return { ok: false, error: 'tournament chain disabled' };
  },
  async rolloverJackpot() {
    return { ok: false, error: 'tournament chain disabled' };
  },
};

/**
 * Build a tournament client from config, or the disabled stub when the operator
 * key / tournament address are absent. The whole pooled model degrades to
 * off-chain bookkeeping (still useful for local play and tests) when disabled.
 */
export function createTournamentChain(
  config: Config,
  log: (message: string) => void = () => {},
): TournamentChain {
  const { operatorPrivateKey, tournamentContractAddress } = config;
  if (!operatorPrivateKey || !tournamentContractAddress) {
    log('[tournament] disabled — set OPERATOR_PRIVATE_KEY and TOURNAMENT_CONTRACT_ADDRESS to enable');
    return DISABLED_TOURNAMENT_CHAIN;
  }

  const key = operatorPrivateKey.startsWith('0x') ? operatorPrivateKey : `0x${operatorPrivateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const address = tournamentContractAddress as Address;
  const transport = http(config.bscTestnetRpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  log(`[tournament] enabled — contract ${address}, operator ${account.address}`);

  async function send(
    functionName: 'openCompetition' | 'seedPool' | 'seedJackpot' | 'closeEntries' | 'settleCompetition' | 'rolloverJackpot',
    args: readonly unknown[],
    value?: bigint,
  ): Promise<ChainResult> {
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address,
        abi: DAMNITS_TOURNAMENT_ABI,
        functionName,
        args: args as never,
        value,
        // viem types simulate per-function; the dynamic call site (mixed payable
        // and non-payable) is checked by the wrappers below instead.
      } as Parameters<typeof publicClient.simulateContract>[0]);
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      log(`[tournament] ${functionName} ok — tx ${txHash}`);
      return { ok: true, txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[tournament] ${functionName} FAILED — ${message}`);
      return { ok: false, error: message };
    }
  }

  const cid = (competitionId: string) => keccak256(toHex(competitionId));

  return {
    enabled: true,
    contractAddress: address,

    openCompetition(competitionId, entryFeeWei) {
      return send('openCompetition', [cid(competitionId), BigInt(entryFeeWei)]);
    },

    async verifyEntry(competitionId, txHash, expectedWei) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt.status !== 'success') return { ok: false, error: 'transaction reverted' };
        if ((receipt.to ?? '').toLowerCase() !== address.toLowerCase()) {
          return { ok: false, error: 'transaction was not sent to this tournament contract' };
        }

        const events = parseEventLogs({
          abi: DAMNITS_TOURNAMENT_ABI,
          eventName: 'EntryPaid',
          logs: receipt.logs,
        });
        const wanted = competitionIdToBytes32(competitionId).toLowerCase();
        const paid = events.find((e) => String(e.args.competitionId).toLowerCase() === wanted);
        if (!paid) return { ok: false, error: 'no entry payment for this competition in that tx' };
        if (paid.args.amount !== BigInt(expectedWei)) {
          return { ok: false, error: `paid ${String(paid.args.amount)} wei, expected ${expectedWei}` };
        }
        return { ok: true, payer: paid.args.player as string, amountWei: String(paid.args.amount) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
      }
    },

    seedPool(competitionId, amountWei) {
      return send('seedPool', [cid(competitionId)], BigInt(amountWei));
    },
    seedJackpot(competitionId, amountWei) {
      return send('seedJackpot', [cid(competitionId)], BigInt(amountWei));
    },
    closeEntries(competitionId) {
      return send('closeEntries', [cid(competitionId)]);
    },
    settleCompetition(competitionId, winners, amounts, jackpotWinner, jackpotAmount, resultRoot) {
      return send('settleCompetition', [
        cid(competitionId),
        winners as Address[],
        amounts,
        (jackpotWinner ?? ZERO_ADDRESS) as Address,
        jackpotAmount,
        resultRoot.startsWith('0x') ? resultRoot : `0x${resultRoot}`,
      ]);
    },
    rolloverJackpot(fromCompetitionId, toCompetitionId) {
      return send('rolloverJackpot', [cid(fromCompetitionId), cid(toCompetitionId)]);
    },
  };
}
