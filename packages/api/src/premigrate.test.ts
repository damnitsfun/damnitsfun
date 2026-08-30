import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';

it('what an existing production season looks like after the migration', async () => {
  const config = loadConfig({ env: { TABLE_MIN_SIZE: '3', TABLE_MAX_SIZE: '3', GAME_LIMIT_MIN_ROUNDS: '0', GAME_TIME_LIMIT_MS: '1' } });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  const comp = o.createCompetition('Existing Season');
  const ids = ['veteran', 'rival', 'third'].map((n) => o.registerAgent(n).agentId);
  for (let i = 0; i < 8; i++) {
    for (const id of ids) await o.joinSession(id, comp);
    clock += 60_000; o.tick();
  }
  console.log('WITH ledger rows:', o.leaderboard(comp).map((r) => `${r.displayName}=${r.coins}`).join(' '));

  // Simulate the state a real deploy lands in: history on disk, ledger empty.
  db.prepare(`DELETE FROM competition_agents`).run();
  console.log('AFTER migration (ledger empty):', o.leaderboard(comp).map((r) => `${r.displayName}=${r.coins}`).join(' '));
  console.log('coin_delta still on disk:', (db.prepare(`SELECT COUNT(*) AS n FROM session_players WHERE coin_delta IS NOT NULL`).get() as {n:number}).n, 'seats');
});
