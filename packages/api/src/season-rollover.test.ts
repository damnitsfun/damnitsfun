import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * Sub-spec 20 T88 — what a season rollover has to do to be real.
 *
 * D136 claimed a new competition "starts everybody at STARTING_COINS for free".
 * It does not, and these tests pin the difference so nobody re-derives the wrong
 * conclusion from the schema: `agent_rebuys` is keyed by competition and resets,
 * but `agents.coins` is one global column and does not.
 */
interface H { db: Db; o: Orchestrator; config: ReturnType<typeof loadConfig>; advance(ms: number): void }

function boot(): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3', TABLE_MAX_SIZE: '3', DECISION_TIMEOUT_MS: '5',
      GAME_LIMIT_MIN_ROUNDS: '0', GAME_TIME_LIMIT_MS: '1',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  return { db, config, o: new Orchestrator(db, config, { clock: () => clock }), advance: (ms) => { clock += ms; } };
}

async function playIn(h: H, comp: string, ids: string[], n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    for (const id of ids) await h.o.joinSession(id, comp);
    h.advance(60_000);
    h.o.tick();
  }
}

describe('season rollover', () => {
  const setup = async (): Promise<{ h: H; s1: string; ids: string[] }> => {
    const h = boot();
    const s1 = h.o.createCompetition('Season 1');
    const ids = ['rich', 'mid', 'poor'].map((n) => h.o.registerAgent(n).agentId);
    await playIn(h, s1, ids, 3);
    h.db.prepare(`UPDATE agents SET coins = 21825 WHERE display_name = 'rich'`).run();
    h.db.prepare(`INSERT OR REPLACE INTO agent_rebuys (competition_id, agent_id, used) VALUES (?,?,5)`)
      .run(s1, ids[2]);
    return { h, s1, ids };
  };

  /** The premise D136 got wrong, pinned so it cannot be re-assumed. */
  it('does NOT reset balances just because a new competition exists', async () => {
    const { h, ids } = await setup();
    const s2 = h.o.createCompetition('Season 2');
    await playIn(h, s2, ids, 1);

    const board = h.o.playgroundStandings(s2);
    const rich = board.find((r) => r.displayName === 'rich')!;
    expect(rich.played).toBe(1);              // one table in this season...
    expect(rich.coins).toBeGreaterThan(21_000); // ...carrying the old season's fortune
    expect(board[0]!.displayName).toBe('rich'); // and leading a board nobody has played
  });

  it('DOES reset the rebuy allowance, which is per competition', async () => {
    const { h, s1, ids } = await setup();
    const s2 = h.o.createCompetition('Season 2');
    expect(h.o.rebuysUsed(ids[2]!, s1)).toBe(5); // exhausted last season
    expect(h.o.rebuysUsed(ids[2]!, s2)).toBe(0); // and forgiven in the new one
  });

  it('is only a real rollover once balances are reset too', async () => {
    const { h, ids } = await setup();
    const s2 = h.o.createCompetition('Season 2');
    h.db.prepare(`UPDATE agents SET coins = ?`).run(h.config.startingCoins); // what the CLI does
    await playIn(h, s2, ids, 1);

    const board = h.o.playgroundStandings(s2);
    // Everyone within one table's swing of the start — nobody arrives ahead.
    const swing = h.config.coinPlaceStep * board.length;
    for (const r of board) {
      expect(Math.abs(r.coins - h.config.startingCoins)).toBeLessThanOrEqual(swing);
    }
  });

  it('leaves the previous season readable after it is archived', async () => {
    const { h, s1, ids } = await setup();
    h.db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(s1);

    // Out of the joinable list...
    expect(h.o.listActiveCompetitions().map((c) => c.id)).not.toContain(s1);
    // ...but its board and its games are all still there.
    const old = h.o.playgroundStandings(s1);
    expect(old.length).toBe(ids.length);
    expect(old.reduce((t, r) => t + r.played, 0)).toBe(9); // 3 agents x 3 tables
  });
});
