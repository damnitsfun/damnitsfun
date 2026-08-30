import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * Sub-spec 22 (T102) — coins belong to the season they were won in.
 *
 * `agents.coins` was a single global integer that both leaderboards read, so each
 * season's standings carried coins won in the other game type. This is the case
 * that was demonstrated on production, reproduced as a fixture:
 *
 *   `coin-carry-probe` played 20 playground tables and exactly ONE tournament
 *   table — which it finished last — and the tournament board ranked it 10th of
 *   20 on a balance that was almost entirely playground. The tournament pool
 *   splits by that order, so the number moved real BNB.
 */

const ENTRY = 10;
const START = 1000;

interface H {
  db: Db;
  o: Orchestrator;
  classic: string;
  tournament: string;
  advance(ms: number): void;
}

function boot(): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '2',
      TABLE_MAX_SIZE: '2',
      STARTING_COINS: String(START),
      PLAYGROUND_ENTRY_COINS: String(ENTRY),
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '1', // every table resolves on the clock, deterministically
      MIN_RANKED_SESSIONS: '1',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  const classic = o.createCompetition('Playground');
  const tournament = o.createCompetition('Championship');
  db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(tournament);
  return { db, o, classic, tournament, advance: (ms) => { clock += ms; } };
}

async function playTable(h: H, competitionId: string, a: string, b: string): Promise<void> {
  await h.o.joinSession(a, competitionId);
  await h.o.joinSession(b, competitionId);
  h.advance(60_000);
  h.o.tick();
}

describe('coins are scoped to a season (D154)', () => {
  it('keeps the two boards independent — the coin-carry-probe case', async () => {
    const h = boot();
    const probe = h.o.registerAgent('coin-carry-probe').agentId;
    const rival = h.o.registerAgent('rival').agentId;
    for (const id of [probe, rival]) await h.o.enterCompetition(id, h.tournament);

    // A long playground record...
    for (let i = 0; i < 8; i++) await playTable(h, h.classic, probe, rival);
    // ...and exactly one tournament table.
    await playTable(h, h.tournament, probe, rival);

    const onClassic = h.o.leaderboard(h.classic).find((r) => r.agentId === probe)!;
    const onTournament = h.o.leaderboard(h.tournament).find((r) => r.agentId === probe)!;

    // The tournament row is built from the ONE table played there, so it sits
    // within a single table's swing of the starting stack however the playground
    // record went. Before D154 both rows showed the same global number.
    expect(onTournament.tables).toBe(1);
    expect(Math.abs(onTournament.coins - START)).toBeLessThanOrEqual(ENTRY);
    expect(onClassic.tables).toBe(8);
    expect(onClassic.coins).not.toBe(onTournament.coins);
  });

  it('does not put a playground-only agent on the tournament board at all', async () => {
    const h = boot();
    const grinder = h.o.registerAgent('playground-only').agentId;
    const rival = h.o.registerAgent('rival').agentId;
    for (let i = 0; i < 5; i++) await playTable(h, h.classic, grinder, rival);

    // Entering is not playing — the board is membership by seat taken, and the
    // production probe confirmed entry alone does not list you.
    await h.o.enterCompetition(grinder, h.tournament);
    expect(h.o.leaderboard(h.tournament).map((r) => r.agentId)).not.toContain(grinder);
  });

  it('starts every season at the same stack, whatever was won elsewhere', async () => {
    const h = boot();
    const rich = h.o.registerAgent('rich').agentId;
    const rival = h.o.registerAgent('rival').agentId;
    for (let i = 0; i < 6; i++) await playTable(h, h.classic, rich, rival);

    // Whatever the playground did, the first tournament seat is bought out of a
    // fresh 1000 — that is what makes the new season a season (D169).
    await h.o.enterCompetition(rich, h.tournament);
    await h.o.joinSession(rich, h.tournament);
    const row = h.db
      .prepare(`SELECT coins FROM competition_agents WHERE competition_id = ? AND agent_id = ?`)
      .get(h.tournament, rich) as { coins: number };
    expect(row.coins).toBe(START - ENTRY);
  });

  it('nets a table to zero inside the season that played it', async () => {
    const h = boot();
    const a = h.o.registerAgent('a').agentId;
    const b = h.o.registerAgent('b').agentId;
    await playTable(h, h.classic, a, b);

    const total = (h.db
      .prepare(`SELECT SUM(coins) AS total FROM competition_agents WHERE competition_id = ?`)
      .get(h.classic) as { total: number }).total;
    expect(total).toBe(2 * START); // zero-sum: the pool went straight back out

    // And the other season never moved.
    const other = h.db
      .prepare(`SELECT COUNT(*) AS n FROM competition_agents WHERE competition_id = ?`)
      .get(h.tournament) as { n: number };
    expect(other.n).toBe(0);
  });

  it('reports a lifetime total that is not either season (D155)', async () => {
    const h = boot();
    const a = h.o.registerAgent('a').agentId;
    const b = h.o.registerAgent('b').agentId;
    for (let i = 0; i < 4; i++) await playTable(h, h.classic, a, b);
    for (const id of [a, b]) await h.o.enterCompetition(id, h.tournament);
    await playTable(h, h.tournament, a, b);

    const balances = h.o.seasonBalances(a);
    expect(Object.keys(balances).sort()).toEqual([h.classic, h.tournament].sort());

    // Opening a second season is not an agent earning another 1000: the seeding
    // stack never reaches the lifetime number, only real deltas do.
    const lifetime = h.o.getAgent(a).coins;
    expect(lifetime).toBeLessThan(2 * START);
    expect(h.o.playgroundCoins(a)).toBe(balances[h.classic]);
  });
});

/**
 * Sub-spec 22 — the state the migration actually lands in.
 *
 * Caught by asking what production looks like the moment the new build starts:
 * seasons in flight, every `coin_delta` on disk, and `competition_agents` empty
 * because it was created seconds ago. The first version answered `STARTING_COINS`
 * for every one of those agents, which flattened a live board to a single number
 * and would have read as "the season was wiped".
 */
describe('an in-flight season that predates the ledger', () => {
  it('keeps its standings when the ledger is empty', async () => {
    const h = boot();
    const a = h.o.registerAgent('veteran').agentId;
    const b = h.o.registerAgent('rival').agentId;
    // An ODD number of tables, so the two agents cannot finish level: every table
    // has exactly one winner, so the win counts differ and so must the totals.
    // A spread is the whole point — a board where everyone already holds the same
    // number could not show the flattening this test exists to catch.
    for (let i = 0; i < 7; i++) await playTable(h, h.classic, a, b);

    const before = h.o.leaderboard(h.classic).map((r) => [r.displayName, r.coins] as const);
    expect(new Set(before.map(([, c]) => c)).size).toBeGreaterThan(1);

    // Exactly what the migration produces: history intact, ledger empty.
    h.db.prepare(`DELETE FROM competition_agents`).run();

    const after = h.o.leaderboard(h.classic).map((r) => [r.displayName, r.coins] as const);
    expect(after).toEqual(before);
  });

  it('does not undo that history on the next join', async () => {
    const h = boot();
    const a = h.o.registerAgent('veteran').agentId;
    const b = h.o.registerAgent('rival').agentId;
    for (let i = 0; i < 6; i++) await playTable(h, h.classic, a, b);
    const earned = h.o.leaderboard(h.classic).find((r) => r.agentId === a)!.coins;
    h.db.prepare(`DELETE FROM competition_agents`).run();

    // Seeding reads the derived balance, so the first seat after the migration is
    // charged against what the agent actually holds — not against a fresh stack.
    await h.o.joinSession(a, h.classic);
    const row = h.db
      .prepare(`SELECT coins FROM competition_agents WHERE competition_id = ? AND agent_id = ?`)
      .get(h.classic, a) as { coins: number };
    expect(row.coins).toBe(earned - ENTRY);
  });

  it('still starts a genuinely new season at the stack', async () => {
    const h = boot();
    const a = h.o.registerAgent('veteran').agentId;
    const b = h.o.registerAgent('rival').agentId;
    for (let i = 0; i < 6; i++) await playTable(h, h.classic, a, b);

    // No seats in the tournament, so the derivation sums nothing and reduces to
    // the stack — D169 without needing to wipe a thing.
    await h.o.enterCompetition(a, h.tournament);
    await h.o.joinSession(a, h.tournament);
    const row = h.db
      .prepare(`SELECT coins FROM competition_agents WHERE competition_id = ? AND agent_id = ?`)
      .get(h.tournament, a) as { coins: number };
    expect(row.coins).toBe(START - ENTRY);
  });
});
