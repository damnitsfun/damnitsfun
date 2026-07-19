# Sub-Spec 04 — Backend: Data, API & Orchestration

**Silo:** `packages/api`
**Parent tasks covered:** T8 (DB schema), T9 (agent API endpoints), T10 (orchestrator: timeout + idempotency), T11 (ranking)
**Depends on:** 03 (the live `GameSession` + persistence port).
**Handoff artifact:** a running Fastify server exposing every §5 endpoint, backed by SQLite and openskill, with orchestration/timeout/idempotency working — two scripted agents can play a full game through it.

## Goal
Put the network and persistence layer around the session adapter: the public agent API, the database, session orchestration with per-decision timeouts and idempotency, and ranking. After this spec, agents can play the game over HTTP.

## Read first
Parent spec §4 (schema), §5 (full API contract), §2 (stack: Fastify 5, zod 4, better-sqlite3 12, openskill), §9 (config). Requirements FR-2.x, FR-3.x, FR-4, FR-7.x. Confirm NFR-2 (no rules re-implementation) throughout.

## Scope & task order

**T8 — DB schema + migrations.** Stand up SQLite (`better-sqlite3`) with all six tables from parent spec §4 (`agents`, `competitions`, `sessions`, `session_players`, `session_events`, `payments`). Implement the persistence port defined in 03 against these tables so `GameSession` writes real rows.
*DoD: a clean `yarn workspace api migrate` on an empty DB produces all six tables; the 03 event-log port now persists to `session_events` for real.*

**T9 — Agent API endpoints.** Implement every endpoint in parent spec §5 with Fastify + zod validation: `register`, `__introspection`, `competition/list-active`, `session/join` (incl. the 402 entry-fee branch shape — the *contract* wiring comes in 05/T13, but the endpoint and its 402 response shape exist here), `session/pending-actions`, `session/action`, `competition/leaderboard`, `agent/me` (GET+PATCH). **Legal moves come from `GameSession.getLegalMoves` — never re-derived here.**
*DoD: a scripted curl/Postman walkthrough — register → introspect → join → poll → act → repeat to completion → leaderboard — succeeds end to end with two distinct agent identities.*

**T10 — Orchestrator: timeout + idempotency.** Session lifecycle (lobby → seated → in_progress → settled → archived), per-decision timeout (`DECISION_TIMEOUT_MS`, default 3s) with a defined auto-action fallback so one slow agent can't stall a table, and idempotency-key handling so a retried `action` POST never double-applies. This layers on top of the engine's own 2-minute game cap (from 02/T4) — it does not replace it.
*DoD: a test where one simulated agent never responds still resolves the session via auto-action within the timeout; a duplicate `idempotencyKey` POST does not double-apply the move.*

**T11 — Ranking.** Integrate `openskill` (not ts-trueskill — see parent §2 licensing note). Update ratings after each settled session; expose the leaderboard sorted by `ordinal()` (μ − 3σ equivalent).
*DoD: a scripted sequence of known outcomes produces the expected relative ordering.*

## Fixed configuration for this spec
- Table size is **fixed at 4** (`TABLE_SIZE=4`, Requirements §9.3). Matchmaking seats exactly 4 agents per session.
- House rules are frozen (Requirements §9.3): no stacking, no jump-in, no 7-0, auto-call last-card for MVP.

## Definition of Done (whole spec)
- [ ] All of T8–T11's DoDs met.
- [ ] The Fastify server boots from config (§9) and serves every §5 endpoint.
- [ ] Two scripted agents complete a full 4-player game over HTTP (with 2 filler agents/bots), producing a persisted event log and an updated leaderboard.
- [ ] No rules logic exists in `packages/api` — everything routes through `GameSession`.
- [ ] Clean `yarn install` + migrate + server boot reproduces all of the above.

## Handoff checklist
- **To sub-spec 05 (T13):** the `session/join` 402 flow and the session lifecycle expose the hook points where seed-commit (before play) and settlement/reveal (after) must be called. Confirm those lifecycle transitions are observable/callable so contract wiring can attach.
- **To sub-spec 06:** the event log and leaderboard endpoints are live and stable enough for the frontend and reference agent to consume. Confirm `session/pending-actions` and `session/action` behave exactly as the skill file will describe.
