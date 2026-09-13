# Every economic proposal, assessed

A single place for every economy change proposed for damnits.fun: issues
[#20](https://github.com/damnitsfun/damnitsfun/issues/20),
[#30](https://github.com/damnitsfun/damnitsfun/issues/30),
[#33](https://github.com/damnitsfun/damnitsfun/issues/33),
[#34](https://github.com/damnitsfun/damnitsfun/issues/34), the merged spec 24 proposal
(`specs/24-economic-model.md`), and the seven-point set raised on 2026-09-08.

Each is rated on **product value**, **legal shape**, **implementation cost**, and **fit against the
deadline**. Written 2026-09-08. **22 days to submission** (30 September); Demo Day October.

This is engineering and product risk assessment. **It is not legal advice.** Anything touching real
value needs counsel — specifically an Indonesian criminal-law practitioner.

---

## 0. Bottom line

**Ship none of the seven new proposals as written.** Not because they are bad ideas in general —
several are how real products work — but because each one trades a large amount of what this
project already has for a small amount of product, and two of them would remove the thing the
submission is built on.

The current shape — **testnet tBNB, a free non-transferable coin economy, capped free rebuys,
sponsor-seeded prizes, agents only, commit-reveal fairness** — already satisfies most of the
20-item checklist that regulated skill-gaming platforms use. Every proposal below spends some of
that.

Ranked by what actually moves the needle in 22 days:

| | | Effort |
|---|---|---|
| **1** | **Merge and deploy the five-deep PR chain** | already built |
| **2** | **Seed the prize pool** — one `--confirm-spend` | minutes |
| **3** | **Fixed season cadence** (new #2/#3/#4, with corrected durations) | **S–M** |
| **4** | **Casino-vocabulary lint + "benchmark" framing** | ~1 hour |
| **5** | **#34 variant B — one-time activation fee** | 4–5 tasks |
| **6** | Spec 24 vault (merged), optionally with #33 §1's ticket split | 16 tasks |
| ✗ | **Rake, escalating paid rebuys, pay-to-win, human play** | reject or defer |

---

## 1. Correction to the previous pass — the Indonesian criminal code changed

The earlier analysis relied on **Pasal 303(3) KUHP**, whose definition of *permainan judi*
expressly included games where the chance of winning rises *because a player is more skilled or
better trained*. That was the cleanest single reason no "but it's a skill game" argument works in
Indonesia.

**That provision is superseded.** UU 1/2023 (the new criminal code) took effect **2 January 2026**
and repealed UU 7/1974. Gambling is now:

| | |
|---|---|
| **Pasal 426** — operator | up to **9 years** / **Rp 2bn** |
| **Pasal 427** — player | up to **3 years** / fine *(sources disagree: Rp 50m vs Rp 200m — **UNVERIFIED**)* |

Two consequences, and they point in opposite directions:

- **The skill-inclusion limb may no longer be in force.** The new code restates no definition of
  *perjudian*, so whether that limb carries over is an **open question**. Do not build on a hoped-for
  skill carve-out either way.
- **Pasal 426(1)(b) is broader in the way that matters here.** It has no livelihood element and
  reaches offering the public an opportunity to gamble *"terlepas dari ada tidaknya suatu syarat
  atau tata cara"* — regardless of any condition or procedure. **That is an express
  anti-structuring clause.** Clever entry-fee architecture is precisely what it is written to
  defeat.

Everything else from the earlier pass stands: enforcement is administrative blocking by Komdigi
(no conviction needed, 3.45–3.7M URLs since Oct 2024), and the two-limb safe harbour — **no stake
of value, and nothing exchangeable for real money** — is the design target. Both limbs hold today.

---

## 2. The inventory

| # | Proposal | Source | Value | Legal (testnet / mainnet-ID) | Cost | Verdict |
|---|---|---|---|---|---|---|
| 1 | On-chain MOCK token replacing coins | #20 | low | negligible / low | L | **No** — declined in spec 23 §D |
| 2 | BNB Agent SDK + ERC-8004 identity | #20 | high | none | — | **Done** (spec 23) |
| 3 | Gas sponsorship (MegaFuel) | #20 | high | none | — | **Done** (spec 23) |
| 4 | Refundable deposit + yield | #30 | medium | negligible / **high (fin-svcs)** | XL | **Maybe** — merged spec 24 |
| 5 | USDT-denominated prize pot | #30 / draft A | low | — | M | **No** — no USDT on chain 97 |
| 6 | On-chain deadlines + public `exitStale` | draft A | **high** | none | M | **Yes** — best idea in spec 24 |
| 7 | Ticket + security-deposit split | #33 §1 | **high** | low / moderate | S* | **Yes** — if spec 24 ships |
| 8 | Spectator betting + rake | #33 §2 | medium | **moderate / severe** | L | **Reject** |
| 9 | Cosmetics / NFTs | #33 §3 | low | negligible / low | L | **Defer** |
| 10 | Naming rights + taunts | #33 §4 | low | negligible / low | M | **Defer** — taunts largely exist |
| 11 | Card-scoring addendum | #33 comment | — | — | — | **Already built** |
| 12 | One-time activation fee | #34 B | **high** | negligible / **low** | S | **Yes** |
| 13 | **5% rake on the entry pool** | new #1 | medium | low / **severe** | S | **Reject as specified** |
| 14 | **Fixed season cadence** | new #2/#3/#4 | **high** | none | **S–M** | **Yes** — fix the durations |
| 15 | **Escalating paid rebuys + bundle** | new #5 | medium | moderate / **severe** | M | **Reject** |
| 16 | **Pay-to-win starter card** | new #6 | low | moderate / **severe** | **XL** | **Reject** |
| 17 | **Human vs human / human vs agent** | new #7 | medium | moderate / **severe** | **XL** | **Reject for now** |

\* small only as an amendment to a spec 24 that has already landed.

---

## 3. The seven new proposals

### New #1 — keep 5% of the entry fee for the platform

**The idea.** Entry fee funds the prize pool; the platform keeps 5%.

**Pros.** Trivial to build (a `feeBps` under a permanent constant ceiling). Scales with
participation, unlike yield. It is how every card room, exchange and marketplace on earth works.

**Cons, and they are decisive.** *Taking a percentage of a pot funded by the players* is the
defining feature of operating a card room, and it costs two separate defences at once:

1. **It forfeits the only clean US safe harbour.** UIGEA §5362(1)(E)(ix) requires the prize to be
   **fixed in advance and independent of the number of entries and fees collected** (*Humphrey v.
   Viacom*). A rake on a player-funded pool fails that by construction — the prize *is* the fees.
2. **It independently triggers "profits from gambling activity"** (NY Penal Law §225.00/.05), and in
   Indonesia it is what escalates exposure into Pasal 426(1)(a)/(c) *mata pencaharian* — deriving
   livelihood from gambling. **An on-chain rake proves it forever**, in public, immutably.

Skillz does rake (~14–16%) and survives on skill-predominance plus excluding AR/CT/DE/LA/SD — and
its own 10-K admits it holds **no licence or approval anywhere**. That is not a template a
hackathon project should copy.

**The money doesn't justify it.** 54 agents × 0.01 tBNB × 5% = **0.027 tBNB ≈ $20 per tournament
season**. You would take on the single worst legal characterisation available for $20 a month.

**Better shape, same revenue.** Send the fee to the **treasury** and fund prizes from a **sponsor
purse announced in advance, independent of entry count**. That is the "esports shape", it is what
#34 already recommends, and it earns the same $20.

**Verdict: reject as specified. Adopt the destination change instead.**

---

### New #2/#3/#4 — fixed season cadence (playground weekly, tournament monthly, 4:1)

**This is the best of the seven and the cheapest to build.**

**Pros.** It fixes a real, live defect. `entries_close_at` is **advisory only** — its sole
behavioural use today is a warning string at `orchestrator.ts:1233-1251` — which is why a funded
production season sat open and unwinnable **for months**. A published, enforced cadence turns a
season into something a player can plan around, gives the site a countdown that means something,
and matches draft A's on-chain deadlines (item 6 above) exactly.

**Cons.** There is **zero scheduling anywhere in the repo** — no cron, no timer, no scheduler
(two `setInterval`s exist, neither is one). And the real risk: automating `settle-season --confirm`
automates **the one command that moves real BNB**. Its empty-field refusal must survive
automation, not be worked around by it.

**Feasibility: S** for a weekly playground roll (`open-season` only inserts and archives rows — no
money moves), **M** once the tournament month, the 4:1 counter and automated settlement are in.

**But the durations are wrong for this deadline.** A one-month tournament started today settles
~8 October — **after submission closes**. Started at submission, ~30 October — possibly after Demo
Day. Either way **you cannot demo a settled tournament**, and the settled loop with real
transaction links is the single most valuable thing a judge can watch.

Worse, `settle-season.js` **refuses to settle when no agent is eligible** — eligibility needs an
X-verified owner, a payout address and `MIN_RANKED_SESSIONS=10` games. Production has 25 entrants
and previously sat at **0 eligible of 60**. A season that ends in time may still not be settleable.

**Verdict: adopt, with hackathon durations.** Run a tournament that opens **and settles before
30 September**, and publish the weekly/monthly cadence as the post-hackathon steady state. Note it
reverses spec 08's D9 (operator-triggered close) — a legitimate amendment, but write it as one.

---

### New #5 — escalating paid rebuys (0.01, 0.015, 0.02 …) plus 0.03 for 4

**Pros.** Real recurring revenue that scales with engagement. Rebuy and re-entry tournaments are a
genuine, established structure.

**Cons.** Three, and the first is disqualifying.

1. **Rebuy tournaments exist only *inside licensed poker rooms*.** No authority was found
   permitting the structure unlicensed. It is not a carve-out; it is a thing licensees may do.
2. **Escalating cost-to-continue after a loss is the textbook loss-chasing pattern**, and
   regulators name it directly: the UKGC bans it by design rule (autoplay ban, RTS 14B
   ban on reversing a withdrawal, 14F/14G) and lists chasing losses as a marker of harm under SR Code
   3.4.3. China's December 2023 draft named "consecutive purchase" rewards specifically.
3. **The bundle makes it worse, not better.** 4 rebuys individually cost 0.07; the bundle is 0.03
   **— a 62.5% discount** for pre-committing. Under UK law that is a payment to enter, and under
   the EU CPC Key Principles it is a "hides the true cost" practice.

**Implementation: M**, and it has a specific unguarded hole — **paid games would buy
`MIN_RANKED_SESSIONS` eligibility** (`orchestrator.ts:1391`). Money would purchase the right to be
paid from the pool. D100's netting (subtracting rebuys from ranked coins) already prevents the
worst outcome and **must not be relaxed**, or 0.01 BNB converts directly into on-chain pool share.

**Verdict: reject.** If any paid rebuy ever ships: flat price, hard cap, **treasury destination**,
and paid-rebuy games excluded from the eligibility count.

---

### New #6 — pay-to-win: 0.005 tBNB for a "+2 any colour", 3 games

**Reject. This is the worst proposal in the entire document, on four independent grounds.**

**1. It silently breaks the fairness proof while the chain keeps signing.**
`hashEventLog` hashes *whatever the log says happened*, so an injected card that is faithfully
logged still produces a self-consistent `result_hash`. **The contract keeps attesting.** What dies
is `replayByReExecution`: it rebuilds the game from the seed alone, the purchased card is not in
that deck, and `applyMove` throws at `adapter.ts:387` the first time it is played.

So `DamnitsEscrow.sol:21`'s own NatSpec — *"anyone can re-run the published event log against the
revealed seed"* — becomes **false while the contract still says it is true**. A loud break would be
better than this.

**2. The card cannot be built without editing the vendored engine.** `Card` refuses a colourless card unless it is a rainbow (*"only
cards can be initialized with no color"*, `card.ts:9-11`), and the predicate deciding that hard-codes only the two
rainbow values. A colourless GRAB2 requires editing two files inside the vendored engine —
**a direct CLAUDE.md rule-3 violation**, where the only permitted vendored edit is the RNG patch.

**3. Rainbow Storm is the counter-example, not the precedent.** Its extra cards come from
`game.draw()` — out of the **seeded** deck — and whether it fires is itself seed-derived. That is
exactly why it replays. A purchased card is external input the seed cannot determine, and there is
no way to make it seed-derived without making the purchase seed-derived, which defeats the point.

**4. It destroys the characterisation everything else rests on.** No direct precedent was found
*(UNVERIFIED)*, but paid advantage does not so much add chance as demolish the "bona fide contest
of skill" framing — the outcome starts turning on spend. And the regulatory direction is decisive:
the **EU Digital Fairness Act** proposal (due Q4 2026) covers loot boxes, in-game currency and
addictive design under **consumer** law — where there is no skill defence, no licence, and no
carve-out. Pennsylvania showed how this ends: the legislature defined "skill slot machine" into the
Gaming Act and the Supreme Court killed ~70,000 machines on 15 June 2026.

**And issue #33 already rejected this**, in its own title: *"Non-Pay-to-Win"*, with the explicit
line *"we strictly reject Pay-to-Win mechanics like buying action cards."*

**Cost: XL.** Touches the vendored engine, vocabulary, events, adapter, replay, house rules,
orchestrator, a new table, config, a payment path, `skill.md`, the web replay renderer, and every
test asserting deck composition.

**If some version must exist:** price it in **coins**, grant a **coloured** GRAB2 that the deck
already contains, and it drops to **S/M** with the money out of both the fairness story and the
legal one. It still costs the re-execution proof unless the grant is folded into the committed deal
— which is a real design, and a spec of its own.

---

### New #7 — human vs human and human vs agent

**Reject for now. This is the most expensively litigated fact pattern in the sector.**

**The legal problem is not theoretical, it is a current judgment.** In *Skillz v. Papaya* (SDNY,
Judge Cote): **$420M actual damages in April 2026, plus $719M disgorgement in July 2026** — on the
finding that describing opponents as "players" and "individuals" **implied human opponents** when
some were bots. Plus a $15M consumer class settlement and a Michigan Gaming Control Board
cease-and-desist. Separately, *Pandolfi v. AviaGames* pleads that undisclosed bots **convert skill
into chance**, making the platform an illegal gambling business under 18 USC §1955.

Mixing humans and agents is the exact fact pattern that produced a **billion-dollar** liability.
And adding humans does not improve the gambling analysis — it removes the "agent benchmark"
framing, which is the safest framing available.

**The implementation problem is equally bad. XL — this is a second product, not a feature.**

- `packages/web` is **replay-only by design**. Spec 10 hardened it that way deliberately and calls
  it *"the single most important integrity property of a spectator"*. Human play requires serving
  live hidden state to a browser — a direct reversal.
- **No browser session can act today.** Web login (spec 11) grants read and ownership only; API
  keys are stored hashed (`schema.sql:22`). A play credential path does not exist.
- **`DECISION_TIMEOUT_MS` defaults to 3000 ms**, one deadline covers the whole table, and
  `autoAction` plays for you when it expires. Fine for bots; unusable for humans.
- **`reapOrphanedSessions` archives every in-flight table at each deploy.** Acceptable for agents,
  a user-visible defect for a human mid-game.
- Roughly 25–35 touch points across 4 of 5 packages, of which ~8 are genuinely new subsystems.

**It also adds no on-chain surface** — the 30/100 line judges actually score.

**The one safe version:** human-vs-agent as a **free, prize-free, loudly disclosed exhibition**,
with the disclosure *in the seat, not the FAQ* (California's B.O.T. Act §17941 standard: clear and
conspicuous). That is a genuinely great demo — a judge playing your agent live. It is still XL.

**Verdict: reject for this deadline. Revisit as a free exhibition mode afterwards.**

---

## 4. Two cross-cutting findings

**The rake and the pool are the same decision.** Every paid mechanic here — entry fee, rebuy,
activation, ticket — is *safe or severe depending on one thing only*: **does the money fund the
prize pool, or the treasury?** Treasury + sponsor-funded prize announced in advance = the esports
shape, and it is defensible. Player money funding the prize the players compete for = "losers fund
winners", and it is severe in Indonesia regardless of how it is packaged — Pasal 426(1)(b) has an
express anti-structuring clause aimed at exactly that packaging.

**The project's current shape is its best legal asset, and every proposal spends some of it.**
Testnet tBNB with no market price, coins that are non-transferable and non-purchasable, free capped
rebuys, sponsor-seeded prizes, agents rather than humans, and a public fairness proof — that
combination already satisfies most of the checklist regulated operators use. It was not designed
for that reason, which makes it more credible, not less.

---

## 5. Self-audit against the standard defensible structure

The 20-item checklist that regulated skill-gaming platforms actually build to, scored against
damnits.fun **as it stands today**. This is the concrete version of "the current shape is the
project's best legal asset."

**A — structure the money so the entry fee is not a stake**

| | Item | Today |
|---|---|---|
| 1 | Prizes announced in advance, fixed, guaranteed | ⚠️ pool is currently `0`, so trivially true; becomes real only under a sponsor purse |
| 2 | Prize value independent of entrant count and fees | ⚠️ same — today's design makes the pool *be* the fees |
| 3 | Prize funded by platform or sponsor, not pooled player money | ⚠️ `SPONSOR_POOL_SEED_WEI` exists but is `0`; **seeding it is what makes this a pass** |
| 4 | Entry paid unconditionally, **never framed as a pot, wager, buy-in or stake — in code, contract or UI** | ❌ **fails on vocabulary alone** — the repo ships "buy-in", "prize pool", "jackpot" |
| 5 | **No rake** | ✅ passes today — **new proposal #1 breaks it** |
| 6 | Operator has no stake in the outcome | ✅ |

**B — structure the game so skill genuinely determines the outcome**

| | Item | Today |
|---|---|---|
| 7 | Skill predominates, with evidence | ⚠️ arguable for a shuffled card game; the ≥300-game fuzz discipline is the right instrument if it is ever needed as an exhibit |
| 8 | Chance minimised and **published and verifiable** | ✅ **strongest item** — commit-reveal converts "trust us" into "verify us" |
| 9 | **No purchasable competitive advantage** | ✅ passes today — **new proposal #6 breaks it** |
| 10 | Equal, transparent conditions — same rules, clock, information | ✅ literally the submission's own claim |
| 11 | All opponents disclosed for what they are | ✅ everything is an agent, and it says so — **new proposal #7 puts this at risk** |
| 12 | No house participation — no house bots, no steered matchmaking | ✅ *(worth confirming the reference agent is never seated in a prize season)* |

**C — structure the platform so it is not an operator of gambling**

| | Item | Today |
|---|---|---|
| 13 | Jurisdictional exclusion, enforced technically | n/a on testnet; **Indonesia belongs on the list** for any paid variant |
| 14 | A genuine free entry route | ✅ the playground is free, and tournament entry is currently `0` |
| 15 | Age / identity checks on anything that pays out | ⚠️ X-verification gates payout eligibility, which is adjacent but not the same thing |
| 16 | Responsible-play controls | ➖ absent; only matters once real value moves |
| 17 | **No design that monetises loss** — no escalating cost-to-continue | ✅ passes today: rebuys are free and capped — **new proposal #5 breaks this squarely** |
| 18 | Truthful marketing, with care around *implied* claims | ⚠️ *Skillz v. Papaya* holds that implication alone is enough |
| 19 | **Nothing convertible to money** | ✅ coins are non-transferable and non-purchasable — and note a transferable on-chain token defeats this defence in **every** jurisdiction surveyed, which retrospectively vindicates declining #20's MOCK token |
| 20 | Say plainly that you hold no gaming licence | ❌ not stated anywhere — **one sentence, and it is free** |

**Score: 11 clear passes, 2 clear fails, both trivially fixable.**

The two failures are items **4** (casino vocabulary in code, contract and UI) and **20** (no
"we hold no licence" statement). Together they are roughly **an hour of work** and they are the
cheapest risk reduction available anywhere in this document. Item 3 becomes a pass the moment the
sponsor pool is seeded — which is already recommendation #2 below.

Every one of the four rejected proposals breaks an item this project currently passes: #1 breaks
item 5, #5 breaks item 17, #6 breaks items 9 and 10, #7 puts item 11 in play. That is the clearest
single way to see why the answer is no.

---

## 6. What to do

**This week, in order:**

1. **Merge and deploy the PR chain.** `main` is still spec 22; seven PRs sit chained five deep;
   production reports `poolWei "0"` and `/config` has no chain fields, so spec 23's verified
   contracts and ERC-8004 identity are **not visible at the URL a judge will open**. Nothing else
   matters until this ships.
2. **Seed the prize pool** — one `--confirm-spend`. It has never been funded. This is the real
   answer to "where does the prize come from" under every model.
3. **Run a tournament that opens and settles before 30 September**, so the demo can show the whole
   loop with transaction links. Publish weekly/monthly as the steady-state cadence.
4. **Casino-vocabulary lint + "benchmark" framing** (~1 hour). The repo ships "buy-in", "prize
   pool", "jackpot" — casino register, and in Indonesian enforcement the register *is* the risk.
   The T14 trademark lint already exists; a second word list in the same script is the whole change.
   And lead with "benchmark", which costs nothing because it is already true.
5. **#34 variant B — one-time activation fee.** Smallest real build, safest model studied
   (negligible/low), and it answers "how does this make money?" better than the entire vault. It
   does **not** depend on spec 24 landing, contrary to the issue's own scope guard.
6. **Spec 24 vault**, only if 1–5 are done. Its one real advantage is that composing with Venus is
   a *visible third-party integration* — the thing worth 30/100.

**If a business model must be demonstrated without taking on any of this risk:** ship rake and
rebuy pricing as **configurable parameters set to zero** in the deployed system, keep prizes
sponsor-funded and announced in advance (already true), and add human-vs-agent later as a free,
prize-free, disclosed exhibition. The mechanism is then real, on chain, inspectable on `/config`,
and priced at zero — which is a complete answer to a judge and a complete non-answer to a
regulator.
