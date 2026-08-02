import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';
import type { TournamentChain } from './tournament-chain';

/**
 * Sub-spec 08 — pooled tournament + jackpot, exercised through the real HTTP
 * stack with a fake TournamentChain so entry verification and settlement are
 * deterministic (no live chain). Asserts the money invariants the on-chain
 * contract enforces are the ones the orchestrator actually sends.
 */

interface SettleCall {
  winners: string[];
  amounts: bigint[];
  jackpotWinner: string | null;
  jackpotAmount: bigint;
  resultRoot: string;
}

interface AwardCall {
  competitionId: string;
  winner: string;
  amountWei: string;
  resultHash: string;
  seedReveal: string;
}

interface FakeChain extends TournamentChain {
  settleCalls: SettleCall[];
  awardCalls: AwardCall[];
}

function fakeTournamentChain(): FakeChain {
  const settleCalls: SettleCall[] = [];
  const awardCalls: AwardCall[] = [];
  return {
    enabled: true,
    contractAddress: '0xTOURNEY',
    settleCalls,
    awardCalls,
    async openCompetition() {
      return { ok: true, txHash: '0xopen' };
    },
    async verifyEntry(_competitionId, txHash, expectedWei) {
      // The "wallet" that paid is derived from the txHash so each agent is distinct.
      return { ok: true, payer: `0x${txHash.replace(/[^a-f0-9]/gi, '0').padEnd(40, '0').slice(0, 40)}`, amountWei: expectedWei };
    },
    async seedPool() {
      return { ok: true, txHash: '0xpool' };
    },
    async seedJackpot() {
      return { ok: true, txHash: '0xjackpot' };
    },
    async closeEntries() {
      return { ok: true, txHash: '0xclose' };
    },
    async settleCompetition(_id, winners, amounts, jackpotWinner, jackpotAmount, resultRoot) {
      settleCalls.push({ winners, amounts, jackpotWinner, jackpotAmount, resultRoot });
      return { ok: true, txHash: '0xsettle' };
    },
    async awardJackpot(competitionId, winner, amountWei, resultHash, seedReveal) {
      awardCalls.push({ competitionId, winner, amountWei, resultHash, seedReveal });
      return { ok: true, txHash: '0xaward' };
    },
    async rolloverJackpot() {
      return { ok: true, txHash: '0xroll' };
    },
  };
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
  orchestrator: Orchestrator;
  chain: FakeChain;
  advance(ms: number): void;
}

function boot(overrides: Record<string, string> = {}): Harness {
  const config = loadConfig({
    env: {
      GAME_TIME_LIMIT_MS: '3600000',
      TABLE_SIZE: '4',
      RAINBOW_STORM_CHANCE: '0.00001',
      MIN_RANKED_SESSIONS: '1', // one game qualifies, so tests stay short
      ...overrides,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const chain = fakeTournamentChain();
  const orchestrator = new Orchestrator(db, config, {
    clock: () => clock,
    tournamentChain: chain,
  });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, config, orchestrator, chain, advance: (ms) => (clock += ms) };
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
  const body = res.json();
  return { agentId: body.agentId, apiKey: body.apiKey, displayName };
}

const authed = (agent: Agent) => ({ 'x-arena-api-key': agent.apiKey });

async function setPayout(app: FastifyInstance, agent: Agent, address: string): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: '/api/arena/agent/me',
    headers: authed(agent),
    payload: { payoutAddress: address },
  });
  expect(res.statusCode).toBe(200);
}

async function enter(app: FastifyInstance, agent: Agent, competitionId: string, txHash?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/arena/competition/enter',
    headers: authed(agent),
    payload: txHash ? { competitionId, txHash } : { competitionId },
  });
}

function chooseMove(legalMoves: Array<Record<string, unknown>>): Record<string, unknown> {
  const play = legalMoves.find((m) => m.type === 'playCard');
  const move = play ?? legalMoves[0]!;
  if (move.type === 'playCard') {
    const card = move.card as { color: string | null; symbol: string };
    if (card.color === null) return { type: 'playCard', card: { ...card, color: 'red' } };
  }
  return move;
}

async function pendingFor(app: FastifyInstance, agent: Agent) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/arena/session/pending-actions',
    headers: authed(agent),
  });
  return res.json().sessions as Array<{ sessionId: string; yourTurn: boolean; legalMoves: Array<Record<string, unknown>> }>;
}

async function playToEnd(h: Harness, agents: Agent[], sessionId: string): Promise<void> {
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const mine = (await pendingFor(h.app, agent)).find((s) => s.sessionId === sessionId);
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
      if (res.statusCode === 200) acted = true;
      break;
    }
    if (!acted) break;
  }
}

/** Register 4 agents, give each a distinct payout address, enter + seat them. */
async function enterAndSeat(h: Harness, competitionId: string): Promise<{ agents: Agent[]; sessionId: string }> {
  const agents: Agent[] = [];
  for (let i = 0; i < 4; i++) {
    const agent = await register(h.app, `agent-${i}`);
    await setPayout(h.app, agent, `0x${String(i + 1).repeat(40).slice(0, 40)}`);
    // Claiming (X-verified owner) is now required to be payout-eligible (sub-spec 09).
    h.orchestrator.devClaimAgent(agent.agentId, `x_${i}`, `agent_${i}`);
    const res = await enter(h.app, agent, competitionId, `0xtx${i}`);
    expect(res.statusCode).toBe(200);
    agents.push(agent);
  }
  let sessionId = '';
  for (const agent of agents) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId },
    });
    expect(res.statusCode).toBe(200);
    sessionId = res.json().sessionId;
  }
  return { agents, sessionId };
}

describe('T22 — competition entry gate', () => {
  it('a paid tournament answers 402 with the tournament contract until entered', async () => {
    const h = boot();
    const compId = h.orchestrator.createTournament('Main Event', '500000000000000');
    const agent = await register(h.app, 'gate-tester');

    // enter with no txHash → 402 naming the tournament contract + amount + competitionId.
    const noPay = await enter(h.app, agent, compId);
    expect(noPay.statusCode).toBe(402);
    const body = noPay.json();
    expect(body.paymentRequired).toMatchObject({
      chainId: 97,
      contractAddress: '0xTOURNEY',
      amountWei: '500000000000000',
      competitionId: compId,
    });

    // joining a table before entering is refused.
    const earlyJoin = await h.app.inject({
      method: 'POST',
      url: '/api/arena/session/join',
      headers: authed(agent),
      payload: { competitionId: compId },
    });
    expect(earlyJoin.statusCode).toBe(402);
    expect(earlyJoin.json().error).toBe('ENTRY_REQUIRED');

    // enter with a txHash → verified, entered, and now allowed to join.
    const paid = await enter(h.app, agent, compId, '0xdeadbeef');
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ entered: true });
    expect(h.orchestrator.isEntered(agent.agentId, compId)).toBe(true);
  });

  it('a free tournament auto-enters with no payment (D13)', async () => {
    const h = boot();
    const compId = h.orchestrator.createTournament('Playground', '0');
    const agent = await register(h.app, 'free-player');
    const res = await enter(h.app, agent, compId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entered: true });
    expect(h.orchestrator.isEntered(agent.agentId, compId)).toBe(true);
  });

  it('buy-ins accumulate into the mirrored pool', async () => {
    const h = boot();
    const compId = h.orchestrator.createTournament('Pool Test', '500000000000000');
    for (let i = 0; i < 3; i++) {
      const agent = await register(h.app, `p-${i}`);
      await enter(h.app, agent, compId, `0xtx${i}`);
    }
    const pool = (h.db.prepare(`SELECT pool_wei FROM competitions WHERE id = ?`).get(compId) as { pool_wei: string }).pool_wei;
    expect(pool).toBe((500000000000000n * 3n).toString());
  });
});

describe('T22 — pooled settlement (ranking drives payout)', () => {
  it('winner-take-all in a small field, distributing the whole pool', async () => {
    // Explicit 0.2 fraction: the default is now 1.0 (pay the top 10), so pin the
    // small-fraction path that yields a single paid rank here.
    const h = boot({ PAYOUT_FIELD_FRACTION: '0.2' });
    const compId = h.orchestrator.createTournament('Small Field', '500000000000000');
    const { agents, sessionId } = await enterAndSeat(h, compId);
    await playToEnd(h, agents, sessionId);

    const settlement = await h.orchestrator.settleTournament(compId);

    // ceil(0.2 * 4) = 1 paid rank → the whole pool to the top agent.
    expect(settlement.winners).toHaveLength(1);
    expect(settlement.winners[0]!.amountWei).toBe((500000000000000n * 4n).toString());
    expect(h.chain.settleCalls).toHaveLength(1);
    const call = h.chain.settleCalls[0]!;
    expect(call.amounts.reduce((s, a) => s + a, 0n)).toBe(500000000000000n * 4n);
    expect(call.resultRoot).toMatch(/^0x[0-9a-f]{64}$/);

    // competition is marked settled with the tx hash.
    const row = h.db.prepare(`SELECT status, settle_tx_hash FROM competitions WHERE id = ?`).get(compId) as {
      status: string;
      settle_tx_hash: string;
    };
    expect(row.status).toBe('settled');
    expect(row.settle_tx_hash).toBe('0xsettle');
  });

  it('pays the whole eligible field when the fraction is 1, summing to the pool', async () => {
    const h = boot({ PAYOUT_FIELD_FRACTION: '1' });
    const compId = h.orchestrator.createTournament('Full Split', '500000000000000');
    const { agents, sessionId } = await enterAndSeat(h, compId);
    await playToEnd(h, agents, sessionId);

    const settlement = await h.orchestrator.settleTournament(compId);
    expect(settlement.winners).toHaveLength(4); // ceil(1 * 4)
    const total = settlement.winners.reduce((s, w) => s + BigInt(w.amountWei), 0n);
    expect(total).toBe(500000000000000n * 4n); // exact — dust folded into rank 1
    // strictly descending prize amounts
    const amounts = settlement.winners.map((w) => BigInt(w.amountWei));
    for (let i = 1; i < amounts.length; i++) expect(amounts[i - 1]! > amounts[i]!).toBe(true);
  });

  it('excludes agents below MIN_RANKED_SESSIONS from the payout', async () => {
    const h = boot({ MIN_RANKED_SESSIONS: '5', PAYOUT_FIELD_FRACTION: '1' });
    const compId = h.orchestrator.createTournament('High Bar', '500000000000000');
    const { agents, sessionId } = await enterAndSeat(h, compId);
    await playToEnd(h, agents, sessionId); // only 1 game each < 5

    const ranked = h.orchestrator.eligibleRanked(compId);
    expect(ranked).toHaveLength(0);
    const settlement = await h.orchestrator.settleTournament(compId);
    expect(settlement.winners).toHaveLength(0); // nobody eligible → pool carries
  });
});

describe('T23 — RAINBOWSTORM jackpot', () => {
  it('captures a storm from the event log and pays its triggerer at settlement', async () => {
    const h = boot({ PAYOUT_FIELD_FRACTION: '1' });
    const compId = h.orchestrator.createTournament('Stormy', '500000000000000');
    await h.orchestrator.seedTournament(compId, '0', '50000000000000000');

    const { agents, sessionId } = await enterAndSeat(h, compId);
    await playToEnd(h, agents, sessionId);

    // Inject a Rainbow Storm into the settled session's event log (deterministic,
    // exactly the shape the engine emits) and capture it — provably fair because
    // the storm sits in the same commit-revealed log the resultHash is built from.
    const triggerer = agents[2]!;
    const nextSeq = (
      h.db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_events WHERE session_id = ?`).get(sessionId) as { n: number }
    ).n;
    h.db
      .prepare(
        `INSERT INTO session_events (session_id, seq, event_type, payload_json)
         VALUES (?, ?, 'RAINBOW_STORM', ?)`,
      )
      .run(sessionId, nextSeq, JSON.stringify({ agentId: triggerer.agentId, victims: [], drawCount: 6 }));
    h.orchestrator.captureJackpotFromSession(sessionId);

    const claim = h.db.prepare(`SELECT agent_id FROM jackpot_events WHERE competition_id = ?`).get(compId) as
      | { agent_id: string }
      | undefined;
    expect(claim?.agent_id).toBe(triggerer.agentId);

    const settlement = await h.orchestrator.settleTournament(compId);
    expect(settlement.jackpot).not.toBeNull();
    expect(settlement.jackpot!.agentId).toBe(triggerer.agentId);
    expect(settlement.jackpot!.amountWei).toBe('50000000000000000');
    const call = h.chain.settleCalls[0]!;
    expect(call.jackpotAmount).toBe(50000000000000000n);
    expect(call.jackpotWinner).toBe(settlement.jackpot!.payoutAddress);
  });

  it('keeps only the first storm as the jackpot claim (idempotent capture)', async () => {
    const h = boot({ PAYOUT_FIELD_FRACTION: '1' });
    const compId = h.orchestrator.createTournament('Two Storms', '500000000000000');
    await h.orchestrator.seedTournament(compId, '0', '50000000000000000');
    const { agents, sessionId } = await enterAndSeat(h, compId);
    await playToEnd(h, agents, sessionId);

    const base = (
      h.db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM session_events WHERE session_id = ?`).get(sessionId) as { n: number }
    ).n;
    for (const [i, who] of [agents[1]!, agents[3]!].entries()) {
      h.db
        .prepare(`INSERT INTO session_events (session_id, seq, event_type, payload_json) VALUES (?, ?, 'RAINBOW_STORM', ?)`)
        .run(sessionId, base + i, JSON.stringify({ agentId: who.agentId, victims: [], drawCount: 6 }));
    }
    h.orchestrator.captureJackpotFromSession(sessionId);
    h.orchestrator.captureJackpotFromSession(sessionId); // second call must not overwrite

    const claim = h.db.prepare(`SELECT agent_id FROM jackpot_events WHERE competition_id = ?`).get(compId) as { agent_id: string };
    expect(claim.agent_id).toBe(agents[1]!.agentId); // the earliest seq wins
  });

  it('rolls an untriggered jackpot over to the next competition (D15)', async () => {
    const h = boot({ PAYOUT_FIELD_FRACTION: '1' });
    const first = h.orchestrator.createTournament('Season 1', '500000000000000');
    await h.orchestrator.seedTournament(first, '0', '50000000000000000');
    const { agents, sessionId } = await enterAndSeat(h, first);
    await playToEnd(h, agents, sessionId); // no storm at the default tiny chance

    const settlement = await h.orchestrator.settleTournament(first);
    expect(settlement.jackpot).toBeNull(); // untriggered

    const second = h.orchestrator.createTournament('Season 2', '500000000000000');
    await h.orchestrator.rolloverJackpot(first, second);

    const from = h.db.prepare(`SELECT jackpot_seed_wei FROM competitions WHERE id = ?`).get(first) as { jackpot_seed_wei: string };
    const to = h.db.prepare(`SELECT jackpot_seed_wei FROM competitions WHERE id = ?`).get(second) as { jackpot_seed_wei: string };
    expect(from.jackpot_seed_wei).toBe('0');
    expect(to.jackpot_seed_wei).toBe('50000000000000000');
  });
});
