import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { compareRank, normalisedPlace, type RankStats } from './ranking';

/**
 * Sub-spec 20 T86 — the tie-break that decides money.
 *
 * `eligibleRanked` is the payout order: the curve pays place 1 more than place 2,
 * so two agents tied on net coins are separated by real BNB. Until this, the tie
 * fell straight through to `agentId` — a string comparison. That was tolerable
 * while coin deltas spanned hundreds; sub-spec 20 bounds them to a handful of
 * integers, and ~29% of agents then share a total after ~50 tables each.
 */
const stat = (o: Partial<RankStats> & { agentId: string }): RankStats => ({
  netCoins: 0,
  tablesWon: 0,
  placeScore: 0.5,
  ...o,
});

describe('normalisedPlace', () => {
  it('is 0 for first and 1 for last, whatever the table size', () => {
    for (const n of [3, 4, 5, 6]) {
      expect(normalisedPlace(1, n)).toBe(0);
      expect(normalisedPlace(n, n)).toBe(1);
    }
  });

  /**
   * The reason a raw mean place is not usable. On the real corpus the agent with
   * the BEST normalised score sits 6th of 8 by raw mean — purely because it plays
   * 4–6 seat tables, where every finish below first carries a bigger number.
   */
  it('does not punish an agent for sitting at a fuller table', () => {
    expect(normalisedPlace(3, 6)).toBeLessThan(normalisedPlace(3, 3));
    expect(normalisedPlace(3, 3)).toBe(1);   // 3rd of 3 is LAST
    expect(normalisedPlace(3, 6)).toBe(0.4); // 3rd of 6 is upper-middle
  });

  it('says nothing rather than dividing by zero on a one-seat table', () => {
    expect(normalisedPlace(1, 1)).toBe(0);
  });
});

describe('compareRank', () => {
  it('ranks by net coins before anything else', () => {
    const a = stat({ agentId: 'a', netCoins: 10, tablesWon: 0, placeScore: 1 });
    const b = stat({ agentId: 'b', netCoins: 9, tablesWon: 99, placeScore: 0 });
    expect([b, a].sort(compareRank)[0]!.agentId).toBe('a');
  });

  it('breaks a coin tie on tables won, not on the id', () => {
    // 'z' would lose on id alone; it has more outright wins, so it must lead.
    const a = stat({ agentId: 'a', netCoins: 100, tablesWon: 1 });
    const z = stat({ agentId: 'z', netCoins: 100, tablesWon: 5 });
    expect([a, z].sort(compareRank).map((x) => x.agentId)).toEqual(['z', 'a']);
  });

  it('breaks a coins+wins tie on finishing position', () => {
    const a = stat({ agentId: 'a', netCoins: 100, tablesWon: 3, placeScore: 0.7 });
    const z = stat({ agentId: 'z', netCoins: 100, tablesWon: 3, placeScore: 0.2 });
    expect([a, z].sort(compareRank).map((x) => x.agentId)).toEqual(['z', 'a']);
  });

  it('sorts "no games" last — no evidence is not the same as finishing badly', () => {
    const played = stat({ agentId: 'a', netCoins: 100, tablesWon: 0, placeScore: 0.9 });
    const never = stat({ agentId: 'b', netCoins: 100, tablesWon: 0, placeScore: null });
    expect([never, played].sort(compareRank).map((x) => x.agentId)).toEqual(['a', 'b']);
  });

  it('reaches the id only when the record is genuinely identical', () => {
    const b = stat({ agentId: 'b', netCoins: 100, tablesWon: 2, placeScore: 0.5 });
    const a = stat({ agentId: 'a', netCoins: 100, tablesWon: 2, placeScore: 0.5 });
    expect([b, a].sort(compareRank).map((x) => x.agentId)).toEqual(['a', 'b']);
  });

  it('is reproducible across repeated sorts', () => {
    const rows = ['d', 'a', 'c', 'b'].map((id, i) =>
      stat({ agentId: id, netCoins: 100, tablesWon: i % 2 }),
    );
    const once = [...rows].sort(compareRank).map((x) => x.agentId);
    expect([...rows].sort(compareRank).map((x) => x.agentId)).toEqual(once);
    // Same set, opposite input order — the result must not depend on it.
    const backwards = [...rows].sort((x, y) => (x.agentId < y.agentId ? 1 : -1));
    expect(backwards.sort(compareRank).map((x) => x.agentId)).toEqual(once);
  });
});

// ---------------------------------------------------------------------------

interface H { db: Db; o: Orchestrator; comp: string; advance(ms: number): void }

function boot(): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '2',
      TABLE_MAX_SIZE: '2',
      DECISION_TIMEOUT_MS: '5',
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '1',
      MIN_RANKED_SESSIONS: '1',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  const comp = o.createCompetition('Tie Cup');
  db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(comp);
  return { db, o, comp, advance: (ms) => { clock += ms; } };
}

async function playTable(h: H, a: string, b: string): Promise<void> {
  await h.o.joinSession(a, h.comp);
  await h.o.joinSession(b, h.comp);
  h.advance(60_000);
  h.o.tick();
}

describe('the board and the payout agree', () => {
  it('orders eligibleRanked and leaderboard identically', async () => {
    const h = boot();
    const ids: string[] = [];
    for (const name of ['alpha', 'bravo']) {
      const reg = h.o.registerAgent(name);
      ids.push(reg.agentId);
      await h.o.enterCompetition(reg.agentId, h.comp);
      h.o.devClaimAgent(reg.agentId, `x_${name}`, name);
      h.o.setPayoutAddress(reg.agentId, `0x${name.padEnd(40, '0')}`);
    }
    await playTable(h, ids[0]!, ids[1]!);

    const paid = h.o.eligibleRanked(h.comp).map((r) => r.agentId);
    const shown = h.o.leaderboard(h.comp).map((r) => r.agentId);
    expect(paid).toHaveLength(2);
    // A public board that led with a different agent than settlement pays is the
    // failure these two share a comparator to prevent.
    expect(shown.filter((id) => paid.includes(id))).toEqual(paid);
  });

  it('computes placeScore in SQL exactly as normalisedPlace does in TS', async () => {
    const h = boot();
    const ids: string[] = [];
    for (const name of ['ceres', 'davis']) {
      const reg = h.o.registerAgent(name);
      ids.push(reg.agentId);
      await h.o.enterCompetition(reg.agentId, h.comp);
    }
    await playTable(h, ids[0]!, ids[1]!);

    const board = h.o.leaderboard(h.comp);
    for (const row of board) {
      const seats = h.db
        .prepare(
          `SELECT p.place AS place, s.table_size AS size
             FROM session_players p JOIN sessions s ON s.id = p.session_id
            WHERE p.agent_id = ? AND s.status = 'settled' AND s.competition_id = ?`,
        )
        .all(row.agentId, h.comp) as Array<{ place: number; size: number }>;
      const expected =
        seats.length === 0
          ? null
          : seats.reduce((sum, x) => sum + normalisedPlace(x.place, x.size), 0) / seats.length;
      if (expected === null) expect(row.placeScore).toBeNull();
      else expect(row.placeScore).toBeCloseTo(expected, 10);
    }
  });

  it('does not count an abandoned lobby as a game', async () => {
    const h = boot();
    const reg = h.o.registerAgent('lonely');
    await h.o.enterCompetition(reg.agentId, h.comp);
    await h.o.joinSession(reg.agentId, h.comp); // sits alone; never deals
    h.advance(10 * 60_000);
    h.o.tick(); // reaper closes it

    const row = h.o.leaderboard(h.comp).find((r) => r.agentId === reg.agentId);
    if (row) {
      expect(row.tablesWon).toBe(0);
      expect(row.placeScore).toBeNull(); // no settled table => no finishing position
    }
  });
});
