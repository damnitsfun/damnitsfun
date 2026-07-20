import { keccak256, toHex } from 'viem';
import type { ChainResult, SettlementChain } from './chain';
import { DISABLED_CHAIN, createSettlementChain } from './chain';
import { seedAsBytes32, seedCommitment, sessionIdToBytes32 } from './commit';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';
import { createChainHooks } from './settlement';

/**
 * T13 — commit-reveal wiring.
 *
 * Uses a fake chain so the whole path is exercised without a network: the
 * commitment must be published before any move, the reveal must verify against
 * it, and a chain failure must never disturb the off-chain result.
 */

interface Recorded {
  commits: Array<{ sessionId: string; seed: string }>;
  settles: Array<{ sessionId: string; winner: string | null; resultHash: string; seed: string }>;
}

function fakeChain(recorded: Recorded, behaviour: 'ok' | 'fail' | 'throw' = 'ok'): SettlementChain {
  const respond = async (): Promise<ChainResult> => {
    if (behaviour === 'throw') throw new Error('rpc exploded');
    if (behaviour === 'fail') return { ok: false, error: 'reverted' };
    return { ok: true, txHash: `0x${'a'.repeat(64)}` };
  };
  return {
    enabled: true,
    async commitSeed(sessionId, seed) {
      recorded.commits.push({ sessionId, seed });
      return respond();
    },
    async settle(sessionId, winner, resultHash, seed) {
      recorded.settles.push({ sessionId, winner, resultHash, seed });
      return respond();
    },
  };
}

function boot(chain: SettlementChain) {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config, { hooks: createChainHooks(db, chain) });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, orchestrator };
}

async function register(app: any, name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName: name } });
  return { agentId: res.json().agentId, apiKey: res.json().apiKey };
}

async function seatFour(app: any, competitionId: string, agents: Array<{ apiKey: string }>) {
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

async function playToEnd(app: any, agents: Array<{ agentId: string; apiKey: string }>, sessionId: string) {
  for (let step = 0; step < 4000; step++) {
    let acted = false;
    for (const agent of agents) {
      const pending = (
        await app.inject({
          method: 'GET',
          url: '/api/arena/session/pending-actions',
          headers: { 'x-arena-api-key': agent.apiKey },
        })
      ).json().sessions as Array<any>;
      const mine = pending.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;
      let move = mine.legalMoves.find((m: any) => m.type === 'playCard') ?? mine.legalMoves[0];
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: 'red' } };
      }
      const res = await app.inject({
        method: 'POST',
        url: '/api/arena/session/action',
        headers: { 'x-arena-api-key': agent.apiKey },
        payload: { sessionId, move, reasoning: '', idempotencyKey: `${agent.agentId}-${step}` },
      });
      if (res.statusCode === 200) acted = true;
      break;
    }
    if (!acted) break;
  }
}

async function runTable(chain: SettlementChain) {
  const { app, db, orchestrator } = boot(chain);
  const competitionId = orchestrator.createCompetition('Chain Cup');
  const agents = [
    await register(app, 'C1'),
    await register(app, 'C2'),
    await register(app, 'C3'),
    await register(app, 'C4'),
  ];
  const sessionId = await seatFour(app, competitionId, agents);
  return { app, db, sessionId, agents };
}

describe('commit-reveal hashing', () => {
  it('uses one scheme the escrow can verify: keccak256(seedAsBytes32(seed))', () => {
    const seed = 'a-test-seed';
    // Exactly what DamnitsEscrow.settle recomputes from the reveal.
    expect(seedCommitment(seed)).toBe(keccak256(seedAsBytes32(seed)));
    expect(seedAsBytes32(seed)).toBe(keccak256(toHex(seed)));
    expect(seedCommitment(seed)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic and seed-specific', () => {
    expect(seedCommitment('one')).toBe(seedCommitment('one'));
    expect(seedCommitment('one')).not.toBe(seedCommitment('two'));
    expect(sessionIdToBytes32('sess_a')).not.toBe(sessionIdToBytes32('sess_b'));
  });
});

describe('T13 — chain wiring', () => {
  it('commits the seed before any move, and settles with a reveal that verifies', async () => {
    const recorded: Recorded = { commits: [], settles: [] };
    const { app, db, sessionId, agents } = await runTable(fakeChain(recorded));

    // The commitment goes out at deal time, before a single card is played.
    expect(recorded.commits).toHaveLength(1);
    expect(recorded.commits[0]!.sessionId).toBe(sessionId);
    expect(recorded.settles).toHaveLength(0);

    const committed = db.prepare(`SELECT seed_commit_hash FROM sessions WHERE id = ?`).get(sessionId) as {
      seed_commit_hash: string;
    };
    // What we recorded is what the escrow will check the reveal against.
    expect(seedCommitment(recorded.commits[0]!.seed)).toBe(committed.seed_commit_hash);

    await playToEnd(app, agents, sessionId);
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget settle land

    expect(recorded.settles).toHaveLength(1);
    const settle = recorded.settles[0]!;
    expect(settle.sessionId).toBe(sessionId);
    // The revealed seed must reproduce the commitment published before play.
    expect(seedCommitment(settle.seed)).toBe(committed.seed_commit_hash);
    expect(settle.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records tx hashes on the session so the demo can capture them', async () => {
    const recorded: Recorded = { commits: [], settles: [] };
    const { app, db, sessionId, agents } = await runTable(fakeChain(recorded));
    await playToEnd(app, agents, sessionId);
    await new Promise((r) => setImmediate(r));

    const row = db
      .prepare(`SELECT commit_tx_hash, settle_tx_hash FROM sessions WHERE id = ?`)
      .get(sessionId) as { commit_tx_hash: string | null; settle_tx_hash: string | null };
    expect(row.commit_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.settle_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    // ...and are visible on the public spectator record.
    const summary = (await app.inject({ method: 'GET', url: `/api/arena/spectate/session/${sessionId}` })).json();
    expect(summary.commitTxHash).toBe(row.commit_tx_hash);
    expect(summary.settleTxHash).toBe(row.settle_tx_hash);
  });

  it('a failing chain does not disturb the off-chain result', async () => {
    const recorded: Recorded = { commits: [], settles: [] };
    const { app, db, sessionId, agents } = await runTable(fakeChain(recorded, 'fail'));
    await playToEnd(app, agents, sessionId);
    await new Promise((r) => setImmediate(r));

    const row = db
      .prepare(`SELECT status, winner_agent_id, commit_tx_hash, settle_tx_hash FROM sessions WHERE id = ?`)
      .get(sessionId) as Record<string, unknown>;
    expect(row.status).toBe('settled');
    expect(row.winner_agent_id).toBeTruthy();
    // No tx to record, but the game itself is unaffected.
    expect(row.commit_tx_hash).toBeNull();
    expect(row.settle_tx_hash).toBeNull();
  });

  it('a throwing chain does not disturb the off-chain result either', async () => {
    const recorded: Recorded = { commits: [], settles: [] };
    const { app, db, sessionId, agents } = await runTable(fakeChain(recorded, 'throw'));
    await playToEnd(app, agents, sessionId);
    await new Promise((r) => setImmediate(r));

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
    };
    expect(row.status).toBe('settled');
  });

  it('is a clean no-op when the chain is not configured', async () => {
    const hooks = createChainHooks(openDatabase(':memory:'), DISABLED_CHAIN);
    expect(hooks.onSessionStarted).toBeUndefined();
    expect(hooks.onSessionSettled).toBeUndefined();

    const { app, db, sessionId, agents } = await runTable(DISABLED_CHAIN);
    await playToEnd(app, agents, sessionId);
    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
    };
    expect(row.status).toBe('settled');
  });

  it('createSettlementChain stays disabled without an operator key or escrow address', () => {
    const config = loadConfig({ env: {} });
    expect(createSettlementChain(config).enabled).toBe(false);

    const partial = loadConfig({ env: { ESCROW_CONTRACT_ADDRESS: '0xabc' } });
    expect(createSettlementChain(partial).enabled).toBe(false);
  });
});
