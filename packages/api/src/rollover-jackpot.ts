/**
 * `node dist/rollover-jackpot.js` — carry a settled tournament's unpaid jackpot
 * into the next tournament season.
 *
 * A season allows one Rainbow-Storm jackpot claim. When that claim went to an
 * agent that cannot be paid — or no storm fired at all — the seeded jackpot is
 * still in the contract when the season settles. `rolloverJackpot` on the
 * contract (D15) moves it into an OPEN season; funds never leave the contract.
 * The orchestrator has wrapped that call since sub-spec 08, but nothing called
 * the wrapper, so an unpaid jackpot had no way off a settled season.
 *
 * Dry run by default. It moves no new money in, but it does move money between
 * seasons and cannot be undone, so it needs `--confirm` like `settle-season`.
 *
 * Usage:
 *   node dist/rollover-jackpot.js --from comp_s1 --to comp_s2             # dry run
 *   node dist/rollover-jackpot.js --from comp_s1 --to comp_s2 --confirm   # move it
 */
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { createTournamentChain } from './tournament-chain';
import { createWalletStore } from './agent-wallet';
import { fmtWei } from './settle-season';

const log = (m = ''): void => {
  process.stdout.write(`${m}\n`);
};
const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface SeasonRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  jackpot_seed_wei: string;
}

export interface RolloverPlan {
  from: SeasonRow | null;
  to: SeasonRow | null;
  amountWei: bigint;
  /** Every reason this rollover must not run. Empty means it may. */
  refusals: string[];
}

/**
 * What a rollover would do, and every reason it must not — checked against the
 * database BEFORE anything is sent. The contract enforces the same rules, but a
 * revert on chain is a worse place to learn that `--to` was a playground.
 */
export function planRollover(db: Db, fromId: string, toId: string): RolloverPlan {
  const read = (id: string): SeasonRow | null =>
    (db
      .prepare(`SELECT id, name, kind, status, jackpot_seed_wei FROM competitions WHERE id = ?`)
      .get(id) as SeasonRow | undefined) ?? null;
  const from = read(fromId);
  const to = read(toId);
  const refusals: string[] = [];

  if (fromId === toId) refusals.push('--from and --to are the same season');
  if (!from) refusals.push(`--from ${fromId} does not exist`);
  if (!to) refusals.push(`--to ${toId} does not exist`);
  if (from && from.kind !== 'tournament') refusals.push(`--from is a ${from.kind} season, not a tournament`);
  if (to && to.kind !== 'tournament') refusals.push(`--to is a ${to.kind} season, not a tournament`);
  // The contract carries only from a SETTLED season into an OPEN one: until a
  // season settles, its jackpot can still be won there.
  if (from && from.status !== 'settled') {
    refusals.push(`--from is "${from.status}" — settle it first (its jackpot can still be won there)`);
  }
  if (to && to.status !== 'active') refusals.push(`--to is "${to.status}", not an active season`);

  const amountWei = from ? BigInt(from.jackpot_seed_wei) : 0n;
  if (from && amountWei === 0n) refusals.push('--from has no jackpot left to carry');

  return { from, to, amountWei, refusals };
}

async function main(): Promise<void> {
  const fromId = arg('--from');
  const toId = arg('--to');
  if (!fromId || !toId) {
    log('FATAL: --from comp_... and --to comp_... are both required.');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(config.databasePath, { autoMigrate: false });
  const tournament = createTournamentChain(config, log);
  const plan = planRollover(db, fromId, toId);
  const confirm = process.argv.includes('--confirm');

  log('');
  log(`rollover-jackpot — ${confirm ? 'APPLYING' : 'dry run (nothing will be written)'}`);
  log(`  database   ${config.databasePath}`);
  log(`  chain      ${tournament.enabled ? `ENABLED — ${tournament.contractAddress}` : 'DISABLED (mirror only)'}`);
  log(`  from       ${plan.from ? `${plan.from.name} (${fromId}) [${plan.from.status}]` : fromId}`);
  log(`  to         ${plan.to ? `${plan.to.name} (${toId}) [${plan.to.status}]` : toId}`);
  log(`  carrying   ${fmtWei(plan.amountWei)}`);

  if (plan.refusals.length) {
    log('');
    for (const r of plan.refusals) log(`  REFUSING: ${r}`);
    db.close();
    process.exit(2);
  }

  if (!confirm) {
    log('');
    log('  Nothing written. Re-run with --confirm to move the jackpot.');
    db.close();
    return;
  }

  const orchestrator = new Orchestrator(db, config, {
    tournamentChain: tournament,
    walletStore: createWalletStore(config.walletEncryptionKey),
  });
  // Throws — leaving both seasons untouched — if the contract refuses.
  const { txHash } = await orchestrator.rolloverJackpot(fromId, toId);
  const after = planRollover(db, fromId, toId);
  log('');
  log(`  rolled over — tx ${txHash ?? '(chain disabled)'}`);
  log(`  ${plan.to!.name} jackpot now ${fmtWei(BigInt(after.to!.jackpot_seed_wei))}`);
  db.close();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
