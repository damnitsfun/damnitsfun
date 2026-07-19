# Sub-Spec 03 — Live Session Adapter & Event Log

**Silo:** the `engine` → `api` seam (lives in `packages/engine`, consumed by `api`)
**Parent tasks covered:** T6 (GameSession adapter + live-drive proof), T7 (event log persistence)
**Depends on:** 02 (the patched/wrapped engine).
**Handoff artifact:** a `GameSession` class that is proven drivable across real wall-clock gaps, plus event-log persistence into the `session_events` shape. **This is the single most important handoff in the whole project — FR-1.6 is closed here.**

## Goal
Wrap the pure engine (02) into a live, incrementally-drivable session object that the backend can call one move at a time as real network requests arrive, and that emits a durable, replayable event log. This is where the project's biggest technical risk is retired.

## Read first
Parent spec §7 (the `GameSession` sketch), §4 (the `session_events` table shape), and the parent spec's first gotcha about T6's real-delay test. Requirements FR-1.6, FR-1.1, FR-7.3.

## Scope & task order

**T6 — GameSession adapter + live-drive proof.** Implement `GameSession` per parent spec §7:
- Constructor takes seat agent IDs and `{ seedReveal?, timeLimitMs? }`; instantiates the vendored `Game` with those seats, applies the seeded deck (from 02's T2 patch) when a seed is given, and attaches the timeout + Rainbow Storm house rules (from 02's T4).
- `getLegalMoves(agentId)` derives legal moves from live engine state, translated to product vocabulary. **This is the method the entire rest of the system must call** — no other component may re-derive rules (Requirements NFR-2).
- `applyMove(agentId, move)` translates the product-vocabulary move to the vendored call, catches vendored errors and rethrows them as 02's typed errors, and returns the resulting events.
- `checkTimeout()` performs the wall-clock check independent of any move call.
- **The proof:** write an integration test that plays a full 4-player game with **real `setTimeout` delays (at least a few hundred ms) between every move** — not mocked/fake timers. This proves the engine tolerates real wall-clock gaps between calls, which inspection alone cannot.
*DoD: the real-delay integration test passes reliably — run it 10× in CI to catch flakiness. This closes FR-1.6 for real.*

**T7 — Event log persistence.** Wire `GameSession`'s emitted events into the `session_events` table shape from parent spec §4 (monotonic `seq` per session, `event_type`, `payload_json`, optional `reasoning`). The event log is the single source of truth that both the replay UI (06) and the on-chain result hash (05) derive from — it must be produced once, here, not regenerated differently by each consumer.
*DoD: replaying a completed session's `session_events` reconstructs the exact same final hands and winner as the live run.*

> Note on ordering vs. the DB: T7 needs the `session_events` *shape* but not a running database. Define the persistence interface here against the §4 schema; the actual SQLite table is stood up in sub-spec 04 (T8). Use a thin persistence port (an interface the adapter writes through) so this spec can be tested with an in-memory implementation and 04 can plug in real SQLite without touching engine code.

## Critical constraints
- **Do not skip or weaken the real-delay test.** A fuzz test with instant/mocked time does *not* satisfy T6. The whole live-engine risk rides on this specific test.
- `getLegalMoves` is the sole rules authority for everything downstream. Treat any temptation to compute legality elsewhere as a bug.

## Definition of Done (whole spec)
- [ ] `GameSession` is live-drivable one move at a time across real wall-clock gaps (proven by the 10×-green real-delay test).
- [ ] Legal moves, applied moves, and errors all round-trip in product vocabulary with typed errors.
- [ ] Event-log persistence writes the §4 `session_events` shape through a port that an in-memory impl satisfies now and SQLite will satisfy in 04.
- [ ] Replay-from-log reconstructs identical final state.
- [ ] Still no HTTP in this layer — it's callable, not networked.

## Handoff checklist to sub-spec 04
04 will put a Fastify server and real SQLite around this. Confirm: `GameSession` can be constructed, driven, and persisted-through purely by function calls; the persistence port is a clean interface 04 can implement with `better-sqlite3`; and the events emitted match the `session_events` columns exactly.
