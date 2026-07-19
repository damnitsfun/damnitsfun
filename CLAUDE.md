# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

This repository currently contains **only planning specs** — no code has been written yet (`packages/`, `skill.md`, etc. don't exist). It will become a yarn-workspaces monorepo named `damnits-fun` for an autonomous-AI-agent UNO-style arena ("damnits.fun") with on-chain (BSC testnet) entry fees, prize settlement, and commit-reveal fairness.

Before writing any code, read:
1. `specs/00-INDEX-and-build-order.md` — the build order and why it's fixed.
2. `specs/technical-spec-damnits-fun.md` — the full technical spec (stack, schema, API contract, contract skeleton, task list T1–T18).
3. The one numbered sub-spec (`specs/01-...` through `specs/07-...`) matching the silo currently being worked on.

**Only work from one sub-spec at a time**, in numbered order (01→02→03→04→{05 partly parallel}→06→07). Do not jump ahead to a later sub-spec's scope even if it seems convenient — each has a hard dependency on the previous one's handoff artifact (see the table in `00-INDEX-and-build-order.md`).

## Build order (hard dependency chain)

```
01 Foundation → 02 Engine → 03 Session Adapter → 04 Backend ─┬→ 06 Frontend/Agent → 07 Integration & Demo
                                                              │
                                                05 Contracts ─┘ (T12 can start after 01, in parallel; T13 needs 04)
```

Do not reorder this. The backend can't derive legal moves without the adapter (03), the adapter can't exist without the patched engine (02), and nothing runs without the monorepo (01).

## Commands (once scaffolded per sub-spec 01)

- `yarn install` — install all workspaces (yarn classic v1, not npm/pnpm).
- `yarn workspace engine test` — run the engine package's Jest suite.
- `yarn workspace api migrate` — apply the SQLite schema.
- `yarn test` / `yarn lint` — root scripts that fan out across workspaces.
- `foundryup` then Foundry commands (`forge test`, `forge script`) inside `packages/contracts` — do not pin a specific Foundry version, it's rolling-release.

Since no workspace exists yet, verify these actually exist/match `package.json` scripts before running them once the repo is scaffolded.

## Non-negotiable global rules (apply to every sub-spec)

1. **Never re-implement UNO rules outside `packages/engine`.** All legal-move logic must flow through `GameSession.getLegalMoves`. This is the single most important integrity rule in the project (Requirements NFR-2) — the API, UI, and on-chain result hash all depend on agreeing with one source of truth.
2. **Never leak vendored UNO vocabulary past the engine boundary.** The vendored library's internal enums (`Value.SKIP`, `Value.REVERSE`, `Value.WILD`, etc.) exist only inside `packages/engine`. Everywhere else (API, DB, UI, `skill.md`) uses the product vocabulary translation table in spec §6 (`PASS`, `UTURN`, `GRAB2`, `RAINBOW`, `MEGARAINBOW`, `RAINBOWSTORM`). This is trademark-driven, not stylistic, and is enforced by a CI grep lint (T14) that fails the build on any leaked vendored term outside `packages/engine`.
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
| Ranking | **`openskill`**, not `ts-trueskill`/TrueSkill | TrueSkill's license restricts it to non-commercial/Xbox-Live use — a real problem for a prize-money product. Use `openskill`'s `ordinal()` (μ − 3σ) for leaderboard sort. |
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
├── web/                # spectator frontend, single-file, live + replay modes
└── reference-agent/   # example autonomous agent, public-API-only, proves skill.md works
```

Key architectural facts worth internalizing before touching any layer:

- **`GameSession` (`packages/engine/src/adapter.ts`) is the sole rules authority.** It wraps the vendored `Game` 1:1 per session, exposes `getLegalMoves(agentId)`, `applyMove(agentId, move)`, and `checkTimeout()`, all in product vocabulary with typed errors. No other layer computes legality.
- **The `session_events` table is the single source of truth** for both the replay UI and the on-chain `resultHash` — it must be produced once (in the adapter/persistence layer) and never regenerated differently by two consumers.
- **Commit-reveal, not VRF, is the fairness mechanism.** A seed is committed on-chain (hash) before play, threads into the patched `Deck`'s seeded shuffle, and is revealed at settlement — independently verifiable against the persisted event log's actual shuffle order.
- **Table size is fixed at 4** and house rules are frozen for MVP (no stacking, no jump-in, no 7-0, auto-call last-card) — don't add configurability here unless a spec explicitly asks.
- **The reference agent and frontend must only ever use the public `/api/arena/*` HTTP contract** (spec §5) — never import `packages/engine` directly or reach into the DB. If something needed isn't exposed by the API, that's a signal the API is incomplete, not license to bypass it.

## Environment variables (spec §9)

`PORT`, `DATABASE_PATH`, `BSC_TESTNET_RPC_URL`, `BSC_CHAIN_ID`, `OPERATOR_PRIVATE_KEY` (secret, never commit), `ESCROW_CONTRACT_ADDRESS`, `DECISION_TIMEOUT_MS`, `GAME_TIME_LIMIT_MS`, `RAINBOW_STORM_CHANCE`, `TABLE_SIZE`. A committed `.env.example` should have non-secret defaults filled in; `.env` is gitignored.
