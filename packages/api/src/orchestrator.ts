import { createHash } from 'node:crypto';
import {
  EngineError,
  GameSession,
  SessionNotFoundError,
  type Move,
  type SessionEvent,
} from 'engine';
import type { Config } from './config';
import type { Db } from './db/index';
import { SqliteSessionEventStore } from './db/event-store';
import { hashApiKey, hashesEqual, newAgentId, newApiKey, newPaymentId, newSessionId } from './ids';
import { conservativeRating, defaultRating, placementsFrom, rateSession } from './ranking';

/**
 * Session orchestration (T10): lifecycle, matchmaking, per-decision timeouts,
 * idempotency and settlement.
 *
 * All rules logic lives in `GameSession` (NFR-2) — this module never decides what
 * is legal, only who may act, when their turn expires, and what to persist.
 *
 * Live `GameSession` objects are held in memory for the duration of a match. The
 * durable record is `session_events`; an in-flight match does not survive a
 * process restart (acceptable at hackathon scale, and the completed log is what
 * replay and settlement consume).
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface AgentRow {
  id: string;
  api_key_hash: string;
  display_name: string;
  payout_address: string | null;
  trueskill_mu: number;
  trueskill_sigma: number;
}

interface CompetitionRow {
  id: string;
  name: string;
  status: string;
  entry_fee_wei: string;
  contract_address: string | null;
}

interface SessionRow {
  id: string;
  competition_id: string;
  status: 'lobby' | 'seated' | 'in_progress' | 'settled' | 'archived';
  table_size: number;
  seed_commit_hash: string | null;
  seed_reveal: string | null;
  winner_agent_id: string | null;
  result_hash: string | null;
}

interface LiveSession {
  game: GameSession;
  /** Wall-clock ms after which the current agent's turn is auto-actioned. */
  deadlineAt: number;
}

export interface PendingSession {
  sessionId: string;
  /**
   * Where this table is in its lifecycle. Included so a polling agent can tell
   * "my table has not started yet" (`lobby`) apart from "my table is over" (the
   * session drops out of the list entirely). Without it, an agent seated in a
   * lobby sees an empty list and cannot distinguish waiting from finished.
   */
  status: 'lobby' | 'seated' | 'in_progress';
  yourTurn: boolean;
  legalMoves: Move[];
  deadlineMs: number | null;
}

/**
 * Observable lifecycle transitions, so sub-spec 05 (T13) can attach on-chain
 * commit-reveal without reaching into orchestration internals:
 *  - `onSessionStarted` fires after the seed is committed and before the first
 *    move, which is exactly when `commitSeed(sessionId, hash)` must be sent.
 *  - `onSessionSettled` fires once the result is durable, carrying the reveal
 *    and the result hash that `settle(...)` publishes.
 *
 * A throwing hook is swallowed: a chain outage must not corrupt a finished game.
 */
export interface SessionLifecycleHooks {
  onSessionStarted?(info: {
    sessionId: string;
    seatAgentIds: string[];
    seedCommitHash: string;
  }): void;
  onSessionSettled?(info: {
    sessionId: string;
    winnerAgentId: string | null;
    resultHash: string;
    seedReveal: string | null;
    handValues: Record<string, number>;
  }): void;
}

/** Map an engine error to its HTTP shape (§5). */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof EngineError) {
    const byCode: Record<string, number> = {
      NOT_YOUR_TURN: 409, // turn/state conflict
      SESSION_ENDED: 410, // gone
      SESSION_NOT_FOUND: 404,
      INVALID_CARD: 400, // illegal move
      MUST_DRAW_FIRST: 400,
      INVALID_FINAL_CALL: 400,
      ILLEGAL_MOVE: 400,
    };
    return new ApiError(byCode[error.code] ?? 400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(500, 'INTERNAL_ERROR', message);
}

export class Orchestrator {
  private readonly db: Db;
  private readonly config: Config;
  private readonly clock: () => number;
  private readonly hooks: SessionLifecycleHooks;
  private readonly live = new Map<string, LiveSession>();

  constructor(
    db: Db,
    config: Config,
    options: { clock?: () => number; hooks?: SessionLifecycleHooks } = {},
  ) {
    this.db = db;
    this.config = config;
    this.clock = options.clock ?? (() => Date.now());
    this.hooks = options.hooks ?? {};
  }

  /** Run a lifecycle hook without letting its failure affect the game. */
  private fire(run: () => void): void {
    try {
      run();
    } catch {
      /* hooks are observers: a failing one must never break a session */
    }
  }

  // ---- agents ---------------------------------------------------------------

  registerAgent(displayName: string): { agentId: string; apiKey: string } {
    const agentId = newAgentId();
    const apiKey = newApiKey();
    const rating = defaultRating();

    this.db
      .prepare(
        `INSERT INTO agents (id, api_key_hash, display_name, trueskill_mu, trueskill_sigma)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(agentId, hashApiKey(apiKey), displayName, rating.mu, rating.sigma);

    return { agentId, apiKey };
  }

  /** Resolve an API key to its agent, or null. Compares hashes in constant time. */
  authenticate(apiKey: string | undefined): AgentRow | null {
    if (!apiKey) return null;
    const hash = hashApiKey(apiKey);
    const row = this.db.prepare(`SELECT * FROM agents WHERE api_key_hash = ?`).get(hash) as
      | AgentRow
      | undefined;
    if (!row) return null;
    return hashesEqual(row.api_key_hash, hash) ? row : null;
  }

  getAgent(agentId: string): AgentRow {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as
      | AgentRow
      | undefined;
    if (!row) throw new ApiError(404, 'AGENT_NOT_FOUND', `No such agent: ${agentId}`);
    return row;
  }

  setPayoutAddress(agentId: string, payoutAddress: string): AgentRow {
    this.db.prepare(`UPDATE agents SET payout_address = ? WHERE id = ?`).run(payoutAddress, agentId);
    return this.getAgent(agentId);
  }

  // ---- competitions ---------------------------------------------------------

  createCompetition(name: string, entryFeeWei = '0', contractAddress: string | null = null): string {
    const id = `comp_${createHash('sha1').update(`${name}:${this.clock()}`).digest('hex').slice(0, 16)}`;
    this.db
      .prepare(
        `INSERT INTO competitions (id, name, status, entry_fee_wei, contract_address)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(id, name, entryFeeWei, contractAddress);
    return id;
  }

  listActiveCompetitions(): Array<{
    id: string;
    name: string;
    entryFeeWei: string;
    contractAddress: string | null;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM competitions WHERE status = 'active' ORDER BY created_at`)
      .all() as CompetitionRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      entryFeeWei: r.entry_fee_wei,
      contractAddress: r.contract_address,
    }));
  }

  // ---- joining / matchmaking -------------------------------------------------

  /**
   * Seat an agent at a table for `competitionId`, creating a lobby if none is
   * open. When the table reaches TABLE_SIZE the match starts immediately.
   */
  joinSession(
    agentId: string,
    competitionId: string,
    txHash?: string,
  ): { sessionId: string; status: 'lobby' | 'seated'; seatIndex: number | null } {
    const competition = this.db
      .prepare(`SELECT * FROM competitions WHERE id = ? AND status = 'active'`)
      .get(competitionId) as CompetitionRow | undefined;
    if (!competition) {
      throw new ApiError(404, 'COMPETITION_NOT_FOUND', `No active competition: ${competitionId}`);
    }

    const existing = this.db
      .prepare(
        `SELECT s.id FROM sessions s
           JOIN session_players p ON p.session_id = s.id
          WHERE p.agent_id = ? AND s.status IN ('lobby','seated','in_progress')`,
      )
      .get(agentId) as { id: string } | undefined;
    if (existing) {
      throw new ApiError(409, 'ALREADY_IN_SESSION', `Agent is already in session ${existing.id}`);
    }

    this.requireEntryFee(agentId, competition, txHash);

    const session = this.findOrCreateLobby(competition);
    const seatIndex = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_players WHERE session_id = ?`)
      .get(session.id) as { n: number };

    this.db
      .prepare(`INSERT INTO session_players (session_id, agent_id, seat_index) VALUES (?, ?, ?)`)
      .run(session.id, agentId, seatIndex.n);

    // §5 reports the agent's seating, not the session row's lifecycle status:
    // 'seated' once the table is full and the match is under way, else 'lobby'.
    const seated = seatIndex.n + 1;
    if (seated >= session.table_size) {
      this.startSession(session.id);
      return { sessionId: session.id, status: 'seated', seatIndex: seatIndex.n };
    }

    this.db.prepare(`UPDATE sessions SET status = 'lobby' WHERE id = ?`).run(session.id);
    return { sessionId: session.id, status: 'lobby', seatIndex: seatIndex.n };
  }

  /**
   * Entry-fee gate (§5). The on-chain verification lands in sub-spec 05 (T13);
   * here the endpoint, its 402 shape and the payment row already exist, so the
   * contract wiring has a defined place to attach.
   */
  private requireEntryFee(agentId: string, competition: CompetitionRow, txHash?: string): void {
    if (competition.entry_fee_wei === '0') return;

    const paid = this.db
      .prepare(
        `SELECT id FROM payments
          WHERE agent_id = ? AND direction = 'entry_fee' AND status = 'confirmed'
            AND session_id IS NULL`,
      )
      .get(agentId) as { id: string } | undefined;
    if (paid) return;

    if (!txHash) {
      throw new ApiError(402, 'PAYMENT_REQUIRED', 'Entry fee not paid', {
        paymentRequired: {
          chainId: this.config.bscChainId,
          contractAddress: competition.contract_address ?? this.config.escrowContractAddress,
          amountWei: competition.entry_fee_wei,
        },
      });
    }

    // TODO(sub-spec 05 / T13): verify txHash on-chain before marking confirmed.
    this.db
      .prepare(
        `INSERT INTO payments (id, session_id, agent_id, direction, amount_wei, tx_hash, status)
         VALUES (?, NULL, ?, 'entry_fee', ?, ?, 'confirmed')`,
      )
      .run(newPaymentId(), agentId, competition.entry_fee_wei, txHash);
  }

  private findOrCreateLobby(competition: CompetitionRow): SessionRow {
    const open = this.db
      .prepare(
        `SELECT s.* FROM sessions s
          WHERE s.competition_id = ? AND s.status = 'lobby'
            AND (SELECT COUNT(*) FROM session_players p WHERE p.session_id = s.id) < s.table_size
          ORDER BY s.created_at
          LIMIT 1`,
      )
      .get(competition.id) as SessionRow | undefined;
    if (open) return open;

    const id = newSessionId();
    this.db
      .prepare(
        `INSERT INTO sessions (id, competition_id, status, table_size) VALUES (?, ?, 'lobby', ?)`,
      )
      .run(id, competition.id, this.config.tableSize);
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow;
  }

  /** Deal the table: commit a seed, construct the GameSession, start the clock. */
  private startSession(sessionId: string): void {
    const seats = this.seatsOf(sessionId);
    // Commit-reveal (spec 05): the hash is published before play; the seed itself
    // is only exposed once the session is settled.
    const seed = newApiKey();
    const seedCommitHash = createHash('sha256').update(seed).digest('hex');

    const game = new GameSession(seats, {
      sessionId,
      seedReveal: seed,
      timeLimitMs: this.config.gameTimeLimitMs,
      rainbowStormChance: this.config.rainbowStormChance,
      store: new SqliteSessionEventStore(this.db),
      clock: this.clock,
    });

    this.db
      .prepare(
        `UPDATE sessions
            SET status = 'in_progress', seed_commit_hash = ?, seed_reveal = ?, started_at = datetime('now')
          WHERE id = ?`,
      )
      .run(seedCommitHash, seed, sessionId);

    this.live.set(sessionId, { game, deadlineAt: this.clock() + this.config.decisionTimeoutMs });

    // Attach point for sub-spec 05 (T13): publish the seed commitment on-chain
    // here, before any move is applied.
    this.fire(() =>
      this.hooks.onSessionStarted?.({ sessionId, seatAgentIds: seats, seedCommitHash }),
    );
  }

  private seatsOf(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT agent_id FROM session_players WHERE session_id = ? ORDER BY seat_index`)
      .all(sessionId) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  // ---- polling + acting -----------------------------------------------------

  /** §5 `GET /session/pending-actions`. Legal moves come from the engine only. */
  pendingActions(agentId: string): PendingSession[] {
    this.tick();

    // Includes tables still filling up, so a seated agent can see it is waiting.
    // A settled table drops out of this list — that is the "it is over" signal.
    const rows = this.db
      .prepare(
        `SELECT s.id, s.status FROM sessions s
           JOIN session_players p ON p.session_id = s.id
          WHERE p.agent_id = ? AND s.status IN ('lobby','seated','in_progress')`,
      )
      .all(agentId) as Array<{ id: string; status: 'lobby' | 'seated' | 'in_progress' }>;

    const out: PendingSession[] = [];
    for (const row of rows) {
      const entry = this.live.get(row.id);
      if (!entry) {
        // Seated but not yet dealt: nothing to decide yet.
        out.push({
          sessionId: row.id,
          status: row.status,
          yourTurn: false,
          legalMoves: [],
          deadlineMs: null,
        });
        continue;
      }
      const yourTurn = entry.game.currentAgentId === agentId;
      out.push({
        sessionId: row.id,
        status: 'in_progress',
        yourTurn,
        legalMoves: entry.game.getLegalMoves(agentId),
        deadlineMs: yourTurn ? Math.max(0, entry.deadlineAt - this.clock()) : null,
      });
    }
    return out;
  }

  /** §5 `POST /session/action`, with FR-3.4 idempotency. */
  applyAction(
    agentId: string,
    sessionId: string,
    move: Move,
    reasoning: string,
    idempotencyKey: string,
  ): { accepted: true; resultingEvents: SessionEvent[] } {
    const replayed = this.db
      .prepare(
        `SELECT response_json FROM action_idempotency
          WHERE session_id = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(sessionId, agentId, idempotencyKey) as { response_json: string } | undefined;
    if (replayed) {
      // A retried request must never re-apply the move — return the original result.
      return JSON.parse(replayed.response_json);
    }

    this.tick();

    const entry = this.live.get(sessionId);
    if (!entry) {
      const known = this.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
        | { status: string }
        | undefined;
      if (!known) throw new ApiError(404, 'SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      throw new ApiError(410, 'SESSION_ENDED', `Session ${sessionId} is ${known.status}`);
    }
    if (!this.seatsOf(sessionId).includes(agentId)) {
      throw toApiError(new SessionNotFoundError(`Agent ${agentId} is not seated in ${sessionId}`));
    }

    let events: SessionEvent[];
    try {
      events = entry.game.applyMove(agentId, move, { reasoning });
    } catch (error) {
      throw toApiError(error);
    }

    this.afterMove(sessionId, entry);

    const response = { accepted: true as const, resultingEvents: events };
    this.db
      .prepare(
        `INSERT INTO action_idempotency (session_id, agent_id, idempotency_key, response_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, agentId, idempotencyKey, JSON.stringify(response));
    return response;
  }

  // ---- decision timeout (T10) -----------------------------------------------

  /**
   * Enforce per-decision deadlines across live sessions. Called on every relevant
   * request and, in the server, on an interval — so one unresponsive agent can
   * never stall a table.
   *
   * The auto-action is deliberately the least advantageous legal move: draw if
   * the agent has not drawn yet, otherwise pass, otherwise the first legal play.
   * A silent agent therefore draws-then-passes its way through its turns rather
   * than being handed a good card play.
   */
  tick(): void {
    const now = this.clock();
    for (const [sessionId, entry] of [...this.live]) {
      if (entry.game.isEnded) {
        this.settle(sessionId, entry);
        continue;
      }
      if (now < entry.deadlineAt) continue;

      const agentId = entry.game.currentAgentId;
      if (agentId === null) {
        this.settle(sessionId, entry);
        continue;
      }

      const move = this.autoAction(entry.game, agentId);
      if (move) {
        try {
          entry.game.applyMove(agentId, move, { reasoning: 'auto-action: decision timeout' });
        } catch {
          // The engine refused (e.g. the session just ended); settlement below handles it.
        }
      }
      this.afterMove(sessionId, entry);
    }
  }

  private autoAction(game: GameSession, agentId: string): Move | null {
    const legal = game.getLegalMoves(agentId);
    return (
      legal.find((m) => m.type === 'drawCard') ??
      legal.find((m) => m.type === 'passTurn') ??
      legal[0] ??
      null
    );
  }

  private afterMove(sessionId: string, entry: LiveSession): void {
    if (entry.game.isEnded) {
      this.settle(sessionId, entry);
      return;
    }
    entry.deadlineAt = this.clock() + this.config.decisionTimeoutMs;
  }

  // ---- settlement -----------------------------------------------------------

  /**
   * Finalize a completed session: record the winner and per-seat hand values,
   * hash the event log (the on-chain `result_hash`), and update ratings.
   */
  private settle(sessionId: string, entry: LiveSession): void {
    this.live.delete(sessionId);

    const current = this.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
      | { status: string }
      | undefined;
    if (!current || current.status === 'settled' || current.status === 'archived') return;

    const winner = entry.game.winnerAgentId;
    const handValues = entry.game.getHandValues();
    const resultHash = this.hashEventLog(sessionId);

    const finalize = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions
              SET status = 'settled', winner_agent_id = ?, result_hash = ?, ended_at = datetime('now')
            WHERE id = ?`,
        )
        .run(winner, resultHash, sessionId);

      for (const [agentId, value] of Object.entries(handValues)) {
        this.db
          .prepare(`UPDATE session_players SET final_hand_value = ? WHERE session_id = ? AND agent_id = ?`)
          .run(value, sessionId, agentId);
      }

      this.updateRatings(winner, handValues);
    });
    finalize();

    // Attach point for sub-spec 05 (T13): settle on-chain with the revealed seed
    // and the result hash, now that the outcome is durable.
    const seedReveal =
      (
        this.db.prepare(`SELECT seed_reveal FROM sessions WHERE id = ?`).get(sessionId) as
          | { seed_reveal: string | null }
          | undefined
      )?.seed_reveal ?? null;
    this.fire(() =>
      this.hooks.onSessionSettled?.({
        sessionId,
        winnerAgentId: winner,
        resultHash,
        seedReveal,
        handValues,
      }),
    );
  }

  /**
   * The on-chain `result_hash`: SHA-256 over the canonical `session_events` log.
   * Derived from the log exactly once, here — the same log the replay UI reads,
   * so the two can never disagree (§4).
   */
  private hashEventLog(sessionId: string): string {
    const rows = this.db
      .prepare(
        `SELECT seq, event_type, payload_json FROM session_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as Array<{ seq: number; event_type: string; payload_json: string }>;
    const canonical = rows.map((r) => `${r.seq}|${r.event_type}|${r.payload_json}`).join('\n');
    return createHash('sha256').update(`${sessionId}\n${canonical}`).digest('hex');
  }

  private updateRatings(winner: string | null, handValues: Record<string, number>): void {
    const places = placementsFrom(winner, handValues);
    const seats = Object.keys(places);
    if (seats.length === 0) return;

    const results = seats.map((agentId) => {
      const row = this.getAgent(agentId);
      return {
        agentId,
        rating: { mu: row.trueskill_mu, sigma: row.trueskill_sigma },
        place: places[agentId] ?? seats.length,
      };
    });

    for (const updated of rateSession(results)) {
      this.db
        .prepare(`UPDATE agents SET trueskill_mu = ?, trueskill_sigma = ? WHERE id = ?`)
        .run(updated.rating.mu, updated.rating.sigma, updated.agentId);
    }
  }

  // ---- leaderboard ----------------------------------------------------------

  leaderboard(competitionId: string): Array<{
    agentId: string;
    displayName: string;
    mu: number;
    sigma: number;
    conservativeRating: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.* FROM agents a
           JOIN session_players p ON p.agent_id = a.id
           JOIN sessions s ON s.id = p.session_id
          WHERE s.competition_id = ?`,
      )
      .all(competitionId) as AgentRow[];

    return rows
      .map((r) => ({
        agentId: r.id,
        displayName: r.display_name,
        mu: r.trueskill_mu,
        sigma: r.trueskill_sigma,
        conservativeRating: conservativeRating({ mu: r.trueskill_mu, sigma: r.trueskill_sigma }),
      }))
      .sort((a, b) => b.conservativeRating - a.conservativeRating);
  }

  /** Test/diagnostic helper: is this session still being played in memory? */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
}

export { toApiError };
