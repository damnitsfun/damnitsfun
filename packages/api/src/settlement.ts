import type { SettlementChain } from './chain';
import type { Db } from './db/index';
import type { SessionLifecycleHooks } from './orchestrator';

/**
 * Commit-reveal wiring (T13).
 *
 * Connects the on-chain escrow to the session lifecycle hooks the orchestrator
 * exposes (sub-spec 04), so no chain concern leaks into orchestration:
 *
 *   session starts  -> commitSeed(sessionId, keccak256(seed))   [before any deal]
 *   session settles -> settle(sessionId, winner, resultHash, seed)
 *
 * Both calls are fire-and-forget. The event log is the source of truth; the chain
 * anchors it. A slow or failing RPC must never block a table or corrupt a result,
 * so failures are logged and the tx hash simply stays null.
 *
 * Resulting tx hashes are persisted on the session row and exposed by the
 * spectator API, which is where the sub-spec 07 demo captures them for BscScan.
 */
export function createChainHooks(
  db: Db,
  chain: SettlementChain,
  log: (message: string) => void = () => {},
): SessionLifecycleHooks {
  if (!chain.enabled) return {};

  const recordCommit = db.prepare(`UPDATE sessions SET commit_tx_hash = ? WHERE id = ?`);
  const recordSettle = db.prepare(`UPDATE sessions SET settle_tx_hash = ? WHERE id = ?`);

  return {
    onSessionStarted({ sessionId, seed }) {
      // Pooled-tournament tables are free (sub-spec 08): the money lives at the
      // competition level, not per session, and nobody paid into this escrow
      // session — so an escrow settle would revert. The season's fairness is
      // anchored by the persisted event log + the tournament's on-chain
      // resultRoot instead, so the per-table escrow calls are omitted entirely.
      if (isTournamentSession(db, sessionId)) return;
      // The hook is synchronous and the chain is not; deliberately not awaited.
      void chain
        .commitSeed(sessionId, seed)
        .then((result) => {
          if (result.ok && result.txHash) {
            recordCommit.run(result.txHash, sessionId);
            log(`[settlement] committed seed for ${sessionId} — ${result.txHash}`);
          } else {
            log(`[settlement] commit failed for ${sessionId}: ${result.error ?? 'unknown'}`);
          }
        })
        .catch((error: unknown) => log(`[settlement] commit threw: ${String(error)}`));
    },

    onSessionSettled({ sessionId, winnerAgentId, resultHash, seedReveal }) {
      if (isTournamentSession(db, sessionId)) return; // see onSessionStarted
      if (!seedReveal) {
        log(`[settlement] no seed reveal for ${sessionId}; skipping on-chain settle`);
        return;
      }
      void chain
        .settle(sessionId, payoutAddressFor(db, winnerAgentId), resultHash, seedReveal)
        .then((result) => {
          if (result.ok && result.txHash) {
            recordSettle.run(result.txHash, sessionId);
            log(`[settlement] settled ${sessionId} — ${result.txHash}`);
          } else {
            log(`[settlement] settle failed for ${sessionId}: ${result.error ?? 'unknown'}`);
          }
        })
        .catch((error: unknown) => log(`[settlement] settle threw: ${String(error)}`));
    },
  };
}

/** True when a session belongs to a pooled tournament (settled at the competition level). */
function isTournamentSession(db: Db, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT c.kind FROM sessions s JOIN competitions c ON c.id = s.competition_id WHERE s.id = ?`,
    )
    .get(sessionId) as { kind?: string } | undefined;
  return row?.kind === 'tournament';
}

/**
 * The contract pays an address, not an agent id. An agent that never set a payout
 * address simply has no on-chain winner — the match still settles off-chain.
 */
function payoutAddressFor(db: Db, agentId: string | null): string | null {
  if (!agentId) return null;
  const row = db.prepare(`SELECT payout_address FROM agents WHERE id = ?`).get(agentId) as
    | { payout_address: string | null }
    | undefined;
  return row?.payout_address ?? null;
}
