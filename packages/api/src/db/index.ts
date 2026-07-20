import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Db = Database.Database;

/**
 * Apply the §4 schema. Every statement is IF NOT EXISTS, so this is idempotent
 * and safe to run on an existing database.
 */
export function migrate(db: Db): void {
  // Sits next to this module in both src/ (ts-jest) and dist/ (copied by build).
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists,
  // so columns introduced after a database was first created are applied here.
  addColumnIfMissing(db, 'sessions', 'commit_tx_hash', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'settle_tx_hash', 'TEXT');
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export interface OpenOptions {
  /** Apply the schema on open. Default true — the schema is idempotent. */
  autoMigrate?: boolean;
}

/**
 * Open (and by default migrate) the SQLite database.
 *
 * Pass `:memory:` for tests. Foreign keys are enforced, and WAL is enabled for
 * file databases so reads don't block the synchronous writer.
 */
export function openDatabase(databasePath: string, options: OpenOptions = {}): Db {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');

  if (options.autoMigrate !== false) migrate(db);
  return db;
}
