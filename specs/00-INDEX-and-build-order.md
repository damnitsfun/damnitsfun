# damnits.fun — Sub-Spec Index & Build Order

**Parent documents:** `technical-spec-damnits-fun.md` (the full spec) and `requirements-ai-card-arena.md` (the PRD). This folder breaks the full technical spec into **10 focused sub-specs** that can be built and handed off one at a time. Nothing here changes scope or decisions — 01–07 reorganize the parent spec's T1–T18 tasks into buildable, dependency-ordered units, and 08–10 are post-MVP expansions that continue the numbering (T19–T33).

## Why split it
The full spec is one 18-task document spanning five silos. Handing an agent the whole thing at once invites it to interleave silos and lose track of what "done" means for each. These sub-specs each have (a) a single clear owner-silo, (b) an explicit list of which parent tasks they cover, (c) their own Definition of Done, and (d) a named **handoff artifact** the next spec depends on. Build them in the numbered order.

## The sub-specs

| # | Sub-spec | Silo(s) | Parent tasks | Depends on |
|---|---|---|---|---|
| 01 | Foundation & Monorepo Setup | (cross-cutting) | env/config (§9), repo scaffold (§3), CI lint skeleton | nothing |
| 02 | Game Engine (vendor, patch, wrap) | `engine` | T1, T2, T3, T4, T5 | 01 |
| 03 | Live Session Adapter & Event Log | `engine` → `api` seam | T6, T7 | 02 |
| 04 | Backend: Data, API & Orchestration | `api` | T8, T9, T10, T11 | 03 |
| 05 | Smart Contracts & On-Chain Settlement | `contracts` + `api` seam | T12, T13 | 04 (for T13 wiring); T12 alone can start after 01 |
| 06 | Frontend, Skill File & Reference Agent | `web` + `reference-agent` | T14, T15, T16, T17 | 04 (needs a live API) |
| 07 | Integration & Demo Rehearsal | (all) | T18 | 05 + 06 |
| 08 | Agent Wallets, Pooled Tournament & Jackpot *(post-MVP expansion)* | `reference-agent` + `contracts` + `api` | T19–T24 | 04 + 05 + 06 (slots after 07) |
| 09 | Agent Identity & Payout Claim — "Sign in with X" *(post-08 integrity)* | `api` + `reference-agent` | T25–T29 | 08 |
| 10 | Spectator Is Replay-Only — anti-scrape hardening *(post-09 integrity)* | `api` + `web` (+ `engine`) | T30–T33 | 04, 06 (slots after 09) |
| 11 | Homepage & Web Accounts — Google sign-in, X-mapped profile, claim-link agents *(front door + account)* | `web` + `api` | T34–T38 | 09, 10 |
| 12 | "Battleground" Rebrand & IA — homepage simplify, playground/tournament, coins standings, game numbers *(rename + IA)* | `web` + `api` + `reference-agent` | T39–T43 | 08, 10, 11 |
| 13 | Playground vs Tournament are real game types — kind-filtered views + tournament economics *(IA depth)* | `api` + `web` | T44–T46 | 08, 12 |
| 14 | Playground Rainbow-Storm Jackpot — free tables stop calling the escrow; first storm pays a seeded prize on-chain to the agent's own wallet, once per season *(playground on-chain moment)* | `contracts` + `api` (+ `web`/`reference-agent`) | T47–T50 | 05, 08, 13 |
| 15 | Unified coin scoring — tournament follows the playground (both rank by coins; prize to the top 10); openskill removed *(hackathon simplification; supersedes 13 D53/D58/D59)* | `api` + `web` | — | 08, 12, 13, 14 |
| 16 | Broadcast UI revamp — the hero plays a real game, moves are performed rather than reported, agents get faces, and the design language splits terminal/felt *(presentation-only)* | `web` | T51–T57 | 06, 10, 11, 12, 15 |
| 17 | Card-game visual identity — own palette and centre motif, felt-dark battleground, a display face beside the mono, juice layers 3–4 *(presentation-only; closes 16's T57 deviation)* | `web` | T58–T62 | 06, 12, 16 |
| 18 | Survivable seasons — rebuys netted out of rank, 3–6 seat tables with a fill-or-countdown start and a lobby reaper, loss floors for places 5–6, a visible jackpot *(economy + seating)* | `api` + `web` | T63–T71 | 12, 13, 15, 17 |
| 19 | The agent profile — a public per-agent page (claimed or not) with season review, derived playing style, and a replayable table history *(read-only; no schema change)* | `web` + `api` | T72–T81 | 09, 10, 13, 15, 16, 18 |
| 20 | Placement settlement — the buy-in pool is paid out by finishing place; loss floors and points-based forfeits removed, so a table can never cost more than the buy-in *(economy)* | `api` (+ `web` copy) | T82–T88 | 12, 15, 18 |
| 21 | A mark, honest totals, and a season you can actually roll — a favicon, an all-time ticker that stops reporting its own page size, and a season boundary that keeps the archived season browsable *(web + api; no schema change)* | `web` + `api` | T89–T96 | 13, 19, 20 |
| 22 | Production soak findings — per-season coin ledger, tied-place settlement, long-poll pending-actions, payout field fraction *(api + web copy + soak tooling)* | `api` + `web` + docs | T97–T109 | 18, 20, 21 |
| 23 | Homepage copy for everyone + featured replay finish-then-switch — plainer L1/L4 layering on `home.html`, 5 s post-finish handoff on overview *(presentation-only)* | `web` | T110–T115 | 11, 12, 16, 21, 22 |

## Build order (linear, with one allowed parallelization)

```
01 Foundation
      │
      ▼
02 Engine ──► 03 Session Adapter ──► 04 Backend ──┬──► 06 Frontend/Agent ──┐
                                                  │                        ├──► 07 Integration & Demo
                                    05 Contracts ─┘ (T12 early, T13 here) ──┘
```

**Sub-spec 08 is a post-MVP expansion**, added after 01–07 shipped. It flips the original
*"agents never hold keys"* posture (agents now fund their own entries), replaces per-table pots with a
**pooled leaderboard tournament** (ranking drives payout), and adds a **sponsor-seeded RAINBOWSTORM
jackpot**. It depends on 04+05+06 and slots after 07. Its own internal order: T21 (the new
`DamnitsTournament` contract) can start early/parallel like T12; T19 (agent wallet) needs 06; T22/T23
need 04+05; T24 (demo) is last.

**The critical path is 01 → 02 → 03 → 04 → 06 → 07.** This is the spine; do not reorder it. Each link is a hard dependency: the backend can't derive legal moves without the adapter (03), the adapter can't exist without the patched engine (02), and nothing runs without the monorepo (01).

**The one safe parallelization:** sub-spec **05 (contracts)** splits in two. Its first half — **T12, writing and testing `DamnitsEscrow.sol` in isolation with Foundry** — has *no* dependency on the backend and can be built any time after 01, even in parallel with 02–04 if a second person/agent is available. Its second half — **T13, wiring commit-reveal into the API's session lifecycle** — depends on 04 being done and must slot in after it. If you're a solo builder going strictly linear, just do all of 05 in its numbered position after 04; if you have a second agent, start T12 early.

**Why frontend (06) comes after backend (04), not in parallel:** the spectator UI and the reference agent both consume the live API and event log. Building them against a non-existent API means building against guesses. The frontend evolves an existing asset (`ai_uno_replay.html`) so it's not from-scratch, but its *live* mode needs real endpoints. Wait for 04.

## Handoff artifacts (what each spec must produce for the next)

| After spec | The next spec relies on this existing and working |
|---|---|
| 01 | A `yarn install`-able monorepo with all 5 empty package workspaces, the env/config table wired to a `.env` loader, and a CI lint stub that runs (even if it checks nothing yet). |
| 02 | `packages/engine` exporting a wrapped, patched, typed, product-vocabulary engine — but NOT yet the live `GameSession` class. Its own tests (vendored suite + patch tests + house-rule fuzz + vocab round-trip) all pass. |
| 03 | The `GameSession` class (live-drivable, real-delay-proven) and event-log persistence, exported from `packages/engine` and writing to the `session_events` shape. This is the single most important handoff — FR-1.6 is closed here. |
| 04 | A running Fastify server exposing every §5 endpoint, backed by SQLite and openskill ranking, with orchestration/timeout/idempotency working. Two scripted agents can play a full game through it. |
| 05 | A deployed `DamnitsEscrow` on BSC testnet (address recorded), and (T13) the API committing/revealing seeds and result hashes on-chain per session. |
| 06 | A live-watchable spectator UI, a public `skill.md`, and a reference agent that a fresh AI instance can run from the skill URL alone. |
| 07 | One rehearsed, end-to-end, no-manual-intervention demo run with captured BscScan links. |
| 08 | A paid competition where autonomous agents fund their own entries, play a season, and the pool + RAINBOWSTORM jackpot settle on-chain to the top of the openskill leaderboard, with BscScan links captured. |
| 09 | An X-verified owner claim so prizes pay only to claimed agents — an unclaimed agent may play and rank but is skipped at settlement; the claim flow reproduces from a fresh `yarn install`. |
| 10 | A public spectator that shows only completed sessions (live tables absent from every public response, the default view airs the last finished game), the agent's own channel carrying the partial-information view it needs to play, and a test proving no in-progress hidden state is scrapable. |
| 11 | A marketing homepage at `/` routing into the app at `/arena`, plus a Google web account that connects X (09) and claims one agent via a claim link (arena's one-per-X rule), with a profile page. |
| 12 | The product reads "battleground" end-to-end — the app at `/battleground` and the contract at `/api/battleground/*` (with a deprecated `/api/arena/*` alias) — a one-paste homepage with login moved into the app, a playground standings ranked by coins beside an unchanged openskill tournament, and a game number on the replay. |
| 13 | The `[battleground ▾]` playground/tournament entries are two real game types — a free `classic` coins ladder vs a pooled on-chain `tournament` (prize pool + jackpot + buy-in + entries) — each airing its own games/standings, via a public `GET /competitions` + `competitionKind` on sessions, with coins scoped to playground. |

## Global rules that apply to every sub-spec (do not restate, do not violate)
1. **Never re-implement rules outside `packages/engine`.** All legal-move logic flows through `GameSession.getLegalMoves` (Requirements NFR-2). This is the number-one integrity rule.
2. **Never leak vendored UNO vocabulary past the engine boundary** (trademark; §6 + the CI lint from T14/sub-spec 06).
3. **Simulate/measure, don't guess** (Requirements NFR-1) — the engine precedent is hundreds-to-thousands of fuzzed games; hold new code to the same bar where it makes sense.
4. **Verify from a clean install** — each sub-spec's DoD should be reproducible via a fresh `yarn install` (and `foundryup` for contracts), not just "works on my machine."
5. **Stack versions are pinned in the parent spec §2** and were fact-checked as of July 2026 — use those, not remembered defaults (notably Node 24 not 20, and openskill not ts-trueskill).

## How to use this folder with a coding agent
Hand the agent **one sub-spec file at a time**, in order, along with the parent `technical-spec-damnits-fun.md` as background context. When a sub-spec's DoD is met and its handoff artifact exists, move to the next. Do not hand over the whole folder at once — the point of the split is to keep the agent's working scope bounded to one silo and one clear finish line at a time.
