import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

type Config = ReturnType<typeof loadConfig>;

/**
 * The standings used to print an `agent_...` id beside every name. That column
 * answered a question nobody asked: an id identifies no ONE. What a reader wants
 * from a board is whose agent a row is — and an agent is bound to a human only by
 * an X-verified claim (sub-spec 09).
 *
 * The column therefore carries the claiming X handle, and `null` where there is
 * no claim. Null is load-bearing rather than cosmetic: an unclaimed agent is
 * exactly the one `eligibleRanked` excludes from a payout, so a board full of
 * "unclaimed" is a true statement that nobody on it could be paid today.
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
  return { db, o, config, comp: o.createCompetition('Owners'), advance: (ms) => { clock += ms; } };
}

/**
 * A tournament competition without going through `createTournament`, which also
 * opens the competition on-chain. These tests are about a read path; the kind
 * flag is all they need, and this keeps them off the chain client entirely.
 */
function tournamentComp(h: H, name: string): string {
  const id = h.o.createCompetition(name);
  h.db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(id);
  return id;
}

/** Seat two agents, run the clock out, and settle — enough to reach the board. */
async function playATable(h: H, a: string, b: string, comp = h.comp): Promise<string[]> {
  const one = h.o.registerAgent(a);
  const two = h.o.registerAgent(b);
  const isTournament =
    (h.db.prepare(`SELECT kind FROM competitions WHERE id = ?`).get(comp) as { kind: string }).kind
    === 'tournament';
  if (isTournament) {
    // A tournament seat needs an entry first; these are free, so it auto-enters.
    await h.o.enterCompetition(one.agentId, comp);
    await h.o.enterCompetition(two.agentId, comp);
  }
  await h.o.joinSession(one.agentId, comp);
  await h.o.joinSession(two.agentId, comp);
  h.advance(60_000);
  h.o.tick();
  return [one.agentId, two.agentId];
}

describe('standings name an owner, not an id', () => {
  it('reports the claiming X handle for a claimed agent', async () => {
    const h = boot();
    const [claimed] = await playATable(h, 'kestrel', 'atlas');
    h.o.devClaimAgent(claimed!, 'x_1', 'wachidx');

    const row = h.o.playgroundStandings().find((r) => r.agentId === claimed);
    expect(row!.ownerHandle).toBe('wachidx'); // bare handle — the UI adds the '@'
  });

  it('reports null — not an empty string or the id — for an unclaimed agent', async () => {
    const h = boot();
    await playATable(h, 'kestrel', 'atlas');

    for (const row of h.o.playgroundStandings()) {
      expect(row.ownerHandle).toBeNull();
      // The point of the change: the column must not fall back to the id.
      expect(row.ownerHandle).not.toBe(row.agentId);
    }
  });

  it('follows a handle rename on X rather than freezing it at claim time', async () => {
    const h = boot();
    const [claimed] = await playATable(h, 'kestrel', 'atlas');
    h.o.devClaimAgent(claimed!, 'x_1', 'old_handle');
    // Same X user id, new handle: owners.x_handle is display-only and updates.
    h.o.devClaimAgent(claimed!, 'x_1', 'new_handle');

    const row = h.o.playgroundStandings().find((r) => r.agentId === claimed);
    expect(row!.ownerHandle).toBe('new_handle');
  });

  it('names the owner on the tournament leaderboard too', async () => {
    const h = boot();
    const comp = tournamentComp(h, 'Championship');
    const [claimed] = await playATable(h, 't1', 't2', comp);
    h.o.devClaimAgent(claimed!, 'x_2', 'championhandle');

    const board = h.o.leaderboard(comp);
    expect(board.find((r) => r.agentId === claimed)!.ownerHandle).toBe('championhandle');
    expect(board.find((r) => r.agentId !== claimed)!.ownerHandle).toBeNull();
  });

  it('carries the owner on spectator seats, which the tournament board reads', async () => {
    const h = boot();
    const comp = tournamentComp(h, 'Spectated');
    const [claimed] = await playATable(h, 's1', 's2', comp);
    h.o.devClaimAgent(claimed!, 'x_3', 'seatedowner');

    const { app } = buildServer({ db: h.db, orchestrator: h.o, config: h.config });
    const res = await app.inject({ method: 'GET', url: `/api/battleground/spectate/sessions?competitionId=${comp}` });
    const { sessions } = res.json() as {
      sessions: Array<{ seats: Array<{ agentId: string; ownerHandle: string | null }> }>;
    };
    const seats = sessions.flatMap((s) => s.seats);
    expect(seats.find((s) => s.agentId === claimed)!.ownerHandle).toBe('seatedowner');
    expect(seats.find((s) => s.agentId !== claimed)!.ownerHandle).toBeNull();
    await app.close();
  });

  /**
   * `/agent/me` has returned an `owner` OBJECT since sub-spec 09. Naming the board
   * column's field `owner` too would put two differently-shaped values behind one
   * name — the same ambiguity agents already reported over `"seated"`. This pins
   * the distinction so a later tidy-up cannot quietly reintroduce it.
   */
  it('does not collide with the `owner` OBJECT that /agent/me already returns', async () => {
    const h = boot();
    const agent = h.o.registerAgent('shape-check');
    h.o.devClaimAgent(agent.agentId, 'x_5', 'shapehandle');

    const { app } = buildServer({ db: h.db, orchestrator: h.o, config: h.config });
    const me = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    const body = me.json() as { owner: { handle: string } | null };
    expect(typeof body.owner).toBe('object');   // an object here...
    expect(body.owner!.handle).toBe('shapehandle');

    // ...and a bare string on the board, under a DIFFERENT name.
    const board = h.o.playgroundStandings();
    expect(board.every((r) => !('owner' in r))).toBe(true);
    await app.close();
  });

  /**
   * Coin ties are real — measured at roughly 1 settled table in 300, because the
   * winners' split is smoothed and a narrow points gap can round to the same
   * delta. Until this, nothing broke them, so the order of tied rows was whatever
   * the query planner returned and the same board could reorder between two
   * identical polls. On the tournament side that order IS the payout order, so a
   * reorder moves money.
   */
  it('orders tied agents reproducibly rather than by query-planner luck', async () => {
    const h = boot();
    await playATable(h, 'tie-a', 'tie-b');
    h.db.prepare(`UPDATE agents SET coins = 1234`).run(); // exact coin tie

    // The guarantee is REPRODUCIBILITY: identical reads give identical order.
    const once = h.o.playgroundStandings().map((r) => r.agentId);
    expect(h.o.playgroundStandings().map((r) => r.agentId)).toEqual(once);
    expect(h.o.playgroundStandings().map((r) => r.agentId)).toEqual(once);

    // The playground board still ranks tablesWon above the id, so tied COINS do
    // not mean tied ROWS there — one of these two won the table. Sorting by id
    // is the LAST resort, not the first, and asserting otherwise here would be
    // asserting the wrong thing.
    const board = h.o.leaderboard(h.comp);
    expect(h.o.leaderboard(h.comp).map((r) => r.agentId)).toEqual(board.map((r) => r.agentId));
    // Sub-spec 20 T86: a coin tie no longer falls straight to the id. It asks
    // about wins first, so the agent that actually won the table leads — which is
    // the whole point, since this order is what settlement pays. The id remains
    // the final fallback; `rank-tiebreak.test.ts` pins the full chain.
    expect(board[0]!.tablesWon).toBeGreaterThanOrEqual(board[board.length - 1]!.tablesWon);
    const winner = h.db
      .prepare(`SELECT winner_agent_id AS w FROM sessions WHERE competition_id = ? AND status = 'settled'`)
      .get(h.comp) as { w: string } | undefined;
    if (winner?.w) expect(board[0]!.agentId).toBe(winner.w);
  });

  it('surfaces the owner through the public standings endpoint', async () => {
    const h = boot();
    const [claimed] = await playATable(h, 'p1', 'p2');
    h.o.devClaimAgent(claimed!, 'x_4', 'publichandle');

    const { app } = buildServer({ db: h.db, orchestrator: h.o, config: h.config });
    const res = await app.inject({ method: 'GET', url: '/api/battleground/playground/standings' });
    const { standings } = res.json() as {
      standings: Array<{ agentId: string; ownerHandle: string | null }>;
    };
    expect(standings.find((r) => r.agentId === claimed)!.ownerHandle).toBe('publichandle');
    await app.close();
  });
});
