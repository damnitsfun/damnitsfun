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
    expect(p.competitions).toEqual([]);
    expect(p.lastPlayedAt).toBeNull();
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
    expect(all.reduce((t, p) => t + p.competitions[0]!.coinsWon, 0)).toBe(0);
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

  it('names a style once there is a sample, and shows the numbers behind it', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE);

    const style = agentStyle(h.db, ids[0]!);
    expect(style).not.toBeNull();
    expect(style!.name).toMatch(/[A-Z]/);
    expect(style!.rows).toHaveLength(3);
    // D118: every row the UI shows is a figure the reader can check.
    for (const row of style!.rows) {
      expect(row.percent).toBeGreaterThanOrEqual(0);
      expect(row.detail).toContain(String(row.percent));
    }
    expect(style!.metrics.tables).toBe(MIN_TABLES_FOR_STYLE);
  });

  /** Same log in, same name out — the archetype is computed, never stored. */
  it('is deterministic', async () => {
    const h = boot();
    const ids = register(h, ['ada', 'bo', 'cy']);
    await playTables(h, ids, MIN_TABLES_FOR_STYLE);
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
