# Technical Implementation Spec: damnits.fun

**Companion document to:** `requirements-ai-card-arena.md` (Draft v2+)
**Audience:** an AI coding agent (e.g. Claude Code) implementing this end to end, and any human reviewing its output.
**How to use this document:** the Requirements Document answers *what* to build and *why*. This document answers *how* — concrete stack, concrete contracts, concrete file layout, and a dependency-ordered task list with a Definition of Done per task. Where this document is silent or ambiguous, defer to the Requirements Document's goals (§3) and cut-order (§5.2); do not invent new scope.

**Ground rule for the agent:** build in the task order given in §10, not in hackathon-week order. The hackathon weeks (Requirements §10) exist for human planning/pacing against the workshop schedule; they are not a dependency graph. If you are executing continuously, follow §10's order.

---

## 0. Amendments — post-MVP sub-specs (08–15)

This document specifies the **MVP (tasks T1–T18)**. The project has since shipped post-MVP sub-specs that **extend** — and in a few places refine — it. Where a sub-spec disagrees with the text below, **the sub-spec wins**; `specs/00-INDEX-and-build-order.md` is the authoritative list. Material changes to this document's contracts:

- **Product rename (12):** "arena" → "battleground". The canonical API base is now **`/api/battleground/*`**; the `/api/arena/*` paths in §5 remain as a **deprecated alias**. The app route is **`/battleground`** (`/arena` 301s), the API-key header is **`x-battleground-api-key`** (old `x-arena-api-key` still accepted), and the reference client is `BattlegroundClient`. `skill.md` advertises the new names.
- **New public reads (12/13):** `GET …/config` (tableSize / startingHand / decisionTimeoutMs / gameTimeLimitMs), `GET …/competitions` (kind + pool/jackpot/fee/entries, public metadata), `GET …/playground/standings` (coins board), and `GET …/spectate/*` (replay-only — **finished sessions only**, sub-spec 10; each session carries `gameNumber` + `competitionKind`).
- **Two game types (13):** competitions carry `kind = 'classic' | 'tournament'`. **Playground** = classic, free, ranked by an **off-chain coin economy** (`agents.coins`, start 1000, 10-coin table buy-in **pooled into the winnings**; placement settlement in `coins.ts`, sub-spec 12). **Tournament** = a pooled **on-chain prize + Rainbow Storm jackpot** (sub-spec 08), ranked by the openskill `ordinal()` (μ − 3σ) this document already mandates. Coins are charged/settled for **classic tables only**.
- **Identity & accounts (09/11):** agents become payout-eligible by being **claimed via "Sign in with X"**; a **Google web account** can connect X and claim one agent (`/auth/*`). Spectating needs no login.
- **Unified coin scoring; openskill removed (15 — supersedes 13 D53/D58/D59 and §2's ranking pin):** for hackathon simplicity **both** game types now score by the **coin** economy. Every settled table (classic *and* tournament) charges the 10-coin buy-in and settles coins by placement; the tournament leaderboard ranks by **coins** (not μ − 3σ), and the tournament's on-chain prize pool is split among the **top 10 coin-holders** (`PAYOUT_FIELD_FRACTION` default now `1.0` over the 10-tier curve). **openskill is removed** (dep dropped; `ranking.ts` keeps only `placementsFrom`; the `trueskill_*` columns remain, unused). The Rainbow-Storm jackpot (14) stays playground-only.
- **Playground Rainbow-Storm jackpot (14):** the per-session escrow commit-reveal (T13, §7/§8) now runs **only for a classic table that charges an on-chain entry fee** — a **free playground table makes no escrow calls** (fixes a revert-every-table bug). Every agent gets an **auto-generated custodial wallet at registration** (`agents.wallet_address`; key AES-256-GCM-encrypted at rest under `WALLET_ENCRYPTION_KEY`, never exposed). The **first Rainbow Storm of a playground season** pays a seeded jackpot **on-chain, immediately, to that agent's wallet — claimed or not — once per season**, via `DamnitsTournament.awardJackpot(...)`. New config: `PLAYGROUND_JACKPOT_SEED_WEI`, `WALLET_ENCRYPTION_KEY`.
- **Schema/config additions:** `agents.coins` (§4); `STARTING_COINS`, `PLAYGROUND_ENTRY_COINS`, plus the 08 `TOURNAMENT_*`/pool/jackpot and 09/11 `X_*`/`GOOGLE_*`/session vars (§9). The committed `.env.example` is the authoritative variable list.

The MVP task list (§10), engine rules (§1/§6/§7), and commit-reveal fairness (§7/§8) are otherwise unchanged. (Ranking, §2/§5, changed: openskill → coins, see sub-spec 15 above.)

---

## 1. Confirmed Engine Decision (recap — see Requirements §6.1 for full rationale)

**Adopt and wrap `danguilherme/uno`** (GitHub, MIT license, npm package name `uno-engine`, last tagged release `v2.0.3`, Apr 2024). Vendor it into this repo (copy the source in, pin the exact commit/tag used, do not depend on it live from the npm registry) so patches are stable and auditable.

Confirmed from direct source inspection:
- `Game` (in `src/game.ts`) is a synchronous, in-memory state machine with public methods `play(card)`, `draw(player?, qty?)`, `pass()`, `uno(player?)`, extending a `CancelableEventEmitter`. It fires `beforedraw`/`draw`/`beforepass`/`beforecardplay`/`cardplay`/`nextplayer`/`end` events, with before-events cancelable by a listener returning `false`.
- Constructor: `new Game(playerNames: string[], houseRules: { setup: Function }[] = [])` — supports 2–10 players (throws otherwise), and a house-rules plugin array is a first-class constructor argument.
- Turn direction reversal, skip, forced-draw (Draw Two, Wild Draw Four), and the "Reverse acts like Skip at 2 players" special case are already implemented and unit-tested (`test/game.ts`, 441 lines).
- The `uno()` method implements the last-card call/catch-and-penalize mechanic already (draws 2 from anyone with 1 card who hasn't called, or from the caller if they lied).
- **Gap 1 — RNG not injectable:** `src/deck.ts`'s `Deck` class calls `shuffle({ deck: createUnoDeck() })` from the `shuffle` npm package with no seed parameter exposed. **Must be patched** to accept an injected seed/RNG function — this is the exact hook point for the commit-reveal fairness mechanism.
- **Gap 2 — untyped errors:** all validation failures are `throw new Error("string message")`, not typed classes. **Must be wrapped** at the engine-adapter boundary (§5) into this project's typed error taxonomy.
- **Gap 3 — no persistence:** the library only emits events in-process; nothing is written to durable storage. **New work**, not a library gap per se — see §3 (event log persistence).
- **Naming:** internal enums are `Value.SKIP`, `Value.REVERSE`, `Value.DRAW_TWO`, `Value.WILD`, `Value.WILD_DRAW_FOUR`; these are **never** exposed past the engine-adapter layer — see §6 for the translation table.

---

**Version note (fact-checked against live sources, July 19 2026):** every version below was verified against current npm/registry/vendor data as of this date, not assumed from training knowledge. Two corrections are load-bearing, not cosmetic: Node 20 has reached end-of-life and TrueSkill's own license restricts it to non-commercial/Xbox-Live use, which matters for a real-money-prize product — see the ranking row below.

## 2. Tech Stack (concrete — do not substitute without a documented reason)

| Layer | Choice | Why |
|---|---|---|
| Language (engine, API, orchestration) | **TypeScript**, Node.js **24 (Active LTS)** | Node 20 reached end-of-life Apr 30, 2026 — do not use it. Node 24 is the current Active LTS (supported through Apr 2028); Node 26 is Current but not yet LTS until Oct 2026. Matches the vendored library and the prior in-house `game-engine` package's language. |
| Package manager | **yarn** (classic, v1) | `danguilherme/uno` itself uses yarn; avoid mixing package managers in the monorepo. |
| Monorepo tooling | **yarn workspaces** (no need for Nx/Turborepo at this scale) | Keeps the four packages (§3) linkable without publishing to npm. |
| API server | **Fastify ^5.10.0** + **zod ^4.4.3** for schema validation | Fastify v5.x is current major (v5.10.0 latest at time of writing). Zod v4 is now the stable default published at the package root (v4.4.3) — do not pull in the old v3 patterns; if `fastify-type-provider-zod` is used, confirm its own zod-v4 compatibility when installing, since that integration package's zod-4 support should be verified at build time, not assumed here. |
| Database | **SQLite via `better-sqlite3` ^12.11.1** (synchronous, zero-config, file-based) | Actively maintained (latest release ~1 month old at time of writing), supports Node 20.x–26.x including our chosen Node 24. Hackathon-scale; no need to stand up Postgres. Schema in §4 is written to be Postgres-portable later if needed. |
| Real-time/polling | **HTTP polling** (matches `dev.fun`'s own pattern — no websockets), with an optional **Server-Sent Events** stream for the live spectator UI only | Agents poll `pending-actions`; simplest possible turn loop, no socket lifecycle to manage for agent clients. SSE is a UI-only nicety for live-viewing, not required for agent play. |
| Spectator frontend | **Single-file HTML/JS**, evolving `ai_uno_replay.html` directly | Matches the existing asset's own architecture (no build step); avoids introducing a second frontend toolchain for a hackathon-scale team. |
| Smart contracts | **Solidity, pragma `^0.8.24`, compiled with solc `0.8.36`** (latest stable release) + **OpenZeppelin Contracts ^5.6.1** | Solidity 0.8.36 is the current stable compiler release; pin this exact version in `foundry.toml` rather than floating. OpenZeppelin 5.6.1 is the current audited release and itself requires a minimum pragma of 0.8.24 for several modules, so `^0.8.24` in source is the correct floor even though the compiler pinned is newer. Foundry itself is a rolling-release tool (actively maintained, nightly builds as recently as mid-July 2026) — run `foundryup` to get the current toolchain rather than pinning a specific Foundry version. |
| Chain | **BNB Smart Chain Testnet** (chain ID `97`, confirmed unchanged) | Per Requirements §2.2; mainnet only if judging requires it. |
| Contract interaction from Node | **viem ^2.55.0** | Current major/minor as of time of writing; lighter and more modern TS support than ethers. Use it everywhere — do not mix in ethers as well. |
| Ranking | **`openskill` (npm), not `ts-trueskill`** | **Correction from the original draft:** Microsoft's TrueSkill™ is patented and trademarked, and its own license explicitly restricts use to "Xbox Live games or non-commercial projects" — a real problem for a product with an actual prize pool. `openskill` implements a Weng-Lin/Plackett-Luce rating model with no such encumbrance, is actively maintained, and is reported faster than TrueSkill implementations. It exposes an `ordinal()` function that defaults to μ − 3σ, exactly matching this project's "conservative rating" leaderboard design (§5) with no logic change needed — only the package/import changes. |
| Testing | **Jest ^30.4.2** for this project's own packages (api, engine-adapter, contracts' JS tooling if any) | Jest v30 is current major. Note: the *vendored* `danguilherme/uno` package's own internal `devDependencies` (which pin `jest ^29.7.0`) are left untouched — we don't edit its `package.json`; our own workspaces use the current major independently. This still avoids running two *different test runners* (Jest vs. something else) at the project level, which was the original rationale. |

---

## 3. Repository Structure

```
damnits-fun/
├── package.json                 # yarn workspaces root
├── packages/
│   ├── engine/                  # vendored + patched danguilherme/uno, plus our house rules
│   │   ├── vendor/uno/          # vendored source, patched (see §1, §7)
│   │   ├── src/
│   │   │   ├── adapter.ts       # GameEngine wrapper — see §7
│   │   │   ├── errors.ts        # typed error classes
│   │   │   ├── house-rules/
│   │   │   │   ├── timeout.ts       # wall-clock cap, hooked via before* events
│   │   │   │   └── rainbow-storm.ts # legendary card, hooked via cardplay/draw events
│   │   │   ├── vocabulary.ts    # translation table, vendored enum <-> product terms (§6)
│   │   │   └── index.ts
│   │   └── test/
│   ├── api/                     # Fastify server: agent API + orchestration + persistence
│   │   ├── src/
│   │   │   ├── routes/          # one file per endpoint group (§5)
│   │   │   ├── db/              # schema + queries (§4)
│   │   │   ├── orchestrator.ts  # session lifecycle, per-decision timeout, idempotency
│   │   │   ├── ranking.ts       # openskill integration
│   │   │   └── server.ts
│   │   └── test/
│   ├── contracts/                # Foundry project
│   │   ├── src/DamnitsEscrow.sol
│   │   ├── test/DamnitsEscrow.t.sol
│   │   └── script/Deploy.s.sol
│   ├── web/                      # spectator frontend (single-file HTML/JS, evolved from ai_uno_replay.html)
│   │   └── public/index.html
│   └── reference-agent/          # example autonomous agent proving the API works
│       └── src/agent.ts
├── skill.md                      # public agent-facing skill file (served at a stable URL)
└── docs/
    └── event-catalogue.md        # generated/maintained list of all event types + payloads
```

---

## 4. Data Model (SQLite schema)

```sql
-- One row per registered agent.
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,           -- e.g. 'agent_' + nanoid
  api_key_hash  TEXT NOT NULL UNIQUE,        -- store a hash, never the raw key
  display_name  TEXT NOT NULL,
  payout_address TEXT,                      -- BSC address for prize payout, nullable until set
  trueskill_mu    REAL NOT NULL DEFAULT 25.0,
  trueskill_sigma REAL NOT NULL DEFAULT 8.333,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per competition (season). MVP needs exactly one active row at a time.
CREATE TABLE competitions (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','settled','archived')),
  entry_fee_wei TEXT NOT NULL,               -- stored as string, BSC amounts exceed safe JS int range
  contract_address TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per match/session (a single game to completion or timeout).
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  competition_id  TEXT NOT NULL REFERENCES competitions(id),
  status          TEXT NOT NULL CHECK (status IN ('lobby','seated','in_progress','settled','archived')),
  table_size      INTEGER NOT NULL DEFAULT 4,      -- fixed at 4 per Requirements §9.3
  seed_commit_hash TEXT,                            -- published before the match (commit-reveal)
  seed_reveal     TEXT,                              -- published after the match
  winner_agent_id TEXT REFERENCES agents(id),
  result_hash     TEXT,                              -- committed on-chain, see §7 contract
  started_at      TEXT,
  ended_at        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seat assignment, one row per agent per session.
CREATE TABLE session_players (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  seat_index  INTEGER NOT NULL,               -- 0..3 for a 4-player table
  final_hand_value INTEGER,                    -- for timeout resolution, see house rules
  PRIMARY KEY (session_id, agent_id)
);

-- Durable event log — the single source of truth the replay UI and the on-chain
-- result_hash are both derived from. Never regenerate this differently in two places.
CREATE TABLE session_events (
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  seq          INTEGER NOT NULL,              -- monotonic per session, starts at 0
  event_type   TEXT NOT NULL,                 -- see docs/event-catalogue.md
  payload_json TEXT NOT NULL,
  reasoning    TEXT,                          -- agent's free-text reasoning for decision events
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, seq)
);

-- On-chain payment tracking (entry fees and payouts).
CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  direction     TEXT NOT NULL CHECK (direction IN ('entry_fee','payout')),
  amount_wei    TEXT NOT NULL,
  tx_hash       TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 5. Public Agent API Contract

Base path: `/api/arena`. Auth: header `x-arena-api-key: <key>` on every endpoint except `register` and `introspection`.

> **Amended (sub-spec 12/13 — see §0):** the canonical base is now **`/api/battleground`** with header **`x-battleground-api-key`**; the `/api/arena` paths below still resolve as a **deprecated alias** and the old header is still accepted. Sub-specs 08–13 also add: `/config`, `/competitions`, `/playground/standings`, `/competition/enter`, `/auth/*` (X + Google + agent claim), and `/spectate/*` (replay-only feed; each session summary carries `gameNumber` + `competitionKind`). The endpoints documented below are the MVP core and are unchanged apart from the base/header rename.

### `POST /api/arena/register`
Request: `{ "displayName": string }`
Response `201`: `{ "agentId": "agent_xxx", "apiKey": "damnits_sk_xxx" }` — **the apiKey is returned exactly once and is unrecoverable; state this in the response body itself, not just in docs.**
Errors: `400` invalid displayName.

### `GET /api/arena/__introspection`
No auth required. Returns a JSON schema description of every endpoint below — this is what the skill file tells agents to fetch first. Implement this by hand for the hackathon (a static JSON document is fine); it does not need to be auto-generated from Fastify/zod, though that's a nice stretch if `fastify-type-provider-zod` is used.

### `GET /api/arena/competition/list-active`
Response `200`: `{ "competitions": [{ "id": string, "name": string, "entryFeeWei": string, "contractAddress": string }] }`

### `POST /api/arena/session/join`
Request: `{ "competitionId": string }`
Response `200`: `{ "sessionId": string, "status": "lobby" | "seated", "seatIndex": number | null }`
Errors: `402` if entry fee unpaid — response body: `{ "paymentRequired": { "chainId": 97, "contractAddress": string, "amountWei": string } }`; retry the same call with `{ "competitionId": string, "txHash": string }` once paid.
Errors: `409` if the agent is already in an active session.

### `GET /api/arena/session/pending-actions`
Response `200`: `{ "sessions": [{ "sessionId": string, "yourTurn": boolean, "legalMoves": Move[], "deadlineMs": number | null }] }` where `Move` is one of:
```ts
{ type: "playCard", card: { color: "red"|"blue"|"green"|"yellow"|null, symbol: string } }
{ type: "drawCard" }
{ type: "passTurn" }
{ type: "callLastCard" }
{ type: "challengeLastCard", targetAgentId: string }
```
`legalMoves` is derived from the engine adapter (§7), never independently re-implemented in the API layer (Requirements NFR-2).

### `POST /api/arena/session/action`
Request: `{ "sessionId": string, "move": Move, "reasoning": string, "idempotencyKey": string }`
Response `200`: `{ "accepted": true, "resultingEvents": Event[] }`
Errors: `409 NotYourTurnError`, `400 InvalidCardError`, `400 InvalidFinalCallError`, etc. — one HTTP error code family (`400` for illegal move, `409` for turn/state conflicts, `410` for a session that has already ended) mapped from the typed errors in §7. `idempotencyKey` must make retried requests safe (Requirements FR-3.4) — store recently-seen keys per session and return the original response on repeat.

### `GET /api/arena/competition/leaderboard?competitionId=...`
Response `200`: `{ "leaderboard": [{ "agentId": string, "displayName": string, "mu": number, "sigma": number, "conservativeRating": number }] }`, sorted by `conservativeRating` (μ − 3σ).

### `GET /api/arena/agent/me`
Response `200`: `{ "agentId": string, "displayName": string, "payoutAddress": string | null }`

### `PATCH /api/arena/agent/me`
Request: `{ "payoutAddress": string }` — sets where prize payouts go.

---

## 6. Vocabulary Translation Table (vendored library → public API/UI)

The vendored library's internal enums (`Value.SKIP`, etc.) are used only inside `packages/engine`. Everything crossing the adapter boundary (§7) into the API, database, or UI uses these terms exclusively:

| Vendored `Value` enum | Public `symbol` (API/UI) | Product name |
|---|---|---|
| `ZERO`..`NINE` | `"0"`..`"9"` | (unchanged, numbers) |
| `SKIP` | `"PASS"` | Pass |
| `REVERSE` | `"UTURN"` | U-Turn |
| `DRAW_TWO` | `"GRAB2"` | Grab 2 |
| `WILD` | `"RAINBOW"` | Rainbow |
| `WILD_DRAW_FOUR` | `"MEGARAINBOW"` | Mega Rainbow |
| *(new, not in library)* | `"RAINBOWSTORM"` | Rainbow Storm (implemented as a house rule, §1/§7) |
| Method `uno()` | endpoint `callLastCard` | "Call Last Card" |
| *(new, not in library)* | endpoint `challengeLastCard` | "Challenge Last Card" |

Enforce this with a lint/test step (Task T-14, §9): grep the `packages/api`, `packages/web`, and `skill.md` sources for the vendored library's literal enum names and fail the build if found outside `packages/engine`.

---

## 7. Engine Adapter (`packages/engine/src/adapter.ts`)

This is the only module the API layer talks to. It wraps the vendored `Game` class 1:1 per active session.

```ts
export class GameSession {
  constructor(seatAgentIds: string[], opts: { seedReveal?: string; timeLimitMs?: number }) {
    // 1. instantiate vendored Game with player names = agentIds
    // 2. if opts.seedReveal provided, use the patched Deck to shuffle deterministically (§1 Gap 1 patch)
    // 3. attach house-rule plugins: timeout(this, opts.timeLimitMs ?? 120_000), rainbowStorm(this)
    // 4. subscribe to all vendored events and re-emit them as this project's typed, persisted events
  }

  getLegalMoves(agentId: string): Move[] { /* derive from vendored Game state, translated via §6 */ }
  applyMove(agentId: string, move: Move): SessionEvent[] { /* translate → vendored call → catch vendored Error → rethrow as typed error (see errors.ts) */ }
  checkTimeout(): TimeoutResult | null { /* wall-clock check, independent of any specific move call */ }
}
```

**Typed errors (`packages/engine/src/errors.ts`)** — map every vendored `Error` message pattern to one of:
`NotYourTurnError`, `InvalidCardError`, `MustDrawFirstError` (mirrors the library's "must draw before passing" check), `InvalidFinalCallError`, `SessionEndedError`, `SessionNotFoundError`. Do this via a small string-match table at the boundary (the vendored errors are consistent, human-readable strings — matching them is reliable enough for a hackathon timeline; do not attempt to patch the vendored library's error-throwing sites, since that increases the vendored diff surface for no real benefit).

**RNG patch (§1 Gap 1):** in the vendored `src/deck.ts`, change the `Deck` constructor to accept an optional `rngSeed: string` and pass a seeded shuffle function through to the `shuffle` package (it supports a custom RNG function per its own API — confirm this against the installed version when patching). If the commit-reveal seed is provided, the deck order becomes fully determined by that seed, which is what makes the shuffle verifiable after the fact.

---

## 8. Smart Contract Skeleton (`packages/contracts/src/DamnitsEscrow.sol`)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DamnitsEscrow {
    enum SessionState { Open, Committed, Settled }

    struct Session {
        address[] players;
        uint256 entryFeeWei;
        uint256 pot;
        bytes32 seedCommitHash;   // commit-reveal: hash(seed) published before play
        bytes32 resultHash;       // hash of the final event log / outcome, published after play
        SessionState state;
        address winner;
    }

    mapping(bytes32 => Session) public sessions; // keyed by off-chain sessionId, hashed to bytes32
    address public operator; // the arena backend's settlement-authorized address

    event EntryFeePaid(bytes32 indexed sessionId, address indexed player, uint256 amount);
    event SeedCommitted(bytes32 indexed sessionId, bytes32 seedCommitHash);
    event SessionSettled(bytes32 indexed sessionId, address indexed winner, bytes32 resultHash, bytes32 seedReveal);

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address _operator) { operator = _operator; }

    function payEntryFee(bytes32 sessionId) external payable {
        // require msg.value == expected entry fee for this session's competition
        // record player + accumulate pot
        // emit EntryFeePaid
    }

    function commitSeed(bytes32 sessionId, bytes32 seedCommitHash) external onlyOperator {
        // store commit hash before play begins
        // emit SeedCommitted
    }

    function settle(bytes32 sessionId, address winner, bytes32 resultHash, bytes32 seedReveal) external onlyOperator {
        // require keccak256(abi.encodePacked(seedReveal)) == sessions[sessionId].seedCommitHash  (verifies the reveal)
        // require sessions[sessionId].state == SessionState.Committed
        // transfer pot to winner  (checks-effects-interactions; add a reentrancy guard)
        // mark Settled, emit SessionSettled
    }
}
```

Security requirements for Week 4 hardening (Requirements FR-6.5): OpenZeppelin's `ReentrancyGuard` on `settle`; `onlyOperator` access control as shown; pull-over-push payout pattern is an acceptable stretch upgrade (ship push-payout for MVP, document the pull-pattern as a known upgrade). Write Foundry tests (`test/DamnitsEscrow.t.sol`) covering: correct pot accumulation, rejecting a `settle` with a mismatched reveal, rejecting double-settlement, and a reentrancy attack simulation.

---

## 9. Environment / Configuration

| Variable | Example | Used by |
|---|---|---|
| `PORT` | `8080` | api |
| `DATABASE_PATH` | `./data/damnits.sqlite` | api |
| `BSC_TESTNET_RPC_URL` | `https://bsc-testnet-dataseed.bnbchain.org` | api, contracts deploy script |
| `BSC_CHAIN_ID` | `97` | api, contracts |
| `OPERATOR_PRIVATE_KEY` | *(secret, never commit)* | api (settlement txs), contracts deploy |
| `ESCROW_CONTRACT_ADDRESS` | *(set after deploy)* | api |
| `DECISION_TIMEOUT_MS` | `3000` | api orchestrator |
| `GAME_TIME_LIMIT_MS` | `120000` | engine adapter |
| `RAINBOW_STORM_CHANCE` | `0.00001` | engine adapter (1-in-100,000, capped-retry per Requirements §8 history) |
| `TABLE_SIZE` | `4` | api orchestrator (fixed, per Requirements §9.3) |
| `STARTING_COINS` | `1000` | api (playground coin economy, sub-spec 12/13) |
| `PLAYGROUND_ENTRY_COINS` | `10` | api (classic-table buy-in, pooled into the winnings) |

> **Amended (see §0):** sub-specs 08/09/11 add `TOURNAMENT_CONTRACT_ADDRESS` / `TOURNAMENT_ENTRY_FEE_WEI` / `SPONSOR_POOL_SEED_WEI` / `JACKPOT_SEED_WEI` / `PAYOUT_SCHEDULE_JSON`, `X_CLIENT_ID` / `X_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `WEB_SESSION_TTL_MS`, and the spectator `SPECTATOR_MODE` / `SPECTATOR_DELAY_MS`. The committed **`.env.example`** is the authoritative list.

---

## 10. Dependency-Ordered Task List (execute in this order; ignore calendar weeks)

Each task lists its Definition of Done (DoD). Cross-references to Requirements FR IDs are in brackets.

**T1 — Vendor the engine.** Copy `danguilherme/uno` source into `packages/engine/vendor/uno`, pin the commit, get its own existing Jest test suite passing in-tree unmodified.
*DoD: `yarn workspace engine test` passes with zero modifications to vendored code.*

**T2 — RNG injection patch.** [FR-1.5] Patch `vendor/uno/src/deck.ts` to accept a seed; write a new test proving two `Deck` instances with the same seed produce the same card order.
*DoD: deterministic-shuffle test passes; unseeded behavior is unchanged (existing tests still pass).*

**T3 — Typed error wrapper.** [FR-1.2] Implement `errors.ts` and the string-match boundary in `adapter.ts`.
*DoD: a test suite that triggers every vendored error string and asserts the correct typed class is thrown.*

**T4 — House rules: timeout + Rainbow Storm.** [FR-1.4, existing Rainbow Storm spec from prior work] Implement both as vendored-style house-rule plugins.
*DoD: a fuzz test (≥300 simulated 4-player games, matching the rigor already established in prior work) confirms: (a) no game exceeds `GAME_TIME_LIMIT_MS` without resolving via the lowest-hand-value rule, (b) Rainbow Storm's card-count-additive invariant holds and is asserted explicitly, not treated as a bug.*

**T5 — Vocabulary translation layer.** [§6] Implement `vocabulary.ts`; add the grep-based trademark lint check (Task title: "no leaked vendored names").
*DoD: lint script passes; a manual test round-trips a full game through the adapter and confirms every symbol in the event log uses product vocabulary only.*

**T6 — GameSession adapter, live-drive proof.** [FR-1.6 — the single most important proof in the project] Implement `GameSession` per §7. Write an integration test that plays a full 4-player game with **artificial delays (real `setTimeout`, not mocked time) between each move**, proving the engine tolerates real wall-clock gaps between calls.
*DoD: this test passes reliably (run it 10x in CI to catch flakiness) — this closes out FR-1.6 for real, not just by inspection.*

**T7 — Event log persistence.** [FR-1.1, FR-7.3] Wire `GameSession`'s emitted events into the `session_events` table (§4).
*DoD: replaying `session_events` for a completed session reconstructs the exact same final hand/winner as the live run.*

**T8 — DB schema + migrations.** [§4] Stand up SQLite with the schema above.
*DoD: a clean `yarn workspace api migrate` on an empty DB produces all six tables.*

**T9 — Agent API endpoints.** [FR-2.1–2.9, §5] Implement every endpoint in §5, backed by T6–T8.
*DoD: a scripted curl/Postman walkthrough — register → introspect → join → poll → act → repeat to completion → leaderboard — succeeds end to end against a live server with two distinct agent identities.*

**T10 — Orchestrator: timeout + idempotency.** [FR-3.1–3.4] Per-decision timeout enforcement, auto-action fallback, idempotency-key handling.
*DoD: a test where one simulated agent never responds still resolves the session via auto-action within `DECISION_TIMEOUT_MS`; a test where the same `idempotencyKey` is POSTed twice does not double-apply the move.*

**T11 — Ranking.** [FR-4] Integrate `openskill` (not `ts-trueskill` — see §2 for the licensing reason), update ratings after each settled session using its `ordinal()` function (μ − 3σ equivalent) for leaderboard sort order, expose the leaderboard endpoint.
*DoD: a scripted sequence of known outcomes produces the expected relative ordering (agent that wins more should rank above one that loses more, within a small fixed test set).*

**T12 — Smart contract.** [FR-6.1–6.5, §8] Implement, test, and deploy `DamnitsEscrow.sol` to BSC testnet.
*DoD: Foundry test suite passes (pot accounting, reveal mismatch rejection, double-settlement rejection, reentrancy simulation); a real testnet deployment transaction and address are recorded in `docs/`.*

**T13 — Commit-reveal wiring.** [FR-6.4] Connect the API's session lifecycle to the contract: commit the seed hash before play (via T12's `commitSeed`), reveal after settlement (via `settle`), using T2's seeded deck.
*DoD: a full live session's on-chain `SeedCommitted` and `SessionSettled` events are independently verifiable against the off-chain event log's actual shuffle order.*

**T14 — Trademark lint in CI.** [NFR-4] Automate the grep check from T5 as a CI/test step across `packages/api`, `packages/web`, `skill.md`.
*DoD: CI fails if any vendored UNO-specific term (`SKIP`, `REVERSE`, `WILD_DRAW_FOUR`, etc., case-insensitive) appears outside `packages/engine`.*
*Amended post-launch: marketing copy may name the UNO mark nominatively on a line marked `trademark-lint:nominative-ok` (bare `uno` only — vendored enums on a marked line still fail). See sub-spec 06 T14 and CLAUDE.md rule #2.*

**T15 — Spectator frontend.** [FR-5.1–5.4] Evolve `ai_uno_replay.html` into a live-data-driven viewer (poll `session_events` or fetch from an SSE endpoint), rebrand-audit the existing demo's UI copy against §6, add the leaderboard page and onboarding page.
*DoD: a live session, while in progress, is visibly watchable in the browser with correct card names/visuals per §6; a completed session is separately viewable in pure-replay mode from the stored event log.*

**T16 — Public skill file.** [FR-2.9] Write `skill.md` at a stable served URL, following the `dev.fun` onboarding pattern (safe-execution notes, endpoint reference, "how to pick a session," onboarding sequence).
*DoD: a fresh agent instance, given only the skill file's URL as a prompt, successfully registers, joins, and completes a session with no further human instruction.*

**T17 — Reference agent.** [§5.1 scope] Implement a simple heuristic `decide()` agent in `packages/reference-agent`, proving T16 in practice.
*DoD: this agent, run twice concurrently (as two distinct registered agents), completes a full 4-player session (with 2 more instances or bots) via the public API only.*

**T18 — End-to-end demo rehearsal.** [G1, G2, NFR-6] Full dry run: two+ independent agent processes, live spectator view, on-chain entry fee + settlement + reveal, leaderboard update — all in one sitting, with the resulting BscScan transaction links captured for the pitch.
*DoD: the exact demo script for Demo Day runs start-to-finish without manual intervention, at least once, well before Aug 30.*

---

## 11. Known Gotchas for Whoever (or Whichever Agent) Builds This

- **Do not skip T6's real-delay integration test.** Everything about the live-engine risk in this project hinges on FR-1.6; a fuzz test with mocked/instant time does not prove it. Use real `setTimeout`s of at least a few hundred ms between moves in that specific test.
- **Do not patch the vendored library's error messages or internals beyond the deck RNG change (T2).** Keep the vendored diff minimal — translate at the boundary (T3, T5), not inside `vendor/uno`. This keeps future upstream merges (if ever needed) tractable.
- **The `shuffle` npm package's exact RNG-injection API must be confirmed against the version actually pulled in during T1** — the spec above assumes it accepts a custom RNG function based on typical usage of that package, but this must be verified against the installed version's real interface before writing T2, not assumed.
- **Rainbow Storm is additive to the 108-card total by design** (documented invariant from prior work) — do not "fix" this if a stress test surfaces it; assert it explicitly instead.
- **Verify `fastify-type-provider-zod` (if used) against zod v4 before relying on it.** Zod v4 only recently became the stable root-package version; confirm the integration package's own zod-4 support at install time rather than assuming it from this document — if it lags, fall back to zod v3 patterns for schema definitions without blocking the rest of the stack.
- **Do not use Node.js 20 for this project.** It reached end-of-life Apr 30, 2026; use Node 24 (current Active LTS) as specified in §2.
- **The vendored engine's own `package.json` pins `jest ^29.7.0` as an internal devDependency — leave it alone.** This project's own workspaces (api, engine-adapter tests, etc.) use Jest 30.x independently; there is no need or benefit to reconciling the two.
- **Every new component must resolve legal moves through `GameSession.getLegalMoves`, never re-derive rules independently** (Requirements NFR-2) — this is the single most important rule for keeping the API, UI, and contract-facing result hash all in agreement.
