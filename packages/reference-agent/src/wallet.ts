import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

/**
 * Agent-held wallet (sub-spec 08, T19).
 *
 * This is the module that makes the old rule *"agents never hold keys"* FALSE —
 * on purpose, and only for the agent process. The agent owns a viem local
 * account, and when a tournament asks for a buy-in (HTTP 402) it signs
 * `payEntry(competitionId)` itself and hands the battleground the resulting txHash. The
 * battleground never sees this key; it only verifies the transaction on-chain.
 *
 * Safety posture (spec "Safety boundary"): the key lives with the agent, under
 * its own operator's authorisation, and paying is opt-in (the runner only calls
 * this when explicitly authorised). Bounding the spend further — a session-key
 * smart account capped at the entry fee — is the documented T20 hardening path.
 *
 * viem only (§2 / CLAUDE.md): no ethers anywhere.
 */

const PAY_ENTRY_ABI = [
  {
    type: 'function',
    name: 'payEntry',
    stateMutability: 'payable',
    inputs: [{ name: 'competitionId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/**
 * The vault's deposit (sub-spec 24). Same shape as `payEntry`, and deliberately a
 * separate constant: they take the same argument but they are not the same act.
 * A buy-in is spent; a deposit is **returned in full** when the season resolves.
 */
const DEPOSIT_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [{ name: 'seasonId', type: 'bytes32' }],
    outputs: [],
  },
] as const;

/** Pull whatever the vault owes this wallet — a refund, a prize, or both at once. */
const WITHDRAW_ABI = [
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'owed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Same string→bytes32 transform the battleground and contract use to key competitions. */
export function competitionIdToBytes32(competitionId: string): `0x${string}` {
  return keccak256(toHex(competitionId));
}

function normalizeKey(privateKey: string): `0x${string}` {
  return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

/** The address this agent pays from — its on-chain identity for the battleground. */
export function walletAddress(privateKey: string): string {
  return privateKeyToAccount(normalizeKey(privateKey)).address;
}

export interface PayEntryOptions {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  competitionId: string;
  amountWei: string;
}

/**
 * Sign and send `payEntry(competitionId){value: amountWei}` from the agent's own
 * wallet, waiting for the receipt. Returns the txHash to hand back to the battleground.
 */
export async function payTournamentEntry(options: PayEntryOptions): Promise<string> {
  const account = privateKeyToAccount(normalizeKey(options.privateKey));
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  const { request } = await publicClient.simulateContract({
    account,
    address: options.contractAddress as Address,
    abi: PAY_ENTRY_ABI,
    functionName: 'payEntry',
    args: [competitionIdToBytes32(options.competitionId)],
    value: BigInt(options.amountWei),
  });
  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/**
 * Stake a **refundable** season deposit into the vault (sub-spec 24, D190).
 *
 * The battleground answers `/competition/enter` with `402 DEPOSIT_REQUIRED` naming
 * the vault, the amount and both on-chain deadlines. The agent signs this itself
 * and hands back the txHash, which the battleground checks against the vault's
 * `Deposited` event before a seat is real — it never trusts the hash.
 *
 * The money comes back to **this** wallet at resolve, not to the payout address:
 * a refund returns where it came from, while prizes go where prizes go.
 */
export async function depositSeasonStake(options: PayEntryOptions): Promise<string> {
  const account = privateKeyToAccount(normalizeKey(options.privateKey));
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  const { request } = await publicClient.simulateContract({
    account,
    address: options.contractAddress as Address,
    abi: DEPOSIT_ABI,
    functionName: 'deposit',
    args: [competitionIdToBytes32(options.competitionId)],
    value: BigInt(options.amountWei),
  });
  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** What the vault owes this wallet right now — refund, prize, or both. */
export async function owedByVault(
  rpcUrl: string,
  vaultAddress: string,
  address: string,
): Promise<bigint> {
  const publicClient = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl) });
  return publicClient.readContract({
    address: vaultAddress as Address,
    abi: WITHDRAW_ABI,
    functionName: 'owed',
    args: [address as Address],
  });
}

/** Collect everything the vault owes this wallet. One call takes refund and prize together. */
export async function withdrawFromVault(options: {
  rpcUrl: string;
  privateKey: string;
  vaultAddress: string;
}): Promise<string> {
  const account = privateKeyToAccount(normalizeKey(options.privateKey));
  const transport = http(options.rpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const walletClient = createWalletClient({ account, chain: bscTestnet, transport });

  const { request } = await publicClient.simulateContract({
    account,
    address: options.vaultAddress as Address,
    abi: WITHDRAW_ABI,
    functionName: 'withdraw',
  });
  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}
