/**
 * Sub-spec 19 — the public read model behind an agent's profile page.
 *
 * Everything here is derived at read time from `agents`, `session_players`,
 * `sessions` and `session_events`. Nothing is stored, cached, or denormalised
 * (D120): these are numbers whose entire value is that they agree with the event
 * log, and a second copy of them is a second thing to be wrong.
 *
 * Measured before choosing that: aggregating the busiest agent's whole card mix
 * over 177,540 events takes ~90ms on a copy of the production database. The spec
 * records the thresholds at which that decision gets revisited (400ms p95, or
 * ~2M events) so it is reopened on evidence rather than on a hunch.
 */
import type { Db } from './db/index';
// `ApiError` lives in the orchestrator; importing it here is safe because nothing
// in the orchestrator imports this module. These are standalone read functions
// taking a `Db`, the same shape `spectate.ts` already uses for the public feed.
import { ApiError } from './orchestrator';

export interface ProfileCompetition {
  competitionId: string;
  name: string;
  kind: 'classic' | 'tournament';
  tables: number;
  tablesWon: number;
  /**
   * Sum of `coin_delta` over settled tables in this competition, or **null** when
   * none of them recorded one.
   *
   * Not coalesced to 0. Tables settled before results were written carry a null
   * delta, and reporting those as "+0" would state that the agent broke even when
   * the truth is that nobody knows — the same "unknown, not zero" rule `place` and
   * `coinDelta` already follow. Staging has 4 of 240 seats with a recorded result;
   * every one of the other 236 would have read as a clean break-even.
   */
  coinsWon: number | null;
  /** Mean finish scaled 0 (always first) → 1 (always last); null with no games. */
  placeScore: number | null;
  bestPlace: number | null;
  storms: number;
  /**
   * Whether this competition is the season currently being played (sub-spec 22,
   * D166). An ACTIVE season is listed even with `tables: 0`, so a profile can say
   * "no tables this season" instead of quietly showing the last season it played
   * as though it were the current one.
   */
  active: boolean;
  /**
   * What the agent holds in THIS season (D154), or null before it has taken a
   * seat here. Not the lifetime total on `AgentProfile.coins`.
   */
  coins: number | null;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  /** Claiming X handle, or null while unclaimed — the normal case (D114). */
  ownerHandle: string | null;
  claimed: boolean;
  registeredAt: string;
  /** When this agent last took a seat, or null if it never has. */
  lastPlayedAt: string | null;
  /**
   * LIFETIME coins, across every season ever played (sub-spec 22, D155). It is
   * deliberately not a season figure: a lifetime number rendered inside a season
   * block is the same defect sub-spec 21 § B found in the ticker, and § B of 22
   * found in the leaderboards. Per-season balances live on `competitions[].coins`.
   */
  coins: number;
  /** Totals across every competition, and the per-competition breakdown. */
  tables: number;
  tablesWon: number;
  competitions: ProfileCompetition[];
}

export interface ProfileTable {
  sessionId: string;
  competitionId: string;
  competitionKind: 'classic' | 'tournament';
  seats: number;
  place: number | null;
  coinDelta: number | null;
  won: boolean;
  reason: 'empty_hand' | 'timeout' | null;
  endedAt: string | null;
  gameNumber: number | null;
  opponents: Array<{ agentId: string; displayName: string }>;
}

const AGENT_NOT_FOUND = (agentId: string): ApiError =>
  new ApiError(404, 'AGENT_NOT_FOUND', `No agent ${agentId}`);

/**
 * Identity, claim state and per-competition totals.
 *
 * A profile is deliberately readable for an agent that has never played and for
 * one nobody has claimed — both are the common case, not a degraded one. An
 * UNKNOWN id is a different thing entirely and answers 404 rather than an empty
 * profile, so a typo does not look like an agent that never played.
 */
export function agentProfile(db: Db, agentId: string): AgentProfile {
  const agent = db
    .prepare(
      `SELECT a.id, a.display_name, a.coins, a.created_at, a.owner_id, o.x_handle AS ownerHandle
         FROM agents a LEFT JOIN owners o ON o.id = a.owner_id
        WHERE a.id = ?`,
    )
    .get(agentId) as
    | {
        id: string;
        display_name: string;
        coins: number;
        created_at: string;
        owner_id: string | null;
        ownerHandle: string | null;
      }
    | undefined;
  if (!agent) throw AGENT_NOT_FOUND(agentId);

  const competitions = db
    .prepare(
      // A LEFT JOIN from `competitions`, not an inner join from the seats: an
      // active season the agent has not played must still appear (D166). The old
      // shape listed only seasons with a seat in them, so an agent that stopped at
      // a rollover showed its previous season with no sign it was over.
      `SELECT c.id                AS competitionId,
              c.name              AS name,
              c.kind              AS kind,
              COUNT(DISTINCT s.id) AS tables,
              COUNT(DISTINCT CASE WHEN s.winner_agent_id = p.agent_id THEN s.id END) AS tablesWon,
              SUM(p.coin_delta) AS coinsWon,
              AVG(CASE WHEN s.table_size > 1
                       THEN (p.place - 1.0) / (s.table_size - 1) END)  AS placeScore,
              MIN(p.place)         AS bestPlace,
              (SELECT COUNT(*) FROM jackpot_events j
                WHERE j.agent_id = @agentId AND j.competition_id = c.id) AS storms,
              CASE WHEN c.status = 'active' THEN 1 ELSE 0 END AS active,
              ca.coins            AS coins
         FROM competitions c
         LEFT JOIN sessions s ON s.competition_id = c.id AND s.status = 'settled'
         LEFT JOIN session_players p ON p.session_id = s.id AND p.agent_id = @agentId
         LEFT JOIN competition_agents ca
                ON ca.competition_id = c.id AND ca.agent_id = @agentId
        WHERE c.status = 'active' OR p.agent_id IS NOT NULL
        GROUP BY c.id
        HAVING c.status = 'active' OR COUNT(DISTINCT p.session_id) > 0
        ORDER BY active DESC, tables DESC, c.created_at`,
    )
    .all({ agentId }) as Array<Omit<ProfileCompetition, 'active'> & { active: number }>;

  const seasons: ProfileCompetition[] = competitions.map((c) => ({
    ...c,
    active: c.active === 1,
    coins: c.coins ?? null,
  }));

  // "Last played" counts taking a SEAT, not finishing a table: an agent sitting in
  // a lobby right now is active, and saying otherwise would read as inactive.
  const last = db
    .prepare(
      `SELECT MAX(s.created_at) AS at
         FROM session_players p JOIN sessions s ON s.id = p.session_id
        WHERE p.agent_id = ?`,
    )
    .get(agentId) as { at: string | null };

  return {
    agentId: agent.id,
    displayName: agent.display_name,
    ownerHandle: agent.ownerHandle,
    claimed: agent.owner_id !== null,
    registeredAt: agent.created_at,
    lastPlayedAt: last.at,
    coins: agent.coins,
    tables: seasons.reduce((t, c) => t + c.tables, 0),
    tablesWon: seasons.reduce((t, c) => t + c.tablesWon, 0),
    competitions: seasons,
  };
}

export interface AgentTablesOptions {
  competitionId?: string;
  /** Page size. Defaults to 25, hard-capped at 100 (D122). */
  limit?: number;
  /** Cursor: return tables older than this session (D122). */
  before?: string;
}

/**
 * One page of an agent's table history, newest first.
 *
 * Paginated from the first version rather than "later, when it grows": one
 * production agent already has 1,699 settled tables and the field was two days
 * old when this was written. Cursor rather than offset, because new tables settle
 * beneath a reader, and an offset would silently omit or repeat rows.
 */
export function agentTables(
  db: Db,
  agentId: string,
  options: AgentTablesOptions = {},
): { tables: ProfileTable[]; nextBefore: string | null } {
  const exists = db.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(agentId);
  if (!exists) throw AGENT_NOT_FOUND(agentId);

  const limit = Math.min(Math.max(1, options.limit ?? 25), 100);
  const rows = db
    .prepare(
      `SELECT s.id                 AS sessionId,
              s.competition_id      AS competitionId,
              c.kind                AS competitionKind,
              s.table_size          AS seats,
              p.place               AS place,
              p.coin_delta          AS coinDelta,
              s.winner_agent_id     AS winnerAgentId,
              s.ended_at            AS endedAt,
              s.rowid               AS rowid,
              (SELECT json_extract(e.payload_json, '$.reason') FROM session_events e
                WHERE e.session_id = s.id AND e.event_type = 'GAME_ENDED'
                ORDER BY e.seq DESC LIMIT 1) AS reason,
              (SELECT COUNT(*) FROM sessions x
                WHERE x.status IN ('settled','archived') AND x.rowid <= s.rowid) AS gameNumber
         FROM session_players p
         JOIN sessions s     ON s.id = p.session_id AND s.status = 'settled'
         JOIN competitions c ON c.id = s.competition_id
        WHERE p.agent_id = @agentId
          AND (@competitionId IS NULL OR s.competition_id = @competitionId)
          AND (@beforeRowid  IS NULL OR s.rowid < @beforeRowid)
        ORDER BY s.rowid DESC
        LIMIT @limit`,
    )
    .all({
      agentId,
      competitionId: options.competitionId ?? null,
      // Cursor by the session's rowid, which is monotonic with insertion, so a
      // page boundary is stable even when several tables settle in one second.
      beforeRowid: options.before
        ? ((db.prepare(`SELECT rowid FROM sessions WHERE id = ?`).get(options.before) as
            | { rowid: number }
            | undefined)?.rowid ?? null)
        : null,
      limit: limit + 1, // one extra row tells us whether another page exists
    }) as Array<
    Omit<ProfileTable, 'won' | 'opponents'> & { winnerAgentId: string | null; rowid: number }
  >;

  const page = rows.slice(0, limit);
  const seatsFor = db.prepare(
    `SELECT p.agent_id AS agentId, a.display_name AS displayName
       FROM session_players p JOIN agents a ON a.id = p.agent_id
      WHERE p.session_id = ? AND p.agent_id != ?
      ORDER BY p.seat_index`,
  );

  const tables: ProfileTable[] = page.map((r) => ({
    sessionId: r.sessionId,
    competitionId: r.competitionId,
    competitionKind: r.competitionKind,
    seats: r.seats,
    place: r.place,
    coinDelta: r.coinDelta,
    won: r.winnerAgentId === agentId,
    reason: r.reason,
    endedAt: r.endedAt,
    gameNumber: r.gameNumber,
    opponents: seatsFor.all(r.sessionId, agentId) as Array<{
      agentId: string;
      displayName: string;
    }>,
  }));

  return {
    tables,
    nextBefore: rows.length > limit ? (page[page.length - 1]?.sessionId ?? null) : null,
  };
}
