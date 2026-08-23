import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * "How did my table end?" — the gap an agent found while playing staging.
 *
 * Before this, the only end-of-table signal was the session vanishing from
 * `pending-actions`. No placement, no winner, no settlement: an agent reported
 * diffing `GET /agent/me` before and after every game to work out whether it had
 * won. For a product whose entire ladder is coins, that is a hole in the contract.
 */
interface H {
  db: Db;
  o: Orchestrator;
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
  return { db, o, comp: o.createCompetition('Results'), advance: (ms) => { clock += ms; } };
}

/** Seat two agents, run the clock out, and settle. */
async function playATable(h: H, a: string, b: string): Promise<string> {
  const one = h.o.registerAgent(a);
  const two = h.o.registerAgent(b);
  await h.o.joinSession(one.agentId, h.comp);
  const joined = await h.o.joinSession(two.agentId, h.comp);
  h.advance(60_000);
  h.o.tick();
  return joined.sessionId;
}

describe('session results', () => {
  it('tells every seat where it placed and what the table cost it', async () => {
    const h = boot();
    const sessionId = await playATable(h, 'winner', 'loser');

    const ids = h.db
      .prepare(`SELECT agent_id AS id, display_name AS name FROM session_players
                  JOIN agents ON agents.id = session_players.agent_id
                 WHERE session_id = ?`)
      .all(sessionId) as Array<{ id: string; name: string }>;

    for (const { id } of ids) {
      const [r] = h.o.sessionResults(id);
      expect(r).toBeDefined();
      expect(r!.sessionId).toBe(sessionId);
      expect(r!.place).not.toBeNull();          // the thing that was missing
      expect(r!.coinDelta).not.toBeNull();
      expect(r!.placedOf).toBe(2);
      expect(typeof r!.won).toBe('boolean');
    }

    // Exactly one seat won, and the places are a permutation of 1..n.
    const results = ids.map(({ id }) => h.o.sessionResults(id)[0]!);
    expect(results.filter((r) => r.won)).toHaveLength(1);
    expect(results.map((r) => r.place).sort()).toEqual([1, 2]);
  });

  it('reports the coin delta that actually moved, not a recomputation', async () => {
    const h = boot();
    await playATable(h, 'a', 'b');
    const ids = h.db.prepare(`SELECT id FROM agents`).all() as Array<{ id: string }>;

    for (const { id } of ids) {
      const r = h.o.sessionResults(id)[0]!;
      // Sub-spec 20: `coinDelta` is now the seat's NET for the table, buy-in
      // included, so the invariant is the one an agent would assume — and the one
      // skill.md has always promised ("what the table moved for you"). Before, the
      // buy-in was excluded and a reader had to subtract it themselves, which is a
      // trap: it is the exact mistake made while reconciling a real balance.
      expect(h.o.getAgent(id).coins).toBe(1000 + (r.coinDelta ?? 0));
    }
  });

  it('says a table ended on the clock rather than on a win', async () => {
    const h = boot();
    await playATable(h, 'x', 'y');
    const id = (h.db.prepare(`SELECT id FROM agents LIMIT 1`).get() as { id: string }).id;
    // GAME_TIME_LIMIT_MS=1 with no moves: nobody empties a hand.
    expect(h.o.sessionResults(id)[0]!.reason).toBe('timeout');
  });

  it('returns newest first, and can be filtered to one table', async () => {
    const h = boot();
    const first = await playATable(h, 'p1', 'p2');
    const id = (h.db.prepare(`SELECT agent_id AS id FROM session_players WHERE session_id = ? LIMIT 1`)
      .get(first) as { id: string }).id;

    const only = h.o.sessionResults(id, { sessionId: first });
    expect(only).toHaveLength(1);
    expect(only[0]!.sessionId).toBe(first);

    expect(h.o.sessionResults(id, { limit: 1 })).toHaveLength(1);
  });

  it('reports nothing for an agent that has not finished a table', () => {
    const h = boot();
    const { agentId } = h.o.registerAgent('never-played');
    expect(h.o.sessionResults(agentId)).toEqual([]);
  });

  it('is honest about tables settled before results were recorded', async () => {
    const h = boot();
    const sessionId = await playATable(h, 'old1', 'old2');
    // Simulate a pre-existing row: the columns exist but were never written.
    h.db.prepare(`UPDATE session_players SET place = NULL, coin_delta = NULL WHERE session_id = ?`)
      .run(sessionId);
    const id = (h.db.prepare(`SELECT agent_id AS id FROM session_players WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as { id: string }).id;

    const r = h.o.sessionResults(id)[0]!;
    expect(r.place).toBeNull();      // unknown, not back-filled with a guess
    expect(r.coinDelta).toBeNull();
    expect(r.sessionId).toBe(sessionId); // still listed — the table did happen
  });
});
