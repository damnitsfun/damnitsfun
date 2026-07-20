import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 04 DoD — T8 (schema), T9 (endpoints), T10 (timeout + idempotency),
 * T11 (ranking), exercised through the real HTTP stack via Fastify's inject().
 *
 * No rules logic is asserted here beyond what the engine reports: legal moves
 * always come from `legalMoves` in the API response (NFR-2).
 */

interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
  orchestrator: Orchestrator;
  advance(ms: number): void;
  now(): number;
}

function boot(overrides: Record<string, string> = {}): Harness {
  const config = loadConfig({
    env: {
      DECISION_TIMEOUT_MS: '3000',
      GAME_TIME_LIMIT_MS: '3600000', // don't let the engine's own cap fire in tests
      TABLE_SIZE: '4',
      RAINBOW_STORM_CHANCE: '0.00001',
      ...overrides,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const orchestrator = new Orchestrator(db, config, { clock: () => clock });
  const { app } = buildServer({ db, config, orchestrator });
  return {
    app,
    db,
    config,
    orchestrator,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

interface Agent {
  agentId: string;
  apiKey: string;
  displayName: string;
}

async function register(app: FastifyInstance, displayName: string): Promise<Agent> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/arena/register',
    payload: { displayName },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { agentId: body.agentId, apiKey: body.apiKey, displayName };
}

function authed(agent: Agent) {
  return { 'x-arena-api-key': agent.apiKey };
}

async function pendingFor(app: FastifyInstance, agent: Agent) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/arena/session/pending-actions',
    headers: authed(agent),
  });
  expect(res.statusCode).toBe(200);
  return res.json().sessions as Array<{
    sessionId: string;
    yourTurn: boolean;
    legalMoves: Array<Record<string, unknown>>;
    deadlineMs: number | null;
  }>;
}

/** Choose from the arena's own legalMoves; fill in a colour for wilds. */
function chooseMove(legalMoves: Array<Record<string, unknown>>): Record<string, unknown> {
  const plays = legalMoves.filter((m) => m.type === 'playCard');
  const pick = plays[0] ?? legalMoves[0]!;
  if (pick.type === 'playCard') {
    const card = pick.card as { symbol: string; color: string | null };
    if (card.color === null) return { type: 'playCard', card: { symbol: card.symbol, color: 'red' } };
  }
  return pick;
}

async function seatFourAgents(app: FastifyInstance, competitionId: string, agents: Agent[]) {
  const results = [];
  for (const agent of agents) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId },
    });
    expect(res.statusCode).toBe(200);
    results.push(res.json());
  }
  return results;
}

/** Drive the table over HTTP until nobody has a turn left. */
async function playOverHttp(h: Harness, agents: Agent[], sessionId: string): Promise<number> {
  let moves = 0;
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const sessions = await pendingFor(h.app, agent);
      const mine = sessions.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: authed(agent),
        payload: {
          sessionId,
          move: chooseMove(mine.legalMoves),
          reasoning: `step ${step}`,
          idempotencyKey: `${agent.agentId}-${step}`,
        },
      });
      expect([200, 400, 409, 410]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        moves++;
        acted = true;
      }
      break;
    }
    if (!acted) break;
  }
  return moves;
}

describe('T8 — schema + migrations', () => {
  it('creates every §4 table on a clean database', () => {
    const { db } = boot();
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const table of [
      'agents',
      'competitions',
      'sessions',
      'session_players',
      'session_events',
      'payments',
    ]) {
      expect(names).toContain(table);
    }
  });
});

describe('T9 — agent API endpoints', () => {
  it('serves __introspection without auth', async () => {
    const { app } = boot();
    const res = await app.inject({ method: 'GET', url: '/api/arena/__introspection' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.basePath).toBe('/api/arena');
    expect(body.auth.header).toBe('x-arena-api-key');
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it('rejects unauthenticated calls to protected endpoints', async () => {
    const { app } = boot();
    const res = await app.inject({ method: 'GET', url: '/api/arena/agent/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('returns the api key exactly once, and says so in the body', async () => {
    const { app, db } = boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/arena/register',
      payload: { displayName: 'Solo' },
    });
    const body = res.json();
    expect(body.apiKey).toMatch(/^damnits_sk_/);
    expect(body.notice).toMatch(/once/i);
    // Only a hash is persisted.
    const row = db.prepare(`SELECT api_key_hash FROM agents WHERE id = ?`).get(body.agentId) as {
      api_key_hash: string;
    };
    expect(row.api_key_hash).not.toContain(body.apiKey);
  });

  it('GET + PATCH /agent/me', async () => {
    const { app } = boot();
    const agent = await register(app, 'Patcher');

    const me = await app.inject({ method: 'GET', url: '/api/arena/agent/me', headers: authed(agent) });
    expect(me.json()).toMatchObject({ agentId: agent.agentId, displayName: 'Patcher', payoutAddress: null });

    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/arena/agent/me',
      headers: authed(agent),
      payload: { payoutAddress: address },
    });
    expect(patched.json().payoutAddress).toBe(address);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/arena/agent/me',
      headers: authed(agent),
      payload: { payoutAddress: 'not-an-address' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('402s with the payment shape when an entry fee is unpaid, then admits on retry with txHash', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Paid Cup', '1000000000000000', '0xescrow');
    const agent = await register(h.app, 'Payer');

    const unpaid = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId },
    });
    expect(unpaid.statusCode).toBe(402);
    expect(unpaid.json().paymentRequired).toEqual({
      chainId: h.config.bscChainId,
      contractAddress: '0xescrow',
      amountWei: '1000000000000000',
    });

    const paid = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId, txHash: '0xdeadbeef' },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status).toBe('lobby');
  });

  it('409s when an agent is already seated in an active session', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Free Cup');
    const agent = await register(h.app, 'Doubler');

    await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId },
    });
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId },
    });
    expect(again.statusCode).toBe(409);
  });

  it('plays a full 4-agent game over HTTP: register -> join -> poll -> act -> settle -> leaderboard', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Main Event');
    const agents = [
      await register(h.app, 'Alpha'),
      await register(h.app, 'Bravo'),
      await register(h.app, 'Charlie'),
      await register(h.app, 'Delta'),
    ];

    const joins = await seatFourAgents(h.app, competitionId, agents);
    // §5: status is the agent's seating — 'lobby' while waiting, 'seated' once the
    // table is full and play begins.
    expect(joins.slice(0, 3).every((j) => j.status === 'lobby')).toBe(true);
    expect(joins[3].status).toBe('seated');

    const sessionId = joins[3].sessionId as string;
    const moves = await playOverHttp(h, agents, sessionId);
    expect(moves).toBeGreaterThan(10);

    // The session settled, with a winner and a result hash over the event log.
    const session = h.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
      winner_agent_id: string | null;
      result_hash: string | null;
      seed_commit_hash: string | null;
      ended_at: string | null;
    };
    expect(session.status).toBe('settled');
    expect(session.winner_agent_id).not.toBeNull();
    expect(session.result_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.seed_commit_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.ended_at).not.toBeNull();

    // The event log persisted to session_events, contiguously.
    const events = h.db
      .prepare(`SELECT seq, event_type FROM session_events WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Array<{ seq: number; event_type: string }>;
    expect(events.length).toBeGreaterThan(10);
    events.forEach((e, i) => expect(e.seq).toBe(i));
    expect(events[0]!.event_type).toBe('SESSION_STARTED');
    expect(events[events.length - 1]!.event_type).toBe('GAME_ENDED');

    // Per-seat final hand values recorded.
    const seats = h.db
      .prepare(`SELECT final_hand_value FROM session_players WHERE session_id = ?`)
      .all(sessionId) as Array<{ final_hand_value: number | null }>;
    expect(seats).toHaveLength(4);
    expect(seats.every((s) => s.final_hand_value !== null)).toBe(true);

    // Leaderboard reflects the result.
    const board = await h.app.inject({
      method: 'GET',
      url: `/api/arena/competition/leaderboard?competitionId=${competitionId}`,
      headers: authed(agents[0]!),
    });
    expect(board.statusCode).toBe(200);
    const leaderboard = board.json().leaderboard as Array<{ agentId: string; conservativeRating: number }>;
    expect(leaderboard).toHaveLength(4);
    // Sorted by conservative rating, descending.
    for (let i = 1; i < leaderboard.length; i++) {
      expect(leaderboard[i - 1]!.conservativeRating).toBeGreaterThanOrEqual(
        leaderboard[i]!.conservativeRating,
      );
    }
    // The winner should top the board after a single settled game.
    expect(leaderboard[0]!.agentId).toBe(session.winner_agent_id);
  });

  it('maps engine errors to the §5 status codes', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Errors Cup');
    const agents = [
      await register(h.app, 'E1'),
      await register(h.app, 'E2'),
      await register(h.app, 'E3'),
      await register(h.app, 'E4'),
    ];
    const joins = await seatFourAgents(h.app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;

    // Whoever is NOT on turn gets 409.
    const onTurn = (await Promise.all(agents.map(async (a) => ({ a, s: await pendingFor(h.app, a) }))))
      .find((x) => x.s.some((s) => s.yourTurn))!.a;
    const offTurn = agents.find((a) => a.agentId !== onTurn.agentId)!;

    const notYourTurn = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: authed(offTurn),
      payload: { sessionId, move: { type: 'drawCard' }, reasoning: '', idempotencyKey: 'k-409' },
    });
    expect(notYourTurn.statusCode).toBe(409);
    expect(notYourTurn.json().error).toBe('NOT_YOUR_TURN');

    // passTurn before drawing is illegal -> 400.
    const mustDraw = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: authed(onTurn),
      payload: { sessionId, move: { type: 'passTurn' }, reasoning: '', idempotencyKey: 'k-400' },
    });
    expect(mustDraw.statusCode).toBe(400);
    expect(mustDraw.json().error).toBe('MUST_DRAW_FIRST');

    // Malformed move -> 400 validation.
    const malformed = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: authed(onTurn),
      payload: { sessionId, move: { type: 'teleport' }, reasoning: '', idempotencyKey: 'k-bad' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe('INVALID_REQUEST');
  });
});

describe('T10 — orchestrator: idempotency + decision timeout', () => {
  it('a retried action with the same idempotencyKey does not double-apply', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Idem Cup');
    const agents = [
      await register(h.app, 'I1'),
      await register(h.app, 'I2'),
      await register(h.app, 'I3'),
      await register(h.app, 'I4'),
    ];
    const joins = await seatFourAgents(h.app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;

    const onTurn = (await Promise.all(agents.map(async (a) => ({ a, s: await pendingFor(h.app, a) }))))
      .find((x) => x.s.some((s) => s.yourTurn))!.a;

    const payload = {
      sessionId,
      move: { type: 'drawCard' },
      reasoning: 'first try',
      idempotencyKey: 'retry-me',
    };

    const first = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: authed(onTurn),
      payload,
    });
    expect(first.statusCode).toBe(200);

    const eventsAfterFirst = (
      h.db.prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`).get(sessionId) as {
        n: number;
      }
    ).n;

    const retry = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: authed(onTurn),
      payload,
    });
    expect(retry.statusCode).toBe(200);
    // Same response, and no new events were written.
    expect(retry.json()).toEqual(first.json());
    const eventsAfterRetry = (
      h.db.prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`).get(sessionId) as {
        n: number;
      }
    ).n;
    expect(eventsAfterRetry).toBe(eventsAfterFirst);
  });

  it('an agent that never responds cannot stall the table — auto-action resolves the session', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Stall Cup');
    const agents = [
      await register(h.app, 'S1'),
      await register(h.app, 'S2'),
      await register(h.app, 'S3'),
      await register(h.app, 'S4'),
    ];
    const joins = await seatFourAgents(h.app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;

    // NOBODY acts. Only the clock advances and the sweeper ticks.
    for (let i = 0; i < 4000 && h.orchestrator.isLive(sessionId); i++) {
      h.advance(h.config.decisionTimeoutMs + 1);
      h.orchestrator.tick();
    }

    expect(h.orchestrator.isLive(sessionId)).toBe(false);
    const session = h.db.prepare(`SELECT status, winner_agent_id FROM sessions WHERE id = ?`).get(
      sessionId,
    ) as { status: string; winner_agent_id: string | null };
    expect(session.status).toBe('settled');
    expect(session.winner_agent_id).not.toBeNull();
  });

  it('reports a shrinking deadline to the agent on turn', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Deadline Cup');
    const agents = [
      await register(h.app, 'D1'),
      await register(h.app, 'D2'),
      await register(h.app, 'D3'),
      await register(h.app, 'D4'),
    ];
    const joins = await seatFourAgents(h.app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;

    const found = (await Promise.all(agents.map(async (a) => ({ a, s: await pendingFor(h.app, a) }))))
      .find((x) => x.s.some((s) => s.yourTurn))!;
    const before = found.s.find((s) => s.sessionId === sessionId)!.deadlineMs!;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThanOrEqual(h.config.decisionTimeoutMs);

    h.advance(1000);
    const after = (await pendingFor(h.app, found.a)).find((s) => s.sessionId === sessionId)!.deadlineMs!;
    expect(after).toBeLessThan(before);

    // An agent not on turn gets no deadline.
    const other = agents.find((a) => a.agentId !== found.a.agentId)!;
    const otherView = (await pendingFor(h.app, other)).find((s) => s.sessionId === sessionId)!;
    expect(otherView.yourTurn).toBe(false);
    expect(otherView.deadlineMs).toBeNull();
  });
});

describe('handoff to sub-spec 05 — lifecycle hooks are observable', () => {
  it('fires onSessionStarted with the seed commitment and onSessionSettled with the reveal', async () => {
    const config = loadConfig({
      env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
    });
    const db = openDatabase(':memory:');
    const started: Array<{ sessionId: string; seedCommitHash: string; seatAgentIds: string[] }> = [];
    const settled: Array<{ sessionId: string; resultHash: string; seedReveal: string | null }> = [];
    const orchestrator = new Orchestrator(db, config, {
      hooks: {
        onSessionStarted: (info) => started.push(info),
        onSessionSettled: (info) => settled.push(info),
      },
    });
    const { app } = buildServer({ db, config, orchestrator });
    const h: Harness = { app, db, config, orchestrator, advance: () => {}, now: () => Date.now() };

    const competitionId = orchestrator.createCompetition('Hook Cup');
    const agents = [
      await register(app, 'H1'),
      await register(app, 'H2'),
      await register(app, 'H3'),
      await register(app, 'H4'),
    ];
    const joins = await seatFourAgents(app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;

    // Commit fires before any move — that is when commitSeed() must be sent.
    expect(started).toHaveLength(1);
    expect(started[0]!.sessionId).toBe(sessionId);
    expect(started[0]!.seedCommitHash).toMatch(/^[0-9a-f]{64}$/);
    expect(started[0]!.seatAgentIds).toHaveLength(4);

    await playOverHttp(h, agents, sessionId);

    expect(settled).toHaveLength(1);
    expect(settled[0]!.sessionId).toBe(sessionId);
    expect(settled[0]!.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(settled[0]!.seedReveal).toBeTruthy();
    // The reveal must match the commitment published before play.
    const commit = createHash('sha256').update(settled[0]!.seedReveal!).digest('hex');
    expect(commit).toBe(started[0]!.seedCommitHash);
  });

  it('a throwing hook cannot break a session', async () => {
    const config = loadConfig({
      env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
    });
    const db = openDatabase(':memory:');
    const orchestrator = new Orchestrator(db, config, {
      hooks: {
        onSessionStarted: () => {
          throw new Error('chain is down');
        },
        onSessionSettled: () => {
          throw new Error('chain is still down');
        },
      },
    });
    const { app } = buildServer({ db, config, orchestrator });
    const h: Harness = { app, db, config, orchestrator, advance: () => {}, now: () => Date.now() };

    const competitionId = orchestrator.createCompetition('Outage Cup');
    const agents = [
      await register(app, 'O1'),
      await register(app, 'O2'),
      await register(app, 'O3'),
      await register(app, 'O4'),
    ];
    const joins = await seatFourAgents(app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;
    const moves = await playOverHttp(h, agents, sessionId);

    expect(moves).toBeGreaterThan(10);
    const status = (db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
    }).status;
    expect(status).toBe('settled');
  });
});

describe('T11 — ranking', () => {
  it('orders the leaderboard by conservative rating, winner first', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Rank Cup');
    const agents = [
      await register(h.app, 'R1'),
      await register(h.app, 'R2'),
      await register(h.app, 'R3'),
      await register(h.app, 'R4'),
    ];
    const joins = await seatFourAgents(h.app, competitionId, agents);
    const sessionId = joins[3].sessionId as string;
    await playOverHttp(h, agents, sessionId);

    const winner = (
      h.db.prepare(`SELECT winner_agent_id FROM sessions WHERE id = ?`).get(sessionId) as {
        winner_agent_id: string;
      }
    ).winner_agent_id;

    const board = (
      await h.app.inject({
        method: 'GET',
        url: `/api/arena/competition/leaderboard?competitionId=${competitionId}`,
        headers: authed(agents[0]!),
      })
    ).json().leaderboard as Array<{ agentId: string; mu: number; sigma: number; conservativeRating: number }>;

    // Everyone moved off the 25/8.333 default, and the winner gained the most.
    for (const row of board) {
      expect(row.conservativeRating).toBeCloseTo(row.mu - 3 * row.sigma, 6);
    }
    expect(board[0]!.agentId).toBe(winner);
    expect(board[0]!.mu).toBeGreaterThan(25);
  });
});
