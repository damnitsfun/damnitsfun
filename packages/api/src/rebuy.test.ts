import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * Sub-spec 18 (T63–T65) — rebuys, and the netting that keeps them honest.
 *
 * The retrospection's blocker finding was that going broke was permanent: the
 * arena told a busted agent to "win tables to rebuild your balance", which it
 * could not do without a seat. These tests pin the replacement behaviour and,
 * just as importantly, D100 — that granted coins never buy rank.
 */

const ENTRY = 10;
const REBUY = 1000;
const LIMIT = 5;

interface Harness {
  db: Db;
  orchestrator: Orchestrator;
  competitionId: string;
}

function boot(env: Record<string, string> = {}): Harness {
  const config = loadConfig({
    env: {
      TABLE_SIZE: '4',
      STARTING_COINS: '1000',
      PLAYGROUND_ENTRY_COINS: String(ENTRY),
      REBUY_LIMIT: String(LIMIT),
      REBUY_COINS: String(REBUY),
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  const competitionId = orchestrator.createCompetition('Rebuy Playground');
  return { db, orchestrator, competitionId };
}

/** Put an agent on the floor without playing 100 tables to get there. */
function setCoins(db: Db, agentId: string, coins: number): void {
  db.prepare(`UPDATE agents SET coins = ? WHERE id = ?`).run(coins, agentId);
}

describe('rebuys (sub-spec 18)', () => {
  it('grants a fresh stack when a broke agent joins, and says so', async () => {
    const h = boot();
    const { agentId } = h.orchestrator.registerAgent('skint');
    setCoins(h.db, agentId, 3); // cannot cover the 10-coin seat

    const joined = await h.orchestrator.joinSession(agentId, h.competitionId);

    expect(joined.rebuy).toEqual({
      granted: REBUY,
      used: 1,
      remaining: LIMIT - 1,
      balance: 3 + REBUY, // after the grant, before the seat is charged
    });
    // ...and the seat was still paid for out of the new stack.
    expect(h.orchestrator.getAgent(agentId).coins).toBe(3 + REBUY - ENTRY);
  });

  it('says nothing about rebuys on an ordinary join', async () => {
    const h = boot();
    const { agentId } = h.orchestrator.registerAgent('solvent');

    const joined = await h.orchestrator.joinSession(agentId, h.competitionId);

    expect(joined.rebuy).toBeUndefined();
    expect(h.orchestrator.rebuysUsed(agentId, h.competitionId)).toBe(0);
  });

  it('allows exactly LIMIT rebuys, then refuses with a seasonal explanation', async () => {
    const h = boot();
    const { agentId } = h.orchestrator.registerAgent('persistent');

    // Bust and rebuy the full allowance. Each iteration leaves the agent with a
    // seat charged against a fresh stack, so we floor it again to force the next.
    for (let n = 1; n <= LIMIT; n++) {
      setCoins(h.db, agentId, 0);
      const joined = await h.orchestrator.joinSession(agentId, h.competitionId);
      expect(joined.rebuy?.used).toBe(n);
      expect(joined.rebuy?.remaining).toBe(LIMIT - n);
      // Leave the table so the next join is not rejected as "already seated".
      h.db.prepare(`DELETE FROM session_players WHERE agent_id = ?`).run(agentId);
    }

    expect(h.orchestrator.rebuysUsed(agentId, h.competitionId)).toBe(LIMIT);

    setCoins(h.db, agentId, 0);
    await expect(h.orchestrator.joinSession(agentId, h.competitionId)).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_COINS',
    });
    // The refusal must name the remedy — the season rolling — not just the balance.
    await expect(h.orchestrator.joinSession(agentId, h.competitionId)).rejects.toThrow(/season/i);
  });

  it('counts rebuys per season, so a new competition starts the allowance over', async () => {
    const h = boot();
    const { agentId } = h.orchestrator.registerAgent('two-seasons');

    setCoins(h.db, agentId, 0);
    await h.orchestrator.joinSession(agentId, h.competitionId);
    expect(h.orchestrator.rebuysUsed(agentId, h.competitionId)).toBe(1);

    // A competition IS a season (D101) — no reset job, just a new row space.
    const nextSeason = h.orchestrator.createCompetition('Season 2');
    expect(h.orchestrator.rebuysUsed(agentId, nextSeason)).toBe(0);
  });

  it('locks a broke agent out entirely when rebuys are disabled', async () => {
    const h = boot({ REBUY_LIMIT: '0' });
    const { agentId } = h.orchestrator.registerAgent('no-safety-net');
    setCoins(h.db, agentId, 1);

    await expect(h.orchestrator.joinSession(agentId, h.competitionId)).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_COINS',
    });
    expect(h.orchestrator.rebuysUsed(agentId, h.competitionId)).toBe(0);
  });

  /**
   * D100. This is the decision the whole feature rests on: coins are the ranking,
   * so if a rebuy were not netted out, busting would be a way to buy rank.
   */
  describe('net-coin ranking (D100)', () => {
    it('ranks an agent below a rival it out-holds but out-rebought', async () => {
      const h = boot();
      const honest = h.orchestrator.registerAgent('honest');
      const bailed = h.orchestrator.registerAgent('bailed-out');

      // Force one rebuy for `bailed`, none for `honest`.
      setCoins(h.db, bailed.agentId, 0);
      await h.orchestrator.joinSession(bailed.agentId, h.competitionId);
      await h.orchestrator.joinSession(honest.agentId, h.competitionId);

      // Raw balance now FAVOURS the agent that was bailed out...
      setCoins(h.db, bailed.agentId, 1200);
      setCoins(h.db, honest.agentId, 1100);

      const board = h.orchestrator.leaderboard(h.competitionId);
      const rows = Object.fromEntries(board.map((r) => [r.displayName, r]));

      expect(rows['bailed-out']!.coins).toBeGreaterThan(rows.honest!.coins);
      expect(rows['bailed-out']!.rebuysUsed).toBe(1);
      expect(rows['bailed-out']!.netCoins).toBe(1200 - REBUY);
      expect(rows.honest!.netCoins).toBe(1100);
      // ...but the ORDER follows net, so the rebuy bought no rank.
      expect(board[0]!.displayName).toBe('honest');
    });

    it('reports coins and rebuysUsed alongside net so the arithmetic is visible', async () => {
      const h = boot();
      const { agentId } = h.orchestrator.registerAgent('shown-working');
      setCoins(h.db, agentId, 0);
      await h.orchestrator.joinSession(agentId, h.competitionId);

      const row = h.orchestrator.leaderboard(h.competitionId)[0]!;
      expect(row.netCoins).toBe(row.coins - row.rebuysUsed * REBUY);
    });
  });
});
