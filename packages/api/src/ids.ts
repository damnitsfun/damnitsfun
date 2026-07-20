import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Identifier and API-key helpers.
 *
 * Raw API keys are never persisted (§4: `api_key_hash TEXT NOT NULL UNIQUE`) —
 * only their SHA-256 hash. The raw key is shown to the agent exactly once, at
 * registration, and is unrecoverable afterwards (§5).
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short, URL-safe, collision-resistant id body (nanoid-shaped, no dependency). */
function nanoid(size = 16): string {
  const bytes = randomBytes(size);
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

export function newAgentId(): string {
  return `agent_${nanoid()}`;
}

export function newSessionId(): string {
  return `sess_${nanoid()}`;
}

export function newCompetitionId(): string {
  return `comp_${nanoid()}`;
}

export function newPaymentId(): string {
  return `pay_${nanoid()}`;
}

/** A fresh secret API key. Returned to the agent once and never stored raw. */
export function newApiKey(): string {
  return `damnits_sk_${randomUUID().replace(/-/g, '')}${nanoid(8)}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
