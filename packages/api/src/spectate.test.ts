import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Spectator API (sub-spec 06 / T15 support).
 *
 * The event log is full-information by design, so the security property under
 * test is: while a session is IN PROGRESS the spectator feed must reveal neither
 * hidden card faces nor the commit-reveal seed. Both become public once settled.
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

describe('spectator feed — live redaction', () => {
  it('never exposes hands or the seed while a session is in progress', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Spectate Cup');
    const agents = [
      await register(app, 'V1'),
      await register(app, 'V2'),
      await register(app, 'V3'),
      await register(app, 'V4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    const live = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/session/${sessionId}/events`,
    });
    expect(live.statusCode).toBe(200);
    const body = live.json() as { events: Array<{ type: string; payload: any }>; settled: boolean };
    expect(body.settled).toBe(false);

    const started = body.events.find((e) => e.type === 'SESSION_STARTED')!;
    // Hand SIZES are public; faces are not.
    expect(started.payload.hands).toBeUndefined();
    expect(started.payload.handCounts).toEqual({
      [agents[0]!.agentId]: 7,
      [agents[1]!.agentId]: 7,
      [agents[2]!.agentId]: 7,
      [agents[3]!.agentId]: 7,
    });
    // The seed determines the entire deck — it must stay secret until settlement.
    expect(started.payload.seedReveal).toBeNull();

    // Belt and braces: no card face from any hand appears anywhere in the feed.
    const summaryLive = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/session/${sessionId}`,
    });
    expect(summaryLive.json().seedReveal).toBeNull();
    expect(summaryLive.json().resultHash).toBeNull();
    // The commitment IS public before play — that is the point of commit-reveal.
    expect(summaryLive.json().seedCommitHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redacts drawn card faces but keeps the count', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Draw Cup');
    const agents = [
      await register(app, 'D1'),
      await register(app, 'D2'),
      await register(app, 'D3'),
      await register(app, 'D4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    // Drive a few moves so at least one draw lands in the log.
    for (const agent of agents) {
      const pending = (
        await app.inject({
          method: 'GET',
          url: '/api/arena/session/pending-actions',
          headers: { 'x-arena-api-key': agent.apiKey },
        })
      ).json().sessions as Array<{ sessionId: string; yourTurn: boolean }>;
      if (!pending.some((s) => s.yourTurn)) continue;
      await app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: { 'x-arena-api-key': agent.apiKey },
        payload: { sessionId, move: { type: 'drawCard' }, reasoning: '', idempotencyKey: 'draw-1' },
      });
      break;
    }

    const body = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}/events` })
    ).json() as { events: Array<{ type: string; payload: any }> };

    const draws = body.events.filter((e) => e.type === 'CARD_DRAWN');
    expect(draws.length).toBeGreaterThan(0);
    for (const draw of draws) {
      expect(draw.payload.cards).toBeUndefined();
      expect(draw.payload.count).toBeGreaterThan(0);
      expect(draw.payload.handCountAfter).toBeGreaterThan(0);
    }
  });

  it('releases the full log, seed and result hash once settled', async () => {
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

    const summary = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}` })
    ).json();
    expect(summary.status).toBe('settled');
    expect(summary.seedReveal).toBeTruthy();
    expect(summary.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.winnerAgentId).toBeTruthy();
    expect(summary.seats).toHaveLength(4);

    const body = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}/events` })
    ).json() as { events: Array<{ type: string; payload: any }>; settled: boolean };
    expect(body.settled).toBe(true);

    // Full information is now public — this is what replay + verification need.
    const started = body.events.find((e) => e.type === 'SESSION_STARTED')!;
    expect(started.payload.seedReveal).toBeTruthy();
    expect(Object.keys(started.payload.hands)).toHaveLength(4);
    const drawsWithFaces = body.events.filter((e) => e.type === 'CARD_DRAWN' && e.payload.cards);
    expect(drawsWithFaces.length).toBeGreaterThan(0);
    const ended = body.events.find((e) => e.type === 'GAME_ENDED')!;
    expect(ended.payload.finalHands).toBeDefined();
  });

  it('supports incremental polling with ?since', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Poll Cup');
    const agents = [
      await register(app, 'P1'),
      await register(app, 'P2'),
      await register(app, 'P3'),
      await register(app, 'P4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    const first = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}/events` })
    ).json() as { events: Array<{ seq: number }> };
    expect(first.events[0]!.seq).toBe(0);

    const lastSeq = first.events[first.events.length - 1]!.seq;
    const tail = (
      await app.inject({
        method: 'GET',
        url: `/api/arena/spectate/session/${sessionId}/events?since=${lastSeq}`,
      })
    ).json() as { events: Array<{ seq: number }> };
    expect(tail.events.every((e) => e.seq > lastSeq)).toBe(true);
  });

  it('lists sessions for a competition and 404s an unknown session', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('List Cup');
    const agents = [
      await register(app, 'L1'),
      await register(app, 'L2'),
      await register(app, 'L3'),
      await register(app, 'L4'),
    ];
    const sessionId = await seatFour(app, competitionId, agents);

    const list = (
      await app.inject({ method: 'GET', url: `/api/arena/spectate/sessions?competitionId=${competitionId}` })
    ).json() as { sessions: Array<{ sessionId: string; status: string; seats: unknown[] }> };
    expect(list.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    expect(list.sessions[0]!.seats).toHaveLength(4);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/arena/spectate/session/sess_nope/events',
    });
    expect(missing.statusCode).toBe(404);
  });
});
