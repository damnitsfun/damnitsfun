import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * Sub-spec 22 — tables abandoned by a restart.
 *
 * A live table is a `GameSession` in memory; the orchestrator has always said an
 * in-flight match does not survive a restart, but nothing cleaned up after one.
 * Two were found sitting in `in_progress` on real deployments — production since
 * 2026-08-26, staging since 2026-08-16 — holding seats that could never play.
 */

const ENTRY = 10;

interface H { db: Db; o: Orchestrator; comp: string; advance(ms: number): void }

function boot(): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3',
      TABLE_MAX_SIZE: '3',
      PLAYGROUND_ENTRY_COINS: String(ENTRY),
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '600000',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  return { db, o, comp: o.createCompetition('Open'), advance: (ms) => { clock += ms; } };
}

/** Deal a table and then simulate the restart: the in-memory session is gone. */
async function dealThenRestart(h: H): Promise<{ sessionId: string; ids: string[]; fresh: Orchestrator }> {
  const ids = ['a', 'b', 'c'].map((n) => h.o.registerAgent(n).agentId);
  const joined = await h.o.joinSession(ids[0]!, h.comp);
  for (const id of ids.slice(1)) await h.o.joinSession(id, h.comp);
  expect(
    (h.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(joined.sessionId) as { status: string }).status,
  ).toBe('in_progress');

  // A new Orchestrator over the same database IS a restart: `live` is empty, so
  // nothing can drive that table again.
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3', TABLE_MAX_SIZE: '3',
      PLAYGROUND_ENTRY_COINS: String(ENTRY),
      GAME_LIMIT_MIN_ROUNDS: '0', GAME_TIME_LIMIT_MS: '600000',
    },
  });
  return { sessionId: joined.sessionId, ids, fresh: new Orchestrator(h.db, config) };
}

describe('reapOrphanedSessions', () => {
  it('archives a table the restart abandoned', async () => {
    const h = boot();
    const { sessionId, fresh } = await dealThenRestart(h);

    expect(fresh.reapOrphanedSessions()).toEqual({ archived: 1, refunded: 3 });

    const row = h.db.prepare(`SELECT status, ended_at FROM sessions WHERE id = ?`).get(sessionId) as
      { status: string; ended_at: string | null };
    expect(row.status).toBe('archived');
    expect(row.ended_at).not.toBeNull();
  });

  it('gives the buy-in back to seats the ledger actually charged', async () => {
    const h = boot();
    const { ids, fresh } = await dealThenRestart(h);
    const seasonCoins = (id: string): number =>
      (h.db
        .prepare(`SELECT coins FROM competition_agents WHERE competition_id = ? AND agent_id = ?`)
        .get(h.comp, id) as { coins: number }).coins;

    const before = ids.map(seasonCoins);
    fresh.reapOrphanedSessions();
    // The table never settled, so the seat cost nothing in the end.
    ids.forEach((id, i) => expect(seasonCoins(id)).toBe(before[i]! + ENTRY));
  });

  it('does NOT refund a seat the ledger never charged', async () => {
    const h = boot();
    const { ids, fresh } = await dealThenRestart(h);
    // The state both real orphans were in: charged before the ledger existed, so
    // there is no row here and the charge is already absent from the standings.
    // Refunding would hand out coins the season never took.
    h.db.prepare(`DELETE FROM competition_agents`).run();

    expect(fresh.reapOrphanedSessions()).toEqual({ archived: 1, refunded: 0 });
    const rows = h.db.prepare(`SELECT COUNT(*) AS n FROM competition_agents`).get() as { n: number };
    expect(rows.n).toBe(0);
    expect(ids).toHaveLength(3);
  });

  it('keeps the seats and the event log — the replay stays readable', async () => {
    const h = boot();
    const { sessionId, fresh } = await dealThenRestart(h);
    const seatsBefore = (h.db
      .prepare(`SELECT COUNT(*) AS n FROM session_players WHERE session_id = ?`)
      .get(sessionId) as { n: number }).n;
    const eventsBefore = (h.db
      .prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`)
      .get(sessionId) as { n: number }).n;

    fresh.reapOrphanedSessions();

    expect((h.db.prepare(`SELECT COUNT(*) AS n FROM session_players WHERE session_id = ?`)
      .get(sessionId) as { n: number }).n).toBe(seatsBefore);
    expect((h.db.prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`)
      .get(sessionId) as { n: number }).n).toBe(eventsBefore);
    expect(eventsBefore).toBeGreaterThan(0);
  });

  it('takes the abandoned table out of the agent’s pending list', async () => {
    const h = boot();
    const { ids, fresh } = await dealThenRestart(h);
    expect(fresh.pendingActions(ids[0]!)).toHaveLength(1); // still listed, and unmovable
    fresh.reapOrphanedSessions();
    // Gone from the list is the contract's one end signal, so the agent stops
    // waiting on a table that can never move and joins another.
    expect(fresh.pendingActions(ids[0]!)).toEqual([]);
  });

  it('is a no-op when nothing was abandoned', () => {
    const h = boot();
    expect(h.o.reapOrphanedSessions()).toEqual({ archived: 0, refunded: 0 });
  });

  it('leaves lobbies alone — they survive a restart and still deal', async () => {
    const h = boot();
    const solo = h.o.registerAgent('early').agentId;
    const joined = await h.o.joinSession(solo, h.comp); // one seat: still a lobby

    h.o.reapOrphanedSessions();

    const row = h.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(joined.sessionId) as
      { status: string };
    // A lobby is a durable row, not an in-memory game, so it is not orphaned by a
    // restart and the ordinary sweep still owns it.
    expect(row.status).toBe('lobby');
  });
});
