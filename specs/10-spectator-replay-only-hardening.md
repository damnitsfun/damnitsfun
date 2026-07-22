# Sub-Spec 10 — Spectator Is Replay-Only (Anti-Scrape Hardening)

**Status:** built. Makes the **public spectator surface a replay of *finished* tables only**,
mirroring **arena.dev.fun** exactly: its viewer calls `getTexasTables` / `getTexasReplay`, both of
which return only tables with `status: "Completed"` — an in-progress table is never in the public
response set at all. That is *fail-safe by construction*: there is no code path that can leak a live
opponent's hidden state to a scraping agent, because live tables aren't served. damnits today does
the opposite — it publicly lists `in_progress` sessions and serves their **redacted live tail**
(`packages/web/public/index.html` polls `pollLive` every 700 ms), and the redaction is a **fail-open
denylist**. This sub-spec closes that, and — because the fix removes state the agent legitimately
needs — restores a proper **partial-information snapshot on the agent's own channel**.
**Silo(s):** `packages/api` + `packages/web` (+ `packages/engine` for the state projection, + `.env.example`).
**New parent tasks:** T30–T33 (continue the T1–T29 numbering).
**Depends on:** 04 (spectator read API, orchestrator, `pending-actions`), 03 (`GameSession`),
06 (the single-file spectator UI). Slots **after 09**; independent of 08/09's payout work.
**Handoff artifact:** a public spectator that shows only completed sessions (live tables are absent
from every public response), an agent channel that still gives each agent the public game view it
needs to play well, and a test proving a scraper cannot read any in-progress hidden state — all
reproducible from a fresh `yarn install`.

---

## Goal

An autonomous agent competes for real money; the website is public and unauthenticated. If any public
endpoint exposes an **in-progress** table's hidden state, an agent can scrape its opponents' current
hands (or, worse, the shuffle seed) and cheat. The single most important integrity property of a
spectator is therefore: **nothing about a live table is public until the table is history.**

arena.dev.fun achieves this the simplest possible way — its spectator only ever fetches *completed*
tables (verified live: `GET /api/arena.getTexasTables` and `getTexasReplay` return
`status:"Completed"`, populated `endedAt`, a terminal `TableEnded` event, and full `holeCards`
*because the hand is already over*). The header says `S9 LIVE`, but "live" refers to the season and
leaderboard, not the table you are watching — every table frame is a replay.

damnits currently diverges in two ways, both of which this spec fixes:

- **A live public surface exists.** `GET /spectate/sessions` lists `in_progress` sessions, and
  `GET /spectate/session/:id/events` serves their event tail (redacted) while the game is being
  played; the UI's `pollLive` refreshes it every 700 ms. This is the scrape surface arena doesn't have.
- **Redaction is fail-open.** `redactPayload` (`packages/api/src/routes/spectate.ts`) is a `switch`
  whose `default:` **returns the payload verbatim**. Only `SESSION_STARTED` (hands → counts, seed →
  null) and `CARD_DRAWN` (faces stripped) are handled. Any *future* event type that carries hidden
  information leaks by default. arena's model cannot have this class of bug because it serves no live
  events at all.

A useful fact that makes the fix cheap: the per-session `settle()` in `orchestrator.ts` flips a
session to `status = 'settled'` **the instant its game ends**, on-chain or not (the chain call is a
fire-and-forget hook). So "the game is over" and "the log is public" already coincide — replay-only
needs only to *stop* serving the not-yet-settled tail, not wait on settlement.

Removing the live tail also removes public state the *agent* was implicitly relying on the spectator
for. `pendingActions` returns only `{ yourTurn, legalMoves, deadlineMs }` — no discard top, no
current color, no per-opponent hand count, no play history. In UNO those are legitimate public
observations an opponent-at-the-table can see, and an agent needs them to play well. So Part C adds a
**partial-information view** to the agent's own authenticated channel — mirroring arena's
`pending-actions`, which returns the full *redacted* table snapshot (your cards + public board,
never opponents' hidden cards).

## Read first

Parent spec §4 (`session_events`, the single source of truth), §5 (agent contract: `pending-actions`,
`action`), §6 (vocabulary — the public view must stay in product terms). Sub-spec 04 (`spectate.ts`,
`orchestrator.pendingActions`), 06 (`packages/web/public/index.html`, `pollLive`), 03 (`GameSession`).
The arena reference: the poker-playground viewer and its `getTexasTables` / `getTexasReplay` calls
(completed-only), and its authenticated `texas/pending-actions` snapshot (your cards + public board).

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D26 | Public spectator scope | **Completed sessions only.** `in_progress` / `seated` / `lobby` sessions are **absent** from every public spectator response (list, summary, events) — arena parity. | Keep listing live tables (the current scrape surface) |
| D27 | The default watching UX | **Delayed-live: air the last finished game.** The default continuously airs the *most-recently-finished* session as a replay and auto-advances as newer ones settle — the live *feel*, finished *data* (exactly arena's `S9 LIVE` featured hand). | True live tail (`pollLive`) — removed |
| D28 | Replayable threshold | **`status ∈ {settled, archived}`** — which `settle()` reaches at game-end regardless of the chain, so replay works with the chain disabled. | Gate on on-chain settlement (couples replay to chain latency; breaks chain-disabled runs) |
| D29 | Redaction posture | **Fail-safe allowlist.** Each event type opts into exactly which fields are public; the `default` **strips to a safe skeleton**. Unknown/new types are most-redacted, never verbatim. | Keep the fail-open denylist (`default` returns payload) |
| D30 | Seed exposure | **`seedReveal` stays gated on `settled`** (unchanged) and is *never* emitted by the allowlist for a non-settled session — the seed determines the whole deck. | Reveal at game-end before settlement (needless) |
| D31 | Agent's own view | **Engine owns the projection.** Add `GameSession.getPublicView(agentId)` — the observable, product-vocabulary, redacted state (discard top, current color, direction, per-seat hand counts, whose turn, recent public events, your own hand). `pending-actions` forwards it. | Assemble the view in the API (violates global rule 1 — state authority lives in the engine) |
| D32 | Spectator mode | **`SPECTATOR_MODE`** default **`delayed`** (arena parity) — auto-airs the last finished session as a continuously-advancing replay; `archive` = on-demand browsing of any past session, no auto-airing. **Neither ever touches an in-progress session** — both replay only `settled` logs (D26/D28); the "delay" is that the aired game is already over. | Serving a redacted *in-progress* tail (the scrape surface) — rejected |

> **Why replay-only and not "just fix the redaction."** Redaction is a moving security boundary: it
> is only correct if every future event author remembers to redact. arena's completed-only model has
> no boundary to get wrong. We adopt it for **every** mode — even the default `delayed` (arena's
> live-*feel*) only ever airs a game that is already over (D26/D27) — *and* make redaction fail-safe
> (D29) as defense-in-depth for the seed gate (D30) and any future code that reads the log before
> settlement. Belt and suspenders, because real money is on the table.

---

## Architecture (target shape)

```
BEFORE (scrape surface)                         AFTER (arena parity)
──────────────────────                          ────────────────────
public GET /spectate/sessions                   public GET /spectate/sessions
  → lobby | seated | in_progress | settled        → settled | archived ONLY
public GET /spectate/.../events (in_progress)   public GET /spectate/.../events (in_progress)
  → redacted tail, denylist (fail-OPEN)           → 409 GAME_IN_PROGRESS (no tail served)
  UI pollLive() every 700ms  ← LIVE DATA          UI airs last COMPLETED game (delayed-live)
                                                    (auto-advances as new sessions settle)

agent GET /session/pending-actions              agent GET /session/pending-actions
  → { yourTurn, legalMoves, deadlineMs }           → { ...same, view: PublicGameView }
  (under-informed)                                 view = GameSession.getPublicView(agentId)
                                                   (your hand + public board; never opp hands)
```

`session_events` remains the **single full-information source of truth** (unchanged — it must be, for
the on-chain `result_hash`). The change is purely at the read boundary: the public boundary now only
opens once a session is `settled`; the agent boundary gets a redacted-per-viewer projection from the
engine.

---

## Part A — Completed-only public spectator (T30)

### T30 — Public spectator serves only finished sessions `[FR-5, NFR-2]`
- **`listSessions` (`spectate.ts`)** — the **public** list filters to `status ∈ {settled,archived}`
  (D28). Add an internal `includeLive` param (default `false`) used only by authenticated ops/debug
  callers, never by the public route.
- **`getSession` (public route)** — for a non-completed session, return a **minimal stub**
  (`sessionId`, `competitionId`, `status:'in_progress'`, `tableSize`, `seats`, `startedAt`,
  `eventCount:0`) and **no** seed/hands/result fields, or `409 GAME_IN_PROGRESS` — pick one and keep
  it consistent with the list (a hidden table should not be individually addressable either).
- **`readEvents` (public route)** — if the session is not completed, return
  **`409 { error: 'GAME_IN_PROGRESS' }`** and **serve no events**. Delete the redacted-live-tail code
  path from the public route entirely (it moves, in reduced form, into the optional `delayed` mode, T32-adjacent).
- **`server.ts`** — the three `/spectate/*` routes call the public variants; the live-only fields
  (`seedReveal`, `resultHash`, `settleTxHash`) already gate on `settled` and stay gated.

*DoD: for a session that is `lobby`/`seated`/`in_progress`, the public list omits it, the public
summary exposes no hidden field, and the public events route answers `409 GAME_IN_PROGRESS`. The same
session, once `settled`, appears in the list and replays in full. A test enumerates a live session id
and confirms no hand face, drawn card, or seed is reachable through any public route.*

## Part B — Fail-safe allowlist redaction (T31)

### T31 — Rewrite `redactPayload` as an allowlist `[NFR-2]`
Pure defense-in-depth: after T30 **no** public route serves an unsettled session's events (every mode
airs only finished games, D26/D32), so this guards the seed gate and any *future* code that might read
the log before settlement, plus future event types.
- Replace the denylist `switch` with an **allowlist**: each event type maps to an explicit
  `pick`-list of public fields; the **`default` returns a safe skeleton** (`{ agentId?, count? }`
  only — never the raw payload). Concretely, from the real payloads in `packages/engine/src/events.ts`:
  - `SESSION_STARTED` → `seats, timeLimitMs, rainbowStormChance, firstAgentId, discard`, plus
    `handCounts` derived from `hands`. **Strip** `hands` (faces) and `seedReveal` (→ null, D30).
  - `CARD_PLAYED` → `agentId, card, chosenColor, handCountAfter` (played face-up — fully public).
  - `CARD_DRAWN` → `agentId, count, cause, handCountAfter`. **Strip** `cards` (faces).
  - `TURN_PASSED` → `agentId`. `TURN_CHANGED` → `currentAgentId, direction`.
  - `RAINBOW_STORM` → `agentId, victims, drawCount`.
  - `GAME_ENDED` → `winnerAgentId, reason, finalHands, handValues` (emitted only at end; public then).
  - **unknown type** → skeleton (`agentId` if present) — the fail-safe default (D29).
- Add a compile-time exhaustiveness check (`satisfies Record<SessionEventType, …>`) so adding an
  engine event type **without** declaring its public projection fails the build, not silently leaks.
- Keep `toSpectatorEvent(record, settled)`: when `settled`, pass through verbatim (history); when not,
  route through the allowlist. No public route reaches the non-settled path after T30 — it exists as a
  guard for any future caller, not a live-serving path.

*DoD: a unit test feeds one synthetic event of an unknown type through the non-settled path and asserts
the output contains no field beyond the skeleton; `SESSION_STARTED` yields `handCounts` and
`seedReveal:null`; removing an event type's projection entry fails `tsc`.*

## Part C — The agent's partial-information view (T32)

### T32 — `GameSession.getPublicView` + snapshot in `pending-actions` `[FR-1, FR-2, §5]`
Removing the live spectator tail must not starve the agent of legal public state. Put the projection
in the engine (global rule 1 — the engine is the sole state authority), not the API.
- **`packages/engine/src/adapter.ts`** — add `getPublicView(agentId): PublicGameView`, in **product
  vocabulary**, returning: `discardTop`, `currentColor`, `direction`, `currentAgentId`, `yourTurn`,
  `seats: [{ agentId, handCount }]` (counts only — never opponents' faces), `yourHand` (the caller's
  own cards, this agent only), and `recentEvents` (last N *public* events). No seed, ever.
- **`orchestrator.pendingActions`** — add `view: entry.game.getPublicView(agentId)` to each
  `PendingSession` alongside the existing `yourTurn` / `legalMoves` / `deadlineMs`. `legalMoves`
  stays the sole authority for *legality* (global rule 1); `view` is context for *choosing*.
- **`introspection.ts` + `skill.md`** — document the `view` shape so an agent knows the public state
  it observes (mirrors arena's `pending-actions` snapshot), and reaffirm `legalMoves` is authoritative.
- **Trademark lint** — `getPublicView` and the snapshot emit only product terms (§6); the lint stays clean.

*DoD: `pending-actions` returns each caller's own hand plus opponents' hand **counts** and the public
board; a test asserts the response for agent A contains no card face belonging to agent B, and that a
reference agent can pick a legal, sensible move from `view` + `legalMoves` alone.*

## Part D — Frontend & demo (T33)

### T33 — Delayed-live UI (air the last finished game) + anti-scrape demo `[FR-5, G1]`
- **`packages/web/public/index.html`** — remove the `pollLive` live-tail (`setInterval(pollLive, 700)`
  and the `/events?since=` tail against an `in_progress` id). The default `delayed` mode **airs the
  last finished game**: poll `GET /spectate/sessions` (now completed-only) on the existing ~2.5 s
  cadence, auto-load the **most-recently-finished** session into the existing **replay** player, and
  auto-advance to the next one as it settles (arena's `S9 LIVE` featured-hand behaviour). Copy stays in
  the arena aesthetic; a small "REPLAY · finished HH:MM" affordance makes the replay-not-live nature
  explicit, as arena's viewer does. `archive` mode reuses the same player for on-demand browsing.
- **Demo** — extend the end-to-end script (07/T18-style) to assert the property: while a session is
  `in_progress`, hit every public `/spectate/*` route and confirm none returns a hand face, a drawn
  card, or the seed; after it settles, confirm the same routes replay it in full.

*DoD: the spectator page shows only finished tables, feels live as new ones complete, and the demo
proves the in-progress-scrape attempt returns nothing sensitive while the post-settlement replay is
complete.*

---

## Safety boundary (environment prohibited-action rules — do not violate)

- This sub-spec is a **read-boundary tightening**; it changes no on-chain code, no settlement, no key
  handling, and no game rules. `session_events` and `result_hash` are byte-for-byte unchanged.
- The public boundary only opens for a session **already finished** (D28); the seed reveal remains
  gated on `settled` (D30) — commit-reveal verification is unaffected (the reveal still lets anyone
  re-derive and check the shuffle after the fact).
- The agent view (Part C) is **partial information by construction**: an agent receives only its own
  hand plus what any player at the table can legally observe; opponents' faces never cross the boundary.

---

## New config (§9 additions)

| Var | Purpose | Default |
|---|---|---|
| `SPECTATOR_MODE` | `delayed` (default — auto-airs the last finished session as a continuously-advancing replay, arena parity) or `archive` (on-demand browsing only, no auto-airing). Both serve only completed sessions (D26/D28). | `delayed` |
| `SPECTATOR_DELAY_MS` | Optional extra buffer: minimum age since a session settled before it is eligible to be aired in `delayed` mode. `0` = air as soon as it settles (arena-style). | `0` |

---

## Definition of Done (whole spec)
- [x] **A (T30):** public `/spectate/*` routes serve only `settled`/`archived` sessions; an
      `in_progress` session is absent from the list, is not addressable (summary `409`), and its
      events route answers `409 GAME_IN_PROGRESS`.
- [x] **B (T31):** `redactPayload` is an allowlist with a skeleton `default` and a compile-time
      `satisfies Record<SessionEventType, …>` exhaustiveness check; adding an engine event type
      without a projection fails the build.
- [x] **C (T32):** `GameSession.getPublicView(agentId)` (engine) feeds a `view` on `pending-actions`;
      tests prove agent A never sees agent B's faces (api + engine); `introspection`/`skill.md`
      document it; trademark lint clean.
- [x] **D (T33):** the spectator UI airs the last finished game as a delayed-live replay and
      auto-advances (no `pollLive`); the demo asserts no live-session hidden state is publicly
      reachable (summary/events `409`, unlisted), and the settled replay is complete.
- [x] Reproducible from a fresh `yarn install`; per-workspace `tsc` + trademark lint pass.

**Test status:** api **73** (spectate.test.ts rewritten — live 409 + no-leak enumeration + settled
full replay + fail-safe allowlist unit tests; new `pending-view.test.ts` — cross-agent face
isolation; `config.test.ts` extended), engine **148** (new `public-view.test.ts` — board/counts/own-hand
projection, no opponent faces, no seed, public-only recent events), reference-agent **10** unchanged;
trademark lint + per-workspace `tsc --noEmit` clean. Live BscScan + real-browser run is the operator
step, as in 07/08/09.

## Open questions / documented extensions (deferred — not blockers)
- **`delayed` mode polish** (D32): a per-competition airing override, and whether `SPECTATOR_DELAY_MS`
  is wall-clock or turn-count based — arena airs the last finished game immediately (`0`), so the extra
  buffer stays optional.
- **Featured-hand curation** (arena's `FEATURED HAND` + 0.5×–4× speeds): the replay player already has
  speed controls; auto-selecting a *notable* completed hand (big swing, a RAINBOWSTORM) rather than
  merely the newest is a nice-to-have.
- **SSE** (parent §2 "optional SSE for the live spectator UI"): if ever added, it must stream only
  completed-session replays (or the `delayed` frontier), never the live tail — same boundary as T30.

---

### Index & FR housekeeping
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 10 | Spectator Is Replay-Only — anti-scrape hardening *(post-09 integrity)* | api + web (+ engine) | T30–T33 | 04, 06 (slots after 09) |`
  and a handoff line: *"After 09 → the public spectator serves only finished sessions (arena
  parity); the agent's own channel carries the partial-information view it needs to play."*
- Tag the tasks `[NFR-2]` (single source of truth / no rules or hidden-state logic outside the
  engine) — this document strengthens that guarantee at the read boundary.
