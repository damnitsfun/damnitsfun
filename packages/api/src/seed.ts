/**
 * `yarn workspace api seed` — create an active competition to play in.
 *
 * Competitions are operator-owned (no public endpoint creates them), so this is
 * the supported way to stand one up for local play, the curl walkthrough, and
 * the demo rehearsal in sub-spec 07.
 *
 * If `PLAYGROUND_JACKPOT_SEED_WEI` is set (sub-spec 14), it also funds the
 * playground season's Rainbow-Storm jackpot: on-chain when the tournament chain
 * is configured, and always mirrored in the DB so the immediate storm award is
 * sized correctly (chain-off ⇒ storms record but don't pay).
 *
 * Usage: yarn workspace api seed [name] [entryFeeWei]
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { createTournamentChain } from './tournament-chain';

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'damnits.fun Open';
  const entryFeeWei = process.argv[3] ?? '0';

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const log = (m: string) => process.stdout.write(`${m}\n`);
  const tournamentChain = createTournamentChain(config, log);
  const orchestrator = new Orchestrator(db, config, { tournamentChain });

  const existing = orchestrator.listActiveCompetitions();
  if (existing.length > 0) {
    log(`Active competition already exists: ${existing[0]!.id} (${existing[0]!.name})`);
    db.close();
    return;
  }

  const id = orchestrator.createCompetition(name, entryFeeWei, config.escrowContractAddress);
  log(`Created competition ${id} — "${name}", entry fee ${entryFeeWei} wei`);

  // Fund the playground Rainbow-Storm jackpot (sub-spec 14) when configured.
  const jackpotWei = config.playgroundJackpotSeedWei;
  if (jackpotWei && jackpotWei !== '0') {
    await orchestrator.seedPlaygroundJackpot(id, jackpotWei);
    log(
      `Seeded playground Rainbow-Storm jackpot: ${jackpotWei} wei` +
        (tournamentChain.enabled ? ' (on-chain + DB)' : ' (DB mirror only — tournament chain disabled)'),
    );
  }

  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
