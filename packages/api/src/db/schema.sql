-- damnits.fun schema (parent spec §4). SQLite via better-sqlite3, written to stay
-- Postgres-portable: no SQLite-only types, TEXT ids, TEXT wei amounts.
--
-- Applied by `yarn workspace api migrate`. Every statement is IF NOT EXISTS so a
-- re-run on an existing database is a no-op.

PRAGMA foreign_keys = ON;

-- One row per registered agent.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,           -- 'agent_' + nanoid
  api_key_hash    TEXT NOT NULL UNIQUE,       -- store a hash, never the raw key
  display_name    TEXT NOT NULL,
  payout_address  TEXT,                       -- BSC address, nullable until set
  trueskill_mu    REAL NOT NULL DEFAULT 25.0,
  trueskill_sigma REAL NOT NULL DEFAULT 8.333,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per competition (season). MVP needs exactly one active row at a time.
CREATE TABLE IF NOT EXISTS competitions (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','settled','archived')),
  entry_fee_wei    TEXT NOT NULL,             -- string: BSC amounts exceed safe JS int range
  contract_address TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per match/session (a single game to completion or timeout).
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  competition_id   TEXT NOT NULL REFERENCES competitions(id),
  status           TEXT NOT NULL CHECK (status IN ('lobby','seated','in_progress','settled','archived')),
  table_size       INTEGER NOT NULL DEFAULT 4,  -- fixed at 4 per Requirements §9.3
  seed_commit_hash TEXT,                        -- published before the match (commit-reveal)
  seed_reveal      TEXT,                        -- published after the match
  winner_agent_id  TEXT REFERENCES agents(id),
  result_hash      TEXT,                        -- committed on-chain, see §8 contract
  started_at       TEXT,
  ended_at         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seat assignment, one row per agent per session.
CREATE TABLE IF NOT EXISTS session_players (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  seat_index       INTEGER NOT NULL,            -- 0..3 for a 4-player table
  final_hand_value INTEGER,                     -- for timeout resolution, see house rules
  PRIMARY KEY (session_id, agent_id)
);

-- Durable event log — the single source of truth the replay UI and the on-chain
-- result_hash are both derived from. Never regenerate this differently in two places.
CREATE TABLE IF NOT EXISTS session_events (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  seq          INTEGER NOT NULL,              -- monotonic per session, starts at 0
  event_type   TEXT NOT NULL,                 -- see docs/event-catalogue.md
  payload_json TEXT NOT NULL,
  reasoning    TEXT,                          -- agent's free-text reasoning for decision events
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, seq)
);

-- On-chain payment tracking (entry fees and payouts).
CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  direction  TEXT NOT NULL CHECK (direction IN ('entry_fee','payout')),
  amount_wei TEXT NOT NULL,
  tx_hash    TEXT,
  status     TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency for POST /session/action (Requirements FR-3.4): a retried request
-- with the same key returns the original response instead of re-applying a move.
CREATE TABLE IF NOT EXISTS action_idempotency (
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  idempotency_key TEXT NOT NULL,
  response_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, agent_id, idempotency_key)
);

-- Lookups the hot paths depend on.
CREATE INDEX IF NOT EXISTS idx_session_players_agent ON session_players(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_competition_status ON sessions(competition_id, status);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
