import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Delayed-live reasoning feed (`/spectate/live*`).
 *
 * Sub-spec 10's replay-only hardening stays the law for the canonical feed: the
 * settled-only routes still answer 409 for live tables, and those tests live in
 * `spectate.test.ts` untouched. This suite covers the SEPARATE, deliberately
 * poorer live surface: seat identity + redacted event tail + the agent's own
 * published `reasoning`, with the SPECTATOR_DELAY_MS buffer enforced in SQL.
 *
 * The property under test: **no hand face, drawn card, or seed is reachable
 * through the live routes while a table runs** — reasoning is public, cards are
 * not, and the delay holds in SQL, not the client.
 */

interface Agent {
  agentId: string;
  apiKey: string;
}

function boot(overrides: Record<string, string> = {}): {
  app: FastifyInstance;
  db: Db;
  config: Config;
  orchestrator: Orchestrator;
} {
  const config = loadConfig({
    env: {
      DECISION_TIMEOUT_MS: '3000',
      GAME_TIME_LIMIT_MS: '3600000',
      TABLE_SIZE: '4',
      // Test-facing delay small enough to step over inside a test, big enough
      // to prove the SQL window is doing the filtering.
      SPECTATOR_DELAY_MS: '2000',
      ...overrides,
    },
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

/** Drive exactly one turn (the first agent whose turn it is plays its first legal move). */
async function playOneMove(
  app: FastifyInstance,
  agents: Agent[],
  sessionId: string,
  step = 0,
): Promise<{ type: string; reasoning: string } | null> {
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
    const reasoning = 'live test: my reasoning for this exact move';
    const res = await app.inject({
      method: 'POST',
      url: '/api/arena/session/action',
      headers: { 'x-arena-api-key': agent.apiKey },
      // Idempotency keys must be unique per step — a fixed key would make every
      // later move a replayed no-op and the table would never settle.
      payload: { sessionId, move, reasoning, idempotencyKey: `${agent.agentId}-live-${step}` },
    });
    if (res.statusCode === 200) return { type: move.type, reasoning };
    return null;
  }
  return null;
}

/**
 * The TRULY hidden card faces for this session, as exact JSON fragments
 * (`{"symbol":"4","color":"blue"}`): hand faces from the full-information log
 * and drawn cards, MINUS anything the public feed shows anyway — played cards
 * appear verbatim in CARD_PLAYED, which is face-up by design, so a naive
 * symbol-substring check would both false-positive on a public discard and
 * (`"4"` inside an agent id) on any character that happens to be a symbol.
 */
function hiddenCardFragments(db: Db, sessionId: string): { fragments: Set<string>; seeds: Set<string> } {
  const hidden = new Set<string>();
  const played = new Set<string>();
  const seeds = new Set<string>();
  const rows = db
    .prepare(`SELECT payload_json, event_type FROM session_events WHERE session_id = ?`)
    .all(sessionId) as Array<{ payload_json: string; event_type: string }>;
  for (const row of rows) {
    const p = JSON.parse(row.payload_json) as Record<string, any>;
    if (row.event_type === 'CARD_PLAYED') {
      if (p.card) played.add(JSON.stringify(p.card));
      continue; // face-up payload: nothing here is hidden
    }
    for (const hand of Object.values(p.hands ?? {})) {
      for (const card of hand as Array<unknown>) hidden.add(JSON.stringify(card));
    }
    for (const card of (p.cards ?? []) as Array<unknown>) hidden.add(JSON.stringify(card));
    if (typeof p.seedReveal === 'string' && p.seedReveal) seeds.add(p.seedReveal);
    if (typeof p.seed === 'string' && p.seed) seeds.add(p.seed);
  }
  for (const s of played) hidden.delete(s);
  return { fragments: hidden, seeds };
}

describe('delayed-live reasoning feed (the reduced live tail spec 10 deferred)', () => {
  // Full-table play + real-delay steps run past Jest's 5 s default (the settled
  // suite averages ~5 s per full table alone); give the live suite room.
  jest.setTimeout(30000);
  it('lists in-progress tables with safe fields, and omits them once settled', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Live List Cup');
    const agents = [
      await register(app, 'L1'),
      await register(app, 'L2'),
      await register(app, 'L3'),
      await register(app, 'L4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    // While live: listed with lean shape, names present, no settlement-gated fields.
    const list = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/live?competitionId=${competitionId}`,
      })
    ).json() as {
      mode: string;
      delayMs: number;
      sessions: Array<Record<string, unknown> & { sessionId: string }>;
    };
    expect(list.delayMs).toBe(2000);
    const liveSession = list.sessions.find((s) => s.sessionId === sessionId);
    expect(liveSession).toBeDefined();
    expect(list.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    for (const banned of ['seedReveal', 'resultHash', 'settleTxHash', 'hands', 'seed', 'finalHands']) {
      expect(Object.keys(liveSession ?? {})).not.toContain(banned);
    }
    expect((liveSession?.status as string)).not.toBe('settled');

    // Settle the table.
    for (let step = 0; step < 4000; step++) {
      const acted = await playOneMove(app, agents, sessionId, step);
      if (!acted) break;
    }
    const after = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/live?competitionId=${competitionId}`,
      })
    ).json() as { sessions: Array<{ sessionId: string }> };
    expect(after.sessions.some((s) => s.sessionId === sessionId)).toBe(false);
  });

  it('serves redacted events + the agent reasoning, and leaks no card face or seed', async () => {
    // delay 0 here: this test proves REDACTION; the delay window has its own test.
    const { app, db, orchestrator } = boot({ SPECTATOR_DELAY_MS: '0' });
    const competitionId = orchestrator.createCompetition('Live Leak Cup');
    const agents = [
      await register(app, 'L1'),
      await register(app, 'L2'),
      await register(app, 'L3'),
      await register(app, 'L4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);
    const played = await playOneMove(app, agents, sessionId);
    expect(played).not.toBeNull();

    // The hidden info EXISTS in the DB (full-information source of truth)…
    const { fragments, seeds } = hiddenCardFragments(db, sessionId);
    expect(fragments.size).toBeGreaterThan(0);

    // …but the live tail carries reasoning and redacted payloads only.
    const res = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/live/${sessionId}/events`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ seq: number; type: string; payload: any; reasoning: string | null }>; live: boolean; delayMs: number };
    expect(body.live).toBe(true);
    expect(body.delayMs).toBe(0);
    expect(body.events.length).toBeGreaterThan(0);

    const text = res.body;
    // No hidden card face or seed string may appear anywhere in the response.
    for (const fragment of fragments) {
      expect(text).not.toContain(fragment);
    }
    for (const seed of seeds) {
      expect(text).not.toContain(seed);
    }
    // Reasoning IS the point of the feed — it must be readable.
    expect(text).toContain('live test: my reasoning for this exact move');

    // Unknown event types would be skeleton-redacted: assert shape stays narrow.
    for (const ev of body.events) {
      if (ev.type === 'CARD_DRAWN') {
        expect(Object.keys(ev.payload).sort()).toEqual(['agentId', 'count', 'cause', 'handCountAfter'].filter((k) => k in ev.payload).sort());
        expect(ev.payload.cards).toBeUndefined();
        expect(ev.payload.hand).toBeUndefined();
      }
    }
  });

  it('holds events behind the SPECTATOR_DELAY_MS window, enforced by the ISO cutoff', async () => {
    const { app, db, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Live Delay Cup');
    const agents = [
      await register(app, 'D1'),
      await register(app, 'D2'),
      await register(app, 'D3'),
      await register(app, 'D4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);
    // Move 1 — created "now"; with delayMs=2000 it must be withheld.
    const first = await playOneMove(app, agents, sessionId);
    expect(first).not.toBeNull();

    const tailEarly = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/live/${sessionId}/events?since=-1` })
    ).json() as { events: Array<{ seq: number }> };
    expect(tailEarly.events.length).toBe(0);

    // Age every event beyond the delay (same ISO format the store writes), then
    // re-tail: they must appear.
    db.prepare(`UPDATE session_events SET created_at = ? WHERE session_id = ?`).run(
      new Date(Date.now() - 10_000).toISOString(),
      sessionId,
    );
    const tailAged = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/live/${sessionId}/events?since=-1` })
    ).json() as { events: Array<{ seq: number }>; live: boolean };
    expect(tailAged.events.length).toBeGreaterThan(0);

    // Incremental contract: since = last served seq returns nothing new.
    const last = tailAged.events[tailAged.events.length - 1]!.seq;
    const tailIncremental = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/live/${sessionId}/events?since=${last}` })
    ).json() as { events: Array<{ seq: number }> };
    expect(tailIncremental.events.length).toBe(0);
  });

  it('signals live:false once the table finishes (fall back to replay), and 404s unknown ids', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Live End Cup');
    const agents = [
      await register(app, 'E1'),
      await register(app, 'E2'),
      await register(app, 'E3'),
      await register(app, 'E4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);
    for (let step = 0; step < 4000; step++) {
      const acted = await playOneMove(app, agents, sessionId, step);
      if (!acted) break;
    }

    const res = await app.inject({ method: 'GET', url: `/api/arena/spectate/live/${sessionId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[]; live: boolean };
    expect(body.live).toBe(false);
    expect(body.events).toHaveLength(0);

    const missing = await app.inject({ method: 'GET', url: '/api/arena/spectate/live/no-such-id/events' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('SESSION_NOT_FOUND');
  });

  it('the canonical settled routes still reject the live table (sub-spec 10 untouched)', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Boundary Cup');
    const agents = [
      await register(app, 'B1'),
      await register(app, 'B2'),
      await register(app, 'B3'),
      await register(app, 'B4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);
    await playOneMove(app, agents, sessionId);

    // The live routes answer; the settled-only routes must NOT have been relaxed.
    for (const url of [
      `/api/arena/spectate/session/${sessionId}`,
      `/api/arena/spectate/session/${sessionId}/events`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('GAME_IN_PROGRESS');
    }
    const list = await app.inject({ method: 'GET', url: `/api/arena/spectate/sessions?competitionId=${competitionId}` });
    expect((list.json() as { sessions: Array<{ sessionId: string }> }).sessions.some((s) => s.sessionId === sessionId)).toBe(
      false,
    );
  });
});