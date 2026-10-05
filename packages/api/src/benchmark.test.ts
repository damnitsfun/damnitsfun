import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator, type BenchmarkResponse } from './orchestrator';
import { buildServer } from './server';

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
  const res = await app.inject({ method: 'POST', url: '/api/battleground/register', payload: { displayName } });
  const body = res.json();
  return { agentId: body.agentId, apiKey: body.apiKey };
}

async function seatFour(app: FastifyInstance, competitionId: string, agents: Agent[]): Promise<string> {
  let sessionId = '';
  for (const agent of agents) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/battleground/session/join',
      headers: { 'x-battleground-api-key': agent.apiKey },
      payload: { competitionId },
    });
    sessionId = res.json().sessionId;
  }
  return sessionId;
}

async function playToEnd(
  app: FastifyInstance,
  agents: Agent[],
  sessionId: string,
  reasoningForFirstMove?: string,
): Promise<void> {
  let firstMoveDone = false;
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const pending = (
        await app.inject({
          method: 'GET',
          url: '/api/battleground/session/pending-actions',
          headers: { 'x-battleground-api-key': agent.apiKey },
        })
      ).json().sessions as Array<{ sessionId: string; yourTurn: boolean; legalMoves: any[] }>;
      const mine = pending.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;

      let move = mine.legalMoves.find((m) => m.type === 'playCard') ?? mine.legalMoves[0];
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: 'red' } };
      }
      const reasoning = !firstMoveDone && reasoningForFirstMove ? reasoningForFirstMove : 'benchmark test reasoning';
      const res = await app.inject({
        method: 'POST',
        url: '/api/battleground/session/action',
        headers: { 'x-battleground-api-key': agent.apiKey },
        payload: { sessionId, move, reasoning, idempotencyKey: `${agent.agentId}-${step}` },
      });
      if (res.statusCode === 200) {
        acted = true;
        firstMoveDone = true;
      }
      break;
    }
    if (!acted) break;
  }
}

describe('benchmark endpoints (GET /benchmark/agents & GET /benchmark/dataset)', () => {
  it('serves unauthenticated /benchmark/agents with accurate totals and null winRate for unplayed agents', async () => {
    const { app } = boot();
    const a1 = await register(app, 'Agent Alpha');
    const a2 = await register(app, 'Agent Beta');

    // Both top-level /benchmark/agents and prefixed /api/battleground/benchmark/agents respond identically
    for (const url of ['/benchmark/agents', '/api/battleground/benchmark/agents']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BenchmarkResponse;

      expect(body.totals).toBeDefined();
      expect(body.totals.tables).toBe(0);
      expect(body.totals.agents).toBe(0); // Only seated agents count in totals.agents
      expect(typeof body.generatedAt).toBe('string');
      expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
      expect(body.sampleWindowHours).toBeGreaterThanOrEqual(1);

      expect(body.agents.length).toBe(2);
      const alpha = body.agents.find((a) => a.agentId === a1.agentId)!;
      expect(alpha).toBeDefined();
      expect(alpha.displayName).toBe('Agent Alpha');
      expect(alpha.ownerHandle).toBeNull();
      expect(alpha.played).toBe(0);
      expect(alpha.tablesWon).toBe(0);
      expect(alpha.winRate).toBeNull(); // null when played === 0
      expect(alpha.netCoins).toBe(1000);
      expect(alpha.sampledMoves).toBe(0);
      expect(alpha.timeoutMoves).toBe(0);
      expect(alpha.timeoutRate).toBeNull();
      expect(alpha.reasoningMoves).toBe(0);
      expect(alpha.medianMoveMs).toBeNull();
      expect(alpha.p95MoveMs).toBeNull();
    }
  });

  it('updates played, winRate, sampledMoves, and decision timeouts after a game', async () => {
    const { app, orchestrator } = boot();
    const compId = orchestrator.createCompetition('Benchmark Classic Cup');
    const agents = [
      await register(app, 'Player 1'),
      await register(app, 'Player 2'),
      await register(app, 'Player 3'),
      await register(app, 'Player 4'),
    ];

    const sessionId = await seatFour(app, compId, agents);

    // Play table to completion, stubbing the first move reasoning with an auto-action decision timeout
    await playToEnd(app, agents, sessionId, 'auto-action: decision timeout');

    orchestrator.clearBenchmarkCache();

    const res = await app.inject({ method: 'GET', url: '/benchmark/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BenchmarkResponse;

    expect(body.totals.tables).toBe(1);
    expect(body.totals.agents).toBe(4);
    expect(body.agents.length).toBe(4);

    // Every player in the game played 1 table
    for (const a of body.agents) {
      expect(a.played).toBe(1);
      expect(a.sampledMoves).toBeGreaterThan(0);
      expect(a.reasoningMoves).toBeGreaterThan(0);
    }

    // Exactly one winner with winRate = 1, three with winRate = 0
    const winner = body.agents.find((a) => a.tablesWon === 1)!;
    expect(winner).toBeDefined();
    expect(winner.winRate).toBe(1);

    const losers = body.agents.filter((a) => a.tablesWon === 0);
    expect(losers.length).toBe(3);
    for (const loser of losers) {
      expect(loser.winRate).toBe(0);
    }

    // The agent whose move carried 'auto-action: decision timeout' has timeoutMoves > 0 and timeoutRate
    const timedOutAgent = body.agents.find((a) => a.timeoutMoves > 0)!;
    expect(timedOutAgent).toBeDefined();
    expect(timedOutAgent.timeoutMoves).toBeGreaterThanOrEqual(1);
    expect(timedOutAgent.timeoutRate).toBe(timedOutAgent.timeoutMoves / timedOutAgent.sampledMoves);
    expect(timedOutAgent.timeoutRate).toBeGreaterThan(0);
    expect(timedOutAgent.timeoutRate).toBeLessThanOrEqual(1);
  });

  it('serves GET /benchmark/dataset with proper CSV headers, agent rows, and move details', async () => {
    const { app, orchestrator } = boot();
    const compId = orchestrator.createCompetition('Benchmark CSV Cup');
    const agents = [
      await register(app, 'CSV A'),
      await register(app, 'CSV B'),
      await register(app, 'CSV C'),
      await register(app, 'CSV D'),
    ];

    const sessionId = await seatFour(app, compId, agents);
    await playToEnd(app, agents, sessionId, 'auto-action: decision timeout');

    orchestrator.clearBenchmarkCache();

    const res = await app.inject({ method: 'GET', url: '/benchmark/dataset' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="benchmark-\d{8}\.csv"$/);

    const csv = res.body;
    const [partA, partB] = csv.split('\n\n');
    expect(partA).toBeDefined();
    expect(partB).toBeDefined();

    // Part (a): agent summary
    const partALines = partA!.split('\n');
    expect(partALines[0]).toBe(
      'agentId,displayName,ownerHandle,played,tablesWon,winRate,netCoins,sampledMoves,medianMoveMs,p95MoveMs,timeoutMoves,timeoutRate,reasoningMoves',
    );
    // 4 registered agents = 4 rows in part (a)
    expect(partALines.length - 1).toBe(4);

    // Part (b): moves
    const partBLines = partB!.split('\n');
    expect(partBLines[0]).toBe('sessionId,seq,event_type,agentId,reasoning');
    expect(partBLines.length).toBeGreaterThan(1);

    // Verify move entries contain valid columns
    const firstMove = partBLines[1]!;
    expect(firstMove).toContain(sessionId);
    expect(firstMove).toContain('CARD_PLAYED');
  });

  it('enforces hard cap of 10,000 rows on part (b) of CSV export with truncation comment', async () => {
    const { app, db, orchestrator } = boot();
    const compId = orchestrator.createCompetition('Cap Test Cup');
    const agents = [
      await register(app, 'Cap 1'),
      await register(app, 'Cap 2'),
      await register(app, 'Cap 3'),
      await register(app, 'Cap 4'),
    ];

    const sessionId = await seatFour(app, compId, agents);
    await playToEnd(app, agents, sessionId);

    // Stub 10,050 rows directly in session_events to test 10,000 cap
    const stmt = db.prepare(
      `INSERT INTO session_events (session_id, seq, event_type, payload_json, reasoning, created_at)
       VALUES (?, ?, 'CARD_PLAYED', ?, 'bulk test reasoning', datetime('now'))`,
    );

    const maxSeq = (
      db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM session_events WHERE session_id = ?`).get(sessionId) as {
        m: number;
      }
    ).m;

    db.transaction(() => {
      for (let i = 1; i <= 10050; i++) {
        stmt.run(sessionId, maxSeq + i, JSON.stringify({ agentId: agents[0]!.agentId }));
      }
    })();

    orchestrator.clearBenchmarkCache();

    const res = await app.inject({ method: 'GET', url: '/benchmark/dataset' });
    expect(res.statusCode).toBe(200);

    const csv = res.body;
    expect(csv).toContain('# truncated at 10000 rows (sample window)');

    const [, partB] = csv.split('\n\n');
    const lines = partB!.split('\n');
    expect(lines[0]).toBe('# truncated at 10000 rows (sample window)');
    expect(lines[1]).toBe('sessionId,seq,event_type,agentId,reasoning');

    // Exactly 10,000 data rows
    const dataRows = lines.slice(2).filter((l) => l.trim().length > 0);
    expect(dataRows.length).toBe(10000);
  });
});
