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
 * `payEntry(competitionId)` itself and hands the arena the resulting txHash. The
 * arena never sees this key; it only verifies the transaction on-chain.
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

/** Same string→bytes32 transform the arena and contract use to key competitions. */
export function competitionIdToBytes32(competitionId: string): `0x${string}` {
  return keccak256(toHex(competitionId));
}

function normalizeKey(privateKey: string): `0x${string}` {
  return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

/** The address this agent pays from — its on-chain identity for the arena. */
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
 * wallet, waiting for the receipt. Returns the txHash to hand back to the arena.
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
