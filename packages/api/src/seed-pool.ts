/**
 * `node dist/seed-pool.js` — add sponsor funds to a tournament season that
 * already exists.
 *
 * `create-tournament.js` can seed, but only a season it creates in the same
 * run. A live season that has been playing for weeks had no supported path to
 * a funded prize, and the two obvious workarounds are both wrong:
 *
 *   - calling `seedPool` on the contract by hand funds the CHAIN and leaves
 *     `competitions.pool_wei` at zero. `settleTournament` reads that column to
 *     size the payout (`distributePool(BigInt(c.pool_wei), …)`), so the season
 *     would settle for nothing while the contract visibly held funds.
 *   - opening a fresh season to get the flag abandons the standings the
 *     eligible agents earned, and their `MIN_RANKED_SESSIONS` count with them.
 *
 * So this is one entry point onto `Orchestrator.seedTournament`, which already
 * does both halves — send on chain, then mirror into `pool_wei` and
 * `sponsor_seed_wei` — and it keeps `create-tournament`'s two-gate discipline:
 * seeding moves real tBNB from the operator wallet, so it prints exactly what
 * it is about to move and refuses without `--confirm-spend`.
 *
 * Usage:
 *   node dist/seed-pool.js --competition comp_x --pool-wei 20000000000000000
 *   node dist/seed-pool.js --competition comp_x --pool-wei 20000000000000000 --confirm-spend
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { createTournamentChain } from './tournament-chain';
import { createWalletStore } from './agent-wallet';

const log = (m = ''): void => {
  process.stdout.write(`${m}\n`);
};

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag: string): boolean => process.argv.includes(flag);

const fmt = (wei: string): string => `${Number(BigInt(wei)) / 1e18} tBNB (${wei} wei)`;

async function main(): Promise<void> {
  const config = loadConfig();
  const competitionId = arg('--competition');
  if (!competitionId) {
    log('FATAL: --competition is required.');
    process.exit(1);
  }

  const poolWei = arg('--pool-wei', '0')!;
  const jackpotWei = arg('--jackpot-wei', '0')!;
  if (BigInt(poolWei) <= 0n && BigInt(jackpotWei) <= 0n) {
    log('FATAL: give --pool-wei and/or --jackpot-wei a non-zero amount.');
    process.exit(1);
  }

  const db = openDatabase(config.databasePath, { autoMigrate: false });
  const tournament = createTournamentChain(config, log);
  const orchestrator = new Orchestrator(db, config, {
    tournamentChain: tournament,
    walletStore: createWalletStore(config.walletEncryptionKey),
  });

  // Read the row directly, as `settle-season.js` does — a CLI preview is not a
  // reason to widen the orchestrator's public surface. Failing on a bad id here
  // also keeps the preview from ever describing a transfer into a season that
  // does not exist.
  const before = db
    .prepare(
      `SELECT id, name, kind, status, pool_wei, jackpot_seed_wei
         FROM competitions WHERE id = ?`,
    )
    .get(competitionId) as
    | {
        id: string;
        name: string;
        kind: string;
        status: string;
        pool_wei: string;
        jackpot_seed_wei: string;
      }
    | undefined;
  if (!before) {
    log(`FATAL: no competition ${competitionId}.`);
    db.close();
    process.exit(1);
  }
  // Which season kind can hold which money is not interchangeable, and getting
  // it wrong strands funds rather than erroring:
  //
  //   tournament — holds the prize `pool`, paid by `settleCompetition`, AND a
  //     jackpot side-pool. Storms fire here too and pay instantly, same as the
  //     playground.
  //   classic — holds only a jackpot, pushed straight to the storm triggerer by
  //     `awardStormJackpot`. It has no prize pool at all.
  const classic = before.kind === 'classic';
  if (!classic && before.kind !== 'tournament') {
    log(`FATAL: ${competitionId} is a "${before.kind}" season; nothing here can hold funds.`);
    db.close();
    process.exit(1);
  }
  if (classic && BigInt(poolWei) > 0n) {
    log(`FATAL: ${competitionId} is a playground season and has no prize pool.`);
    log('Only --jackpot-wei applies here; the prize pool lives on a tournament.');
    db.close();
    process.exit(1);
  }

  log('');
  log(`environment    ${process.env.ENV_NAME ?? config.databasePath}`);
  log(`chain          ${tournament.enabled ? `ENABLED — ${tournament.contractAddress}` : 'DISABLED (no key/contract)'}`);
  log(`competition    ${competitionId}  ${before.name}  [${before.status}]`);
  log(`pool now       ${fmt(before.pool_wei)}`);
  log(`jackpot now    ${fmt(before.jackpot_seed_wei)}`);
  log(`${classic ? 'setting jackpot' : 'adding pool   '} ${fmt(classic ? jackpotWei : poolWei)}`);
  if (!classic) log(`adding jackpot ${fmt(jackpotWei)}`);
  log('');

  if (!has('--confirm-spend')) {
    log('DRY RUN — nothing was sent. Seeding moves real funds from the operator');
    log('wallet; re-run with --confirm-spend if the amounts above are intended.');
    db.close();
    return;
  }

  // A season that has closed entries or settled must not be topped up: after
  // `settleCompetition` nothing ever reads `Competition.pool` again, so funds
  // added here would be unreachable on chain, permanently.
  if (before.status !== 'active') {
    log(`REFUSING: ${competitionId} is "${before.status}", not active. Funds added`);
    log('to a closed or settled season are not reachable by any later payout.');
    db.close();
    process.exit(2);
  }

  log('seeding (this moves funds)…');
  if (classic) {
    // NOTE: `seedPlaygroundJackpot` SETS the mirror rather than adding to it, so
    // this is "make the jackpot N", not "add N". It is printed as such above.
    await orchestrator.seedPlaygroundJackpot(competitionId, jackpotWei);
    log(`  jackpot now ${fmt(jackpotWei)}`);
  } else {
    const seeded = await orchestrator.seedTournament(competitionId, poolWei, jackpotWei);
    log(`  pool now ${fmt(seeded.pool)}`);
    log(`  jackpot now ${fmt(seeded.jackpot)}`);
  }
  log('');
  log('Check it landed on both sides: GET /competitions should now report the');
  log('same poolWei the contract holds.');
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
