/**
 * `yarn workspace api migrate` — apply the §4 schema to DATABASE_PATH.
 *
 * Idempotent: safe to run against an existing database.
 */
import { loadConfig } from '../config';
import { openDatabase } from './index';

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;

  process.stdout.write(`Migrated ${config.databasePath}\n`);
  process.stdout.write(`Tables: ${tables.map((t) => t.name).join(', ')}\n`);
  db.close();
}

main();
