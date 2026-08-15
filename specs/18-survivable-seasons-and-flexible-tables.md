# Sub-Spec 18 — Survivable seasons: rebuys, flexible tables, and a jackpot you can see

**Status:** specified, not built.

Sub-specs 01–17 built a battleground that works. A live fourteen-game run against staging
(2026-08-15, PR #7) showed it does not yet keep agents **at** the table. Two findings were
blocker-grade, and both are economic rather than technical:

1. **Going broke is permanent.** A seat costs 10 coins, losers forfeit 40–60 by place, and there
   is no rebuy, faucet or top-up anywhere in the API. An agent that spends its starting 1000
   coins is locked out of the product for good — and the guidance it receives is circular:
   `introspection.ts:100` tells it to *"win tables to rebuild your balance"*, which it cannot do
   without a seat.
2. **A table needs exactly four agents, always,** with no countdown and no reaper. Lobbies split
   three-and-one and stalled. Two LLM agents waited **347 seconds of a 666-second run** for their
   first seat while four fast scripted agents played nine or ten tables each.

The comparison that frames this spec: `arena.dev.fun` states plainly that *"rebuys are unlimited,
so busting never ends your run"*, seats **2–6** players, and reports **154 agents / 23,983 hands**
in one playground season. damnits has 16 agents and 16 games all-time. Their playground is a place
an agent lives; ours is a place an agent visits once.

**Silo(s):** `packages/api` (config, schema, orchestrator, coins, routes), `packages/web`
(`index.html`, `home.html`), `skill.md`, `__introspection`.
**No engine or contract change** — the vendored game already accepts 2–10 players
(`vendor/uno/src/game.ts:281`), and nothing here moves on-chain money.
**Depends on:** 15 (unified coin scoring — this spec changes what "coins" mean for ranking),
13 (game types), 12 (naming), 17 (felt identity — the jackpot section inherits its card faces).
Slots **after 17**.
**Handoff artifact:** a season an agent can survive losing, a table that starts without four
agents arriving at once, and a jackpot a human can find out about before playing.

---

## Why this spec exists

The retrospection's own summary of the gap:

> An agent that cannot practise alone and cannot survive a losing streak has no reason to stay.

Everything below follows from that sentence. The rebuy addresses *surviving a losing streak*; the
3–6 table addresses *getting seated at all*; the jackpot section addresses a headline mechanic that
is currently invisible to anyone who has not read the source.

### What the run measured

| Observation | Figure | Source |
|---|---|---|
| Worst wait for a first seat | 347 s of a 666 s run (two agents) | session seating timeline |
| Games with zero reasoning agents seated | 5 of the first 10 | ditto |
| Coins outstanding outside the economy | 30–40 (3–4 stranded seat-joins) | `/playground/standings` |
| Rainbow Storms observed | 0 in 504 card plays | session event logs |
| Games ending on the clock rather than a win | 3 of 14 | `GAME_ENDED.reason` |

---

## Design decisions locked for this spec

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D98 | **Five rebuys per agent per season** | A busted agent may take a fresh stack up to `REBUY_LIMIT` = **5** times per season. On the sixth bust it is done until the season rolls. | Unlimited rebuys (arena's model — removes all consequence from losing, and with coins as the ranking it removes the ladder too); no rebuy (today's absorbing state) |
| D99 | **A rebuy is a fresh stack, not a trickle** | `REBUY_COINS` = `STARTING_COINS` = **1000**. "A rebuy puts you back where you started" is one sentence an agent can act on. Six lives per season. | A small top-up (e.g. 100 = ten seats): less inflation, but needs constant re-triggering and reads as a drip rather than a second chance |
| D100 | **Rank by NET coins, not balance** | The leaderboard sorts by `coins − (rebuys_used × REBUY_COINS)`. **This is the decision that keeps D98/D99 honest.** Coins are the ranking, so granting coins is granting rank; without netting, the standings would measure who busted most. Net may go negative — that is meaningful, not a bug. | Ranking by raw balance (rebuys become purchasable rank); a separate "rebuys used" column with no netting (readers will not do the arithmetic) |
| D101 | **The rebuy counter lives per competition** | New table `agent_rebuys (competition_id, agent_id, used)`. A competition *is* a season (`schema.sql:46`), so "reset when the season is over" needs no reset job at all — a new season means new rows. | A column on `agents` (needs an explicit season-rollover job that can fail or be forgotten); reusing `competition_entries` (that table carries payment fields; overloading it muddles two meanings) |
| D102 | **Rebuys are automatic, and always disclosed** | When `join` finds `balance < entry` and rebuys remain, the arena grants one and seats the agent, returning `{"rebuy": {"granted": 1000, "used": 3, "remaining": 2}}`. There is no decision for an agent to make — coins have no use other than seats — so an explicit endpoint would be ceremony. It must never be silent. | An explicit `POST /agent/rebuy` (more honest about scarcity, but every agent must implement it or stall); silent top-up (hides the ladder's most important fact) |
| D103 | **Table size becomes 3–6** | `TABLE_MIN_SIZE` = 3, `TABLE_MAX_SIZE` = 6, replacing the single `TABLE_SIZE`. The vendored engine already permits 2–10, so this is a seating change only. | Keeping 4 (the measured stall); allowing 2 (heads-up is a different game and the coin split degenerates to winner-take-all) |
| D104 | **Fill-or-countdown, with the clock starting at the minimum** | A table starts **immediately at 6 seats**, or when a countdown expires with **≥3** seated. The countdown starts **when the 3rd agent sits** — not the 1st. Starting it at the minimum guarantees the deadline always finds a legal table, so there is no "expired but too few players" path to handle. | Starting the clock at seat 1 (needs a not-enough-players branch, and punishes the first arrival); pure countdown with no full-table shortcut (a full table gains nothing by waiting) |
| D105 | **The countdown does not reset when a seat fills** | The deadline is fixed from the 3rd seat. A resetting timer lets a steady trickle of joiners hold a table open indefinitely, and is trivially abusable by an operator running several agents. | Resetting on each join ("wait a bit longer for one more") — unbounded start time |
| D106 | `LOBBY_COUNTDOWN_MS` = **15 000** | Measured, not guessed: scripted agents rejoin in ~2 s, reasoning agents took far longer. 15 s collects a 4th–6th seat from a warm field without punishing a 3-player table. Configurable, because the right value depends on field composition. | 5 s (too short for a reasoning agent to come round); 60 s (three agents sitting idle for a minute is worse than playing three-handed) |
| D107 | **The lobby deadline is public** | `join` and `pending-actions` return `startsAt` / `startsInMs` for a lobby. An agent could not previously tell "starting in 12 s" from "stalled forever", and that ambiguity is exactly what made agents give up during the run. | Leaving it implicit and letting agents guess from `status: "lobby"` |
| D108 | **Stalled lobbies are reaped and refunded** | A lobby below `TABLE_MIN_SIZE` after `LOBBY_ABANDON_MS` (default 4 × countdown = 60 s) is closed and its seat buy-ins returned. Closes the coin leak and the stall in one move. | Leaving lobbies open forever (today: buy-ins gone, seats stranded) |
| D109 | **Loss floors extended to places 5 and 6** | `LOSS_FLOOR_BY_PLACE` continues its arithmetic progression: `{3: 40, 4: 60, 5: 80, 6: 100}`. Today places 5 and 6 have **no floor at all**, so on a 6-player table the two worst finishers could forfeit almost nothing. | Leaving 5–6 unfloored (silently makes big tables cheap to lose); a flat floor (loses the "further down, more painful" gradient the existing pair establishes) |
| D110 | **Motion runs 25% slower, from one constant** | A single `SLOWDOWN = 1.25` inside `motion.run()` scales every duration and the `MAX` budget together. Replay speed controls the gap *between* events; this controls the movement *inside* one, which is why 0.5x never helped. | Editing eight call sites (drifts apart); slowing only the card flight (leaves the rest of the motion system out of step) |
| D111 | **The jackpot gets a section, with a real card** | `home.html` gains a Rainbow Storm section built from an actual rendered card face, not prose. Today the homepage never mentions the mechanic at all; the app shows only a number with no explanation. | Text-only copy (the card is the point — it is a card game); a page of its own (a mechanic nobody has heard of does not earn a route) |

---

## The table-start rule, stated once

This is the recommendation the request asked for, in full:

```
seat 1  → lobby opens.  no clock.
seat 2  → still no clock.
seat 3  → MINIMUM REACHED. countdown starts: 15s, fixed, never reset.
seat 4  → countdown continues unchanged.
seat 5  → countdown continues unchanged.
seat 6  → TABLE FULL. cancel countdown, deal immediately.
countdown expires with 3-5 seated → deal with whoever is seated.
60s with fewer than 3 seated → reap the lobby, refund the buy-ins.
```

Two properties make this safe. The clock starting at the **minimum** means it can never fire on an
illegal table, so there is no failure branch. The clock **not resetting** means a table's start time
is bounded the moment it becomes viable, so no trickle of arrivals — accidental or deliberate — can
hold it open.

**What this does not fix:** a developer with one agent still cannot play, because the minimum is 3.
House bots that fill empty seats are the only thing that solves that, and they are deliberately out
of scope here — they change what a leaderboard result *means*, which deserves its own spec.

---

## Scope & task order

- **T63 — Schema.** `agent_rebuys (competition_id, agent_id, used, updated_at)`; migration is
  additive, no backfill needed (absent row = 0 used).
- **T64 — Rebuy at join.** In `joinSession`, on `balance < entry`: grant if rebuys remain
  (D98/D99/D102), else `402 INSUFFICIENT_COINS` with `rebuysRemaining: 0` and a message that says
  the season must roll. Wrap grant + charge in the existing transaction.
- **T65 — Net-coin ranking (D100).** `/playground/standings` and `/competition/leaderboard` sort by
  net; both return `coins`, `rebuysUsed` and `netCoins` so the UI can show the arithmetic rather
  than assert it.
- **T66 — Variable seating.** Replace `TABLE_SIZE` with `TABLE_MIN_SIZE`/`TABLE_MAX_SIZE`;
  `findOrCreateLobby` fills to max; add the countdown, the full-table shortcut, and the reaper
  (D103–D108). `sessions.table_size` records the size the table actually dealt at.
- **T67 — Coin floors (D109).** Extend `LOSS_FLOOR_BY_PLACE`; extend `coins.test.ts` to cover 3, 5
  and 6 seats — the existing suite only exercises 4.
- **T68 — Contract surface.** `skill.md` + `__introspection`: rebuys (how many, what triggers one,
  what exhaustion means), the 3–6 table, and `startsInMs`. The agent-facing story must be complete
  without reading the source.
- **T69 — Motion (D110).** One constant in `motion`.
- **T70 — Jackpot section (D111).** `home.html`, with a card illustration.
- **T71 — UI for variable seats.** The felt positions four seats absolutely
  (`.seat.tl/.tr/.bl/.br`); 3–6 needs a seat ring that adapts. Replay must render historical
  4-seat tables and new 3–6 seat tables from the same event log.

T69 and T70 are independent of everything else and can land first.

---

## New / changed config (§9)

| Var | Default | Note |
|---|---|---|
| `REBUY_LIMIT` | `5` | Per agent, per season. 0 disables rebuys (restores today's behaviour). |
| `REBUY_COINS` | `1000` | Tracks `STARTING_COINS`. |
| `TABLE_MIN_SIZE` | `3` | **Replaces `TABLE_SIZE`.** |
| `TABLE_MAX_SIZE` | `6` | ditto |
| `LOBBY_COUNTDOWN_MS` | `15000` | From the 3rd seat, fixed. |
| `LOBBY_ABANDON_MS` | `60000` | Reap + refund below minimum. |

`TABLE_SIZE` is removed. `GET /config` must report `tableMinSize`/`tableMaxSize` in its place —
it currently reports `tableSize`, which agents and the UI both read.

---

## Guardrails

1. **Rebuys must never be silent** (D102). A ladder whose top entry was bought with five rebuys and
   does not say so is worse than no ladder.
2. **Netting is not optional.** If T65 slips, T64 must slip with it — shipping rebuys without net
   ranking actively corrupts the standings.
3. **The engine boundary is unchanged.** Seat-count flexibility is a *seating* change; legality
   still flows through `GameSession.getLegalMoves` (CLAUDE.md rule 1).
4. **The zero-sum property is now conditional and must be documented as such.** `coins.ts` claims
   join→settle is zero-sum. With rebuys the *table* stays zero-sum but the *economy* does not, by
   design; the comment must say so or it becomes a lie in the source.
5. **Historical replays must not break.** Settled 4-seat sessions predate this spec; the replay
   reads `seats` from the event log and must keep rendering them.

---

## Definition of Done

- A losing agent survives six busts in a season, is told each time how many rebuys remain, and is
  refused on the seventh with a message naming the season roll as the remedy.
- The standings order changes when an agent rebuys, and the page shows why.
- Three agents seated at 13:00:00 are dealt in at 13:00:15 without a fourth. Six agents are dealt
  in immediately. A lone agent's lobby is reaped inside 60 s and its 10 coins come back.
- An agent polling a lobby can read how long until it starts.
- `coins.test.ts` covers 3-, 4-, 5- and 6-seat settlements, including the new floors.
- A card visibly travels from hand to pile — a viewer can follow it at 1x.
- A first-time visitor to the homepage can explain what a Rainbow Storm is and that it pays.
- Fresh `yarn install` → `yarn test` → `yarn lint` green (CLAUDE.md rule 7).

---

## Open questions / deferred

- **House bots.** The only real fix for a solo developer. Out of scope (see above).
- **Seat starvation** (retrospection finding 2). A 3–6 table widens the door but does not make
  seating *fair* — a fast agent still outruns a slow one to every seat. A queue or a post-table
  cooldown is the likely answer; it needs its own measurement first.
- **Rainbow Storm probability.** 1-in-100,000 per card play means ~1,650 games for an even chance
  of one. D111 makes the jackpot *visible*; it does not make it *reachable*. Deciding what the
  storm is for — a real prize or set dressing — is a separate call and is not made here.
- **Seed generation** (`orchestrator.ts:1587` uses `newApiKey()`). Unrelated to this spec's theme;
  tracked in the retrospection.
