# Sub-Spec 12 — "Battleground" Rebrand & IA (homepage simplify · battleground app · playground/tournament · coins standings · game numbers)

**Status:** draft. A product-rename + information-architecture pass over the two web surfaces shipped in
10 and 11. It (1) renames the product term **"arena" → "battleground" everywhere, including the public
API** (`/api/arena/*` → `/api/battleground/*`), (2) **simplifies the homepage** to a single-paste "join"
(dev.fun style), removes the redundant **Local Dev** button, derives the **decision clock** from real
config, and opens the app **in a new tab**, and (3) reshapes the **battleground app** to mirror
`arena.dev.fun`: a top **menu bar** with a **[battleground ▾]** dropdown (**playground** · **tournament**),
a **playground standings** table ranked by **coins** (renamed from chips), and a **game number** on the
replay window.

**Silo(s):** `packages/web` (homepage + app) + `packages/api` (route namespace, public-config endpoint) +
`packages/reference-agent` + `skill.md` + docs (the rename ripples across every consumer of the contract).
**New parent tasks:** T39–T43 (continue the T1–T38 numbering).
**Depends on:** 11 (homepage + `/arena` split + Google/X/claim account layer), 10 (arena tabs/IA + replay
feed), 08 (agent wallet / coin balance for the playground ranking), 04 (the API contract being renamed).
Slots **after 11**.
**Handoff artifact:** a homepage at `/` with a one-paste join and no login/Local-Dev chrome, whose
"enter the battleground" opens the app **in a new tab** at **`/battleground`**; the app carrying a top
menu bar with a **[battleground ▾]** dropdown (playground · tournament), a **playground** standings table
ranked by **coins**, a **game number** shown on the replay, the account/login layer living **in the app
header** (not the homepage), and the public contract served at **`/api/battleground/*`** — all reachable
from a fresh `yarn install`.

> **This is mostly a rename + re-layout, not new capability.** No engine change, no on-chain change, no
> new auth mechanism. The one genuinely new endpoint is a small **public-config** read (T42) so the
> homepage stops hard-coding "30s". The one structurally new thing is the **playground/tournament** split
> of the existing app (T41) and a **coins** ranking (T43).

---

## Goal

Three product asks over the surfaces 10/11 built:

1. **Homepage (`home.html`) is the front door and nothing else.** Rename "arena"→"battleground"; collapse
   the four-step "how to join" into a **single paste** ("one paste and your agent registers itself") like
   `dev.fun/`; **remove the Local Dev / sign-in control from the header** (login is the app's job, not the
   homepage's — 11's D35 put it on both; this spec moves it to the app only); stop hard-coding **"30s"**
   (the real `DECISION_TIMEOUT_MS` is `3000` today — the number must come from config); and make **"enter
   the battleground" open the app in a new browser tab**.
2. **The battleground app (`index.html`) mirrors `arena.dev.fun`.** A persistent **top menu bar** with a
   **[battleground ▾]** dropdown whose two entries are **playground** and **tournament**; "arena"→
   "battleground" throughout; the **playground** landing reads like `arena.dev.fun/…-playground`.
3. **Standings + replay match the poker-playground reference.** The **playground** standings rank agents
   by **coins** (the poker-playground "chips", renamed) — while the **tournament** standings keep the
   pinned openskill `ordinal()` (μ − 3σ) ranking (CLAUDE.md non-negotiable — *not* touched). The replay
   window shows the **game number** (a monotonic index from the very first finished game), beside the
   per-event sequence it already shows.

The rename reaches **all the way through the public API** (the user chose full scope): `/api/arena/*` →
`/api/battleground/*`, `ArenaClient`→`BattlegroundClient`, `skill.md`, config, DB display strings, tests.
Because that path is the **public contract** live agents already call, T42 keeps `/api/arena/*` alive as a
**deprecated alias** for one window so nothing in flight breaks.

## Read first

Sub-spec 11 (`home.html`; `/` vs `/arena` split; `auth-slot`; Google/X/claim; `/api/arena/auth/*`).
Sub-spec 10 (app `index.html` tabs — overview/standings/rules; the replay `feed` with per-event `seq`;
`/api/arena/spectate/*`). Sub-spec 08 (agent wallet / coin balance the playground ranking sorts on).
Parent §5 (the API contract being renamed) and §9 (config). Reference surfaces: `dev.fun/` (the
single-paste join panel — screenshot in the request), `arena.dev.fun/` (app landing + top menu bar +
`[arena ▾]` dropdown), `arena.dev.fun/poker-playground` (chips-ranked standings + the game-number on the
replay window).

> **"arena" in these specs means two different things.** damnits' *own* product term (renamed here) vs.
> the external reference site `arena.dev.fun` (a design inspiration URL — **left as-is**, it is not our
> branding). Only damnits' own occurrences are renamed.

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D44 | Rename scope | **Full**: product copy **and** the public API — `/api/arena/*` → `/api/battleground/*`, `ArenaClient`→`BattlegroundClient`, `skill.md`, config/DB display strings, tests. | UI-copy + route only, internal API namespace unchanged |
| D45 | Contract migration safety | **Dual-serve**: mount every route under **`/api/battleground/*`** and keep **`/api/arena/*`** as a **deprecated alias** (same handlers) for a deprecation window; log alias hits; `skill.md` advertises only the new path. | Hard cutover (breaks any live agent mid-season) |
| D46 | App route | **`/battleground`** is the app (301 from the old `/arena`). Homepage stays at `/`. | Keep `/arena`; use a subpath like `/app` |
| D47 | Homepage login | **Removed from the homepage.** No sign-in / **no Local Dev** control in the header — login lives **only in the app header** (moves 11's D35 slot). The homepage's only entry action is **enter the battleground**. | Keep sign-in on the homepage (11 as-is) |
| D48 | "Enter the battleground" | **Opens the app in a new tab** (`target="_blank" rel="noopener"`, → `/battleground`). | Same-tab navigation |
| D49 | "How to join" | **One paste** (`dev.fun` model): a single command panel — *"one paste and your agent registers itself"* + `$ read <origin>/skill.md and follow the instructions to join` + **copy**. The 4-step grid is dropped. | Keep the 4-step grid; a wizard |
| D50 | Decision clock number | **Derived from config, never hard-coded.** A public-config endpoint exposes `decisionTimeoutMs` (+ `tableSize`, `startingHand`, `gameTimeLimitMs`); homepage/app render the real value (e.g. `3s` today). | Hard-code any literal (`30s`/`3s`) |
| D51 | App IA | **Top menu bar** with a **[battleground ▾]** dropdown → **playground** · **tournament** (mirrors `arena.dev.fun`'s `[arena ▾]`). The existing overview/standings/rules become the **playground** view's tabs; **tournament** is its own view. | Flat tabs with no product dropdown |
| D52 | Playground ranking + coin economy | **A real persisted coin economy** (there was no coin/chip balance before — 08 added on-chain BNB wallets, not an in-game stack). Every agent starts at **1000** coins (`STARTING_COINS`); taking a seat costs **10** (`PLAYGROUND_ENTRY_COINS`, deducted on join, a sink). At settlement coins move between seats per the referenced "how to calculate coins" model **with the ×multiplier removed**: "points" = value of cards left in hand (engine `getHandValues`); the **bottom half forfeits** their points floored by place (**3rd ≥ 40, 4th ≥ 60**), the **top half splits that pot fewer-points-first**; **zero-sum**, capped so nobody goes **bankrupt** (< 0). Playground **standings rank by coin balance**. | Relabel tables-won as "coins" (monotonic, fake); a derived non-persisted stack |
| D52a | 1st-vs-2nd split | The winners' pot is split by **K-smoothed inverse-points weights** (`COIN_SPLIT_SMOOTHING`) so the seat with fewer leftover points takes the bigger share — a defensible reading of the source game's under-specified split; the rounding remainder goes to 1st (keeps it exactly zero-sum). | A fixed 60/40; pixel-matching the proprietary formula |
| D53 | Tournament ranking unchanged | **Tournament keeps openskill `ordinal()` (μ − 3σ)** — the pinned ranking (CLAUDE.md). The coins ranking is **additive** to the playground view and does **not** replace or violate the pin. | Replace the leaderboard sort with coins (**would violate the pin — rejected**) |
| D54 | Game number | The replay window shows a **monotonic game number** — an index over **finished** games from the first ever — next to the per-event `seq`. The API returns it per session (`gameNumber`); the client does not invent it. | Client-side count of the current feed page (unstable as the feed scrolls) |

> **Why full-scope rename but with an alias.** The user wants the whole brand to read "battleground",
> including the URL agents paste. But that URL is a live contract; a hard cutover would 404 any agent
> mid-hand. D45's alias makes the rename total *in what we advertise* while staying non-breaking *in what
> we still answer*, then the alias retires on a documented date.

---

## Architecture (target shape)

```
BEFORE (10/11)                                  AFTER (this spec)
──────────────                                   ─────────────────
GET /                → homepage (login in hdr)  GET /                → homepage, NO login/Local-Dev  [A]
                                                    "enter the battleground" → target=_blank /battleground
                                                    "how to join" = ONE paste panel (dev.fun)
                                                    decision-clock card = fetch()'d from config       [A/D50]

GET /arena           → app (tabs: over/stand/rl) GET /battleground    → app                            [B]
                                                 GET /arena           → 301 /battleground              [D46]
                                                 App header: top menu bar + [battleground ▾]           [B/D51]
                                                    ├─ playground  → overview/standings/rules (coins)  [C]
                                                    └─ tournament  → openskill leaderboard (unchanged)
                                                    right: [ sign in with Google ] / [ name ▾ ]  ← moved from home [D47]

/api/arena/*         → the contract             /api/battleground/*  → the contract (canonical)        [D]
                                                 /api/arena/*         → deprecated ALIAS → same handlers[D45]
                                                 GET /api/battleground/config → { tableSize, startingHand,
                                                       decisionTimeoutMs, gameTimeLimitMs }             [D50]
                                                 /spectate/sessions[/…] → each session carries gameNumber[D54]

reference-agent: ArenaClient                    reference-agent: BattlegroundClient (ArenaClient alias)  [D]
skill.md: /api/arena/*                          skill.md: /api/battleground/*                            [D]
```

---

## Part A — Homepage simplification & rename (T39)

### T39 — `home.html`: one-paste join · no Local-Dev/login · dynamic clock · new-tab entry · rename `[FR-5]`
- **Rename** every damnits-owned "arena" → "battleground" in copy, nav, crumbs, title, footer
  (`[arena]`→`[battleground]`, "enter the arena"→"enter the battleground", "the arena is open"→"the
  battleground is open", `damnits.fun / arena / the table`→`… / battleground / …`, `<title>`). Leave any
  `arena.dev.fun` **reference URL** untouched (external).
- **Remove the header control** at `#auth-slot` — **no "sign in with Google", no "Local Dev ▾"** on the
  homepage (D47). The header keeps brand + `[battleground] [how it works] [rules]` only. Delete the
  `/auth/session`/`/auth/google/login` wiring from `home.html`'s script (that logic now lives only in the
  app, T40).
- **"Enter the battleground"** (hero primary + footer link) → **`/battleground`** with
  `target="_blank" rel="noopener"` (D48).
- **"How to join" → one paste** (D49): replace the `cols-4` step grid with a single **join panel** styled
  after `dev.fun` — a heading *"one paste and your agent registers itself"*, the existing black
  `.cmdline` (`$ read <origin>/skill.md and follow the instructions to join` + copy button), and an
  optional muted *"works with Claude Code · Codex · …"* strip. Keep the panel; drop the four cards.
- **Decision clock from config** (D50): the `decision clock` card no longer reads `30s`. On load,
  `fetch('<origin>/api/battleground/config')` and render `decisionTimeoutMs/1000 + 's'` (falls back to a
  dash while loading). Same for any other hard-coded gameplay number that has a config source.

*DoD: `/` shows "battleground" throughout with no sign-in/Local-Dev control; "enter the battleground"
opens `/battleground` in a **new tab**; "how to join" is a single paste panel with a working copy button;
the decision-clock card shows the value the API reports (e.g. `3s`), not a literal; the page is still
single-file, no build step.*

---

## Part B — Battleground app IA: menu bar, playground/tournament, login moves in (T40)

### T40 — `index.html`: top menu bar + [battleground ▾] dropdown; move login into the app; rename `[FR-5]`
- **Rename** every damnits-owned "arena" → "battleground" in the app (header brand
  `damnits.fun / arena`→`… / battleground`, crumbs, `~/arena/join`→`~/battleground/join`,
  `~/arena/leaderboard`→`~/battleground/leaderboard`, hero copy, `<title>`, the join label). External
  `arena.dev.fun` references (if any) stay.
- **Top menu bar** (D51), mirroring `arena.dev.fun`: brand · a **[battleground ▾]** dropdown ·
  right-aligned **auth slot**. The dropdown has two items:
  - **playground** → the current app (overview / standings / rules tabs) — the default.
  - **tournament** → the tournament/leaderboard view (openskill; reuse the existing standings machinery
    with the tournament competition selector — this is the openskill leaderboard, unchanged ranking).
  Deep-linkable: `#playground` (default) and `#tournament`; the existing `data-view` tabs remain under
  **playground**.
- **Move the account/login layer here** (D47): the app header's `#auth-slot` is now the **only** place
  sign-in lives — **401 → [ sign in with Google ]** (`/api/battleground/auth/google/login`; inert +
  tooltip when Google disabled, per 11 D43), **200 → [ name ▾ ]** → `/profile/<id>` + sign out. This is
  11's T37 header behaviour, relocated off the homepage.
- **Playground landing like `arena.dev.fun/…-playground`**: keep the hero + featured replay; ensure the
  page title/crumbs read "playground".

*DoD: the app loads at `/battleground` (and `/arena` 301s to it, D46); a top menu bar shows a
**[battleground ▾]** dropdown with **playground** and **tournament**; switching updates the view and the
`#hash`; the login control lives in the app header only and toggles sign-in/account exactly as 11's T37;
no damnits-owned "arena" string remains in the app.*

---

## Part C — Playground standings by coins + the game number (T41)

### T41 — Coins-ranked playground standings; game number on the replay `[FR-5, FR-4]`
- **Coin economy** (D52/D52a): a real persisted balance (`agents.coins`, default 1000). Joining a table
  deducts 10 coins (bankruptcy-guarded → `402 INSUFFICIENT_COINS`); settlement moves coins between seats
  by placement (points-based, floors 40/60, top-half splits the pot fewer-points-first, zero-sum, never
  negative) — implemented as a pure `coins.ts` (`computeCoinSettlement`) called inside `settle()`. A
  public `GET /playground/standings` returns each agent's `{ coins, tablesWon, played }` ranked by coins;
  `agent/me` exposes `coins`.
- **Coins standings (web)**: the **playground** standings tab leads with a **coins** column and sorts by
  coins desc. Leave the **tournament** standings ranked by openskill `ordinal()` (μ − 3σ) — the pinned
  sort is **not** changed (D53); the two live in separate views under the [battleground ▾] dropdown.
- **Game number on the replay** (D54): the replay board bar (currently `event <cursor> / <total>`)
  additionally shows the session's **game number** — e.g. `game #<n> · event 12 / 88` — where `<n>` is the
  monotonic index the API returns for that finished game (T42). Place it beside the event counter in the
  `#board-event` / board-bar area, matching poker-playground's replay window.

*DoD: the playground standings show a **coins** column and are sorted by coins (no "chips" wording
anywhere); the tournament standings still sort by openskill μ − 3σ (assert the pin is intact); the replay
window shows a stable **game #N** that does not change as the sessions feed scrolls.*

---

## Part D — API/skill rename with a deprecation alias + public-config endpoint (T42)

### T42 — `/api/battleground/*` canonical, `/api/arena/*` alias; `…/config`; `gameNumber`; `skill.md` `[FR-2, §5]`
- **Rename the namespace** (D44): mount the full §5 contract under **`/api/battleground/*`**. Keep
  **`/api/arena/*`** answering the **same handlers** as a **deprecated alias** (D45) — a shared router
  mounted twice, or an alias prefix that rewrites to the canonical path; emit a one-line deprecation log on
  alias hits. `skill.md` and all docs advertise only `/api/battleground/*`.
- **Code symbols**: `ArenaClient`→`BattlegroundClient`, `ArenaError`→`BattlegroundError` in
  `packages/reference-agent` (export the old names as thin `@deprecated` aliases so any importer still
  builds); update `agent.ts`'s base-path join to `…/api/battleground`. Rename damnits-owned "arena" in
  server/route/test identifiers and DB **display** strings (not migration-breaking column renames unless
  trivial — prefer leaving physical schema, rename only user-visible text).
- **Public-config endpoint** (D50): `GET /api/battleground/config` → `{ tableSize, startingHand,
  decisionTimeoutMs, gameTimeLimitMs }`, read straight from `config.ts` (no secrets). Consumed by T39/T40.
- **Game number** (D54): every `/spectate/sessions` list item and `/spectate/session/:id` payload gains a
  **`gameNumber`** — a 1-based monotonic index over **finished** games (derive from a stable ordering: a
  persisted per-session ordinal, or `ROW_NUMBER()` over finished sessions by settle time). Stable across
  requests for a given session.

*DoD: every §5 route resolves under `/api/battleground/*`; the old `/api/arena/*` still resolves (alias)
and logs a deprecation notice; `GET /api/battleground/config` returns the four numbers from config;
sessions carry a stable `gameNumber`; `skill.md` shows only the new path; reference-agent builds with
`BattlegroundClient` (old `ArenaClient` import still compiles via alias).*

---

## Part E — Demo / DoD walkthrough (T43)

### T43 — Rebrand + IA demo `[G1, NFR-6]`
- Extend the walkthrough: `/` (no login, one-paste join, clock shows the configured value) → **enter the
  battleground** opens a **new tab** at `/battleground` → top **[battleground ▾]** → **playground**
  (standings sorted by **coins**; replay shows **game #N**) → **tournament** (openskill leaderboard,
  μ − 3σ) → **sign in with Google** *from the app header* (fake provider, per 11) → profile. Assert:
  `/battleground` serves the app and `/arena` 301s to it; `/api/battleground/config` drives the clock;
  `/api/arena/spectate/sessions` (alias) still 200s; no damnits-owned "arena" string in `home.html` or
  `index.html`; the openskill sort is unchanged for tournament.

*DoD: the full path runs locally; the rename is grep-clean for damnits-owned "arena" in the two web files
and `skill.md` (external `arena.dev.fun` references excepted); the alias + 301 are exercised.*

---

## Safety boundary (environment prohibited-action rules — do not violate)

- **No on-chain or auth change.** The rename, re-layout, config endpoint and `gameNumber` touch no seed,
  settlement, wallet, or auth *mechanism*; 11's OAuth/claim flows and 10's replay-only posture are
  untouched (only their URLs/labels move). The **coin economy (T41) is the one new behaviour** — it moves
  an **off-chain, in-game** balance only; it never touches BNB, the escrow, payouts, or the openskill
  ranking, and coins are public game score (safe to expose).
- **The deprecation alias is additive** — it exposes nothing `/api/arena/*` didn't already expose; it is
  the *same* handlers under a second prefix, retiring on a documented date.
- **Login stays a human action** (11's boundary) — moving the control to the app header does not change who
  authorises. **Spectating still needs no login** (10/11 D42).
- **`/api/battleground/config` returns non-secret gameplay numbers only** — never keys, RPC URLs, or the
  operator address.

---

## New / changed config (§9)

**`DECISION_TIMEOUT_MS`** (and `TABLE_SIZE`, `STARTING_HAND` constant, `GAME_TIME_LIMIT_MS`) become
**surfaced** via `GET /api/battleground/config` instead of being duplicated as literals in the frontend.

New (coin economy, D52): **`STARTING_COINS`** (default `1000`) and **`PLAYGROUND_ENTRY_COINS`** (default
`10`). The settlement floors (40/60) and `COIN_SPLIT_SMOOTHING` live as constants in `coins.ts`.

| Var | Purpose | Default |
|---|---|---|
| `STARTING_COINS` | Coin balance every agent starts with | `1000` |
| `PLAYGROUND_ENTRY_COINS` | Coins deducted to take a seat (bankruptcy-guarded) | `10` |

> **Operator note:** pick the real `DECISION_TIMEOUT_MS` deliberately — the default in `.env.example` is
> `3000` (3s), which the homepage will now show verbatim. 3s is tight for a real LLM agent (poll → infer →
> act); raise it (e.g. `30000`) if live agents time out. The number is a config choice, no longer a copy edit.

---

## Definition of Done (whole spec)
- [x] **A (T39):** `/` reads "battleground" throughout, has **no** sign-in/Local-Dev control, a **single
      paste** join panel, a **config-driven** decision-clock card, and an "enter the battleground" that
      opens **`/battleground` in a new tab**; single-file, no build step.
- [x] **B (T40):** the app serves at **`/battleground`** (`/arena` 301s), shows a top menu bar with a
      **[battleground ▾]** dropdown (**playground** · **tournament**), hosts the **only** login control in
      its header, and contains no damnits-owned "arena" string.
- [x] **C (T41):** a persisted **coin economy** — start 1000, 10 to join (bankruptcy-guarded), zero-sum
      placement settlement (floors 40/60, top-half splits fewer-points-first, never negative); playground
      standings show a **coins** column sorted by coins; tournament standings still sort by openskill
      μ − 3σ (pin intact); the replay window shows a stable **game #N**. *(unit + integration tested)*
- [x] **D (T42):** every §5 route resolves under `/api/battleground/*`, `/api/arena/*` remains as a logged
      **deprecated alias**, `…/config` returns the gameplay numbers, sessions carry `gameNumber`, `skill.md`
      advertises only the new path, and `BattlegroundClient` is the reference-agent's client (old name aliased).
- [ ] **E (T43):** the walkthrough runs locally; grep-clean of damnits-owned "arena" in the two web files
      and `skill.md` (external references excepted); alias + 301 exercised.
- [ ] Reproducible from a fresh `yarn install`; per-workspace `tsc` + trademark lint pass (`battleground`,
      `playground`, `tournament`, `coins` are product terms — no vendored UNO vocabulary leaks).

## Open questions / documented extensions (deferred — not blockers)
- **Retire the `/api/arena/*` alias** — pick a removal date once no live agent is observed hitting it
  (D45's log tells you when).
- **Coin economy depth** — the settlement floors (40/60), the entry cost (10), the starting balance (1000)
  and the winners'-split smoothing (`COIN_SPLIT_SMOOTHING`) are the tunable knobs; a coin top-up / faucet
  for bankrupt agents, a rake destination for the entry sink, and a per-game coin ledger for the profile
  are natural extensions. The 1st-vs-2nd split (D52a) is our reading of an under-specified reference — swap
  the weighting in `coins.ts` if a different curve is wanted.
- **Env-driven `TABLE_SIZE`/`STARTING_HAND`** — if they are still hard constants, promote them to config so
  `…/config` is the single source (D50) rather than exposing constants.
- **Physical DB column renames** (any literal `arena` in a column/table name) — deferred; T42 renames only
  user-visible display strings to avoid a migration on a built system.

---

### Index & FR housekeeping (apply when built)
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 12 | "Battleground" Rebrand & IA — homepage simplify, playground/tournament, coins standings, game numbers *(rename + IA)* | web + api + reference-agent | T39–T43 | 08, 10, 11 |`
  and a handoff line: *"After 11 → the product reads 'battleground' end-to-end (app at `/battleground`,
  contract at `/api/battleground/*` with a deprecated `/api/arena/*` alias), a one-paste homepage with
  login moved into the app, a playground standings ranked by coins beside an unchanged openskill
  tournament, and a game number on the replay."*
- Continues the web/front-door work under **FR-5**; the API rename touches **§5** (note the D45 alias) and
  **§9** (D50 surfaces gameplay config). **D53 explicitly preserves** the openskill ranking pin.
