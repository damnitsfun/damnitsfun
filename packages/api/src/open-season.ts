/**
 * `node dist/open-season.js` — roll the playground into a fresh season.
 *
 * Sub-spec 20 T88. Written after discovering that the spec's own D136 was wrong
 * about what a season boundary does.
 *
 * D136 says "a competition IS a season, so a new one starts everybody at
 * STARTING_COINS for free." It does not. `agent_rebuys` is keyed by competition,
 * so the rebuy allowance resets — but `agents.coins` is a single global column,
 * and the standings select that balance while scoping only which GAMES they
 * count. Measured: open a new competition next to an agent holding 21,825 coins
 * and, on its first table in the new season, it appears at the top of an
 * otherwise-empty board leading by 20,875. The season is decided before it
 * starts, which is precisely what rolling was supposed to prevent.
 *
 * So a rollover is two operations with very different risk, kept separate the
 * way `create-tournament.ts` separates creating from spending:
 *
 *   opening      — insert a competition row, archive the old one. Reversible.
 *   resetting    — rewrite EVERY agent's balance. Not reversible, and it is the
 *                  only part that actually makes the new season fresh.
 *
 * Nothing is written without `--confirm`. Without it this prints exactly what it
 * would do and exits, so "look at the rollover" can never quietly become "reset
 * every balance on production".
 *
 * Usage:
 *   node dist/open-season.js --name "damnits.fun Open S2"                  # dry run
 *   node dist/open-season.js --name "damnits.fun Open S2" --archive comp_x --reset-coins --confirm
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';

const log = (m = ''): void => {
  process.stdout.write(`${m}\n`);
};

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag: string): boolean => process.argv.includes(flag);

function main(): void {
  const name = arg('--name');
  if (!name) {
    log('open-season: --name "damnits.fun Open S2" is required.');
    process.exit(1);
  }
  const kind = arg('--kind', 'classic') as 'classic' | 'tournament';
  const archiveId = arg('--archive');
  const resetCoins = has('--reset-coins');
  const confirm = has('--confirm');

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const orchestrator = new Orchestrator(db, config);

  const agents = db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number };
  const holding = db
    .prepare(`SELECT COUNT(*) AS n FROM agents WHERE coins != ?`)
    .get(config.startingCoins) as { n: number };
  const top = db
    .prepare(`SELECT display_name AS n, coins AS c FROM agents ORDER BY coins DESC LIMIT 3`)
    .all() as Array<{ n: string; c: number }>;

  log('');
  log(`open-season — ${confirm ? 'APPLYING' : 'dry run (nothing will be written)'}`);
  log(`  database        ${config.databasePath}`);
  log(`  new season      "${name}" (${kind})`);
  log(`  archive         ${archiveId ?? '(none — the old season stays joinable)'}`);
  log(`  reset balances  ${resetCoins ? `yes → ${config.startingCoins} for all ${agents.n} agents` : 'NO'}`);
  log('');

  if (archiveId) {
    const old = db.prepare(`SELECT id, name, status FROM competitions WHERE id = ?`).get(archiveId) as
      | { id: string; name: string; status: string }
      | undefined;
    if (!old) {
      log(`  ! no competition ${archiveId} — refusing to archive something that does not exist.`);
      process.exit(1);
    }
    // What archiving actually moves out of the default view (sub-spec 21 T94/D149).
    // Print it before `--confirm`, not after: this is the number that tells you
    // whether you are retiring a warm-up or a season somebody watched.
    const history = db
      .prepare(
        `SELECT COUNT(*) AS tables,
                (SELECT COUNT(*) FROM session_events e
                   JOIN sessions x ON x.id = e.session_id
                  WHERE x.competition_id = @id AND x.status = 'settled') AS events
           FROM sessions WHERE competition_id = @id AND status = 'settled'`,
      )
      .get({ id: archiveId }) as { tables: number; events: number };

    log(`  archiving: ${old.name} (${old.status} → archived).`);
    log(`             ${history.tables} settled tables and ${history.events} events move out of`);
    log(`             the default view. Nothing is deleted: the season stays selectable on the`);
    log(`             site's season picker, and every coin_delta stays on disk — which is why`);
    log(`             its final standings still rank correctly after a --reset-coins.`);
    log(`             It stops appearing in list-active, so agents join the new season instead.`);
  }

  // Sub-spec 22 (D154) turned this warning inside out. It used to read "WITHOUT
  // --reset-coins THIS ROLLOVER IS COSMETIC", because `agents.coins` was global
  // and the new season inherited every balance. Coins are now scoped to a
  // competition, so a new season has no ledger rows and every agent's first seat
  // there is bought out of a fresh stack — the rollover is real on its own.
  //
  // Which makes --reset-coins the dangerous option rather than the necessary one:
  // it now rewrites the LIFETIME totals (D155) that the profile and the homepage
  // ticker read, and it buys the new season nothing.
  if (resetCoins) {
    log('  ! --reset-coins IS NO LONGER NEEDED, AND IS NOT WHAT IT WAS.');
    log('    Since sub-spec 22 (D154) balances are per-competition, so the new season already');
    log('    starts everyone at the stack. This flag now rewrites the LIFETIME total on every');
    log(`    agent — the number the profile and the ticker show. ${holding.n} of ${agents.n} agents would lose:`);
    for (const t of top) log(`      ${t.n.padEnd(16)} ${t.c}`);
    log('    Pass it only if you actually mean to erase that history.');
    log('');
  } else {
    log(`  balances: the new season starts empty — every agent's first seat there is bought`);
    log(`            out of a fresh ${config.startingCoins}. Lifetime totals are left alone.`);
    log('');
  }

  if (!confirm) {
    log('  Nothing written. Re-run with --confirm to apply.');
    return;
  }

  const apply = db.transaction((): string => {
    const id = orchestrator.createCompetition(name);
    if (kind === 'tournament') {
      db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(id);
    }
    if (archiveId) {
      db.prepare(`UPDATE competitions SET status = 'archived' WHERE id = ?`).run(archiveId);
    }
    if (resetCoins) {
      db.prepare(`UPDATE agents SET coins = ?`).run(config.startingCoins);
    }
    return id;
  });

  const id = apply();
  log(`  created ${id}`);
  if (resetCoins) log(`  reset ${agents.n} balances to ${config.startingCoins}`);
  if (archiveId) log(`  archived ${archiveId}`);
  log('');
  log('  Done. The previous season keeps its rows, its standings and its replays.');
}

main();
