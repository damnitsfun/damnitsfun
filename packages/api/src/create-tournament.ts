/**
 * `node dist/create-tournament.js` — open a tournament season on a live server.
 *
 * There was no way to do this against a real deployment: `seed.ts` only creates
 * the classic playground, and `demo-tournament.ts` is an in-process demo against
 * a disabled chain. So the tournament path — the on-chain buy-in, the pooled
 * prize, the top-10-by-net split — had never run outside a test, on either
 * environment, despite being the project's stated headline differentiator.
 *
 * Two clearly separated operations, because they carry very different risk:
 *
 *   creating   — a DB row plus `openCompetition` on-chain. GAS ONLY, no funds move.
 *   seeding    — `seedPool` / `seedJackpot` send real tBNB from the operator wallet.
 *
 * Seeding therefore requires `--confirm-spend`. The tool prints exactly what it
 * is about to move and refuses without it, so "create a tournament" can never
 * quietly become "spend the operator's balance".
 *
 * `--staked` opens a REFUNDABLE season instead (sub-spec 24): the entry is a
 * deposit held in DamnitsVault and returned in full at resolve, and the two
 * deadlines are written on chain before anyone can pay. Without `--staked` this
 * is byte-for-byte the fee model spec 08/15/22 built (D191).
 *
 * Usage:
 *   node dist/create-tournament.js --name "Season 1" --buy-in-wei 100000000000000
 *   node dist/create-tournament.js --name "Season 1" --seed-jackpot-wei 1000000000000000 --confirm-spend
 *   node dist/create-tournament.js --name "Season 3" --staked \
 *     --deposit-wei 1000000000000000 --registration-hours 24 --resolve-hours 72
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { createTournamentChain } from './tournament-chain';
import { createVaultChain } from './vault-chain';
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
  const name = arg('--name');
  if (!name) {
    log('FATAL: --name is required.');
    process.exit(1);
  }

  const staked = has('--staked');
  const buyInWei = arg('--buy-in-wei', config.tournamentEntryFeeWei)!;
  const depositWei = arg('--deposit-wei', config.stakedDepositWei)!;
  const poolWei = arg('--seed-pool-wei', '0')!;
  const jackpotWei = arg('--seed-jackpot-wei', '0')!;
  const spends = BigInt(poolWei) > 0n || BigInt(jackpotWei) > 0n;

  // Deadlines in hours from now, because a staked season's whole point is that
  // they are short enough to demo and long enough to mean something. Absolute
  // unix seconds are accepted too, for a rehearsal that needs an exact minute.
  const nowSec = Math.floor(Date.now() / 1000);
  const registrationCloseAt = Number(
    arg('--registration-close-at', String(nowSec + Number(arg('--registration-hours', '24')) * 3600)),
  );
  const resolveBy = Number(
    arg('--resolve-by', String(nowSec + Number(arg('--resolve-hours', '72')) * 3600)),
  );

  const db = openDatabase(config.databasePath, { autoMigrate: false });
  const tournament = createTournamentChain(config, log);
  const vault = createVaultChain(config, log);
  const orchestrator = new Orchestrator(db, config, {
    tournamentChain: tournament,
    vaultChain: vault,
    walletStore: createWalletStore(config.walletEncryptionKey),
  });

  log('');
  log(`environment    ${process.env.ENV_NAME ?? config.databasePath}`);
  log(`chain          ${tournament.enabled ? `ENABLED — ${tournament.contractAddress}` : 'DISABLED (no key/contract)'}`);
  log(`name           ${name}`);
  if (staked) {
    log(`model          STAKED — the entry is a deposit and comes back in full`);
    log(`vault          ${vault.enabled ? vault.contractAddress : 'DISABLED — recorded, never staked, still refunded'}`);
    log(`yield source   ${config.yieldSourceAddress ?? 'none (held in the vault, earns nothing)'}`);
    log(`deposit        ${fmt(depositWei)}   (per wallet, refunded at resolve)`);
    log(`deposits close ${new Date(registrationCloseAt * 1000).toISOString()}`);
    log(`resolve by     ${new Date(resolveBy * 1000).toISOString()}   (after this, ANYONE may call exitStale)`);
  } else {
    log(`model          FEE — the entry funds the prize and is not returned`);
    log(`buy-in         ${fmt(buyInWei)}   ${BigInt(buyInWei) === 0n ? '(free to enter)' : '(paid by each agent from its OWN wallet)'}`);
  }
  log(`seed pool      ${fmt(poolWei)}`);
  log(`seed jackpot   ${fmt(jackpotWei)}`);
  log('');

  if (staked && resolveBy <= registrationCloseAt) {
    log('REFUSING: resolveBy must be after registrationCloseAt.');
    process.exit(2);
  }
  if (staked && BigInt(jackpotWei) > 0n) {
    log('REFUSING: a staked season has no jackpot side-pool. Seed its prize pot instead.');
    process.exit(2);
  }

  if (spends && !has('--confirm-spend')) {
    log('REFUSING: seeding moves real funds from the operator wallet, and');
    log('--confirm-spend was not given. Re-run with it if that is intended.');
    log('');
    log('Creating the tournament itself costs only gas and moves no funds — drop');
    log('the --seed-* flags to do just that.');
    process.exit(2);
  }

  const competitionId = staked
    ? orchestrator.createStakedSeason(name, depositWei, registrationCloseAt, resolveBy, {
        requiresClaim: has('--requires-claim'),
      })
    : orchestrator.createTournament(name, buyInWei, {
        entriesCloseAt: arg('--entries-close-at'),
        requiresClaim: has('--requires-claim'),
      });
  log(`created ${competitionId}`);

  if (spends) {
    log('seeding (this moves funds)…');
    if (staked) {
      const seeded = await orchestrator.seedStakedPot(competitionId, poolWei);
      log(`  prize pot now ${fmt(seeded.pool)}   (sponsor money — deposits are never part of it)`);
    } else {
      const seeded = await orchestrator.seedTournament(competitionId, poolWei, jackpotWei);
      log(`  pool now ${fmt(seeded.pool)}`);
      log(`  jackpot now ${fmt(seeded.jackpot)}`);
    }
  }

  log('');
  log('Agents enter with POST /competition/enter, then join its tables normally.');
  if (staked) {
    log('A staked season answers that with 402 naming the vault; the agent calls');
    log('deposit(bytes32) itself and retries with the txHash.');
  }
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
