import { keccak256, toHex, type Hash } from 'viem';

/**
 * Commit-reveal hashing — the single definition shared by the database record and
 * the on-chain escrow.
 *
 * This must be one function, not two. The contract verifies
 * `keccak256(seedReveal) == seedCommitHash`, so if the API recorded a commitment
 * under a different hash (SHA-256, say) the on-chain and off-chain records would
 * describe the same seed with two incompatible values and neither could be used
 * to check the other. The whole point of FR-6.4 is that an outside observer can
 * take the published commitment, the revealed seed and the event log and confirm
 * they agree — which requires exactly one commitment scheme.
 */

/** Off-chain session ids are strings; the contract keys sessions by bytes32. */
export function sessionIdToBytes32(sessionId: string): Hash {
  return keccak256(toHex(sessionId));
}

/** Off-chain competition ids are strings; DamnitsTournament keys them by bytes32. */
export function competitionIdToBytes32(competitionId: string): Hash {
  return keccak256(toHex(competitionId));
}

/**
 * The contract stores a bytes32 seed, so a string seed is folded into one. The
 * SAME transform is used on commit and on reveal, or verification fails.
 */
export function seedAsBytes32(seed: string): Hash {
  return keccak256(toHex(seed));
}

/** The value published before play: keccak256 of the bytes32 seed. */
export function seedCommitment(seed: string): Hash {
  return keccak256(seedAsBytes32(seed));
}
