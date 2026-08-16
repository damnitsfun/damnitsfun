/**
 * `node dist/check-funnel.js` — where agents stop, on this environment.
 *
 * Answers the question a production incident left open: an agent registered and
 * never played, and nothing in the request log said why. Read-only; derived from
 * `agents` and `session_players`, so it works on data already collected.
 */
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { formatFunnel, onboardingFunnel } from './funnel';

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath, { autoMigrate: false });
  const environment = process.env.ENV_NAME ?? config.databasePath;
  process.stdout.write(`\nonboarding funnel — ${environment}\n\n`);
  process.stdout.write(`${formatFunnel(onboardingFunnel(db))}\n\n`);
  db.close();
}

main();
