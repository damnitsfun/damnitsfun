import type { SessionEventRecord } from 'engine';
import type { Db } from '../db/index';

/**
 * Spectator read API.
 *
 * §5 defines only the agent-facing contract, so the spectator UI (sub-spec 06)
 * had nothing to read the event log through. Per that spec's critical
 * constraint, a missing capability means the API is incomplete — the frontend
 * does NOT get to reach into the database — so these endpoints are added here.
 *
 * ## Why redaction is mandatory
 *
 * `session_events` is deliberately a full-information record: it carries every
 * dealt hand, every drawn card face, and the commit-reveal seed, because replay
 * and the on-chain result hash need all of it. Serving that verbatim while a
 * game is running would let anyone — including a competing agent — read their
 * opponents' hands and, worse, derive the entire shuffled deck from the seed.
 *
 * So a live session is served redacted; the full log is released only once the
 * session is settled, when the information is historical and the seed is meant
 * to be public for verification.
 */

export type SessionStatus = 'lobby' | 'seated' | 'in_progress' | 'settled' | 'archived';

export interface SpectatorEvent {
  seq: number;
  type: string;
  payload: unknown;
  reasoning: string | null;
  createdAt: string;
}

/** Hidden-information fields, stripped while a session is still being played. */
function redactPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'SESSION_STARTED': {
      const { hands, seedReveal, ...rest } = payload as {
        hands?: Record<string, unknown[]>;
        seedReveal?: string | null;
      } & Record<string, unknown>;
      return {
        ...rest,
        // Sizes are public (you can see how many cards someone holds); faces are not.
        handCounts: Object.fromEntries(
          Object.entries(hands ?? {}).map(([agentId, cards]) => [agentId, cards.length]),
        ),
        // The seed stays secret until settlement — it determines the whole deck.
        seedReveal: null,
      };
    }
    case 'CARD_DRAWN': {
      // How many were drawn is public; which cards is not.
      const { cards, ...rest } = payload as { cards?: unknown[] } & Record<string, unknown>;
      void cards;
      return rest;
    }
    default:
      // CARD_PLAYED, TURN_PASSED, TURN_CHANGED, RAINBOW_STORM and GAME_ENDED are
      // all public by nature (played face-up, or emitted only at the end).
      return payload;
  }
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

export function listSessions(db: Db, competitionId?: string, limit = 50): SessionSummary[] {
  const rows = (
    competitionId
      ? db
          .prepare(
            `SELECT * FROM sessions WHERE competition_id = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(competitionId, limit)
      : db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit)
  ) as Array<Record<string, unknown>>;

  return rows.map((row) => summaryFromRow(db, row));
}

export function getSession(db: Db, sessionId: string): SessionSummary | null {
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | Record<string, unknown>
    | undefined;
  return row ? summaryFromRow(db, row) : null;
}

function summaryFromRow(db: Db, row: Record<string, unknown>): SessionSummary {
  const sessionId = row.id as string;
  const status = row.status as SessionStatus;
  const settled = status === 'settled' || status === 'archived';

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

export function readEvents(
  db: Db,
  sessionId: string,
  since: number,
): { events: SpectatorEvent[]; settled: boolean } | null {
  const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
    | { status: SessionStatus }
    | undefined;
  if (!row) return null;

  const settled = row.status === 'settled' || row.status === 'archived';
  const records = db
    .prepare(
      `SELECT session_id AS sessionId, seq, event_type AS eventType, payload_json AS payloadJson,
              reasoning, created_at AS createdAt
         FROM session_events
        WHERE session_id = ? AND seq > ?
        ORDER BY seq`,
    )
    .all(sessionId, since) as SessionEventRecord[];

  return { events: records.map((r) => toSpectatorEvent(r, settled)), settled };
}
