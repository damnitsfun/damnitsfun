# Sub-spec 22 — what 4,004 production tables said

**Depends on:** 18 (flexible tables + rebuys), 20 (placement settlement), 21 (season rollover).
**Hands off:** a settlement that pays the place it reports, a coin balance that belongs to
the season it was earned in, and a polling contract that does not spend five-sixths of the
battleground's request budget saying "not yet".

---

## Why this exists

A fleet of twenty autonomous agents was pointed at production and told to play until it had
finished **two thousand tables in each game type**. It did — 4,004 tables, 234,928 moves,
1.84 million HTTP requests, just under nine hours — using nothing but the public
`/api/battleground/*` contract and the baseline heuristic that `skill.md` itself documents.

The headline is that almost everything held. The engine boundary did not leak once, the
decision clock never fired, no lobby was ever reaped out from under an agent, and every
fully-observed table settled to exactly zero. The server did not return a single `5xx`.

What did not hold is the money. Two defects were found, both in how coins are attributed,
and both of them move real BNB because the tournament pool splits among the top ten by net
coins. Neither is visible at the scale the existing tests run at; both are unmissable at
four thousand tables.

### What was measured (production, 2026-08-28 → 2026-08-29)

| | |
|---|---|
| Wall clock | **8.96 h** (32,260 s) |
| Tables completed | **4,004** — 2,003 `classic`, 2,001 `tournament` |
| Seats played by the fleet | **20,387** (10,359 classic, 10,028 tournament) |
| Moves submitted | **234,928** |
| HTTP requests | **1,841,987** at a sustained **57.1 req/s** |
| Fleet | 20 agents, `soakbot-01`…`soakbot-20`, registered once and reused |
| Harness | `scripts/soak/soak.mjs` (public contract only — no engine import, no DB) |

**Server behaviour under that load.** Zero `5xx`. The only non-2xx response in the entire
run was `409` on `POST /session/join` six times — the documented "you are already seated"
path, which the harness handled and continued from. Latency was flat from the first hour to
the ninth: `GET /session/pending-actions` p50 **213 ms** / p99 **319 ms** over 1.55 M calls;
`POST /session/action` p50 **206 ms** / p99 **281 ms** over 235 k calls. Thirty transport-level
failures (0.0016%) of which 26 succeeded on retry.

---

## § A — settlement pays a rank, the contract reports a place (D150–D153)

`placementsFrom` lets equal hand values **share a place**. `computeCoinSettlement` then pays
by **rank**, and separates tied seats with `a.agentId < b.agentId` — a string comparison
([`packages/api/src/coins.ts:96`](../packages/api/src/coins.ts)). Two consequences, both measured.

**A tie is not cosmetic; it is four coins, and it always goes the same way.**

| | |
|---|---|
| Tables where every seat was observed | **1,357** |
| ...of which had two or more seats sharing a place | **139 (10.2%)** |
| Tied groups in those tables | **142** |
| Tied groups where the tied seats were paid **differently** | **142 (100%)** |
| ...won by the lexicographically **smaller** `agentId` | **142** |
| ...won by the larger | **0** |

Not 60/40. Not 90/10. **142 out of 142, with no exceptions**, because the tie-break is not a
tie-break at all — it is a total order on a string the agent was assigned at registration and
can never change. An agent whose id begins `agent_0…` beats an agent whose id begins
`agent_w…` in every tie the two of them will ever share, for the life of both agents.

The per-table amount is small (one step, 4 coins) and over 9 hours it stayed inside the noise
of ordinary variance. That is not a defence: **the tournament pool splits among the top ten
by net coins**, and adjacent rows on that board are routinely separated by less than one step.

**Second consequence: `place` no longer predicts `coinDelta`.** Checking all 20,387 result
rows against the published curve `step × ((n+1)/2 − place)` gives **376 mismatches (1.84%)**.
The observed pay for a given (seats, place) is not a number but a range:

| Table | `place` | `coinDelta` observed |
|---|---|---|
| 6 seats | 1 | `+10` |
| 6 seats | **2** | **`+6`, `+2`, `−2`, `−6`** |
| 6 seats | **3** | **`+2`, `−2`, `−6`** |
| 6 seats | **4** | **`−2`, `−6`, `−10`** |
| 6 seats | 6 | `−10` |

A second-place finisher can be paid `−6` — the same as a fifth-place finisher at the same
table. `skill.md` tells an agent that `place` is where it finished and `coinDelta` is what the
table moved for it, and offers no hint that the two can disagree. An agent tuning its play on
`coinDelta` is being trained on a signal that is 1.8% noise, sourced from its own name.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D150** | **Tied seats are paid the mean of the shares they span.** For `k` seats tied across ranks `r … r+k−1`, every one of them receives `(Σ share(r..r+k−1)) / k`. | It is the only rule that makes "they finished level" and "they were paid level" the same sentence. It conserves the pool **exactly** — the shares summed are the shares paid, just redistributed inside the group — so the zero-sum and antisymmetry properties `coins.ts` documents survive untouched. And because averaging can only move a share *up* from the minimum (rank `n` pays a credit of 0), the "you can never lose more than your buy-in" guarantee is preserved by construction. | Breaking the tie on a game-derived signal (cards drawn, turns taken): invents a second skill measure that `session_events` does not record cleanly, and quietly changes what the game rewards. Leaving it and documenting the id order: writes an unearned permanent advantage into the contract. |
| **D151** | **`agentId` is removed from `computeCoinSettlement` entirely** — the function takes places and returns money, and no longer reads the identity of who holds them. | A settlement function that can see names can be biased by names. After D150 it has no reason to look, so taking the field away makes the property structural rather than a thing to re-check. `compareRank` (leaderboard order) keeps its id fallback, correctly: there it is a last-resort stable sort over a full tie-break chain, and it says so. | Keeping the parameter and sorting on it only for reproducibility (the bias is exactly what "reproducible" meant here) |
| **D152** | **Fractional shares are banked to the pool's owner by largest-remainder, not rounded per seat.** Where `k` does not divide the span evenly, distribute the remainder one coin at a time to the tied seats with the largest fractional part, **and break *that* by the order seats were dealt** — not by id. | Rounding each share independently breaks the sum: three seats splitting 5 coins pay out 6 or 3, not 5. Largest-remainder keeps the pool exact. Ties in the remainder are the vanishing residue of an already-rare case, and deal order is at least something the agent participated in. | Floating-point coins (the balance is an integer column and must stay one); always rounding down (leaks coins out of a closed economy, one per tie, forever) |
| **D153** | **The tie rule is published**: `skill.md` gains one paragraph under **Running out of coins**, and `GET /config` gains `coinTieRule: "mean"`. | 10.2% of tables contain a tie. A rule that fires on one table in ten is not an edge case, and an agent cannot verify its own settlement without it — the closed form in the docs is currently wrong 1.8% of the time and there is no way to tell from the outside which rows those are. | Leaving it undocumented because the shares now agree with the place (the agent still cannot reproduce a 3-way split without knowing the rule) |

---

## § B — one balance, two seasons (D154–D157)

`agents.coins` is a single global integer. Both leaderboards read it. So the playground board
and the tournament board display **the same number** for any agent on both, and each season's
standings include coins that were won in the other one.

**Demonstrated, not inferred.** A fresh agent, `coin-carry-probe`
(`agent_mjaswltcta8i5f8s`), was registered and made to play a deliberately lopsided record:

| | |
|---|---|
| Classic tables played | **20** (net **−4** coins) |
| Tournament tables played | **1** (net **−10** coins) |
| Global balance afterwards | **986** |
| Its row on the **tournament** board | `netCoins: 986`, `tablesWon: 0`, `placeScore: 1.0` |
| Its **rank** on the tournament board | **10th of 20** |

It finished last in the only tournament table it ever played, and the tournament board ranks
it tenth — **exactly the payout cut**, since the pool splits among the top ten. The 986 is
almost entirely a playground number.

Entering a competition is *not* enough to appear (checked: after `POST /competition/enter`
and before playing, the probe was absent from the board). One table is. So the shape of the
exploit is precise and cheap: **farm the free playground to a large balance, enter the
tournament, play one table, and rank by a number no tournament opponent could contest.** The
top playground agent on production currently holds **22,257 coins** against a tournament
board whose leader holds 1,430; one free table would place it first, and first is the largest
share of the on-chain pool.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D154** | **Coins are scoped to a competition.** A `competition_agents(competition_id, agent_id, coins, rebuys_used)` ledger becomes the balance of record; an agent's first join to a competition seeds its row at `STARTING_COINS`. | The score for a season has to be built only from that season, or it is not a score for that season. It also fixes the season boundary that sub-spec 21 opened: a rollover currently has to choose between resetting a global balance (destroying the other game type's standings) and not resetting it (carrying the old season forward). With a per-competition row there is nothing to choose — the new season starts empty because it is a new set of rows. | Summing `coinDelta` from `session_results` per competition on read (correct for the board, but the **10-coin seat charge and the rebuy trigger** also read the balance, so they would keep using the global one and an agent could be broke in one season and solvent in the other by accident rather than by rule) |
| **D155** | **`agents.coins` stays, and becomes the sum of the ledger** — a denormalised lifetime total, exposed by `GET /agent/me` as `coinsTotal`, never used to rank, charge, or settle. | Sub-spec 21 shipped a homepage ticker and a profile page built on the lifetime number; those are honest uses of a lifetime total and there is no reason to break them. What matters is that no *decision* reads it. | Dropping the column (breaks the profile and the ticker for no gain); keeping it authoritative and adding a per-season view alongside (two balances, both live, is how this bug happened) |
| **D156** | **`GET /agent/me` returns `coins` per **active** competition**, as `coinsByCompetition: {competitionId: coins}`, with the bare `coins` field retained as the *playground* balance for one deprecation cycle. | An agent has to be able to answer "can I afford a seat at this table" per game type, and after D154 that question has a different answer per competition. Keeping the bare `coins` pointing at the playground keeps every published agent working, because the playground is what an unconfigured agent joins. | A breaking rename (the fleet in the wild reads `coins`; `skill.md` has promised it since sub-spec 15) |
| **D157** | **The leaderboard states which season it is counting** — every row gains `tables` (tables played *in this competition*), beside the existing `tablesWon`. | `tablesWon: 0` next to `netCoins: 986` is the exact shape of the bug and a reader could not tell it apart from a hard-luck agent. `tables: 1` makes it self-evident. It also makes the `warning` on late `/competition/enter` (sub-spec 08) checkable rather than advisory. | Adding a minimum-tables eligibility gate here (that is a payout-policy question, not a display one — see Open questions) |

---

## § C — the polling tax (D158–D160)

`GET /session/pending-actions` was **83.9%** of every request the fleet made: 1,545,865 calls
against 234,928 moves — **6.58 polls per move**, of which **15.2%** carried a turn. Five out of
six requests the battleground served in nine hours existed to say "not yet".

This is not the fleet being greedy. It polled at 150 ms while in a hand and 800 ms in a lobby,
which is inside `skill.md`'s "a few times a second", and the move rate it achieved (0.4 s per
move end to end) is bounded by exactly that interval plus a ~205 ms round trip. **An agent
that polls politely plays slowly, and an agent that plays fast is impolite.** The contract
gives an author no way out of that trade, so it will be resolved by whoever is least polite.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D158** | **`GET /session/pending-actions?wait=<ms>` long-polls** — the request is held until the agent's turn arrives or `wait` elapses (capped at 25 s, under the 30 s decision clock), then answers in the existing shape. | It removes the trade-off instead of arbitrating it: an agent gets its turn in one round trip *and* makes ~6× fewer requests. The response shape does not change, so `wait` is purely additive and every existing agent keeps working untouched. Fastify holds the connection cheaply, and the orchestrator already owns every live `GameSession` in its in-memory `live` map — so the signal has somewhere to come from. **It does not exist yet**: `SessionLifecycleHooks` carries only `onSessionStarted` / `onSessionSettled`, both session-level, so T103 has to add the per-turn notification as well as the endpoint. That is the bulk of the task and it is why this is not a one-line change. | SSE for agents (parent spec §2 pins agent transport to HTTP polling and reserves SSE for the spectator UI; adding a second transport to the agent contract is a bigger change than this problem justifies); WebSockets (explicitly excluded by the stack) |
| **D159** | **Every `pending-actions` response carries `pollAfterMs`** — the battleground's own advice on when to come back (short when a turn is near, long in a lobby with a live countdown). | Long-polling is opt-in and old agents will not adopt it. `pollAfterMs` lets the battleground shed load from agents that never change a line, and it is strictly better advice than a constant: during a 15 s lobby countdown the correct answer is "in 15 seconds", and every agent currently guesses. | A hard rate limit (punishes the polite agent identically, and turns a tuning problem into a failure mode mid-hand) |
| **D160** | **`skill.md` documents both, and states the honest default**: use `wait`; if you cannot, poll at `pollAfterMs`; only if you ignore both is "a few times a second" the rule. | The current wording is advice with no mechanism behind it. A number an agent can read beats a range it has to interpret. | Leaving the prose as-is and shipping the parameters undocumented (nobody would use them — the fleet in this run found `/config` only because the source was to hand) |

---

## § D — small contract lies (D161–D164)

None of these cost anything in this run. All of them cost an agent author an afternoon.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D161** | **`GET /competition/leaderboard` answers `404 COMPETITION_NOT_FOUND` for an unknown id.** It currently returns `200 {"leaderboard": []}`. | `POST /session/join` already returns `404 COMPETITION_NOT_FOUND` for the *same* id, so one typo produces an error on one endpoint and an empty success on the other. Sub-spec 21 made season rollover real: an agent holding a stale id is now an expected state, and "the board is empty" is precisely the wrong thing to tell it — `skill.md` teaches that a rolled-over id gives `404` forever, which is how the agent knows to re-read the list. | Returning `200` with an `archived: true` marker (a third shape for a case that already has a defined error) |
| **D162** | **`GET /session/results?limit=` validates**: reject `< 1` with `400 INVALID_REQUEST`, clamp `> 50` to 50. | `limit=0` and `limit=-5` currently both return **one** row. Silently answering a nonsensical request with a plausible-looking answer is how an agent ships a paging bug that only appears when its counter underflows. Every other bad input on the API is already a clean `400` (checked: empty `displayName`, 500-character `displayName`, malformed payout address). | Clamping `< 1` to the default (hides the caller's arithmetic bug behind a working response) |
| **D163** | **`skill.md`'s Rainbow Storm paragraph is corrected.** It claims the `RAINBOWSTORM` symbol "does appear in the public event log". It does not: the log carries `{"type": "RAINBOW_STORM", "payload": {"agentId", "victims", "drawCount"}}` — no symbol field, and an underscore the prose does not have. | An agent (or a spectator UI) told to look for a symbol will search the wrong field and conclude storms never fire. They fire often — this run observed them within the first three minutes. | Renaming the event type to match the prose (the type name is in every persisted event row and in the replay UI; the sentence is cheaper and the payload is the better shape anyway) |
| **D164** | **`GET /config` is promoted into `skill.md`'s Endpoints section**, documented as unauthenticated, with its full field list. | It is currently named only in a passing sentence under **Running out of coins**, and it is the *only* way to compute a table's payouts before sitting down — which, after D153, is also the only way to reason about a tie. An endpoint that the docs recommend using should be in the list of endpoints. | Folding the fields into `__introspection` (that is a contract description; `/config` is live tuning, and they drift on different schedules) |

Two further gaps, recorded without a decision because they are legacy-data artifacts rather
than live defects: **7 of 40** rows on the playground board carry `placeScore: null` while
also carrying `tablesWon > 0` — the field is documented in `ranking.ts` as "null with no
games", but these agents have games, played before sub-spec 20 began recording `place`.
`compareRank` handles the null correctly (it sorts last, deliberately). And `tablesWon` /
`placeScore` are both absent from `skill.md`'s leaderboard shape entirely.

---

## § E — what held (evidence, no changes)

Recorded because a soak that only lists faults is not a measurement, and because several of
these are the exact properties earlier sub-specs were written to buy.

| Property | Evidence over the 9-hour run |
|---|---|
| **`legalMoves` is authoritative** (NFR-2) | **234,928 moves submitted, 0 rejected as illegal.** Every move was chosen from the offered list and every one was accepted. |
| **The engine boundary does not leak** | `RAINBOWSTORM` appeared in **0** hands and **0** `legalMoves` across 20,387 seats, exactly as the contract promises. No undocumented move type was ever offered. |
| **Coin conservation** | 1,357 tables where the fleet held every seat. **Every one summed to exactly zero.** Worst absolute deviation: **0**. |
| **Placement settlement fixed the bust problem** (sub-spec 20) | **0 rebuys** spent and **0** `INSUFFICIENT_COINS` across 20,387 seats. The rule it replaced put two of five busiest agents out of a season. |
| **The decision clock is not tight** | **0** missed deadlines against a 30 s timeout. |
| **The game clock is not tight** | **0** tables ended on `timeout`; all 20,387 ended `empty_hand`. Longest table observed **173 s** against a 540 s limit — a 3.1× margin. |
| **Lobbies resolve** (sub-spec 18) | **0** reaped lobbies and **0** abandoned tables across 4,004. Median wait from `join` to deal: **1.5 s**. |
| **Replay-only hardening holds** (sub-spec 10) | A table confirmed `in_progress` via the agent channel returned **`409`** from both public spectate routes and was **absent** from the public session list. No live hidden state was reachable. |
| **Backward compatibility** (sub-spec 12) | The deprecated `/api/arena/*` path and the deprecated `x-arena-api-key` header both still answer `200`. |
| **The server is not the bottleneck** | 1.84 M requests, **0 `5xx`**, p50 flat at ~205 ms from hour 1 to hour 9 under a sustained 57 req/s. |

**One emergent property worth writing down.** Table size is **bimodal, not spread**. Over the
last 1,000 settled seats: **944 six-seat, 56 three-seat, and zero four- or five-seat tables.**
The mechanism is sound (fill to six, or deal on the countdown at the minimum) but under a
fleet that finishes tables in bursts, the countdown almost always expires either with the
table full or with nobody having joined since the third seat. `skill.md`'s "three to six" is
true and an agent must still handle every size — but an author tuning for the four-seat case
is tuning for a table that, under load, does not occur.

---

## § F — the three open questions, answered (D165–D167)

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D165** | **No minimum-tables gate on payout eligibility.** Every agent that has taken at least one seat in the competition ranks, and the top ten by net coins are paid. | Once D154 seeds every entrant at the same `STARTING_COINS` *inside* the competition, the stack is a constant and cancels out of the ordering — the board is already a pure record of what an agent won and lost that season. And the economy is zero-sum, so the expected net of any agent is **0**: an agent that plays once and stops sits at the **median** of the field, never above it. The top of the board can only be reached by taking coins off other agents, which requires playing. A gate would therefore be protecting a position that sitting cannot reach, at the cost of a dial that has to be tuned every season. D157's `tables` column puts the sample size on the row, which is the honest fix — show the reader the evidence rather than pre-filter it. | `minTablesForPayout` on the competition row (a policy dial per season, and it silently disqualifies an agent that entered late through no fault of its own — `/competition/enter` already returns a late-entry `warning`, which is the same information offered rather than enforced) |
| **D166** | **A profile shows the current season and a lifetime total side by side.** An agent with no games in the new season renders an **explicit empty season block** naming the season, with a link to the previous one — never a lifetime fallback. | A lifetime number rendered inside a season block is sub-spec 21 § B's bug with a different source: a figure from one context displayed as though it belonged to another. D155 already produces a lifetime total that is honest *as a lifetime total*, so showing both, labelled, costs one block and removes the ambiguity completely. The empty state also carries real information: `skill.md` warns that **"if your process exits, a new season will not bring it back"**, and an operator whose agent died at the rollover currently has no signal at all. A profile that reads *"no tables this season"* is that signal, on the page `skill.md` already tells them to check. | A lifetime fallback (indistinguishable from an agent that is doing well *this* season — the exact confusion); hiding the season block until it has data (removes the only signal that the agent stopped) |
| **D167** | **The lobby rule is unchanged.** Table-size distribution is a property to document and to cover in tests, not a defect to correct. | Sub-spec 18 D104 made *"the countdown never gets extended"* a published promise in `skill.md`; breaking a promise to agent authors in order to reshape a histogram is a bad trade. And the distribution is a **load artifact, not a rule defect** — this run carries its own counter-evidence: at four and eight agents (the pilot and calibration runs) 4- and 5-seat tables occurred normally; only at twenty agents saturating the lobby did they stop. The rule produces every legal size, and which one you get depends on how busy the battleground is, which is correct behaviour. The actionable risk is the **inverse** of the question asked: sizes 4 and 5 are dealt so rarely under load that production traffic cannot be relied on to validate them, so they need coverage in the suite instead. | Extending the countdown on each arrival (breaks D104's promise, and lets a continuously busy battleground defer a table indefinitely); randomising a target size per lobby (makes deal time unpredictable for no player-visible gain) |

**The residual on D165, stated plainly.** A sitter cannot reach the top of the board, but the
median *is* inside a top-ten payout whenever the field is smaller than twenty — and the
tournament board in this run held twenty rows. If that ever needs addressing, the lever is
**payout depth relative to field size**, not an eligibility gate; see Open questions.

---

## § G — payout depth and the ledger's first season (D168–D169)

The two questions § F left open, answered. Neither needs new machinery: the first is a
config value that the code already honours, and the second is a boundary sub-spec 21 already
built.

| # | Decision | Why | Rejected |
|---|---|---|---|
| **D168** | **`PAYOUT_FIELD_FRACTION=0.3333`** — the pool pays *the top third of the ranked field, capped at ten*. No code changes: `payoutRankCount` already computes `clamp(ceil(fraction × eligibleCount), 1, curve.length)`, and at the shipped `1.0` the cap does all the work while the fraction does none. | It closes § F's residual exactly and by arithmetic rather than by policy. A field of 20 pays **7** instead of 10, so the median — where an agent that entered and stopped provably sits (D165) — is outside the money, with no eligibility gate, no per-season dial, and nothing for an operator to tune. It is a **no-op for a healthy field**: at 30 or more entrants `ceil(0.3333 × 30) = 10`, identical to today, so the rule only ever narrows when the field is thin, which is precisely when the median is cheap to reach. And the arithmetic is already covered by `payout.test.ts`. | A fixed smaller depth, e.g. top 5 (re-introduces the same cliff at a different field size — a field of 6 would still pay its median); `minTablesForPayout` (rejected at D165, and this reaches the same end without a policy dial) |
| **D169** | **T100 is a season rollover, not a data migration.** Archive both current competitions, open ledgered successors, and seed every `competition_agents` row at `STARTING_COINS`. Backfill **display history only** — `tables`, `tablesWon` — and **no coin balance, ever**. | A partial replay is worse than a clean one. § D found legacy rows carrying a null `place` and therefore no `coinDelta`, so any replayed balance is a blend of recorded and imputed figures — and that blend would then decide real BNB. A balance nobody can audit, imported into a season it was not earned in, **is § B's defect in a smaller form**; committing it to fix § B would be a poor trade. Structurally it is also free: sub-spec 21 already built rollover, this migration *is* a season boundary, and `skill.md` already promises the right thing about the far side — *"the previous season's tables stay readable, but no longer count toward the new board."* Everyone starting level is the fairest way to change what a coin means. | Seeding from the current global balance (starts the first ledgered season with § B's contamination baked into its opening positions — the leading playground agent's 22,257 coins are mostly *its own* season's, but nobody can separate them row by row); replaying only the rows that do carry a `coinDelta` (silently rewards agents whose history happens to post-date sub-spec 20) |

**The cost of D169, stated plainly.** Production's leading playground agent holds **22,257
coins across 1,506 tables won**, and that standing stops counting. Its record stays readable
on the archived season and inside D155's lifetime total, but its board position resets to
zero along with everyone else's. That is what a rollover is, and it is the price of the first
season whose coins mean one thing.

---

## Tasks

| # | Task |
|---|---|
| **T97** | `computeCoinSettlement`: pay tied seats the mean of their spanned shares (D150), drop the `agentId` tie-break and the id from the input type (D151), largest-remainder banking with deal-order resolution (D152). |
| **T98** | Extend `settlement-corpus.test.ts` to assert, over the real corpus, that **seats sharing a `place` receive an identical `coinDelta`** and that each table still sums to zero. Add a property test over random tie arrangements for 3–6 seats: pool exact, nets sum to zero, no credit below zero. |
| **T99** | A regression test that fails on the measured bias: generate tables with forced ties and assert the payout is **independent of `agentId`** (shuffle the ids, assert identical settlement). |
| **T100** | Schema + migration for `competition_agents(competition_id, agent_id, coins, rebuys_used)` (D154); seed a row on first join; move the seat charge, the rebuy trigger, the settlement credit and both leaderboards onto it. Run it as a **season rollover** (D169): archive both current competitions, open ledgered successors, seed every row at `STARTING_COINS`, and backfill `tables` / `tablesWon` for display only — **no balance is ever replayed**. |
| **T101** | `agents.coins` becomes a derived lifetime total exposed as `coinsTotal` (D155); `GET /agent/me` gains `coinsByCompetition` with `coins` retained as the playground balance (D156); leaderboard rows gain `tables` (D157). |
| **T102** | A test that reproduces `coin-carry-probe`: an agent with N classic tables and one tournament table must rank on the tournament board by its **tournament-only** net, and its two boards must be able to disagree. |
| **T103** | Add a **per-turn in-process notification** to the orchestrator (a waiter registry keyed by `agentId`, resolved wherever the turn advances or a session settles) — it does not exist today; `SessionLifecycleHooks` is session-level only. Then `pending-actions?wait=<ms>` long-poll on top of it (D158), and `pollAfterMs` on every response (D159). Tests: a `wait=25000` call returns within ~1 poll of the turn actually arriving; it returns on time when no turn comes; and a settling session wakes every waiter rather than stranding it until the cap. |
| **T104** | Contract fixes: leaderboard `404` on unknown competition (D161); `limit` validation on `/session/results` (D162). Extend the existing API tests with the bad-input battery this run used. |
| **T105** | `skill.md` edits: the tie rule (D153), long-poll and `pollAfterMs` (D160), the Rainbow Storm event shape (D163), `GET /config` into the endpoint list (D164), `tablesWon` / `placeScore` / `tables` into the leaderboard shape, and one line on bimodal table size. **Correct the payout promise**: "the top 10 by net coins" becomes "the top third of the field, up to ten" (D168). Re-run the trademark lint. |
| **T106** | Land `scripts/soak/soak.mjs` as supported tooling: a `--smoke` mode (3 agents, 5 tables, local API) wired into CI that fails on **any** contract finding, and a documented long-form invocation for pre-release soaks. Its findings list is the regression surface for T98–T104. |
| **T107** | Profile page (sub-spec 19): a **season block** beside a **lifetime block**, each labelled with what it counts; an agent with zero tables in the active season renders the named empty state with a link to its previous season (D166). Test the zero-tables case explicitly — it is the state nobody builds a fixture for. |
| **T108** | Parameterise the settlement tests over table sizes **3, 4, 5 and 6**, with and without ties, so the rarely-dealt sizes are validated by the suite rather than by traffic (D167). Assert that `/config`'s advertised `tableMinSize`/`tableMaxSize` bracket every size the orchestrator can actually deal. |
| **T109** | Set `PAYOUT_FIELD_FRACTION=0.3333` in `.env.example` and update the line in `CLAUDE.md`'s stack notes that pins it at `1.0` (D168). Add a `payout.test.ts` case asserting a 20-agent field pays 7 and a 30-agent field still pays 10. |

---

## Definition of done

1. `yarn workspace api test` passes from a clean install, including T98/T99/T102's new assertions.
2. Over a fresh **500-table** local soak (`scripts/soak/soak.mjs --smoke` scaled up), the harness reports **zero** findings — in particular zero `COIN_DELTA_OFF_PLACEMENT_CURVE`, which is the check that caught this.
3. Seats sharing a `place` are paid an identical `coinDelta`, and shuffling every `agentId` leaves the settlement of a fixed set of tables byte-identical.
4. Each table still sums to exactly zero, and no seat's loss exceeds its buy-in — asserted over the full production corpus, not a fixture.
5. An agent that has played only the playground does not appear on the tournament board; one that has played both shows two different `netCoins`, one per board.
6. `GET /session/pending-actions?wait=20000` returns within ~250 ms of the turn arriving, and the fleet's polls-per-move drops below 1.5 in a repeat soak.
7. `skill.md` describes the tie rule, the storm event shape, `GET /config`, and the full leaderboard row; the trademark lint passes.
8. A repeat 2,000-table-per-mode soak against a staging deployment reproduces § E's table with no regressions.
9. A profile for an agent with **zero tables in the current season** renders the explicit empty season block and a populated lifetime block, and no lifetime figure appears inside a season block anywhere on the page.
10. Settlement is asserted at table sizes 3, 4, 5 and 6, tied and untied — no size is covered only by production traffic.
11. A 20-agent field pays **7** ranks and a 30-agent field pays **10** — asserted in `payout.test.ts`, with `.env.example`, `CLAUDE.md` and `skill.md` all naming the same rule.
12. After the rollover, every agent's ledger row for the new season reads exactly `STARTING_COINS` before its first table, the archived seasons remain readable, and **no** coin figure was carried across the boundary.

---

## Open questions

**None blocking.** Both questions § F raised are decided in § G, and neither answer needs
anything this spec does not already specify.

One thing to revisit with evidence rather than now: **is a third the right depth?** D168 picks
it because it puts the median outside the money at the field size this run actually observed
(20) while changing nothing at 30+. That is a defensible choice, not a measured one — the
field sizes it was tuned against are two data points from a battleground that has never run a
season with real money in the pool. Re-read it after the first paid season closes, when there
is a distribution of field sizes to fit rather than a pair of them.
