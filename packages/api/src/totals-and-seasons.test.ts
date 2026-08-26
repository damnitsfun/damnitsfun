import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

type Config = ReturnType<typeof loadConfig>;

/**
 * Sub-spec 21 T96.
 *
 * Two of these tests exist because the obvious query is wrong and the wrong
 * answer looks *better* than the right one — a bigger table count, a bigger
 * agent count. Nothing about the output says it is lying, which is exactly why
 * it needs a test rather than a comment.
 *
 * Measured on production before this was written: 25,411 session rows, of which
 * 20,921 were reaped empty lobbies and 4,490 were tables anybody played. And 20
 * registered agents against 15 that had ever taken a seat.
 */
interface H {
  db: Db;
  o: Orchestrator;
  config: Config;
  comp: string;
  advance(ms: number): void;
}

function boot(env: Record<string, string> = {}): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '2',
      TABLE_MAX_SIZE: '2',
      DECISION_TIMEOUT_MS: '5',
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '1',
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  return {
    db,
    o,
    config,
    comp: o.createCompetition('damnits.fun Open'),
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** Seat two agents, run the clock out, and settle — one real, settled table. */
async function playATable(h: H, a: string, b: string, comp = h.comp): Promise<string[]> {
  const one = h.o.registerAgent(a);
  const two = h.o.registerAgent(b);
  await h.o.joinSession(one.agentId, comp);
  await h.o.joinSession(two.agentId, comp);
  h.advance(60_000);
  h.o.tick();
  return [one.agentId, two.agentId];
}

describe('all-time totals (D141–D143)', () => {
  it('counts settled tables — never the session ROWS, which are mostly reaped lobbies', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');

    // A lobby that was opened and reaped without ever dealing. On production this
    // is 82% of the sessions table, so counting rows would report 5.7x the tables
    // anyone actually played — on the single number a visitor reads as activity.
    h.db
      .prepare(
        `INSERT INTO sessions (id, competition_id, status, created_at)
         VALUES ('sess_reaped', @comp, 'archived', '2026-01-01T00:00:00.000Z')`,
      )
      .run({ comp: h.comp });

    const rows = (h.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get() as { n: number }).n;
    const settled = (
      h.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'settled'`).get() as { n: number }
    ).n;

    expect(rows).toBeGreaterThan(settled);       // the trap is live in this fixture
    expect(h.o.totals().tables).toBe(settled);
    expect(h.o.totals().tables).not.toBe(rows);
  });

  it('counts agents that took a seat — not agents that merely hold an API key', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');
    h.o.registerAgent('never-sat-down');   // registered, never joined anything

    expect((h.db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number }).n).toBe(3);
    // The label says agents that JOINED the battleground. Registering is not
    // joining, and counting keys inflates the moment anyone scripts a loop.
    expect(h.o.totals().agents).toBe(2);
  });

  it('counts events from settled sessions only', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');
    const t = h.o.totals();
    expect(t.events).toBeGreaterThan(0);
    expect(t.events).toBe(
      (
        h.db
          .prepare(
            `SELECT COUNT(*) AS n FROM session_events e
               JOIN sessions s ON s.id = e.session_id AND s.status = 'settled'`,
          )
          .get() as { n: number }
      ).n,
    );
  });

  it('is stable across a cache window, and reflects reality once it expires', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');
    const first = h.o.totals();

    // A second settled table, inserted directly rather than played. `playATable`
    // has to advance the clock a full minute to time the seats out, which would
    // expire the cache legitimately and make this assert nothing.
    const third = h.o.registerAgent('third');
    h.db
      .prepare(
        `INSERT INTO sessions (id, competition_id, status, created_at)
         VALUES ('sess_direct', @comp, 'settled', '2026-01-01T00:00:00.000Z')`,
      )
      .run({ comp: h.comp });
    h.db
      .prepare(
        `INSERT INTO session_players (session_id, agent_id, seat_index)
         VALUES ('sess_direct', @agent, 0)`,
      )
      .run({ agent: third.agentId });

    // Inside the window the cached answer is reused. That is the point — every
    // visitor polls this and they all get the same three integers.
    expect(h.o.totals()).toEqual(first);

    h.advance(11_000);                       // past TOTALS_CACHE_MS
    expect(h.o.totals().tables).toBe(first.tables + 1);
    expect(h.o.totals().agents).toBe(3);
  });

  it('serves the totals unauthenticated', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');
    const { app } = buildServer({ db: h.db, orchestrator: h.o, config: h.config });
    const res = await app.inject({ method: 'GET', url: '/api/battleground/stats/totals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: 2, tables: 1, events: expect.any(Number) });
    await app.close();
  });
});

describe('two seasons of a kind (D145–D147)', () => {
  it('lists the NEWEST season first, so a find() lands on the current one', () => {
    const h = boot();
    // Same-millisecond creation is the realistic case for a scripted rollover and
    // the one where an unstable sort shows up, so force distinct timestamps the
    // way real minutes-apart seasons would have them.
    const s2 = h.o.createCompetition('damnits.fun Open S2');
    h.db.prepare(`UPDATE competitions SET created_at = '2026-01-01 00:00:00' WHERE id = ?`).run(h.comp);
    h.db.prepare(`UPDATE competitions SET created_at = '2026-06-01 00:00:00' WHERE id = ?`).run(s2);

    // This is the exact selection every consumer makes — the web's
    // `comps.find(c => c.kind === 'classic')` and the reference agent's
    // `pickCompetition`. Ascending order handed all of them the OLDEST season.
    expect(h.o.publicCompetitions().find((c) => c.kind === 'classic')!.id).toBe(s2);
    expect(h.o.listActiveCompetitions()[0]!.id).toBe(s2);
  });

  it('hides archived seasons by default and reveals them on request', () => {
    const h = boot();
    const s2 = h.o.createCompetition('damnits.fun Open S2');
    h.db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(h.comp);

    const active = h.o.publicCompetitions().map((c) => c.id);
    expect(active).toEqual([s2]);                       // unchanged default

    const all = h.o.publicCompetitions('all');
    expect(all.map((c) => c.id).sort()).toEqual([h.comp, s2].sort());
    expect(all.find((c) => c.id === h.comp)!.status).toBe('archived');
  });

  it('serves archived seasons through ?status=all only', async () => {
    const h = boot();
    h.db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(h.comp);
    const { app } = buildServer({ db: h.db, orchestrator: h.o, config: h.config });

    const dflt = await app.inject({ method: 'GET', url: '/api/battleground/competitions' });
    expect((dflt.json() as { competitions: unknown[] }).competitions).toEqual([]);

    const all = await app.inject({ method: 'GET', url: '/api/battleground/competitions?status=all' });
    expect((all.json() as { competitions: Array<{ id: string }> }).competitions.map((c) => c.id))
      .toEqual([h.comp]);
    await app.close();
  });

  /**
   * The rollover's whole promise. `--reset-coins` rewrites every balance, and the
   * archived season's board must survive that — otherwise "the previous season
   * keeps its standings" is false and the tool destroys the thing it claims to
   * preserve. It survives because the scoped query reconstructs a season's coins
   * from its own `coin_delta` rows rather than reading the live balance.
   */
  it("an archived season's board still ranks correctly after --reset-coins", async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');

    const before = h.o.playgroundStandings(h.comp);
    expect(before.length).toBe(2);
    expect(before[0]!.coins).toBeGreaterThan(before[1]!.coins);  // a real result, not a tie

    // The rollover: archive, and reset every balance to the starting stack.
    h.db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(h.comp);
    h.db.prepare(`UPDATE agents SET coins = ?`).run(h.config.startingCoins);

    const after = h.o.playgroundStandings(h.comp);
    expect(after).toEqual(before);

    // ...and unscoped, every agent is genuinely back to the starting stack, which
    // is what the new season needs to be worth playing.
    for (const row of h.o.playgroundStandings()) {
      expect(row.coins).toBe(h.config.startingCoins);
    }
  });

  /**
   * D147: unscoped, a new season's board silently counts the previous season's
   * games. The web had never passed `competitionId`, so this is the defect the
   * boundary would have shipped with.
   */
  it('scopes a season board to its own games', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');
    const s2 = h.o.createCompetition('damnits.fun Open S2');
    await playATable(h, 'newcomer-a', 'newcomer-b', s2);

    expect(h.o.playgroundStandings(s2).map((r) => r.displayName).sort())
      .toEqual(['newcomer-a', 'newcomer-b']);
    expect(h.o.playgroundStandings(h.comp).map((r) => r.displayName).sort())
      .toEqual(['atlas', 'kestrel']);
    expect(h.o.playgroundStandings().length).toBe(4);   // unscoped is still all-time
  });
});
