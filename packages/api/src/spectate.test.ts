import type { SessionEventRecord } from 'engine';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { toSpectatorEvent } from './routes/spectate';
import { buildServer } from './server';

/**
 * Spectator API (sub-spec 06 / T15 support, hardened by sub-spec 10).
 *
 * The event log is full-information by design, so the security property under
 * test is now the arena.dev.fun one: the PUBLIC feed only ever serves FINISHED
 * sessions. While a table is in progress it is absent from the list, is not
 * addressable, and its events answer 409 — there is no redacted live tail to
 * scrape. Once settled, the full log (hands, seed, result hash) is public for
 * replay + verification. The allowlist redaction is tested directly as
 * defense-in-depth.
 */

interface Agent {
  agentId: string;
  apiKey: string;
}

function boot(): { app: FastifyInstance; db: Db; config: Config; orchestrator: Orchestrator } {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, config, orchestrator };
}

async function register(app: FastifyInstance, displayName: string): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName } });
  const body = res.json();
  return { agentId: body.agentId, apiKey: body.apiKey };
}

async function seatFour(app: FastifyInstance, competitionId: string, agents: Agent[]): Promise<string> {
  let sessionId = '';
  for (const agent of agents) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: { 'x-arena-api-key': agent.apiKey },
      payload: { competitionId },
    });
    sessionId = res.json().sessionId;
  }
  return sessionId;
}

async function playToEnd(app: FastifyInstance, agents: Agent[], sessionId: string): Promise<void> {
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const pending = (
        await app.inject({
          method: 'GET',
          url: '/api/arena/session/pending-actions',
          headers: { 'x-arena-api-key': agent.apiKey },
        })
      ).json().sessions as Array<{ sessionId: string; yourTurn: boolean; legalMoves: any[] }>;
      const mine = pending.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;

      let move = mine.legalMoves.find((m) => m.type === 'playCard') ?? mine.legalMoves[0];
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: 'red' } };
      }
      const res = await app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: { 'x-arena-api-key': agent.apiKey },
        payload: { sessionId, move, reasoning: 'spectate test', idempotencyKey: `${agent.agentId}-${step}` },
      });
      if (res.statusCode === 200) acted = true;
      break;
    }
    if (!acted) break;
  }
}

describe('spectator feed — replay-only (sub-spec 10 T30)', () => {
  it('an in-progress session is unlisted, unaddressable, and its events 409', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Scrape Cup');
    const agents = [
      await register(app, 'V1'),
      await register(app, 'V2'),
      await register(app, 'V3'),
      await register(app, 'V4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    // The table is now in progress. It must not appear in the public list.
    const list = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/sessions?competitionId=${competitionId}`,
      })
    ).json() as { sessions: Array<{ sessionId: string }> };
    expect(list.sessions.some((s) => s.sessionId === sessionId)).toBe(false);

    // It is not individually addressable either.
    const summary = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/session/${sessionId}`,
    });
    expect(summary.statusCode).toBe(409);
    expect(summary.json().error).toBe('GAME_IN_PROGRESS');

    // No live tail: the events route serves nothing while the game runs.
    const events = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/session/${sessionId}/events`,
    });
    expect(events.statusCode).toBe(409);
    expect(events.json().error).toBe('GAME_IN_PROGRESS');
  });

  it('no hand face, drawn card, or seed is reachable through any public route while live', async () => {
    const { app, db, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('NoLeak Cup');
    const agents = [
      await register(app, 'N1'),
      await register(app, 'N2'),
      await register(app, 'N3'),
      await register(app, 'N4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    // Drive a draw so a hidden face exists in the log, then confirm it never leaks.
    for (const agent of agents) {
      const pending = (
        await app.inject({
          method: 'GET',
          url: '/api/arena/session/pending-actions',
          headers: { 'x-arena-api-key': agent.apiKey },
        })
      ).json().sessions as Array<{ yourTurn: boolean }>;
      if (!pending.some((s) => s.yourTurn)) continue;
      await app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: { 'x-arena-api-key': agent.apiKey },
        payload: { sessionId, move: { type: 'drawCard' }, reasoning: '', idempotencyKey: 'draw-1' },
      });
      break;
    }

    // The real faces live in the DB (full-information source of truth)…
    const faces = new Set<string>();
    const rows = db
      .prepare(`SELECT payload_json FROM session_events WHERE session_id = ?`)
      .all(sessionId) as Array<{ payload_json: string }>;
    for (const row of rows) {
      const p = JSON.parse(row.payload_json);
      for (const hand of Object.values(p.hands ?? {})) {
        for (const card of hand as Array<{ symbol: string }>) faces.add(card.symbol);
      }
      for (const card of (p.cards ?? []) as Array<{ symbol: string }>) faces.add(card.symbol);
    }
    expect(faces.size).toBeGreaterThan(0); // there IS hidden info to protect

    // …but every public surface 409s while the game is live, leaking none of it.
    for (const url of [
      `/api/arena/spectate/sessions?competitionId=${competitionId}`,
      `/api/arena/spectate/session/${sessionId}`,
      `/api/arena/spectate/session/${sessionId}/events`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      const text = res.body;
      // The list is a 200 that simply omits the live table; the others are 409.
      if (url.endsWith('sessions') || url.includes('?competitionId')) {
        expect(text).not.toContain(sessionId);
      } else {
        expect(res.statusCode).toBe(409);
      }
    }
  });

  it('releases the full log, seed and result hash once settled, and lists it', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Settled Cup');
    const agents = [
      await register(app, 'S1'),
      await register(app, 'S2'),
      await register(app, 'S3'),
      await register(app, 'S4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);
    await playToEnd(app, agents, sessionId);

    // Now listed (finished sessions only, but this one IS finished).
    const list = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/sessions?competitionId=${competitionId}`,
      })
    ).json() as {
      sessions: Array<{ sessionId: string; seats: unknown[]; gameNumber: number | null }>;
    };
    const listed = list.sessions.find((s) => s.sessionId === sessionId);
    expect(listed).toBeDefined();
    expect(listed!.seats).toHaveLength(4);

    const summary = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}` })
    ).json();
    expect(summary.status).toBe('settled');
    expect(summary.seedReveal).toBeTruthy();
    expect(summary.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.winnerAgentId).toBeTruthy();
    // Game number (sub-spec 12 D54): a finished session carries a 1-based index,
    // and the list summary agrees with the single-session summary.
    expect(summary.gameNumber).toBe(1);
    expect(listed!.gameNumber).toBe(1);

    // Coin economy (sub-spec 12 T41): each of the 4 agents started at 1000 and
    // paid the 10-coin buy-in, which is pooled back into the winnings — so coins
    // are only redistributed between seats, never destroyed.
    const standings = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/playground/standings?competitionId=${competitionId}`,
      })
    ).json().standings as Array<{ agentId: string; coins: number; tablesWon: number }>;
    expect(standings).toHaveLength(4);
    // Sorted by coins descending.
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i - 1]!.coins).toBeGreaterThanOrEqual(standings[i]!.coins);
    }
    // Pooled buy-ins ⇒ coins are conserved: the four balances still total 4000.
    const total = standings.reduce((s, r) => s + r.coins, 0);
    expect(total).toBe(4 * 1000);
    // The table winner ended up ahead of the last-place seat, and nobody is negative.
    expect(standings[0]!.coins).toBeGreaterThan(standings[3]!.coins);
    expect(standings.every((r) => r.coins >= 0)).toBe(true);
    // agent/me exposes the balance too.
    const me = (
      await app.inject({
        method: 'GET',
        url: '/api/battleground/agent/me',
        headers: { 'x-battleground-api-key': agents[0]!.apiKey },
      })
    ).json();
    expect(typeof me.coins).toBe('number');

    const body = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}/events` })
    ).json() as { events: Array<{ type: string; payload: any; seq: number }>; settled: boolean };
    expect(body.settled).toBe(true);

    // Full information is now public — this is what replay + verification need.
    const started = body.events.find((e) => e.type === 'SESSION_STARTED')!;
    expect(started.payload.seedReveal).toBeTruthy();
    expect(Object.keys(started.payload.hands)).toHaveLength(4);
    const drawsWithFaces = body.events.filter((e) => e.type === 'CARD_DRAWN' && e.payload.cards);
    expect(drawsWithFaces.length).toBeGreaterThan(0);
    const ended = body.events.find((e) => e.type === 'GAME_ENDED')!;
    expect(ended.payload.finalHands).toBeDefined();

    // Incremental ?since polling still works on the settled replay.
    const lastSeq = body.events[body.events.length - 1]!.seq;
    const tail = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/session/${sessionId}/events?since=${lastSeq}`,
      })
    ).json() as { events: Array<{ seq: number }> };
    expect(tail.events.every((e) => e.seq > lastSeq)).toBe(true);
  });

  it('404s an unknown session on both summary and events', async () => {
    const { app } = boot();
    const summary = await app.inject({ method: 'GET', url: '/api/arena/spectate/session/sess_nope' });
    expect(summary.statusCode).toBe(404);
    const events = await app.inject({
      method: 'GET',
      url: '/api/arena/spectate/session/sess_nope/events',
    });
    expect(events.statusCode).toBe(404);
  });
});

describe('redaction allowlist — fail-safe (sub-spec 10 T31)', () => {
  const rec = (eventType: string, payload: unknown): SessionEventRecord => ({
    sessionId: 'sess_x',
    seq: 0,
    eventType: eventType as SessionEventRecord['eventType'],
    payloadJson: JSON.stringify(payload),
    reasoning: null,
    createdAt: '2026-07-22T00:00:00.000Z',
  });

  it('SESSION_STARTED exposes counts, never faces, and nulls the seed', () => {
    const out = toSpectatorEvent(
      rec('SESSION_STARTED', {
        seats: [{ seatIndex: 0, agentId: 'a' }],
        hands: { a: [{ symbol: '7', color: 'red' }, { symbol: '9', color: 'blue' }], b: [{ symbol: '3' }] },
        seedReveal: 'super-secret-seed',
        discard: { symbol: '5', color: 'green' },
        firstAgentId: 'a',
      }),
      false,
    );
    const p = out.payload as Record<string, any>;
    expect(p.hands).toBeUndefined();
    expect(p.handCounts).toEqual({ a: 2, b: 1 });
    expect(p.seedReveal).toBeNull();
    expect(p.discard).toEqual({ symbol: '5', color: 'green' });
  });

  it('CARD_DRAWN keeps the count but strips the faces', () => {
    const out = toSpectatorEvent(
      rec('CARD_DRAWN', { agentId: 'a', cards: [{ symbol: 'RAINBOW' }], count: 1, cause: 'draw', handCountAfter: 8 }),
      false,
    );
    const p = out.payload as Record<string, any>;
    expect(p.cards).toBeUndefined();
    expect(p.count).toBe(1);
    expect(p.handCountAfter).toBe(8);
  });

  it('CARD_PLAYED is public verbatim (played face-up)', () => {
    const played = { agentId: 'a', card: { symbol: '7', color: 'red' }, chosenColor: 'red', handCountAfter: 6 };
    const out = toSpectatorEvent(rec('CARD_PLAYED', played), false);
    expect(out.payload).toEqual(played);
  });

  it('an UNKNOWN/new event type falls back to a bare skeleton, never the raw payload', () => {
    const out = toSpectatorEvent(
      rec('FUTURE_SECRET_EVENT', { agentId: 'a', secretHand: [{ symbol: '9' }], seed: 'leak-me' }),
      false,
    );
    const p = out.payload as Record<string, any>;
    expect(p).toEqual({ agentId: 'a' });
    expect(p.secretHand).toBeUndefined();
    expect(p.seed).toBeUndefined();
  });

  it('once settled, payloads pass through verbatim (history + verification)', () => {
    const full = { hands: { a: [{ symbol: '7' }] }, seedReveal: 'seed', seats: [] };
    const out = toSpectatorEvent(rec('SESSION_STARTED', full), true);
    expect(out.payload).toEqual(full);
  });
});
