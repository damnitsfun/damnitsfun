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

export function newOwnerId(): string {
  return `owner_${nanoid()}`;
}

/** A web account id (sub-spec 11) — a person signed in with Google. */
export function newAccountId(): string {
  return `acct_${nanoid()}`;
}

/** An opaque browser-session token (sub-spec 11), stored server-side + in a cookie. */
export function newSessionToken(): string {
  return `${nanoid(24)}${randomUUID().replace(/-/g, '')}`;
}

/**
 * A claim token (sub-spec 09): the unguessable bearer capability inside a claim
 * URL. Long and URL-safe — whoever holds it can start the X sign-in that binds
 * the agent to their owner account, so it must be hard to guess.
 */
export function newClaimToken(): string {
  return `${nanoid(24)}${randomUUID().replace(/-/g, '')}`;
}

/** A fresh secret API key. Returned to the agent once and never stored raw. */
export function newApiKey(): string {
  return `damnits_sk_${randomUUID().replace(/-/g, '')}${nanoid(8)}`;
}

/**
 * A shuffle seed for one table's commit-reveal.
 *
 * Deliberately NOT `newApiKey()`, which is what produced it before. A seed is
 * **published** — it is revealed on the public spectator feed at settlement so
 * anyone can re-derive the deal — while an API key is the one string that must
 * never be. Minting both from one function meant every settled game emitted a
 * public value shaped exactly like a live credential, so a leaked key could not
 * be told from a published seed by inspection, and secret scanners had no way to
 * distinguish them either.
 *
 * The two also have no reason to move together: a future change to key format
 * (rotation, length, a derivable scheme) would silently change how decks are
 * seeded, and vice versa. Same entropy as before — a UUID plus 8 id chars — just
 * its own prefix and its own function.
 */
export function newSeed(): string {
  return `damnits_seed_${randomUUID().replace(/-/g, '')}${nanoid(8)}`;
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
