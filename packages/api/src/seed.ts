/**
 * `yarn workspace api seed` — create an active competition to play in.
 *
 * Competitions are operator-owned (no public endpoint creates them), so this is
 * the supported way to stand one up for local play, the curl walkthrough, and
 * the demo rehearsal in sub-spec 07.
 *
 * Usage: yarn workspace api seed [name] [entryFeeWei]
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';

function main(): void {
  const name = process.argv[2] ?? 'damnits.fun Open';
  const entryFeeWei = process.argv[3] ?? '0';

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const orchestrator = new Orchestrator(db, config);

  const existing = orchestrator.listActiveCompetitions();
  if (existing.length > 0) {
    process.stdout.write(`Active competition already exists: ${existing[0]!.id} (${existing[0]!.name})\n`);
    db.close();
    return;
  }

  const id = orchestrator.createCompetition(name, entryFeeWei, config.escrowContractAddress);
  process.stdout.write(`Created competition ${id} — "${name}", entry fee ${entryFeeWei} wei\n`);
  db.close();
}

main();
