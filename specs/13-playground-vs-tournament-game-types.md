# Sub-Spec 13 — Playground vs Tournament are real game types (not just views)

**Status:** built (T44–T46 done; verified live + 99 api tests). Fixes the gap sub-spec 12 left in the `[battleground ▾]` menu: today **playground** and
**tournament** are two *views over the same finished-sessions data* (the tournament view just re-sorts the
same games' leaderboard). On `arena.dev.fun` they are genuinely **different games** — a **free chips
playground** vs a **paid buy-in tournament with a prize pool + jackpot**, each with its own tables,
economy, and season. This sub-spec wires our two views to the two **competition kinds the backend already
has** (`competition.kind = 'classic' | 'tournament'`, sub-spec 08), so each view shows its own games,
standings, and economics.

**Silo(s):** `packages/api` (public competitions read + `competitionKind` on sessions + scope coins to
playground) + `packages/web` (kind-filtered playground/tournament views + tournament economics).
**New parent tasks:** T44–T46 (continue the T1–T43 numbering).
**Depends on:** 08 (pooled tournament: `kind`, `pool_wei`, `jackpot_seed_wei`, `entry_fee_wei`,
`entries_close_at`, on-chain settlement), 12 (the `[battleground ▾]` dropdown, coins economy, coins
standings, replay/overview), 10 (replay-only spectator).
Slots **after 12**.
**Handoff artifact:** on `/battleground`, **playground** airs `classic` (free) games ranked by **coins**,
and **tournament** airs `tournament` games with a **prize pool · jackpot · buy-in · entries** header and
the tournament leaderboard — the two draw from **different competitions**, not the same dataset. A seeded
tournament competition proves it locally.

---

## Goal

Make the dropdown's two entries **two game types**, mirroring `arena.dev.fun`:

| | Playground (`classic`) | Tournament (`kind='tournament'`) |
|---|---|---|
| Premise | free, continuous — manage a **coin** bankroll across many tables | **buy in once**, compete for a **pooled prize** |
| Entry | free seat, **10-coin** buy-in (12's coin economy) | on-chain **buy-in** (`entry_fee_wei`, sub-spec 08) |
| Economy shown | **coins** standings | **prize pool** (`pool_wei`) + **jackpot** (`jackpot_seed_wei`) + **entries** |
| Ranking | coins (12) | openskill `ordinal()` (μ − 3σ), the pinned sort |
| Data source | sessions of `classic` competitions | sessions of `tournament` competitions |

Today both views read `GET /spectate/sessions` unfiltered and the tournament view merely re-sorts it. The
fix: the web must know each competition's **kind** and each session's **competition**, and filter/label by
that. The backend already stores all of it — it is just not exposed publicly.

## Read first

Sub-spec 08 (`DamnitsTournament`, `competitions.kind/pool_wei/jackpot_seed_wei/entry_fee_wei/entries_close_at`,
`competition_entries`, `orchestrator.listActiveCompetitions()` shape, on-chain pool/jackpot settlement).
Sub-spec 12 (the `[battleground ▾]` dropdown + `#playground`/`#tournament` modes; `agents.coins`,
`computeCoinSettlement`, `GET /playground/standings`; `gameNumber`; the overview featured replay). Sub-spec
10 (replay-only: only finished sessions are public). The reference: `arena.dev.fun/poker-playground`
(chips, free) vs `arena.dev.fun/poker-tournament` (**PRIZE POOL + JACKPOT**, buy-in, seasons).

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D55 | Two views = two kinds | The dropdown's **playground** ↔ `classic` competitions, **tournament** ↔ `kind='tournament'` competitions. Each view's replays + standings are filtered to its kind. | Keep re-sorting one dataset (today — the bug) |
| D56 | Public competitions read | New **`GET /competitions`** (no auth) returns active competitions' **public** metadata: `{ id, name, kind, entryFeeWei, poolWei, jackpotWei, entriesCloseAt, entriesCount, requiresClaim }`. Reuses `listActiveCompetitions` + an entries count; no secrets (no operator key/RPC). | Keep it behind the API key (web can't read it) |
| D57 | Kind on sessions | Session summaries gain **`competitionKind`** (join `sessions → competitions`), so the replay feed + standings can be split by kind without a second lookup. | Have the web map `competitionId → kind` itself (breaks for settled competitions absent from the active list) |
| D58 | Coins are a **playground** currency | The 12 coin economy (10-coin buy-in + placement settlement) applies to **`classic`** competitions only. A `tournament` seat is gated by its **on-chain buy-in** (08), not coins — so no double-charging. `joinSession`/`settleCoins` skip coins when `kind='tournament'`. **Refines 12** (which charged coins on every join). | Charge coins on tournaments too (double economy) |
| D59 | Tournament ranking unchanged | Tournament standings stay **openskill `ordinal()` (μ − 3σ)** — the pinned rule (12 D53). Coins never rank the tournament. | Rank the tournament by coins |
| D60 | Money display | Pool/jackpot/buy-in render as **formatted native testnet coin** (wei → `tBNB`) — non-secret, mirrors arena's "27,505 MON". Playground stays integer **coins**. | Show raw wei; invent a USD oracle |
| D61 | Empty tournament | If no active `tournament` competition exists, the tournament view shows an **empty state** ("no tournament running — the season opens when one is configured"), never playground data. | Fall back to playground games (the current confusing behaviour) |

> **Why coins for playground, on-chain for tournament.** Playground is the always-on, free, casual ladder —
> a soft **coin** bankroll (12) is the right stake and keeps it walletless. The tournament is the money
> event — a real **on-chain pool + jackpot** (08) that settles to the ranked field. Wiring each view to its
> own competition kind is what makes them feel like two games instead of one page with a toggle.

---

## Architecture (target shape)

```
BEFORE (12)                                   AFTER (this spec)
───────────                                    ─────────────────
[battleground ▾]                               [battleground ▾]
  playground → overview/standings/rules         playground → classic games only; coins standings   [A/B]
  tournament → SAME sessions, re-sorted          tournament → tournament games only, with:          [A/B]
                                                    ┌ PRIZE POOL (pool_wei)  JACKPOT (jackpot_wei) ┐
                                                    │ BUY-IN (entry_fee_wei) ENTRIES (n)           │
                                                    └ openskill leaderboard + tournament replays   ┘

GET /spectate/sessions → {…}                   GET /spectate/sessions → each session + competitionKind [A/D57]
(no public competitions list)                  GET /competitions → [{id,name,kind,poolWei,jackpotWei,       [A/D56]
                                                                     entryFeeWei,entriesCloseAt,entriesCount}]
joinSession: −10 coins always                  joinSession: −10 coins only for kind='classic' (D58)   [A]
settle: coins on every table                   settleCoins: only for classic sessions (D58)           [A]
```

---

## Part A — Backend: public competitions, kind on sessions, coins scoped to playground (T44)

### T44 — `GET /competitions`; `competitionKind` on sessions; classic-only coins `[FR-5, §5]`
- **`GET /competitions`** (no auth, D56) → `{ competitions: [{ id, name, kind, entryFeeWei, poolWei,
  jackpotWei, entriesCloseAt, entriesCount, requiresClaim }] }`. Reuse `listActiveCompetitions()` and add
  `entriesCount` (from `competition_entries`). Mount inside the same plugin so it serves under both
  `/api/battleground/*` and the `/api/arena/*` alias (12 D45). Public metadata only — never the operator
  key, RPC URL, or payout private data.
- **`competitionKind` on session summaries** (D57): `summaryFromRow` joins `sessions → competitions` and
  adds `competitionKind: 'classic' | 'tournament'` to `SessionSummary`, so the replay feed and standings
  can be split by kind. (Additive; existing fields unchanged.)
- **Scope coins to playground** (D58): in `joinSession`, deduct the 10-coin buy-in **only when the
  competition is `classic`**; a `tournament` seat is gated by its on-chain buy-in (08). In `settle()`, call
  `settleCoins` **only for `classic` sessions**. Tournament coins are untouched. `playgroundStandings`
  already filters to settled sessions — **scope it to `classic` competitions**; add a
  `tournamentLeaderboard`/reuse `leaderboard(competitionId)` for the tournament view.

*DoD: `GET /competitions` returns both kinds with pool/jackpot/fee/entries and no secrets; a session
summary carries `competitionKind`; joining a `classic` table costs 10 coins while a `tournament` table does
not; `playground/standings` counts only `classic` games; 12's coin tests still pass (a classic game
settles coins; a tournament game does not).*

---

## Part B — Web: two game types under the dropdown (T45)

### T45 — Kind-filtered playground + tournament views with economics `[FR-5]`
- On load, `GET /competitions`; split into **playground** (`classic`) and **tournament** (`tournament`).
- **Playground view** (default): the overview featured replay + `/spectate/sessions` filtered to
  `competitionKind === 'classic'`; **coins** standings (12) scoped to classic; rules. Hero copy:
  *"free coin ladder — manage a bankroll across many tables."*
- **Tournament view**: a header of stat cards — **PRIZE POOL** (`poolWei`→tBNB), **JACKPOT**
  (`jackpotWei`→tBNB), **BUY-IN** (`entryFeeWei`→tBNB), **ENTRIES** (`entriesCount`); the **openskill
  leaderboard** for the tournament competition (12's tournament view, now bound to the real tournament
  competition); and the featured replay filtered to `competitionKind === 'tournament'`. Hero copy:
  *"buy in once — play the season for the pooled prize."* Empty state when no tournament is active (D61).
- Keep `#playground` / `#tournament` deep-links, the menu, and the login header (12) unchanged.

*DoD: switching the dropdown changes **which games** are shown, not just the sort; the tournament view shows
prize pool / jackpot / buy-in / entries and lists only tournament games; the playground view shows only
classic games with coins; an absent tournament shows the empty state, never classic data; trademark lint clean.*

---

## Part C — Seed a tournament + end-to-end (T46)

### T46 — Tournament seed + walkthrough `[G1, NFR-6]`
- Extend the local seed (12's script / `demo-tournament.ts`) to stand up **one `tournament` competition**
  with a sponsor-seeded pool + jackpot and play a few tournament tables, alongside the `classic` playground
  games — so both views have real data.
- **E2E** (`battleground-e2e` extension): assert `GET /competitions` returns a `classic` and a `tournament`
  entry; `/playground/standings` contains only classic agents; a `classic` game charged coins while a
  `tournament` game did not; sessions carry `competitionKind`; the web tournament payload exposes
  `poolWei/jackpotWei/entryFeeWei/entriesCount`.

*DoD: the seed produces both a playground and a tournament with games; the walkthrough asserts the split
end-to-end; verified live that the two views show different games + the tournament economics.*

---

## Safety boundary (environment prohibited-action rules — do not violate)

- **No new on-chain behaviour.** This reads existing competition metadata and filters existing data; the
  08 pool/jackpot/settlement flows and 10's replay-only posture are unchanged. The coin change only
  **narrows** 12's economy to `classic` (removes a charge from tournaments), never adds a money movement.
- **`GET /competitions` is public metadata only** — id/name/kind/pool/jackpot/fee/entries/close. Never the
  operator key, RPC URL, payout addresses, or any live hidden game state (replay-only still holds).
- Spectating stays anonymous; the tournament's real buy-in remains a **human/agent on-chain action** (08),
  never performed by the site.

---

## New / changed config (§9)
None. Uses existing 08 tournament config (`TOURNAMENT_*`, `SPONSOR_POOL_SEED_WEI`, `JACKPOT_SEED_WEI`) and
12's coin config (`STARTING_COINS`, `PLAYGROUND_ENTRY_COINS`, now classic-only).

## Definition of Done (whole spec)
- [x] **A (T44):** `GET /competitions` (public) returns both kinds with pool/jackpot/fee/entries, no
      secrets; sessions carry `competitionKind`; coins are charged/settled for `classic` only;
      `playground/standings` is classic-scoped; 12's coin tests still pass.
- [x] **B (T45):** the dropdown switches **games**, not sorts — tournament shows prize pool/jackpot/buy-in/
      entries + openskill leaderboard + tournament replays; playground shows classic games + coins; empty
      tournament state handled.
- [x] **C (T46):** a seed stands up a playground **and** a tournament with games; the e2e asserts the split
      (competitions, kind on sessions, classic-only coins, tournament economics); verified live.
- [x] Per-workspace `tsc` (api build) + trademark lint pass; 99 api tests green. *(Full clean-`yarn install` not re-run this pass.)*

## Open questions / documented extensions (deferred — not blockers)
- **Seasons UI** (S9/S10, "past seasons") like arena — needs 08's season/close data surfaced; add if wanted.
- **A grid of multiple concurrent tables** per game type (arena lists several LIVE tables) — our replay-only
  posture airs one featured finished game; a selectable finished-game list is the closest parity.
- **Extra modes** (headsup / invite-only) and a **referral**/stats surface — new competition kinds + UI.
- **USD estimate** beside tBNB — needs a price oracle; deferred (D60 shows native only).

---

### Index & FR housekeeping (apply when built)
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 13 | Playground vs Tournament are real game types — kind-filtered views + tournament economics *(IA depth)* | \`api\` + \`web\` | T44–T46 | 08, 12 |`
  and a handoff line: *"After 12 → the `[battleground ▾]` playground/tournament entries are two game types
  (classic coins ladder vs pooled on-chain tournament with prize pool + jackpot), each airing its own
  games."*
- Note the **D58 refinement to 12**: the coin economy is now `classic`-only.
