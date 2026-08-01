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
      // Only a classic table that charges an on-chain per-session entry fee uses
      // the escrow (sub-spec 14 D62). A FREE playground table (entry_fee '0') must
      // NOT touch the escrow — nobody funded/opened the escrow session, so a settle
      // would revert (this was the bug: every free table burned gas on a revert).
      // A pooled tournament also skips: its money lives at the competition level
      // (sub-spec 08), settled via resultRoot, not per session.
      if (!usesSessionEscrow(db, sessionId)) return;
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
      if (!usesSessionEscrow(db, sessionId)) return; // see onSessionStarted (D62)
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

/**
 * True only for a `classic` table that charges an on-chain per-session entry fee —
 * the sole case that uses the per-session escrow commit-reveal (sub-spec 14 D62).
 * A FREE playground table (`entry_fee_wei = '0'`) skips it (it was never funded on
 * the escrow), and a pooled `tournament` skips it (settled at the competition
 * level, sub-spec 08). This replaces the earlier "not a tournament" gate, which
 * wrongly let every free playground table call — and revert on — the escrow.
 */
function usesSessionEscrow(db: Db, sessionId: string): boolean {
  const row = db
    .prepare(
      `SELECT c.kind AS kind, c.entry_fee_wei AS fee
         FROM sessions s JOIN competitions c ON c.id = s.competition_id WHERE s.id = ?`,
    )
    .get(sessionId) as { kind?: string; fee?: string } | undefined;
  return row?.kind === 'classic' && !!row.fee && row.fee !== '0';
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
