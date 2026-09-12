/**
 * `node dist/settle-season.js` — close and settle a pooled tournament.
 *
 * Sub-spec 22. `closeTournament` and `settleTournament` have existed on the
 * orchestrator since sub-spec 08, but the only caller was `demo-tournament.ts`
 * — an in-process demo against a DISABLED chain. So the operation that actually
 * pays the prize had no way to be run against a live deployment, and had never
 * been run on either environment.
 *
 * Two operations with very different risk, kept apart the way `create-tournament.ts`
 * separates creating from spending:
 *
 *   closing    — `closeEntries` on-chain plus a timestamp. Gas only, reversible in
 *                effect (nobody can enter; everyone already in still plays).
 *   settling   — sends the pool to the winners and marks the season settled.
 *                NOT reversible, and it is the only part that moves money.
 *
 * Nothing is written without `--confirm`. Without it this prints the exact field,
 * the exact split, and every agent it is about to leave out and why — so "look at the
 * settlement" can never quietly become "pay it out".
 *
 * Usage:
 *   node dist/settle-season.js --competition comp_abc            # dry run
 *   node dist/settle-season.js --competition comp_abc --close    # close entries only
 *   node dist/settle-season.js --competition comp_abc --confirm  # close (if needed) + pay
 *
 * On a STAKED season (sub-spec 24) `--confirm` resolves instead: every depositor
 * is refunded in full whether they played or not, and the sponsor pot goes to the
 * eligible field.
 */
import { distributePool } from './payout';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
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

export const fmtWei = (wei: bigint | string): string =>
  `${Number(BigInt(wei)) / 1e18} tBNB (${wei.toString()} wei)`;

/** Why an agent on the board is not going to be paid. */
export interface SkippedAgent {
  agentId: string;
  displayName: string;
  reasons: string[];
}

export interface SettlementPreview {
  competitionId: string;
  name: string;
  poolWei: bigint;
  jackpotWei: bigint;
  entriesClosed: boolean;
  alreadySettled: boolean;
  /** The payout-eligible field, best first. */
  ranked: Array<{ agentId: string; displayName: string; netCoins: number; payoutAddress: string }>;
  /** What each paid rank receives; `ranked[i]` gets `amounts[i]`. */
  amounts: bigint[];
  /** On the board, but not eligible — with the reason, which is the useful part. */
  skipped: SkippedAgent[];
}

/**
 * Work out exactly what settling would do, without doing any of it.
 *
 * Exported and pure-ish (reads only) so the dry run and the real run cannot
 * disagree: `settleTournament` recomputes the same split from the same inputs,
 * and this exists so an operator sees it first.
 */
export function previewSettlement(
  db: Db,
  orchestrator: Orchestrator,
  config: Config,
  competitionId: string,
): SettlementPreview {
  const c = db
    .prepare(
      `SELECT id, name, kind, status, pool_wei, jackpot_seed_wei, entries_closed_at
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
        entries_closed_at: string | null;
      }
    | undefined;
  if (!c) throw new Error(`No such competition: ${competitionId}`);
  if (c.kind !== 'tournament') throw new Error(`${competitionId} is a ${c.kind}, not a tournament`);

  const poolWei = BigInt(c.pool_wei);
  const ranked = orchestrator.eligibleRanked(competitionId);
  const amounts = distributePool(
    poolWei,
    ranked.length,
    config.payoutSchedule,
    config.payoutFieldFraction,
  );

  // Everyone who took a seat here but will not be paid, and why. This is the
  // number that matters before a settlement: production ran for months with
  // 0 of 60 agents claimed, and settling into that field pays nobody at all.
  const eligible = new Set(ranked.map((r) => r.agentId));
  const board = db
    .prepare(
      `SELECT a.id            AS agentId,
              a.display_name  AS displayName,
              a.owner_id      AS ownerId,
              a.payout_address AS payoutAddress,
              COUNT(DISTINCT CASE WHEN s.status = 'settled' THEN s.id END) AS games
         FROM agents a
         JOIN session_players p ON p.agent_id = a.id
         JOIN sessions s ON s.id = p.session_id
        WHERE s.competition_id = ?
        GROUP BY a.id`,
    )
    .all(competitionId) as Array<{
    agentId: string;
    displayName: string;
    ownerId: string | null;
    payoutAddress: string | null;
    games: number;
  }>;

  const skipped: SkippedAgent[] = [];
  for (const row of board) {
    if (eligible.has(row.agentId)) continue;
    const reasons: string[] = [];
    if (!row.ownerId) reasons.push('not claimed by an X-verified owner');
    if (!row.payoutAddress) reasons.push('no payout address set');
    if (row.games < config.minRankedSessions) {
      reasons.push(`only ${row.games} settled games (needs ${config.minRankedSessions})`);
    }
    skipped.push({ agentId: row.agentId, displayName: row.displayName, reasons });
  }

  return {
    competitionId: c.id,
    name: c.name,
    poolWei,
    jackpotWei: BigInt(c.jackpot_seed_wei),
    entriesClosed: c.entries_closed_at !== null,
    alreadySettled: c.status === 'settled',
    ranked: ranked.map((r) => ({
      agentId: r.agentId,
      displayName: r.displayName,
      netCoins: r.netCoins,
      payoutAddress: r.payoutAddress,
    })),
    amounts,
    skipped,
  };
}

async function main(): Promise<void> {
  const competitionId = arg('--competition');
  if (!competitionId) {
    log('FATAL: --competition comp_... is required.');
    process.exit(1);
  }

  const config = loadConfig();
  const db = openDatabase(config.databasePath, { autoMigrate: false });
  const tournament = createTournamentChain(config, log);
  const vault = createVaultChain(config, log);
  const orchestrator = new Orchestrator(db, config, {
    tournamentChain: tournament,
    vaultChain: vault,
    walletStore: createWalletStore(config.walletEncryptionKey),
  });

  const p = previewSettlement(db, orchestrator, config, competitionId);
  const season = db
    .prepare(`SELECT entry_model, deposit_wei, resolve_by FROM competitions WHERE id = ?`)
    .get(competitionId) as
    | { entry_model: string; deposit_wei: string | null; resolve_by: string | null }
    | undefined;
  const isStaked = season?.entry_model === 'staked';
  const confirm = has('--confirm');
  const closeOnly = has('--close') && !confirm;

  log('');
  log(`settle-season — ${confirm ? 'APPLYING' : 'dry run (nothing will be written)'}`);
  log(`  database       ${config.databasePath}`);
  log(`  chain          ${tournament.enabled ? `ENABLED — ${tournament.contractAddress}` : 'DISABLED (no key/contract)'}`);
  log(`  competition    ${p.name} (${p.competitionId})`);
  log(`  entries        ${p.entriesClosed ? 'closed' : 'OPEN — settling will close them first'}`);
  if (isStaked) {
    const depositors = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM competition_entries WHERE competition_id = ?`)
        .get(competitionId) as { n: number }
    ).n;
    const held = BigInt(season?.deposit_wei ?? '0') * BigInt(depositors);
    log(`  model          STAKED — resolving REFUNDS every depositor, eligible or not`);
    log(`  vault          ${vault.enabled ? vault.contractAddress : 'DISABLED — refunds recorded, nothing sent'}`);
    log(`  deposits held  ${fmtWei(held)} across ${depositors} wallet(s)`);
    log(`  resolve by     ${season?.resolve_by ?? '(unset)'}   (after this, ANYONE may call exitStale)`);
    log(`  prize pot      ${fmtWei(p.poolWei)}   (sponsor money — no deposit is part of it)`);
  } else {
    log(`  pool           ${fmtWei(p.poolWei)}`);
    log(`  jackpot        ${fmtWei(p.jackpotWei)}`);
  }
  log(
    `  payout depth   top ${Math.round(config.payoutFieldFraction * 100)}% of the field, ` +
      `capped at ${config.payoutSchedule.length} — ${p.amounts.length} of ${p.ranked.length} eligible get paid`,
  );
  log('');

  if (p.alreadySettled) {
    log('  ! This competition is already settled. Refusing — settling twice would');
    log('    re-send a pool that has already been paid.');
    db.close();
    process.exit(2);
  }

  log(`  eligible field: ${p.ranked.length} agent(s), ${p.amounts.length} paid`);
  if (p.ranked.length === 0) {
    log('    (nobody)');
  }
  p.ranked.forEach((r, i) => {
    const amount = p.amounts[i];
    log(
      `    ${String(i + 1).padStart(2)}. ${r.displayName.padEnd(18)} net=${String(r.netCoins).padEnd(7)} ` +
        `${amount === undefined ? '— (below the payout depth)' : fmtWei(amount)}`,
    );
    if (amount !== undefined) log(`        -> ${r.payoutAddress}`);
  });
  log('');

  if (p.skipped.length > 0) {
    log(`  skipped: ${p.skipped.length} agent(s) played here but cannot be paid`);
    for (const s of p.skipped.slice(0, 15)) {
      log(`    ${s.displayName.padEnd(18)} ${s.reasons.join('; ')}`);
    }
    if (p.skipped.length > 15) log(`    ... and ${p.skipped.length - 15} more`);
    log('');
  }

  // The trap this tool exists to prevent. Settling an empty field marks the
  // season settled and sends nothing, so the pool is stranded in the contract
  // with no second chance. Production sat at 0 eligible of 60 agents for months,
  // which is exactly how someone reaches this by accident.
  if (p.ranked.length === 0 && p.poolWei > 0n && !isStaked) {
    log('  ! REFUSING: the pool is funded but NOBODY is eligible to receive it.');
    log('    Settling now would mark the season settled and pay out nothing, and');
    log('    the pool would be stranded. Fix eligibility first — an agent needs an');
    log('    X-verified owner, a payout address, and');
    log(`    ${config.minRankedSessions} settled games in this competition.`);
    db.close();
    process.exit(3);
  }

  // The same trap, softer, because the vault does not have the hole that makes it
  // fatal: resolving with no winners leaves the prize pot readable and payable
  // later with awardPrizes, where DamnitsTournament would strand it forever. So
  // this warns and asks for an explicit flag rather than refusing outright —
  // deposits must still be able to come home.
  if (p.ranked.length === 0 && p.poolWei > 0n && isStaked && !has('--refund-only')) {
    log('  ! The prize pot is funded but NOBODY is eligible to receive it.');
    log('    Resolving now refunds every deposit in full and pays no prize. The pot');
    log('    is NOT lost — it stays attributed to this season and can be paid later');
    log('    — but nothing will go out today. Fix eligibility first (an X-verified');
    log(`    owner, a payout address, and ${config.minRankedSessions} settled games here),`);
    log('    or re-run with --refund-only if returning the deposits is the intent.');
    db.close();
    process.exit(3);
  }

  if (isStaked) {
    if (!confirm) {
      log('  Nothing written. Re-run with --confirm to refund every depositor and');
      log('  pay the prize pot to the eligible field.');
      db.close();
      return;
    }
    log('  resolving (this refunds deposits and pays prizes)…');
    const out = await orchestrator.resolveStakedSeason(competitionId);
    log('');
    log(`  resolved. tx ${out.txHash ?? '(none — vault disabled)'}`);
    log(`  resultRoot ${out.resultRoot}`);
    log(`  refunded ${out.refunds.length} depositor(s) in full:`);
    for (const r of out.refunds) log(`    ${r.agentId} -> ${r.walletAddress ?? '(no wallet)'}  ${fmtWei(r.amountWei)}`);
    for (const w of out.winners) log(`    prize ${w.agentId} -> ${w.payoutAddress}  ${fmtWei(w.amountWei)}`);
    log('');
    log('  Everyone withdraws with vault.withdraw() — refunds and prizes alike.');
    db.close();
    return;
  }

  if (closeOnly) {
    log('  closing entries (gas only, no funds move)…');
    await orchestrator.closeTournament(competitionId);
    log('  entries closed. Re-run with --confirm to pay out.');
    db.close();
    return;
  }

  if (!confirm) {
    log('  Nothing written. Re-run with --confirm to close entries and pay out,');
    log('  or with --close to close entries only.');
    db.close();
    return;
  }

  if (!p.entriesClosed) {
    log('  closing entries…');
    await orchestrator.closeTournament(competitionId);
  }
  log('  settling (this moves funds)…');
  const result = await orchestrator.settleTournament(competitionId);
  log('');
  log(`  settled. tx ${result.txHash ?? '(none — chain disabled)'}`);
  log(`  resultRoot ${result.resultRoot}`);
  for (const w of result.winners) log(`    ${w.agentId} -> ${w.payoutAddress}  ${fmtWei(w.amountWei)}`);
  if (result.jackpot) {
    log(`  jackpot ${result.jackpot.agentId} -> ${result.jackpot.payoutAddress} ${fmtWei(result.jackpot.amountWei)}`);
  }
  db.close();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
