/**
 * T24 — pooled-tournament demo (sub-spec 08), the counterpart to demo.ts.
 *
 * Runs the whole pooled-tournament path end to end, in one process, against an
 * in-memory database and the DISABLED chain — so it needs no testnet, no funds,
 * and no keys, and proves the orchestration:
 *
 *   1. open a tournament and seed a sponsor prize pool + a Rainbow Storm jackpot
 *   2. register four agents, give each a payout address, and enter them
 *   3. play a season of free tables to completion over the real HTTP stack
 *   4. a Rainbow Storm fires (injected here so the demo is deterministic) and is
 *      captured as the jackpot claim — provably fair against the session's seed
 *   5. close the season, rank the eligible field, and settle: the pool is split
 *      across the top ranks and the jackpot is paid to the storm's triggerer
 *
 * On a real testnet (TOURNAMENT_CONTRACT_ADDRESS + OPERATOR_PRIVATE_KEY set) the
 * same orchestrator methods drive DamnitsTournament instead, and each agent pays
 * its OWN buy-in from its OWN wallet (reference-agent --pay-entry, T19). Here we
 * use a free tournament + a sponsor-seeded pool so the flow runs with no chain.
 *
 * Usage: yarn workspace api demo:tournament
 */
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

const log = (m = '') => process.stdout.write(`${m}\n`);
const AGENTS = ['ada', 'bishop', 'clarke', 'dijkstra'];
const SEASON_TABLES = 3; // enough games for MIN_RANKED_SESSIONS below

interface Agent {
  agentId: string;
  apiKey: string;
  name: string;
}

const authed = (a: Agent) => ({ 'x-arena-api-key': a.apiKey });

async function register(app: FastifyInstance, name: string): Promise<Agent> {
  const res = await app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName: name } });
  const body = res.json();
  return { agentId: body.agentId, apiKey: body.apiKey, name };
}

function chooseMove(legalMoves: Array<Record<string, unknown>>): Record<string, unknown> {
  const move = legalMoves.find((m) => m.type === 'playCard') ?? legalMoves[0]!;
  if (move.type === 'playCard') {
    const card = move.card as { color: string | null; symbol: string };
    if (card.color === null) return { type: 'playCard', card: { ...card, color: 'red' } };
  }
  return move;
}

async function playTable(app: FastifyInstance, agents: Agent[], sessionId: string): Promise<void> {
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const pending = (
        await app.inject({ method: 'GET', url: '/api/arena/session/pending-actions', headers: authed(agent) })
      ).json().sessions as Array<{ sessionId: string; yourTurn: boolean; legalMoves: Array<Record<string, unknown>> }>;
      const mine = pending.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;
      const res = await app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: authed(agent),
        payload: { sessionId, move: chooseMove(mine.legalMoves), reasoning: 'demo', idempotencyKey: `${agent.agentId}-${step}` },
      });
      if (res.statusCode === 200) acted = true;
      break;
    }
    if (!acted) break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig({
    env: {
      ...process.env,
      GAME_TIME_LIMIT_MS: '3600000',
      MIN_RANKED_SESSIONS: '2',
      // Show a full split across the field rather than winner-take-all.
      PAYOUT_FIELD_FRACTION: '1',
    },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  const { app } = buildServer({ db, config, orchestrator });

  log('=== damnits.fun — pooled tournament demo (sub-spec 08) ===\n');

  // 1. Open a free tournament and seed a sponsor pool + jackpot.
  const compId = orchestrator.createTournament('Demo Championship', '0');
  const { pool, jackpot } = await orchestrator.seedTournament(compId, '2500000000000000000', '500000000000000000');
  log(`Opened tournament ${compId}`);
  log(`  sponsor pool : ${pool} wei`);
  log(`  jackpot seed : ${jackpot} wei\n`);

  // 2. Register + enter four agents, each with a distinct payout address, each
  //    claimed by an X-verified owner (sub-spec 09 — claiming is what makes an
  //    agent payout-eligible). The live claim is "Sign in with X"; the demo has no
  //    browser/X, so it simulates a completed claim deterministically.
  const agents: Agent[] = [];
  for (const [i, name] of AGENTS.entries()) {
    const agent = await register(app, name);
    await app.inject({
      method: 'PATCH',
      url: '/api/arena/agent/me',
      headers: authed(agent),
      payload: { payoutAddress: `0x${String(i + 1).repeat(40).slice(0, 40)}` },
    });
    orchestrator.devClaimAgent(agent.agentId, `x_${1000 + i}`, name.toLowerCase());
    const entered = await app.inject({
      method: 'POST',
      url: '/api/arena/competition/enter',
      headers: authed(agent),
      payload: { competitionId: compId },
    });
    log(`  ${name} registered + entered (${entered.json().entered ? 'ok' : 'FAILED'})`);
    agents.push(agent);
  }
  log('');

  // 3. Play a season of free tables.
  let firstSession = '';
  for (let table = 0; table < SEASON_TABLES; table++) {
    let sessionId = '';
    for (const agent of agents) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/arena/session/join',
        headers: authed(agent),
        payload: { competitionId: compId },
      });
      sessionId = res.json().sessionId;
    }
    if (!firstSession) firstSession = sessionId;
    await playTable(app, agents, sessionId);
    const winner = (db.prepare(`SELECT winner_agent_id FROM sessions WHERE id = ?`).get(sessionId) as {
      winner_agent_id: string | null;
    }).winner_agent_id;
    const name = agents.find((a) => a.agentId === winner)?.name ?? 'timeout';
    log(`  table ${table + 1}: ${sessionId} — winner ${name}`);
  }
  log('');

  // 4. A Rainbow Storm fires. Injected into the first table's log so the demo is
  //    deterministic; in a live run the seeded 1-in-100k roll produces it, and the
  //    same commit-revealed seed makes the claim independently checkable.
  const stormBy = agents[1]!;
  const seq = (db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_events WHERE session_id = ?`).get(firstSession) as { n: number }).n;
  db.prepare(`INSERT INTO session_events (session_id, seq, event_type, payload_json) VALUES (?, ?, 'RAINBOW_STORM', ?)`)
    .run(firstSession, seq, JSON.stringify({ agentId: stormBy.agentId, victims: [], drawCount: 6 }));
  orchestrator.captureJackpotFromSession(firstSession);
  log(`Rainbow Storm! ${stormBy.name} triggered it → holds the jackpot claim\n`);

  // 5. Close the season and settle: rank the field by coins, split the pool, pay the jackpot.
  log('Final leaderboard (eligible, by coins):');
  for (const [i, r] of orchestrator.eligibleRanked(compId).entries()) {
    const name = agents.find((a) => a.agentId === r.agentId)?.name ?? r.agentId;
    log(`  #${i + 1}  ${name.padEnd(9)} ${r.coins} coins  (${r.games} games)`);
  }
  log('');

  await orchestrator.closeTournament(compId);
  const settlement = await orchestrator.settleTournament(compId);

  log('Payout (ranking drives the split, dust → rank 1):');
  for (const [i, w] of settlement.winners.entries()) {
    const name = agents.find((a) => a.agentId === w.agentId)?.name ?? w.agentId;
    log(`  #${i + 1}  ${name.padEnd(9)} ${w.amountWei} wei → ${w.payoutAddress}`);
  }
  if (settlement.jackpot) {
    const name = agents.find((a) => a.agentId === settlement.jackpot!.agentId)?.name ?? settlement.jackpot.agentId;
    log(`  jackpot   ${name.padEnd(9)} ${settlement.jackpot.amountWei} wei → ${settlement.jackpot.payoutAddress}`);
  }
  log(`\nresultRoot ${settlement.resultRoot}`);
  log(`settle tx  ${settlement.txHash ?? '(chain disabled — off-chain settlement)'}`);
  log('\n=== demo complete ===');

  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
