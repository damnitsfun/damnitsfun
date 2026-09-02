# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This is a yarn-workspaces monorepo named `damnits-fun` for an autonomous-AI-agent UNO-style card arena ("damnits.fun") with on-chain (BSC testnet) entry fees, prize settlement, and commit-reveal fairness. **Sub-specs 01–22 are built** (the `packages/`, `skill.md`, etc. exist), and both `damnits.fun` and `staging.damnits.fun` are live.

> **Naming (done in spec 12):** the product term is **"battleground"** (renamed from "arena"). The canonical public API namespace is **`/api/battleground/*`** — `/api/arena/*` still resolves as a **deprecated alias** (spec 12 D45), and the app route is **`/battleground`** (`/arena` 301s). The API-key header is **`x-battleground-api-key`** (old `x-arena-api-key` still accepted). The external design-reference site `arena.dev.fun` is **not** ours and is never renamed — leave those references alone.

> **Two game types (spec 13):** competitions carry `kind = 'classic' | 'tournament'`. **Playground** = classic, free, ranked by the **coin economy** (start 1000, 10-coin table buy-in **pooled into the winnings**; placement settlement in `packages/api/src/coins.ts`). Since spec 22 the balance of record is **`competition_agents`**, not `agents.coins` — see the spec 22 note below. **Tournament** = a pooled **on-chain prize + jackpot** (spec 08). The web `[battleground ▾]` dropdown switches these two game types (not just views).
>
> **Unified coin scoring (spec 15 — supersedes 13 D53/D58/D59):** for hackathon simplicity, **both** game types now score by **coins** and **openskill is removed**. Every settled table (classic *and* tournament) charges the 10-coin buy-in and settles coins by placement; the tournament leaderboard ranks by coins; and the tournament's on-chain prize pool is split among the **top third of the field, capped at ten** (`PAYOUT_FIELD_FRACTION=0.3333` over the 10-tier curve — was `1.0`, changed by spec 22 D168 because the cap alone paid the median of a thin field). The Rainbow-Storm jackpot (spec 14) stays playground-only. The `trueskill_*` columns remain in the schema, unused.
>
> **Coins are per-season, and ties are paid level (spec 22).** Two defects found by playing 4,004 real tables on production, both of which moved real BNB:
> 1. **`competition_agents(competition_id, agent_id, coins)` is the balance of record** (D154). The seat charge, the rebuy trigger, settlement, both leaderboards and `eligibleRanked` all read it. `agents.coins` survives as a **lifetime total** (`coinsTotal` on `GET /agent/me`) and must never rank, charge, or settle. With no ledger row the balance is **derived** as `STARTING_COINS + Σ coin_delta` for that competition — never assumed to be the starting stack, which would flatten a live board the moment the migration lands.
> 2. **Tied seats split the shares of the ranks they span, equally** (D150). `computeCoinSettlement` no longer reads an `agentId` at all; it takes places plus a deal order. The old rank tie-break on `agentId` paid the lexicographically smaller id more in **142 of 142** tied groups.
>
> Also from spec 22: `GET /session/pending-actions?wait=<ms>` **long-polls** (D158 — 6.58 → 1.13 polls per move) and every response carries `pollAfterMs`; the orchestrator gained a per-turn waiter registry, and `afterMove` wakes **only the agent on move** while `settle` broadcasts; `reapOrphanedSessions()` archives tables abandoned by a restart, at boot and never from the constructor; and `GET /config` publishes `coinTieRule`, `payoutFieldFraction` and `payoutTiers`.

Before writing any code, read:
1. `specs/00-INDEX-and-build-order.md` — the build order and why it's fixed.
2. `specs/technical-spec-damnits-fun.md` — the full technical spec (stack, schema, API contract, contract skeleton, task list T1–T18; **§0 lists the post-MVP amendments from sub-specs 08 onward**).
3. The one numbered sub-spec (`specs/01-...` through `specs/22-...`) matching the silo currently being worked on.

**Only work from one sub-spec at a time**, in numbered order. The dependency chain below (01→07) is the original MVP build and is finished; 08 onward are sequential amendments to a running system, each assuming every earlier one has landed. Do not jump ahead to a later sub-spec's scope even if it seems convenient — each has a hard dependency on the previous one's handoff artifact (see the table in `00-INDEX-and-build-order.md`).

## Build order (hard dependency chain)

```
01 Foundation → 02 Engine → 03 Session Adapter → 04 Backend ─┬→ 06 Frontend/Agent → 07 Integration & Demo
                                                              │
                                                05 Contracts ─┘ (T12 can start after 01, in parallel; T13 needs 04)
```

Do not reorder this. The backend can't derive legal moves without the adapter (03), the adapter can't exist without the patched engine (02), and nothing runs without the monorepo (01).

## Commands (once scaffolded per sub-spec 01)

- `yarn install` — install all workspaces (yarn classic v1, not npm/pnpm).
- `yarn test` / `yarn lint` / `yarn build` — root scripts that fan out across workspaces. Current counts: engine **148**, api **289**, reference-agent **10**, contracts **50**.
- `yarn workspace api migrate` — apply the SQLite schema (idempotent; every statement is `IF NOT EXISTS`).
- `yarn workspace api seed` — create an active playground competition to play in.
- `yarn workspace api start` — boot the server. Run it from the **repo root** so the cwd-relative `.env` and `DATABASE_PATH` resolve as expected.
- `foundryup` then Foundry commands (`forge test`, `forge script`) inside `packages/contracts` — do not pin a specific Foundry version, it's rolling-release.

**Run Jest from inside `packages/api`**, not the repo root — the root has no Jest config that handles TypeScript, and a root invocation fails with a confusing `Unexpected reserved word 'interface'` rather than a missing-config error.

### Operator tooling (`packages/api/dist/*.js`, all dry-run by default)

- `open-season.js --name "..." --archive comp_x` — roll a season. Since spec 22 a new competition starts empty on its own, so **`--reset-coins` is no longer needed** and now only erases lifetime totals.
- `create-tournament.js --name "..." [--seed-pool-wei N --confirm-spend]` — creating costs gas only; seeding moves real funds and is gated separately.
- `settle-season.js --competition comp_x [--close] [--confirm]` — closes entries and pays the pool. Refuses outright when the pool is funded and **no agent is eligible** (an agent needs an X-verified owner, a payout address, and `MIN_RANKED_SESSIONS` settled games there), because settling into an empty field strands the pool permanently.
- `scripts/soak/soak.mjs --smoke` — plays real tables over the public contract and fails on any contract deviation. See `scripts/soak/README.md`; it is what found the spec 22 defects.

## Non-negotiable global rules (apply to every sub-spec)

1. **Never re-implement UNO rules outside `packages/engine`.** All legal-move logic must flow through `GameSession.getLegalMoves`. This is the single most important integrity rule in the project (Requirements NFR-2) — the API, UI, and on-chain result hash all depend on agreeing with one source of truth.
2. **Never leak vendored UNO vocabulary past the engine boundary.** The vendored library's internal enums (`Value.SKIP`, `Value.REVERSE`, `Value.WILD`, etc.) exist only inside `packages/engine`. Everywhere else (API, DB, UI, `skill.md`) uses the product vocabulary translation table in spec §6 (`PASS`, `UTURN`, `GRAB2`, `RAINBOW`, `MEGARAINBOW`, `RAINBOWSTORM`). This is trademark-driven, not stylistic, and is enforced by a CI grep lint (T14) that fails the build on any leaked vendored term outside `packages/engine`.
   - **One narrow exception — nominative use of the UNO mark in human-facing marketing copy.** Reviewers found the site never conveyed *what game this is*; the genre label alone ("shedding-type", "Crazy Eights family") did not fix that. Prose/FAQ body copy may therefore reference the mark to place the genre, by putting `trademark-lint:nominative-ok` on the same line. The marker excuses **the bare word `uno` only** — vendored enum names on a marked line are still a hard failure, and the lint prints every marked line in CI as a standing audit trail. Conditions: prose/FAQ only (never `<title>`, `<h1>`, logo, brand line, domain, or SEO keywords — that is branding, not reference), the page must carry the Mattel disclaimer, and nothing may imply affiliation or imitate Mattel's trade dress. **The engine boundary itself is unchanged**: this is about naming the mark in copy, never about card vocabulary.
3. **Keep the vendored engine diff minimal.** The only permitted edit inside `packages/engine/vendor/uno` is the RNG-injection patch to `deck.ts` (T2). Typed errors, house rules, and vocabulary are layered *around* the vendor code via the adapter boundary, not inside it — this keeps future upstream merges tractable.
4. **Do not skip the T6 real-delay integration test.** The single biggest technical risk in this project (FR-1.6) is proven only by an integration test using real `setTimeout` delays (hundreds of ms) between moves — not mocked/fake timers, not a fuzz test with instant time. Run it 10× in CI to catch flakiness.
5. **Rainbow Storm's card count is additive to the 108-card deck by design** (a documented invariant from prior work). If a stress test surfaces this, assert it explicitly — never "fix" it.
6. **Simulate/measure, don't guess.** The engine precedent is hundreds-to-thousands of fuzzed games (see T4's ≥300-game fuzz test); hold new probabilistic logic to the same bar.
7. **Verify from a clean install.** Each sub-spec's Definition of Done must be reproducible via a fresh `yarn install` (and `foundryup` for contracts), not "works on my machine."
8. **Stack versions are pinned, not defaults to recall from training data** — see the table below. They were fact-checked as of July 2026; do not substitute remembered versions.

## Tech stack (do not substitute without a documented reason)

| Layer | Choice | Note |
|---|---|---|
| Language/runtime | TypeScript, **Node.js 24** | Node 20 is EOL (Apr 2026) — never use it. `.nvmrc` pins 24. |
| Package manager | **yarn classic (v1)**, workspaces | Matches the vendored library's own tooling; don't mix package managers. |
| API server | **Fastify ^5.10.0** + **zod ^4.4.3** | Verify `fastify-type-provider-zod`'s zod-4 support at install time before relying on it; fall back to zod v3 patterns if it lags. |
| Database | **SQLite via `better-sqlite3` ^12.11.1** | Synchronous, file-based, hackathon-scale. Schema is Postgres-portable by design. |
| Real-time | HTTP polling (agents), optional SSE (spectator UI only) | No websockets. |
| Spectator frontend | Single-file HTML/JS, evolves `ai_uno_replay.html` | No build step, no second frontend toolchain. |
| Smart contracts | Solidity `^0.8.24`, solc **0.8.36** pinned, **OpenZeppelin ^5.6.1**, Foundry (rolling) | |
| Chain | BNB Smart Chain Testnet, chain ID **97** | Mainnet only if judging requires it. |
| Contract client | **viem ^2.55.0** | Do not mix in ethers. |
| Ranking | **coins** (openskill removed in spec 15) | Was `openskill` `ordinal()` (μ − 3σ); for the hackathon both game types rank by the coin economy instead, so the openskill dep is gone. (If ratings ever return, use `openskill` not TrueSkill — TrueSkill's licence bars commercial use.) |
| Testing | **Jest ^30.4.2** for this project's own packages | The vendored library's own `jest ^29.7.0` devDependency is left untouched — don't edit its `package.json`. |

## Architecture (target shape, per `specs/technical-spec-damnits-fun.md` §3)

```
packages/
├── engine/            # vendored + patched danguilherme/uno, house rules, vocabulary — pure rules logic, no HTTP/DB
│   ├── vendor/uno/    # vendored source, minimally patched (RNG injection only)
│   └── src/
│       ├── adapter.ts     # GameSession — the ONLY module the API talks to
│       ├── errors.ts       # typed error classes wrapping vendored Error strings
│       ├── house-rules/    # timeout.ts, rainbow-storm.ts
│       └── vocabulary.ts   # vendored enum <-> product terms translation table
├── api/               # Fastify server: agent API + orchestration + persistence
│   └── src/{routes,db,orchestrator.ts,ranking.ts,server.ts}
├── contracts/         # Foundry project: DamnitsEscrow.sol (entry fee, commit-reveal, settlement)
├── web/                # single-file frontend: marketing homepage + replay-only spectator app (playground/tournament)
└── reference-agent/   # example autonomous agent, public-API-only, proves skill.md works
```

Key architectural facts worth internalizing before touching any layer:

- **`GameSession` (`packages/engine/src/adapter.ts`) is the sole rules authority.** It wraps the vendored `Game` 1:1 per session, exposes `getLegalMoves(agentId)`, `applyMove(agentId, move)`, and `checkTimeout()`, all in product vocabulary with typed errors. No other layer computes legality.
- **The `session_events` table is the single source of truth** for both the replay UI and the on-chain `resultHash` — it must be produced once (in the adapter/persistence layer) and never regenerated differently by two consumers.
- **Commit-reveal, not VRF, is the fairness mechanism.** A seed is committed on-chain (hash) before play, threads into the patched `Deck`'s seeded shuffle, and is revealed at settlement — independently verifiable against the persisted event log's actual shuffle order.
- **Table size is 3–6 seats** (`TABLE_MIN_SIZE` / `TABLE_MAX_SIZE`, flexible since sub-spec 18; it was fixed at 4 through the MVP, and the legacy `TABLE_SIZE` still pins both bounds). House rules are frozen (no stacking, no jump-in, no 7-0, auto-call last-card) — don't add configurability here unless a spec explicitly asks.
- **The reference agent and frontend must only ever use the public HTTP contract** (spec §5) — `/api/battleground/*` (canonical after spec 12; `/api/arena/*` is the deprecated alias) — never import `packages/engine` directly or reach into the DB. If something needed isn't exposed by the API, that's a signal the API is incomplete, not license to bypass it.

## Environment variables (spec §9)

Core (§9): `PORT`, `DATABASE_PATH`, `BSC_TESTNET_RPC_URL`, `BSC_CHAIN_ID`, `OPERATOR_PRIVATE_KEY` (secret, never commit), `ESCROW_CONTRACT_ADDRESS`, `DECISION_TIMEOUT_MS`, `GAME_TIME_LIMIT_MS`, `RAINBOW_STORM_CHANCE`, `TABLE_SIZE`. Added by later sub-specs: `STARTING_COINS` / `PLAYGROUND_ENTRY_COINS` (coin economy, 12/13); `TOURNAMENT_*` / `SPONSOR_POOL_SEED_WEI` / `JACKPOT_SEED_WEI` / `PAYOUT_SCHEDULE_JSON` / `PAYOUT_FIELD_FRACTION` / `MIN_RANKED_SESSIONS` (08); `X_CLIENT_ID` / `X_CLIENT_SECRET` (09), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `WEB_SESSION_TTL_MS` (11); `SPECTATOR_MODE` / `SPECTATOR_DELAY_MS` (10); `WALLET_ENCRYPTION_KEY` (secret, 14); `TABLE_MIN_SIZE` / `TABLE_MAX_SIZE` / `LOBBY_COUNTDOWN_MS` / `REBUY_LIMIT` / `REBUY_COINS` (18). The committed **`.env.example`** is the authoritative list (non-secret defaults filled in); `.env` is gitignored.

**A deployed `.env` overrides the code default, and `.env.example` is only a template.** Nothing in the deploy rewrites a box's `.env`, so changing a default in `config.ts` does *not* change a running environment. Spec 22 shipped `PAYOUT_FIELD_FRACTION=0.3333` and both boxes kept paying at `1.0` for days because their own `.env` still pinned it. When a config change appears to have no effect, check the box before checking the code — and prefer publishing the live value on `GET /config` so it is verifiable from outside.
