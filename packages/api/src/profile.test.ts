import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { agentProfile, agentTables } from './profile';
import { buildServer } from './server';
import { MIN_TABLES_FOR_STYLE, agentStyle, archetype, type StyleMetrics } from './style';

/**
 * Sub-spec 19, T72–T74 — the public read model behind an agent profile.
 *
 * The load-bearing case is the UNCLAIMED agent with a real history: every agent on
 * production is unclaimed, so that is the normal page, not a degraded one.
 */
type Config = ReturnType<typeof loadConfig>;
interface H { db: Db; o: Orchestrator; config: Config; comp: string; advance(ms: number): void }

function boot(env: Record<string, string> = {}): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3',
      TABLE_MAX_SIZE: '3',
      DECISION_TIMEOUT_MS: '5',
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '1',
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  return { db, o, config, comp: o.createCompetition('Open'), advance: (ms) => { clock += ms; } };
}

/** Play `count` three-seat tables with the same three agents. */
async function playTables(h: H, ids: string[], count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    for (const id of ids) await h.o.joinSession(id, h.comp);
    h.advance(60_000);
    h.o.tick();
  }
}

const register = (h: H, names: string[]): string[] =>
  names.map((n) => h.o.registerAgent(n).agentId);

/**
 * Write a FIXED event log for an agent: `cards` symbols played and `draws` taken,
 * spread across its settled sessions. The orchestrator harness times its tables
 * out (nobody moves), so a style test driven by it would read an empty log — and
 * the spec asks for fixed fixtures here precisely so the same log always yields
 * the same name.
 */
function seedPlay(h: H, agentId: string, cards: string[], draws: number): void {
  const sessions = h.db
    .prepare(`SELECT s.id FROM sessions s JOIN session_players p ON p.session_id = s.id
               WHERE p.agent_id = ? AND s.status = 'settled' ORDER BY s.rowid`)
    .all(agentId) as Array<{ id: string }>;
  const ins = h.db.prepare(
    `INSERT INTO session_events (session_id, seq, event_type, payload_json, reasoning)
     VALUES (?, ?, ?, ?, NULL)`,
  );
  let seq = 5000;
  cards.forEach((symbol, i) => {
    const sid = sessions[i % sessions.length]!.id;
    ins.run(sid, seq++, 'CARD_PLAYED', JSON.stringify({ agentId, card: { symbol, color: 'red' } }));
  });
  for (let i = 0; i < draws; i++) {
    const sid = sessions[i % sessions.length]!.id;
    ins.run(sid, seq++, 'CARD_DRAWN', JSON.stringify({ agentId, cause: 'draw', count: 1 }));
  }
}

/** n copies of a symbol. */
const times = (symbol: string, n: number): string[] => Array.from({ length: n }, () => symbol);

describe('agentProfile', () => {
  it('reads fully for an UNCLAIMED agent — the normal case, not a degraded one', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 3);

    const p = agentProfile(h.db, ids[0]!);
    expect(p.claimed).toBe(false);
    expect(p.ownerHandle).toBeNull();
    expect(p.displayName).toBe('ada');
    expect(p.tables).toBe(3);              // history is NOT withheld from the unclaimed
    expect(p.competitions).toHaveLength(1);
    expect(p.competitions[0]!.tables).toBe(3);
  });

  it('names the owner once claimed', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 1);
    h.o.devClaimAgent(ids[0]!, 'x_1', 'wachidx');

    const p = agentProfile(h.db, ids[0]!);
    expect(p.claimed).toBe(true);
    expect(p.ownerHandle).toBe('wachidx');
  });

  it('renders for an agent that has never played, rather than erroring', () => {
    const h = boot();
    const [id] = register(h, ['newcomer']);
    const p = agentProfile(h.db, id!);
    expect(p.tables).toBe(0);
    expect(p.lastPlayedAt).toBeNull();
    // Sub-spec 22 (D166): the ACTIVE season is listed even with no tables in it,
    // so the page can say "no tables this season" rather than showing nothing and
    // leaving a reader to guess whether the agent is idle or the season is new.
    expect(p.competitions).toHaveLength(1);
    expect(p.competitions[0]).toMatchObject({ tables: 0, tablesWon: 0, active: true });
    expect(p.competitions[0]!.coins).toBeNull(); // no seat taken here yet
  });

  /**
   * Sub-spec 22 (T107/D166) — the state nobody writes a fixture for.
   *
   * An agent that played a season and then stopped is the normal outcome of a
   * rollover: `skill.md` warns that "if your process exits, a new season will not
   * bring it back", and its operator has no other signal that it died. Falling
   * back to the lifetime total here would render that agent as though it were
   * still playing well.
   */
  it('shows an empty CURRENT season beside the season it actually played', async () => {
    const h = boot();
    // Three agents: the table minimum, or nothing ever settles and there is no
    // previous season to be looking at.
    const ids = register(h, ['stopped', 'rival', 'third']);
    await playTables(h, ids, 2);

    // The operator rolls the season while this agent is not running.
    const oldSeason = h.comp;
    h.db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(oldSeason);
    const newSeason = h.o.createCompetition('Season 2');

    const p = agentProfile(h.db, ids[0]!);
    const current = p.competitions.find((c) => c.competitionId === newSeason)!;
    const previous = p.competitions.find((c) => c.competitionId === oldSeason)!;

    expect(current.active).toBe(true);
    expect(current.tables).toBe(0);
    expect(current.coins).toBeNull();
    // The archived season keeps its record — readable, but no longer current.
    expect(previous.active).toBe(false);
    expect(previous.tables).toBe(2);
    // And the lifetime total is a separate number from either of them.
    expect(p.coins).toBeGreaterThan(0);
    expect(p.competitions.some((c) => c.active && c.tables > 0)).toBe(false);
  });

  /** A typo must not look like an agent that never played. */
  it('404s on an unknown id instead of inventing an empty profile', () => {
    const h = boot();
    expect(() => agentProfile(h.db, 'agent_nope')).toThrow(/No agent/);
  });

  it('totals wins and coins per competition', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 4);

    const all = ids.map((id) => agentProfile(h.db, id));
    expect(all.reduce((t, p) => t + p.tablesWon, 0)).toBe(4); // one winner per table
    // Coins are zero-sum across the table (sub-spec 20), so the field nets to zero.
    expect(all.reduce((t, p) => t + (p.competitions[0]!.coinsWon ?? 0), 0)).toBe(0);
  });

  /**
   * "Unknown, not zero" — the same rule `place` and `coinDelta` follow. Tables
   * settled before results were recorded carry a null delta, and reporting them
   * as +0 would claim the agent broke even when nobody knows. Staging has 4 of
   * 240 seats with a recorded result; the other 236 would all have read as clean
   * break-evens.
   */
  it('reports unknown coins as null, never as zero', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 2);
    h.db.prepare(`UPDATE session_players SET coin_delta = NULL`).run();

    const c = agentProfile(h.db, ids[0]!).competitions[0]!;
    expect(c.tables).toBe(2);        // the tables happened...
    expect(c.coinsWon).toBeNull();   // ...but what they paid is not known
  });

  it('reports last activity from taking a SEAT, not from finishing', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 1);
    expect(agentProfile(h.db, ids[0]!).lastPlayedAt).not.toBeNull();
  });
});

describe('agentTables', () => {
  it('returns newest first with placement, coins and how the table ended', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 3);

    const { tables } = agentTables(h.db, ids[0]!);
    expect(tables).toHaveLength(3);
    expect(tables[0]!.seats).toBe(3);
    expect(tables[0]!.place).not.toBeNull();
    expect(tables[0]!.coinDelta).not.toBeNull();
    expect(['empty_hand', 'timeout']).toContain(tables[0]!.reason);
    expect(tables[0]!.opponents).toHaveLength(2);        // the other seats, not itself
    expect(tables[0]!.opponents.map((o) => o.agentId)).not.toContain(ids[0]);
    // Newest first: game numbers descend.
    const numbers = tables.map((t) => t.gameNumber ?? 0);
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);
  });

  /**
   * Paginated from the first version, not "later, when it grows": one production
   * agent had 1,699 settled tables when this was written and the field was two
   * days old.
   */
  it('pages with a cursor that never drops or repeats a table as more settle', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 7);

    const first = agentTables(h.db, ids[0]!, { limit: 3 });
    expect(first.tables).toHaveLength(3);
    expect(first.nextBefore).not.toBeNull();

    const second = agentTables(h.db, ids[0]!, { limit: 3, before: first.nextBefore! });
    expect(second.tables).toHaveLength(3);
    const seen = [...first.tables, ...second.tables].map((t) => t.sessionId);
    expect(new Set(seen).size).toBe(6); // no repeats across the boundary

    const third = agentTables(h.db, ids[0]!, { limit: 3, before: second.nextBefore! });
    expect(third.tables).toHaveLength(1);
    expect(third.nextBefore).toBeNull(); // last page says so
  });

  it('caps the page size so one agent cannot ask for everything', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 2);
    expect(agentTables(h.db, ids[0]!, { limit: 10_000 }).tables.length).toBeLessThanOrEqual(100);
  });

  it('404s on an unknown agent', () => {
    const h = boot();
    expect(() => agentTables(h.db, 'agent_nope')).toThrow(/No agent/);
  });
});

describe('agentStyle', () => {
  it('says nothing rather than inventing a character from a tiny sample', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 2);
    expect(agentStyle(h.db, ids[0]!)).toBeNull();
  });

  /**
   * A rate needs a denominator. An agent that timed out of every table clears the
   * TABLE minimum while having played no cards at all, and every metric is then 0
   * — which the archetype would read, quite confidently, as "sheds quickly,
   * spends few punishers". Found by running this against a real server.
   */
  it('says nothing when the tables happened but no cards were played', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE); // all time out, zero plays
    expect(agentStyle(h.db, ids[0]!)).toBeNull();
  });

  it('reads the rates off the log exactly', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE);
    // 100 cards: 20 punishing, 10 colour-choosing (MEGARAINBOW counts as both).
    seedPlay(h, ids[0]!, [...times('GRAB2', 15), ...times('MEGARAINBOW', 5),
      ...times('RAINBOW', 5), ...times('7', 75)], 25);

    const style = agentStyle(h.db, ids[0]!)!;
    expect(style.metrics.cardsPlayed).toBe(100);
    expect(style.metrics.aggression).toBe(20);    // GRAB2 + MEGARAINBOW
    expect(style.metrics.colourControl).toBe(10); // RAINBOW + MEGARAINBOW
    expect(style.metrics.patience).toBe(20);      // 25 draws of 125 turns
    expect(style.rows).toHaveLength(3);
    // D118: every row the UI shows carries the figure a reader can check.
    for (const row of style.rows) expect(row.detail).toContain(String(row.percent));
  });

  /** A house-rule EVENT, never a card — it must not enter the mix. */
  it('never counts a Rainbow Storm as a played card', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE);
    seedPlay(h, ids[0]!, times('7', 60), 10);
    const before = agentStyle(h.db, ids[0]!)!;

    const sid = (h.db.prepare(`SELECT session_id AS s FROM session_players WHERE agent_id = ? LIMIT 1`)
      .get(ids[0]!) as { s: string }).s;
    h.db.prepare(
      `INSERT INTO session_events (session_id, seq, event_type, payload_json, reasoning)
       VALUES (?, 9999, 'RAINBOW_STORM', ?, NULL)`,
    ).run(sid, JSON.stringify({ agentId: ids[0], victims: [], drawCount: 6 }));

    const after = agentStyle(h.db, ids[0]!)!;
    expect(after.metrics.cardsPlayed).toBe(before.metrics.cardsPlayed); // not a card
    expect(after.metrics.storms).toBe(1);                               // but counted
  });

  /** Same log in, same name out — the archetype is computed, never stored. */
  it('is deterministic', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE);
    seedPlay(h, ids[0]!, times('7', 80), 20);
    expect(agentStyle(h.db, ids[0]!)).toEqual(agentStyle(h.db, ids[0]!));
  });

  const m = (o: Partial<StyleMetrics>): StyleMetrics => ({
    aggression: 0, colourControl: 0, patience: 0, winRate: 0, placeScore: 0.5,
    storms: 0, decisionSeconds: null, cardsPlayed: 100, tables: 30, ...o,
  });

  it('reads the two axes it claims to read', () => {
    expect(archetype(m({ aggression: 30, patience: 30 })).name).toBe('PATIENT & BRUTAL');
    expect(archetype(m({ aggression: 30, patience: 5 })).name).toBe('RELENTLESS');
    expect(archetype(m({ aggression: 5, patience: 30 })).name).toBe('QUIET & MEASURED');
    expect(archetype(m({ aggression: 5, patience: 5 })).name).toBe('FAST & PLAIN');
  });
});

describe('the public routes', () => {
  const serve = (h: H) => buildServer({ db: h.db, orchestrator: h.o, config: h.config }).app;

  it('serves a profile with no API key at all', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 1);

    const app = serve(h);
    const res = await app.inject({ method: 'GET', url: `/api/battleground/agent/${ids[0]}/profile` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { profile: { displayName: string }; style: unknown };
    expect(body.profile.displayName).toBe('ada');
    expect(body.style).toBeNull(); // one table is below the sample minimum
    await app.close();
  });

  /**
   * The one collision this spec could introduce. `/agent/me` is two segments and
   * the profile routes are three, so they cannot clash today — but a future bare
   * `GET /agent/:agentId` WOULD swallow `me`, so this is pinned rather than
   * trusted to a careful reading.
   */
  it('does not capture the authenticated /agent/me', async () => {
    const h = boot();
    const agent = h.o.registerAgent('mine');
    const app = serve(h);

    const me = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { agentId: string }).agentId).toBe(agent.agentId);

    // And unauthenticated it must still be the AUTH route answering, not a profile.
    const anon = await app.inject({ method: 'GET', url: '/api/battleground/agent/me' });
    expect(anon.statusCode).toBe(401);
    await app.close();
  });

  it('404s an unknown agent through the route, not 500', async () => {
    const h = boot();
    const app = serve(h);
    const res = await app.inject({ method: 'GET', url: '/api/battleground/agent/agent_nope/profile' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('AGENT_NOT_FOUND');
    await app.close();
  });

  it('redirects the old /profile/:id trap to the agent profile (D113)', async () => {
    const h = boot();
    const app = serve(h);
    const res = await app.inject({ method: 'GET', url: '/profile/agent_abc' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/agent/agent_abc');
    await app.close();
  });

  it('serves the app shell at /agent/:agentId', async () => {
    const h = boot();
    const app = serve(h);
    const res = await app.inject({ method: 'GET', url: '/agent/agent_abc' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    await app.close();
  });

  /** T81/D127: an agent should be able to tell its owner where to watch it. */
  it('hands the agent its own profile URL on /agent/me', async () => {
    const h = boot();
    const agent = h.o.registerAgent('linkable');
    const app = serve(h);
    const res = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    const body = res.json() as { profileUrl: string };
    // The PAGE, not the API endpoint — building it from the API prefix would have
    // handed the owner a JSON document.
    expect(body.profileUrl).toMatch(new RegExp(`/agent/${agent.agentId}$`));
    expect(body.profileUrl).not.toContain('/api/');
    await app.close();
  });

  it('pages the table history over HTTP', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, 4);
    const app = serve(h);
    const res = await app.inject({
      method: 'GET',
      url: `/api/battleground/agent/${ids[0]}/tables?limit=2`,
    });
    const body = res.json() as { tables: unknown[]; nextBefore: string | null };
    expect(body.tables).toHaveLength(2);
    expect(body.nextBefore).not.toBeNull();
    await app.close();
  });
});
