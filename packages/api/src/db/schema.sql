-- damnits.fun schema (parent spec §4). SQLite via better-sqlite3, written to stay
-- Postgres-portable: no SQLite-only types, TEXT ids, TEXT wei amounts.
--
-- Applied by `yarn workspace api migrate`. Every statement is IF NOT EXISTS so a
-- re-run on an existing database is a no-op.

PRAGMA foreign_keys = ON;

-- One row per human owner, established by "Sign in with X" (sub-spec 09).
-- An owner is an X-verified identity; it may own MANY agents (arena parity).
CREATE TABLE IF NOT EXISTS owners (
  id          TEXT PRIMARY KEY,               -- 'owner_' + nanoid
  x_user_id   TEXT NOT NULL UNIQUE,           -- X (Twitter) numeric user id — the stable key
  x_handle    TEXT NOT NULL,                  -- @handle at claim time (may change on X; display only)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per registered agent.
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,           -- 'agent_' + nanoid
  api_key_hash    TEXT NOT NULL UNIQUE,       -- store a hash, never the raw key
  display_name    TEXT NOT NULL,
  payout_address  TEXT,                       -- BSC address prizes are RECEIVED at, nullable until set
  wallet_address  TEXT,                       -- address the agent PAYS entries FROM (sub-spec 08), nullable
  -- Ownership claim (sub-spec 09): an agent is CLAIMED once an X-verified owner
  -- has signed in with X against its claim link. Claiming gates payout eligibility.
  owner_id        TEXT REFERENCES owners(id), -- null until claimed
  claimed_at      TEXT,                       -- when the X-verified claim completed
  trueskill_mu    REAL NOT NULL DEFAULT 25.0,
  trueskill_sigma REAL NOT NULL DEFAULT 8.333,
  coins           INTEGER NOT NULL DEFAULT 1000,  -- playground coin balance (sub-spec 12)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Custodial agent wallets (sub-spec 14). Every agent is issued a fresh EOA at
-- registration so ANY agent — claimed or not — can receive a Rainbow-Storm
-- jackpot. The private key is stored ENCRYPTED (AES-256-GCM under
-- WALLET_ENCRYPTION_KEY) and is NEVER returned by the API, logged, or committed.
CREATE TABLE IF NOT EXISTS agent_wallets (
  agent_id        TEXT PRIMARY KEY REFERENCES agents(id),
  address         TEXT NOT NULL,             -- the public EOA address (safe to expose)
  enc_private_key TEXT NOT NULL,             -- 'ivHex:authTagHex:cipherHex' (AES-256-GCM)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per competition (season). MVP needs exactly one active row at a time.
CREATE TABLE IF NOT EXISTS competitions (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','settled','archived')),
  entry_fee_wei    TEXT NOT NULL,             -- string: BSC amounts exceed safe JS int range
  contract_address TEXT,
  -- Pooled-tournament fields (sub-spec 08). 'classic' = legacy per-table escrow;
  -- 'tournament' = one pooled prize distributed to the ranked field at close.
  kind                 TEXT NOT NULL DEFAULT 'classic',  -- 'classic' | 'tournament'
  pool_wei             TEXT NOT NULL DEFAULT '0',        -- buy-ins + sponsor seed (mirrors on-chain)
  sponsor_seed_wei     TEXT NOT NULL DEFAULT '0',        -- sponsor money added to the main pool
  jackpot_seed_wei     TEXT NOT NULL DEFAULT '0',        -- sponsor-seeded jackpot side-pool
  payout_schedule_json TEXT,                             -- base % curve snapshot used at settlement
  entries_close_at     TEXT,                             -- advisory season-close timestamp (D9)
  entries_closed_at    TEXT,                             -- set when closeEntries actually runs
  requires_claim       INTEGER NOT NULL DEFAULT 0,       -- 1 = agent must be X-verified (claimed) to enter (sub-spec 09)
  settled_at           TEXT,
  settle_tx_hash       TEXT,                             -- settleCompetition() tx, for the demo
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per agent that has entered a (paid) tournament — the buy-in record.
CREATE TABLE IF NOT EXISTS competition_entries (
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  wallet_address TEXT,                        -- address the buy-in was paid from
  tx_hash        TEXT,                        -- payEntry() tx (null for free auto-entry)
  amount_wei     TEXT NOT NULL DEFAULT '0',
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','failed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, agent_id)
);

-- Rebuys taken, per agent per season (sub-spec 18, T63/D101).
--
-- Keyed by competition on purpose: a competition IS a season (see the comment on
-- `competitions`), so "the count resets when the season ends" needs no reset job
-- and no scheduled task that could fail or be forgotten — a new season simply has
-- no rows yet. An absent row means zero rebuys used, so nothing needs back-filling.
--
-- Deliberately NOT a column on `agents` (that would need an explicit rollover) and
-- NOT folded into `competition_entries` (that table records a PAYMENT; overloading
-- it with a play-credit counter conflates two different meanings).
CREATE TABLE IF NOT EXISTS agent_rebuys (
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  used           INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, agent_id)
);

-- Per-season coin balance — the balance of record (sub-spec 22, D154).
--
-- `agents.coins` used to be the only balance, and it is GLOBAL: one integer
-- serving both game types. Both leaderboards read it, so each season's standings
-- included coins won in the other one. Measured on production: an agent that
-- played 20 playground tables and exactly ONE tournament table ranked 10th of 20
-- on the tournament board — the payout cut — on a balance that was almost
-- entirely playground. The tournament pool splits by that order, so this moved
-- real BNB.
--
-- Keyed by competition for the same reason `agent_rebuys` is: a competition IS a
-- season, so "balances reset when the season ends" needs no reset job and no
-- scheduled task that could fail. A new season simply has no rows yet, and an
-- absent row means the agent has not sat down there — seeded at STARTING_COINS on
-- its first join, never back-filled from the old global balance (D169).
--
-- Rebuys are deliberately NOT duplicated here: `agent_rebuys` already counts them
-- per competition, and two counters for one fact is how they drift apart.
CREATE TABLE IF NOT EXISTS competition_agents (
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  coins          INTEGER NOT NULL DEFAULT 1000,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, agent_id)
);

-- The FIRST Rainbow Storm of a competition — claims the jackpot (sub-spec 08 D6).
-- One row per competition; provably fair against that session's commit-revealed seed.
CREATE TABLE IF NOT EXISTS jackpot_events (
  competition_id TEXT NOT NULL REFERENCES competitions(id),
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  seq            INTEGER NOT NULL,            -- the storm event's seq within the session
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  triggered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  tx_hash        TEXT,                        -- on-chain awardJackpot tx (sub-spec 14); null if unpaid/unfunded
  amount_wei     TEXT,                        -- wei paid to the storm agent; null when recorded-but-unpaid
  PRIMARY KEY (competition_id)
);

-- One row per match/session (a single game to completion or timeout).
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  competition_id   TEXT NOT NULL REFERENCES competitions(id),
  status           TEXT NOT NULL CHECK (status IN ('lobby','seated','in_progress','settled','archived')),
  -- While the row is a lobby this holds the table's CAPACITY (TABLE_MAX_SIZE);
  -- at deal time it is rewritten to the number of seats actually filled, so a
  -- settled row always reports the size the game was really played at (18/D103).
  table_size       INTEGER NOT NULL DEFAULT 4,
  -- Epoch ms after which a lobby deals with whoever is seated. Set when the
  -- TABLE_MIN_SIZE-th agent sits, and never reset by later joins (18/D104-D105).
  lobby_deadline_at INTEGER,
  -- Epoch ms the lobby opened, used by the reaper (18/D108). Deliberately stored
  -- in the SAME clock domain as lobby_deadline_at — the orchestrator's injectable
  -- clock — rather than derived from created_at's SQL `now`, so lobby ageing is
  -- deterministic and testable instead of depending on the database's wall clock.
  lobby_opened_at   INTEGER,
  seed_commit_hash TEXT,                        -- published before the match (commit-reveal)
  seed_reveal      TEXT,                        -- published after the match
  winner_agent_id  TEXT REFERENCES agents(id),
  result_hash      TEXT,                        -- committed on-chain, see §8 contract
  commit_tx_hash   TEXT,                        -- commitSeed() tx, captured for the demo
  settle_tx_hash   TEXT,                        -- settle() tx, captured for the demo
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
  -- What this seat's game came to. Written once at settlement so an agent can be
  -- TOLD how its table ended instead of inferring it by diffing its own balance.
  place            INTEGER,                     -- 1 = winner; null until settled
  coin_delta       INTEGER,                     -- coins won/lost on this table
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

-- Claim tokens (sub-spec 09). A long-lived, unguessable bearer capability that
-- identifies which agent an owner is claiming. Handed to the owner as a claimUrl
-- (`/claim?token=...`); "works any time" (arena parity) — re-issued on demand.
CREATE TABLE IF NOT EXISTS agent_claims (
  claim_token TEXT PRIMARY KEY,               -- URL-safe random; the capability itself
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed')),
  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT,
  owner_id    TEXT REFERENCES owners(id)
);

-- OAuth transient (sub-spec 09). One row per "Sign in with X" attempt: the CSRF
-- `state` and the PKCE `code_verifier`, tied back to the claim being completed.
-- Consumed (deleted) on callback; short-lived.
CREATE TABLE IF NOT EXISTS oauth_flows (
  state         TEXT PRIMARY KEY,             -- OAuth CSRF state, echoed back on callback
  claim_token   TEXT NOT NULL REFERENCES agent_claims(claim_token),
  code_verifier TEXT NOT NULL,                -- PKCE verifier; its S256 challenge went to X
  redirect_uri  TEXT NOT NULL,                -- must match exactly at token exchange
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

-- Web accounts (sub-spec 11). A person signs up / signs in with GOOGLE; the
-- account may later CONNECT X (sub-spec 09's owners), which maps it to a public,
-- payout-bound identity. `owner_id` is null until the account connects X.
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,               -- 'acct_' + nanoid
  google_sub  TEXT NOT NULL UNIQUE,           -- Google's stable subject id
  email       TEXT,
  name        TEXT,
  owner_id    TEXT UNIQUE REFERENCES owners(id), -- set on "connect X"; one X ↔ one account
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Browser login sessions (sub-spec 11). Opaque token stored in an httpOnly cookie.
CREATE TABLE IF NOT EXISTS web_sessions (
  token       TEXT PRIMARY KEY,               -- opaque random; the cookie value
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- OAuth transient for the WEB flows (sub-spec 11): Google login and connect-X.
-- Kept separate from 09's `oauth_flows` (which is tied to an agent claim token).
CREATE TABLE IF NOT EXISTS web_oauth_flows (
  state         TEXT PRIMARY KEY,
  purpose       TEXT NOT NULL CHECK (purpose IN ('google','connect')),
  account_id    TEXT REFERENCES accounts(id), -- the account connecting X (null for google login)
  code_verifier TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

-- Lookups the hot paths depend on.
CREATE INDEX IF NOT EXISTS idx_web_sessions_account ON web_sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_session_players_agent ON session_players(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_competition_status ON sessions(competition_id, status);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_claims_agent ON agent_claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
