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

  // Back-fill columns added to already-existing tables BEFORE running the schema:
  // schema.sql builds an index on one of them (idx_agents_owner on agents.owner_id),
  // so on a database created before that column existed, the CREATE INDEX inside
  // db.exec(schema) would throw "no such column". addColumnIfMissing is a no-op on a
  // table that doesn't exist yet (a fresh database — schema.sql creates it complete).
  backfillAddedColumns(db);

  db.exec(schema);

  // Run again so a table schema.sql just created is fully shaped, and to stay correct
  // if a future column lands on a table with no dependent index.
  backfillAddedColumns(db);
}

// CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists, so
// columns introduced after a database was first created are applied here.
function backfillAddedColumns(db: Db): void {
  addColumnIfMissing(db, 'sessions', 'commit_tx_hash', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'settle_tx_hash', 'TEXT');

  // Sub-spec 08 additions (pooled tournament + agent wallets).
  addColumnIfMissing(db, 'agents', 'wallet_address', 'TEXT');

  // Sub-spec 09 additions (ownership claim). schema.sql indexes agents(owner_id), so
  // these MUST be back-filled before db.exec(schema) on a pre-09 database. Added as
  // plain TEXT — ALTER TABLE can't re-attach the FK, matching the other back-fills.
  addColumnIfMissing(db, 'agents', 'owner_id', 'TEXT');
  addColumnIfMissing(db, 'agents', 'claimed_at', 'TEXT');

  // Sub-spec 12: the playground coin economy. Every agent carries a coin balance
  // (starts at 1000); tables cost coins to join and settle coins by placement.
  addColumnIfMissing(db, 'agents', 'coins', 'INTEGER NOT NULL DEFAULT 1000');
  addColumnIfMissing(db, 'competitions', 'kind', "TEXT NOT NULL DEFAULT 'classic'");
  addColumnIfMissing(db, 'competitions', 'pool_wei', "TEXT NOT NULL DEFAULT '0'");
  addColumnIfMissing(db, 'competitions', 'sponsor_seed_wei', "TEXT NOT NULL DEFAULT '0'");
  addColumnIfMissing(db, 'competitions', 'jackpot_seed_wei', "TEXT NOT NULL DEFAULT '0'");
  addColumnIfMissing(db, 'competitions', 'payout_schedule_json', 'TEXT');
  addColumnIfMissing(db, 'competitions', 'entries_close_at', 'TEXT');
  addColumnIfMissing(db, 'competitions', 'entries_closed_at', 'TEXT');
  addColumnIfMissing(db, 'competitions', 'settled_at', 'TEXT');
  addColumnIfMissing(db, 'competitions', 'settle_tx_hash', 'TEXT');
}

function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) return; // table doesn't exist yet — schema.sql creates it complete
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
