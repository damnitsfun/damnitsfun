import type { SessionEventRecord, SessionEventType } from 'engine';
import type { Db } from '../db/index';

/**
 * Spectator read API.
 *
 * §5 defines only the agent-facing contract, so the spectator UI (sub-spec 06)
 * had nothing to read the event log through. Per that spec's critical
 * constraint, a missing capability means the API is incomplete — the frontend
 * does NOT get to reach into the database — so these endpoints are added here.
 *
 * ## Replay-only: the public feed never shows a live table (sub-spec 10)
 *
 * `session_events` is deliberately a full-information record: it carries every
 * dealt hand, every drawn card face, and the commit-reveal seed, because replay
 * and the on-chain result hash need all of it. Serving any of that while a game
 * is running would let a competing agent read its opponents' hands or, worse,
 * derive the whole shuffled deck from the seed.
 *
 * So — mirroring arena.dev.fun, whose viewer only ever fetches `Completed`
 * tables — the public spectator serves **only finished sessions**
 * (`settled`/`archived`). An in-progress session is absent from the list, is not
 * individually addressable, and its events answer `409 GAME_IN_PROGRESS`. There
 * is no redacted live tail to get wrong; the boundary opens only once a session
 * is over, when the log is history and the seed is meant to be public for
 * verification. {@link redactPayload} remains as defense-in-depth (see below).
 */

export type SessionStatus = 'lobby' | 'seated' | 'in_progress' | 'settled' | 'archived';

export interface SpectatorEvent {
  seq: number;
  type: string;
  payload: unknown;
  reasoning: string | null;
  createdAt: string;
}

/** A session is publicly viewable only once its game is over. */
function isCompleted(status: SessionStatus): boolean {
  return status === 'settled' || status === 'archived';
}

type Projection = (payload: Record<string, unknown>) => Record<string, unknown>;

/** Keep only `keys` that are present — never introduce fields the payload lacks. */
function pick(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in payload) out[key] = payload[key];
  }
  return out;
}

/**
 * Allowlist of what each event type may expose BEFORE settlement. This is a
 * **fail-safe** design (sub-spec 10 T31): every type opts into an explicit set of
 * public fields, and an unknown/new type falls through to a bare skeleton — never
 * the raw payload. A future event that carries hidden information therefore
 * cannot leak by omission the way the old denylist `default: return payload`
 * would have.
 *
 * The `satisfies` clause makes this exhaustive: adding a `SessionEventType`
 * without declaring its projection fails the build.
 *
 * NOTE: after T30 no public route serves an unsettled session's events at all, so
 * this path is reached only by unit tests and any future pre-settlement reader —
 * it is defense-in-depth guarding the seed, not a live-serving path.
 */
const PUBLIC_PROJECTIONS = {
  SESSION_STARTED: (payload) => {
    const hands = (payload.hands ?? {}) as Record<string, unknown[]>;
    return {
      ...pick(payload, ['seats', 'timeLimitMs', 'rainbowStormChance', 'firstAgentId', 'discard']),
      // Sizes are public (you can see how many cards someone holds); faces are not.
      handCounts: Object.fromEntries(
        Object.entries(hands).map(([agentId, cards]) => [agentId, cards.length]),
      ),
      // The seed determines the whole deck — it stays secret until settlement.
      seedReveal: null,
    };
  },
  // Played face-up: fully public.
  CARD_PLAYED: (payload) => pick(payload, ['agentId', 'card', 'chosenColor', 'handCountAfter']),
  // How many were drawn is public; which cards is not.
  CARD_DRAWN: (payload) => pick(payload, ['agentId', 'count', 'cause', 'handCountAfter']),
  TURN_PASSED: (payload) => pick(payload, ['agentId']),
  RAINBOW_STORM: (payload) => pick(payload, ['agentId', 'victims', 'drawCount']),
  TURN_CHANGED: (payload) => pick(payload, ['currentAgentId', 'direction']),
  // Emitted only at game end — hands are public by then.
  GAME_ENDED: (payload) => pick(payload, ['winnerAgentId', 'reason', 'finalHands', 'handValues']),
} satisfies Record<SessionEventType, Projection>;

/** Fail-safe projection: known types use their allowlist, unknown types a skeleton. */
function redactPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const project = (PUBLIC_PROJECTIONS as Record<string, Projection>)[type];
  // Unknown/new type → reveal only a minimal skeleton, never the raw payload.
  return project ? project(payload) : pick(payload, ['agentId']);
}

export function toSpectatorEvent(record: SessionEventRecord, settled: boolean): SpectatorEvent {
  const payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  return {
    seq: record.seq,
    type: record.eventType,
    payload: settled ? payload : redactPayload(record.eventType, payload),
    reasoning: record.reasoning,
    createdAt: record.createdAt,
  };
}

export interface SessionSummary {
  sessionId: string;
  competitionId: string;
  status: SessionStatus;
  tableSize: number;
  seats: Array<{ seatIndex: number; agentId: string; displayName: string }>;
  winnerAgentId: string | null;
  /** Published before play; lets a spectator verify the reveal afterwards. */
  seedCommitHash: string | null;
  /** Only once settled — see redaction note above. */
  seedReveal: string | null;
  resultHash: string | null;
  /** On-chain transactions, for independent verification on a block explorer. */
  commitTxHash: string | null;
  settleTxHash: string | null;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number;
}

export interface ListSessionsOptions {
  /**
   * Include not-yet-finished sessions. Public callers MUST leave this false — a
   * live table must never be listed. Reserved for internal/ops callers.
   */
  includeLive?: boolean;
  /**
   * `delayed`-mode airing buffer (sub-spec 10 D32): hide sessions that finished
   * fewer than this many ms ago from the public list, so the featured replay lags
   * the true frontier. `0` (default) = list as soon as finished (arena-style).
   */
  minFinishedAgeMs?: number;
}

export function listSessions(
  db: Db,
  competitionId?: string,
  limit = 50,
  options: ListSessionsOptions = {},
): SessionSummary[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (competitionId) {
    clauses.push('competition_id = ?');
    params.push(competitionId);
  }
  if (!options.includeLive) {
    // The security invariant: the public list is finished sessions only.
    clauses.push(`status IN ('settled', 'archived')`);
    const age = options.minFinishedAgeMs ?? 0;
    if (age > 0) {
      // Optional UX buffer — lag the featured frontier by SPECTATOR_DELAY_MS.
      clauses.push(`ended_at IS NOT NULL AND ended_at <= datetime('now', ?)`);
      params.push(`-${Math.floor(age / 1000)} seconds`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => summaryFromRow(db, row));
}

/** Raw summary for any status — internal use. Hidden fields are still gated on settlement. */
export function getSession(db: Db, sessionId: string): SessionSummary | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | Record<string, unknown>
    | undefined;
  return row ? summaryFromRow(db, row) : null;
}

export type PublicSessionResult =
  | { status: 'ok'; summary: SessionSummary }
  | { status: 'in_progress' }
  | { status: 'not_found' };

/**
 * Public session lookup (sub-spec 10 T30): a not-yet-finished session is reported
 * `in_progress` and carries NO summary — a live table is not individually
 * addressable, mirroring its omission from the list. The route maps that to
 * `409 GAME_IN_PROGRESS`.
 */
export function getPublicSession(db: Db, sessionId: string): PublicSessionResult {
  const summary = getSession(db, sessionId);
  if (!summary) return { status: 'not_found' };
  if (!isCompleted(summary.status)) return { status: 'in_progress' };
  return { status: 'ok', summary };
}

function summaryFromRow(db: Db, row: Record<string, unknown>): SessionSummary {
  const sessionId = row.id as string;
  const status = row.status as SessionStatus;
  const settled = isCompleted(status);

  const seats = db
    .prepare(
      `SELECT p.seat_index AS seatIndex, p.agent_id AS agentId, a.display_name AS displayName
         FROM session_players p JOIN agents a ON a.id = p.agent_id
        WHERE p.session_id = ? ORDER BY p.seat_index`,
    )
    .all(sessionId) as Array<{ seatIndex: number; agentId: string; displayName: string }>;

  const eventCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`).get(sessionId) as {
      n: number;
    }
  ).n;

  return {
    sessionId,
    competitionId: row.competition_id as string,
    status,
    tableSize: row.table_size as number,
    seats,
    winnerAgentId: (row.winner_agent_id as string | null) ?? null,
    seedCommitHash: (row.seed_commit_hash as string | null) ?? null,
    seedReveal: settled ? ((row.seed_reveal as string | null) ?? null) : null,
    resultHash: settled ? ((row.result_hash as string | null) ?? null) : null,
    // The commit tx is public from the moment it lands — that IS the commitment.
    commitTxHash: (row.commit_tx_hash as string | null) ?? null,
    settleTxHash: settled ? ((row.settle_tx_hash as string | null) ?? null) : null,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    eventCount,
  };
}

export type ReadEventsResult =
  | { status: 'ok'; events: SpectatorEvent[]; settled: boolean }
  | { status: 'in_progress' }
  | { status: 'not_found' };

/**
 * Public event log (sub-spec 10 T30). Serves the FULL log of a finished session
 * (the seed is public post-settlement, for commit-reveal verification). A
 * still-running session yields `in_progress` and NO events — there is no redacted
 * live tail. The route maps that to `409 GAME_IN_PROGRESS`.
 */
export function readEvents(db: Db, sessionId: string, since: number): ReadEventsResult {
  const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
    | { status: SessionStatus }
    | undefined;
  if (!row) return { status: 'not_found' };
  if (!isCompleted(row.status)) return { status: 'in_progress' };

  const records = db
    .prepare(
      `SELECT session_id AS sessionId, seq, event_type AS eventType, payload_json AS payloadJson,
              reasoning, created_at AS createdAt
         FROM session_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq`,
    )
    .all(sessionId, since) as SessionEventRecord[];

  return { status: 'ok', events: records.map((r) => toSpectatorEvent(r, true)), settled: true };
}
