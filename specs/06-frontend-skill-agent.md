# Sub-Spec 06 — Frontend, Skill File & Reference Agent

**Silo:** `packages/web` + `packages/reference-agent` (+ the real trademark lint)
**Parent tasks covered:** T14 (trademark lint in CI), T15 (spectator frontend), T16 (public skill file), T17 (reference agent)
**Depends on:** 04 (a live API + event log + leaderboard). Also relies on 02/§6 for the vocabulary the lint enforces.
**Handoff artifact:** a live-watchable spectator UI, a public `skill.md`, and a reference agent a fresh AI instance can run from the skill URL alone.

## Goal
Make the arena watchable, joinable, and provably usable: the spectator experience, the public onboarding skill file, the example agent that proves the API works, and the CI lint that guarantees no UNO trademark leaks to any public surface.

## Read first
Parent spec §5 (API the frontend/agent consume), §6 (vocabulary the lint enforces), §5.1 (reference-agent scope), Requirements §5 (product/UX), FR-5.x, FR-2.9, NFR-4. The existing `ai_uno_replay.html` is the starting asset for T15 — evolve it, don't rebuild.

## Scope & task order

**T14 — Trademark lint in CI (do this first — it guards everything else in this spec).** Replace the sub-spec-01 stub with the real grep check across `packages/api`, `packages/web`, and `skill.md`: fail CI if any vendored UNO-specific term (`SKIP`, `REVERSE`, `WILD_DRAW_FOUR`, `uno`, etc., case-insensitive) appears outside `packages/engine`.
*DoD: CI fails on a planted violation and passes when clean.*

> **Amendment (post-launch copy review).** Human-facing marketing copy may reference the UNO mark *nominatively* — reviewers could not tell what game the product was, and the genre label alone did not fix it. A line carrying `trademark-lint:nominative-ok` is exempt for the bare word `uno` only; a marked line that also names a vendored enum is a distinct, louder failure ("used to smuggle vendored vocabulary"), and all marked lines are echoed in CI as an audit trail. Conditions and rationale: CLAUDE.md rule #2. **The vocabulary rule this task exists to enforce is untouched** — `PASS`/`UTURN`/`GRAB2`/`RAINBOW`/`MEGARAINBOW` remain the only card names on any public surface.
> *Extended DoD: CI still fails on a planted unmarked `uno`, fails on a marked line carrying a vendored enum, and passes clean while listing each approved nominative use.*

**T15 — Spectator frontend.** Evolve `ai_uno_replay.html` into a live-data-driven viewer in `packages/web`:
- **Live mode:** subscribe to a session's events (poll `session_events` or the optional SSE endpoint) and render the game as it happens.
- **Replay mode:** fetch a completed session's stored event log and play it back (the existing scrubber/speed UI).
- Same rendering code, two event sources.
- Rebrand-audit the existing demo's card names/visuals against §6 (the old demo may still say "Uno"/"Skip"/etc. — fix all of it; the T14 lint will catch leftovers).
- Add the leaderboard page and the onboarding page ("point your agent here" + the skill URL).
*DoD: a live session is watchable in-browser with correct product vocabulary; a completed session is separately viewable in replay mode from the stored log.*

**T16 — Public skill file.** Write `skill.md` at a stable served URL, following the dev.fun onboarding pattern: safe-execution notes, the §5 endpoint reference, a "how to pick a session" algorithm, and the onboarding sequence (register → introspect → join → poll → act).
*DoD: a fresh AI agent instance, given only the skill file's URL as a prompt, registers, joins, and completes a session with no further human instruction.*

**T17 — Reference agent.** Implement a simple heuristic `decide()` agent in `packages/reference-agent` that talks to the public API only (no internal shortcuts).
*DoD: run twice concurrently as two distinct registered agents, it completes a full 4-player session (with 2 filler agents) via the public API alone — this is also the practical proof of T16.*

## Critical constraints
- The frontend and reference agent consume the API **as any third party would** — through the documented §5 endpoints and the event log only. They must not import from `packages/engine` or reach into the DB directly. If the reference agent needs something the public API doesn't expose, that's a signal the API (04) is incomplete, not a license to bypass it.
- Every public string goes through the §6 vocabulary. The T14 lint is the backstop, but write it right the first time.

## Definition of Done (whole spec)
- [ ] T14 lint is real and green across api/web/skill.md.
- [ ] Live and replay modes both work with correct product vocabulary.
- [ ] `skill.md` is served and self-sufficient — a cold agent can onboard from the URL alone.
- [ ] The reference agent plays a full game through the public API, proving the skill file end to end.

## Handoff checklist to sub-spec 07
07 needs to run multiple independent agents and watch a live game while on-chain settlement happens. Confirm: the reference agent can be launched as N independent processes, the live view updates during play, and (with 05 done) on-chain tx hashes are visible/capturable from the UI or API logs.
