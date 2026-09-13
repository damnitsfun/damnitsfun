# Sub-spec 24 — the refundable season

**Depends on:** 23 (verified contracts, `/config` chain facts, ERC-8004 identity, `balances`),
22 (per-season coins, pull payments, the soak lessons), 15 (unified coin scoring).
**Hands off:** a season you can enter without losing anything, with a deadline written on the
blockchain and a way out that does not need us; the money parked in a real BNB Chain protocol
while the season runs; and a third hackathon category we can honestly tick — beside the fee
tournament, which keeps working untouched.

**This is the adopted spec 24.** Two versions were written separately against issue #30 and both
claimed the number — Draft A on `spec-24-adjust-improvement-economy-model`, Draft B on
`e/economic-model`. A side-by-side compared them and recommended neither as-is: A's structure
carrying B's evidence. This document is that merge, and it **supersedes both** — the drafts and
the comparison are gone from `main`, kept only in the branches and in git history, because three
documents answering one settled question is how the wrong one gets read six months from now.

Where the drafts disagreed, the reason the winner won is written into the decision rather than
left behind in a branch. Two questions neither draft settled are decided here on purpose and
flagged as such: the shortfall rule (D189) and whether to build a fee switch at all (D182).

**Written in plain language on purpose.** Money mechanics are simple once the jargon is gone,
and everyone who reviews this — including a judge with five minutes — should be able to follow
it.

---

## Why this exists

Today, entering a tournament costs money you never see again. That is normal, and it is also
why we have **no answer** to a question the judges ask directly: *how will this project make
money one day?* BNB Chain publishes what it scores, and "a clear revenue or token utility model"
is one of five things. We score zero, because there is nothing there.

Issue [#30](https://github.com/damnitsfun/damnitsfun/issues/30) proposed a fix. Players
**deposit** instead of paying. We hold the deposit, put it somewhere it earns interest, give the
deposit back at the end, and the interest funds the project.

The player-facing sentence changes from *"your entry funds the prize you compete for"* to
**"your entry is a stake — you get it back, and what it earns funds the project."**

### The one number that shapes everything below

The interest will never be meaningful, and it is better to say so here than to be caught later.
Full working in [`docs/defi-economic-model-research.md`](../docs/defi-economic-model-research.md):

- BNB actually pays about **0.91%** a year. Not 2–5% — that rate exists only for dollar-pegged
  coins, and earning it means converting player deposits to dollars and back, which is exactly
  how a refund stops being a refund.
- 1,000 players depositing 0.01 BNB for a **whole week** earn **$1.32 in total.**
- Funding a **$1,000 weekly prize** from interest alone would need **$5.8 million** locked.
- Our pool today is **$16**. Three months of interest on it is **16 cents**.

So this spec builds the deposit, and **never calls the interest revenue.** The product claim is
the refund, which is true and checkable. The interest is a real mechanism, on chain, with the
numbers published — and D193 forbids putting a percentage on any page, because a claim a judge
can disprove in one click costs more than it earns.

### Three constraints that shaped the rest

1. **The submission closes 30 September 2026.** Everything is sized in weeks. The yield source
   is mock-first with a measured adapter behind it (D183), and the model **sits beside** the fee
   tournament rather than replacing it (D191) — so a failure the week before the deadline costs
   a feature, not the product.
2. **A months-long season cannot be shown at Demo Day.** The mock yield source must run fast
   enough that a judge watches a number climb inside five minutes, and the deadlines must be
   settable in minutes so the public exit can be triggered live on stage.
3. **What already works is not touched.** Nothing enters `packages/engine`. The coin ledger
   stays the balance of record — a seat still costs 10 coins. The live, verified contracts keep
   their addresses and their 4,004-table anchor.

### What was checked before any of this was written

Every address was probed by asking chain 97 whether code lives there. Nothing here is from an
article.

| | |
|---|---|
| **Venus vBNB, chain 97** | `0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c` — **real**, 39,686 characters of code |
| ...and does it round-trip? | **Yes — measured, not read. See T126's result below.** |
| ...are deposits open? | `Comptroller.actionPaused(vBNB, MINT)` = **false**, supply cap unlimited |
| ...does a deposit work? | `mint()` simulated with 0.1 test-BNB — **succeeded** |
| ...is the market alive? | holds 16.36 test-BNB, interest last updated ~9h before we looked |
| ...can we get out fast? | **Yes — withdrawal is instant.** No queue, no waiting period |
| Venus controller, chain 97 | `0x94d1820b2D1c7c7452A163983Dc888CEC546b77D` — **real** |
| **Ankr, chain 97** | tokens are deployed, but **`ratio()` is frozen at 1e18 — it earns nothing, ever** |
| **Lista, chain 97** | `0x1adB950d…` and `0xB0b84D29…` — **both empty**. Their docs list zero test addresses |
| BNB native staking | real, but **1 BNB minimum** and a **3-day wait** — cannot fit a settlement |
| Real BNB interest rates | Lista 0.91%, Venus 0.13%, Lista Lending 0.06%, Aave 0.01% |
| Test-BNB faucets | ration roughly **1 tBNB per address per day** — a 0.01 deposit is hostile to onboarding, so staging pins **0.001** (D187) |
| USDT on chain 97 | none exists. Which is why prizes stay in tBNB (D181) |

The Ankr and Lista rows are why an earlier draft's choice was changed. The Venus rows are why
this one is safe to build on.

---

## § A — the shape of the money (D181–D184)

**D181 — one asset, three buckets, no swaps and no second token.**

Everything is **native tBNB**: deposits, interest, and prizes. The vault keeps three separate
running totals and never lets them touch:

| Bucket | Whose it is | How it leaves |
|---|---|---|
| `depositTotal` | the players' | refunded in full at resolve |
| `prizePot` | sponsor money, seeded by `seedPot` | paid to winners at resolve |
| everything else | the interest | swept to the treasury at resolve |

An earlier draft introduced a **MockUSDT** token for prizes, with careful reasoning: chain 97
has no real USDT, and keeping two currencies apart means never needing a swap or a price feed.
The reasoning is sound and the conclusion is still no. **MockUSDT can be minted for free by
anyone.** A judge who asks *"what did the winner actually receive?"* should not hear *"a token
we can print." * Winners already receive real test-BNB from a contract that has been settling
games for months, and that is a stronger answer than a mainnet-shaped mock.

Keeping one asset also deletes a contract, a task, and the dual payout bookkeeping — **one
`owed` map serves both refunds and prizes**, because both are tBNB.

**D182 — the deposit comes back in full, and the interest goes to the project. Neither is a
revenue claim.**

The deposit is the player's. There is **no code path in the contract that can reduce a recorded
deposit** — not a fee, not a rake, not rounding. That is the product, so it is enforced by the
contract and not by policy.

100% of the interest sweeps to the treasury at resolve, which is what issue #30 asked for,
stated plainly rather than quietly redirected. Two consequences get named rather than implied:

1. **A player's deposit earns nothing for that player.** The prize is sponsor money end to end.
   The website says so in one sentence, rendered from config, never hard-coded.
2. **A project paid by lock-time is tempted to extend locks.** Which is exactly why the
   deadlines are on chain with a public exit (D186), and not left to us.

**What this spec will not say, anywhere:** that the interest is revenue, funding, or
sustainable. It is pennies, the numbers are published above, and the arithmetic goes into the
submission's *"what we deliberately did not build"* table where it is an asset instead of a
liability.

No fee mechanism is built. An earlier draft proposed a yield fee under a permanent ceiling; with
100% already going to the treasury there is nothing left to take a percentage of, and a fee
switch on a pot worth pennies is machinery for its own sake. The version that would actually
scale is a small cut of the **prize pool** — that needs a `DamnitsTournament` redeploy, which
D185 refuses, and it is named in § D.

**D183 — the yield source is one seam, mock-first, with Venus behind it.**

The vault knows exactly one interface:

```solidity
interface IYieldSource {
    function stake(bytes32 seasonId) external payable;                      // takes the money
    function redeem(bytes32 seasonId) external returns (uint256 returned);  // gives tBNB back
}
```

Three things implement it:

- **`address(0)` — off.** The vault holds the money itself, redeem returns exactly what went in,
  interest is zero. This is what a chainless or broken deployment degrades to **without losing
  refunds**, and it is what the test suite runs by default.
- **`MockYieldSource`.** Predictable, with a **configurable fast demo rate**, capped at what it
  has actually been funded with because it cannot invent native value. This is the demo floor.
  A months-long season cannot be shown in five minutes, and a demo that depends on somebody
  else's contract behaving is a demo that can fail on stage.
- **`VenusYieldSource`.** The real one, over vBNB at
  `0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c`. Venus is the choice for one measured reason and
  one structural one: **it is the only yield protocol that exists and works on chain 97**
  (Ankr's rate is frozen at zero; Lista is not deployed there at all), and **it is the only one
  you can exit instantly.** Lista makes you wait 7 days; native staking 3 days and 1 BNB
  minimum. We pay winners the moment a season settles.

The vBNB address is a constructor argument, never a hard-coded constant. Lista stays mocked
behind the same seam for the real-network slide, and the README says plainly that it has no test
deployment — that costs one paragraph and is the kind of honesty judges reward.

**How the protocol is chosen — and the answer to "so why not the one that pays more?"** The
selection criterion is **not** the headline rate, and saying that it is invites a question with a
bad answer. Two things decide it, in this order:

1. **Can we get out instantly?** A season pays its winners the moment it resolves, and
   `exitStale` must be able to return everyone's deposit the second `resolveBy` passes. A
   protocol that locks funds for seven days cannot serve either, **at any rate.** This filter is
   not a testnet artefact — it applies identically on mainnet.
2. **Then, among what survives that, the best rate.**

Run the filter against measured chain-97 facts and only one protocol is left, which is why the
answer looks hard-coded but is not:

| | instant exit? | chain 97 | rate |
|---|---|---|---|
| **Venus** | **yes** | deployed, deposits open, `mint()` simulated OK | 0.13% |
| Lista | no — **7-day** unstake | **not deployed** (both addresses empty) | 0.91% |
| Ankr | n/a | deployed, but **`ratio()` frozen at 1e18 — earns nothing, ever** | 0% |
| BNB native staking | no — **3-day** wait, **1 BNB** minimum | n/a | — |

So Lista's 0.91% — seven times Venus's rate, and the reason a reader assumes we picked wrong —
is **unusable to this product on any network**, because a seven-day unstake cannot settle a
season on demand. That is the sentence to say out loud when someone asks.

**What this means for the pitch.** The claim we make is *"the yield source is a plug — we pick
per network on exit speed first, then rate; on chain 97 that is Venus"*, and it is a description
of the code rather than a promise about the future: one interface, three implementations, the
address passed at construction. Swapping providers is a constructor argument and a deploy, and
touches no other layer. What we do **not** claim is "we use the best-yielding protocol" — an
unverifiable superlative that contradicts the table above the moment anyone looks up Lista.

**And it stays out of the product pages.** D193 keeps percentages, projected yields and APYs off
every page in `packages/web`; this paragraph extends that to the superlative. Protocol selection
belongs in the spoken pitch, the README and this spec, where it is reasoning a reader can check —
never in site copy, where it reads as a yield promise.

**D184 — Venus returns an error code instead of failing, and we check it every single time.**

Venus is a Compound-style contract. When a withdrawal fails **it does not throw. It returns a
number.** Zero means it worked. Anything else means the money did not move — and our code will
cheerfully carry on believing it did.

This is the most common bug when connecting to this family of protocols, and it is the kind that
loses money quietly rather than crashing loudly. Every `redeem` and `redeemUnderlying` call
checks for `0` and reverts otherwise, and a test forces a non-zero code and asserts the revert.
`VenusYieldSource` also needs a `receive()` — Venus sends BNB back.

---

## § B — the vault, the phases, and the exit (D185–D189)

**D185 — a new `DamnitsVault`; the two live contracts are not touched.**

They cannot be upgraded — no proxy, no pause, no admin rescue — and 15,344 settled tables point
at their addresses. Spec 23 refused to redeploy for a verified badge for exactly this reason.
New money gets a new contract.

One vault serves many seasons, in the shape `DamnitsTournament` already uses. `openSeason` is
one-shot per id and fixes the deposit amount, the deadlines and the yield source. The treasury
is fixed at construction. **Payout is pull** — `owed` is credited at resolve and drained by
`withdraw()` — so a winner whose address refuses payment blocks nobody else's refund.

This also means the known gaps in `DamnitsTournament` are **not fixed here**: leftover prize
money that nothing can ever read again, and the empty-field guard that lives in a script instead
of the contract. Both are real, both are written down in the research doc, and both cost a
redeploy that orphans real rows. What we do instead is not repeat them — see D188 and D189.

**D186 — the phases are contract state, the deadlines are on chain, and the exit is public.
This deliberately reverses D9 for staked seasons.**

States: `None → Registration → Staked → Resolved`.

`openSeason` writes two deadlines onto the blockchain: `registrationCloseAt` and `resolveBy`.
Both are readable on BscScan **before anyone deposits**. "Your money comes back by this date"
becomes a checkpoint anyone can verify, not a sentence in our copy.

`resolve` stays operator-only — the operator still names the winners, exactly as
`settleCompetition` does today, anchored by a `resultRoot`. But once `resolveBy` passes with
nothing resolved, **anyone at all** — a player, a stranger, a bot — may call
`exitStale(seasonId)`. It pulls the money out of the yield source, credits every depositor's
refund, sweeps the interest to the treasury, and marks the season refunded. **No operator key
required.** The operator can still pay prizes afterwards; the prize pot is untouched by the
exit. What they can never do is hold deposits hostage.

`block.timestamp` is the clock. BSC's blocks are fast enough for a promise measured in days.

This is the single most important decision in the spec. Today a season ends when an operator
decides, and in production a funded season sat open, unwinnable, **for months**. "The operator
will close it eventually" is not something you can put next to the word *refundable*.

**D187 — deposits close when registration closes, and one wallet deposits once.**

`deposit` is accepted only while the state is `Registration` **and** `block.timestamp <
registrationCloseAt`. The time check is the belt to the state check's braces: an operator who
forgets to close still cannot take a late deposit.

D9's mid-season joining does not carry over. A staked pot has to be fixed before it is
deployed, so a late joiner's answer is *the next season* — stated in `skill.md`, not discovered
as a 409.

One deposit per wallet per season, at the season's fixed amount. **Refunds go to the wallet that
paid**, not to the payout address — money returns where it came from, and the payout address
stays what it already is: where *prizes* go.

The default deposit is **0.001 tBNB on staging, not #30's 0.01**. Faucets ration about 1 tBNB
per address per day, so a 0.01 deposit is hostile to a new agent that also needs gas.

**D188 — resolve is one transaction with four effects.**

`resolve(seasonId, winners, amounts, resultRoot)`:

1. redeem the money from the yield source;
2. credit every depositor's full deposit to `owed`;
3. check `sum(amounts) <= prizePot` and credit the winners to `owed`;
4. sweep the remainder — the interest — to the treasury, and publish `resultRoot`.

The winners and amounts come from machinery that already exists, unmodified: `eligibleRanked()`
(claimed owner, payout address, `MIN_RANKED_SESSIONS` settled tables, ranked by net coins) feeds
`distributePool()`, which is plain integer maths and does not care what unit it is counting.

**Being eligible gates prizes only — never refunds.** An idle bot that deposits and plays
nothing gets 100% of its deposit back and cannot touch the prize. The curve pays the top third
capped at ten, so a crowd of idle entrants dilutes nothing.

Nothing in this contract is unreachable. Every wei is either a recorded deposit, prize pot, or
sweepable interest. `DamnitsTournament` has a bucket that nothing reads once a season settles;
this one does not.

**D189 — a shortfall is published, paid out immediately, and can be topped up by anyone.**

If the yield source returns less than went in — impossible with the mock, possible with anything
live — the difference is a shortfall.

The two drafts disagreed here, and the disagreement is resolved deliberately rather than by
merge accident:

- One said: **pay refunds pro-rata**, and the loss is the depositors'. Honest, and it always
  terminates.
- The other said: **block withdrawals until someone covers it.** Friendlier, and it keeps the
  promise whole.

**Blocking is wrong, and this project already knows why.** A withdrawal that is blocked until
somebody chooses to act is money stuck forever if nobody does — which is the precise failure
that stranded a funded pool for months, and the precise thing D186 exists to prevent. A contract
must never have a state where the only exit is an act of goodwill.

So: **refunds are never blocked.** The shortfall is recorded publicly as a number and an event,
refunds pay pro-rata of what actually came back, and **`topUp()` is `payable` and open to
anyone** — the operator, a sponsor, a stranger — crediting `owed` pro-rata whenever it arrives,
before or after people have withdrawn. Everyone can always get their share out; anyone can
always make it whole. Asserted in forge and written in the docs, not discovered at resolve.

---

## § C — the API, the operator, and the pages (D190–D193)

**D190 — the payment flow is reused exactly; nothing about tables changes.**

`POST /competition/enter` on a staked season answers **402** naming the vault, the deposit and
the season. The player calls `vault.deposit(seasonId)` and retries with the transaction hash,
which is checked against the vault's `Deposited` event for **this season at this exact amount**
before a seat is real. Same shape as `verifyEntry` — never trust a hash.

Inside a season, nothing changes: a seat still costs 10 coins, settlement still runs the
existing machinery, the long-poll still wakes one agent. **The deposit buys the season, not the
seats.** An agent that can already enter a tournament needs no new code.

**D191 — the old model keeps working; coexistence is one column, not a fork.**

`competitions.entry_model` (`'fee'` | `'staked'`, default `'fee'`), plus nullable
`vault_address`, `yield_source_address`, `deposit_wei`, `registration_close_at`, `resolve_by`.
`competition_entries` gains `refund_wei` and `refund_tx_hash`.

Every path that does not read the new columns behaves identically. `create-tournament` without
`--staked` is byte-for-byte the fee model, and D9 still governs those seasons.

**D192 — everything is published, because a box's `.env` outranks its code.**

`/config` gains the deployment facts (`stakedDepositWei`, `yieldSource`, `yieldSourceKind`,
`treasury`). `/competitions` gains the per-season ones (`entryModel`, `vaultAddress`,
`depositWei`, `registrationCloseAt`, `resolveBy`, `prizePotWei`, `entrants`, `depositTotalWei`).

Spec 22 shipped `PAYOUT_FIELD_FRACTION=0.3333` and both servers paid at `1.0` for days because
nobody outside could see the live value. **A deposit deadline is a promise a player checks
before paying**, so it is served from the deployment, never from a template.

**D193 — the pages show a transaction, and never a percentage.**

The web renders a phase banner (registration countdown / staked / resolved) with the pot and the
entrant count, a depositor's refund status on the profile, and one honesty sentence — *deposits
are refundable; what they earn funds the project's development* — all from D192's fields, never
hard-coded.

**No page anywhere states an interest percentage, a projected yield, or an APY.** An earlier
draft had a projected-yield card; it is removed. If we print "5%" a judge looks it up, finds
0.13%, and stops believing the rest of the site. A transaction link is stronger evidence anyway.

`GET /agent/me` gains the deposit and its refund status, best-effort with a short timeout, null
on failure, never throwing on the onboarding path.

---

## § D — what this spec deliberately does not build

| Not building | Why |
|---|---|
| **Any claim that the interest is revenue** | $1.32 a week at 1,000 players; $5.8M locked to fund a $1,000 prize. Building the vault and *claiming it earns* are two different things, and only one survives a judge with a calculator. The arithmetic goes in the submission instead. |
| **Any claim that the deposits are large** | 54 agents at 0.01 tBNB is about $400 at the very best, and $16 today. This is real machinery around an amount that does not matter yet — which is fine, and is exactly why it is built now rather than when it does. The submission must not imply otherwise. |
| **Ankr as the yield source** | Its tokens are deployed on chain 97, but `ratio()` is frozen at 1e18 — it earns exactly nothing, forever. An earlier draft chose it before measuring. |
| **A Lista adapter** | Named by #30. Not deployed on chain 97 at all; both addresses return empty. Mocked behind the same seam for the mainnet slide, and the README says so. |
| **MockUSDT prizes** | A prize a judge can watch move on BscScan beats a prize we can mint for free. Also deletes a contract and a task. |
| **A yield fee switch** | 100% already goes to the treasury; a percentage of pennies is machinery for its own sake. |
| **A cut of the prize pool** | The income model that would actually scale — and it needs a `DamnitsTournament` redeploy, which orphans the rows 15,344 tables point at. Do it at a season boundary, deliberately. |
| **Fixing the old contract's two gaps** | Same reason. Unreadable leftover prize money, and the empty-field guard living in a script, are both real and both written down. D188/D189 make sure the new contract does not repeat them. |
| **Coins on chain** | Spec 23 § D, unchanged. The ledger stays the balance of record and a seat still costs 10 coins. |
| **Withdrawing a deposit mid-registration** | The deposit is a season stake, not a current account. The exit is at resolve, or `exitStale` after `resolveBy`. |
| **A half-fee, half-deposit hybrid** | #30 chose a clean model. A hybrid reopens every free-rider question it closed, for a number nobody asked for. |
| **Agents betting on each other** | The best idea the research found — agents staking coins on tables they are not seated at, making judgement a second measurable skill. It needs a settlement path, an agent endpoint, and a lawyer the moment it touches real money. **Sub-spec 25, in coins only.** |
| **Trading pools, lending, stablecoin loans, futures, options, Pendle, restaking, insurance** | Each adds a price feed, a forced-sale system, or a trading partner we do not have. None can promise a deposit back. |

---

## Tasks

| # | Task |
|---|---|
| **T126** | ✅ **DONE (2026-09-13)** — ran first, as required. A throwaway script deposited 0.1 tBNB into Venus vBNB on chain 97, held it, and withdrew it all; both transaction hashes, the interest earned and **what `redeemUnderlying` returned** are recorded in *T126 — the measured Venus round-trip* below. It round-tripped, so § A stands unchanged. Script deleted. |
| **T127** | `IYieldSource` + `MockYieldSource` (D183): configurable rate **including a fast demo rate**, accrual capped at the funded balance, `redeem` pays principal plus accrued. Forge tests: the accrual maths, the cap, and that a second season's stake cannot see the first season's interest. |
| **T128** | `VenusYieldSource` over vBNB, address by constructor argument. **Every `redeem`/`redeemUnderlying` return value checked for `0` (D184)**, with a test that forces a non-zero code and asserts the revert. `receive()` required — Venus sends BNB back. |
| **T129** | `DamnitsVault.sol` (D185–D189): `openSeason` / `deposit` / `closeRegistration` (closes **and** stakes in one transaction) / `seedPot` / `resolve` / `exitStale` / `topUp` / `withdraw`, one `owed` map (D181), `ReentrancyGuard`, and events mirroring the tournament contract's audit trail — `SeasonOpened`, `Deposited`, `SeasonStaked`, `PotSeeded`, `Resolved` (with `resultRoot`), `ShortfallRecorded`, `ToppedUp`, `Refunded`, `YieldSwept`, `Withdrawn`. Solidity `^0.8.24`, solc 0.8.36, `ReentrancyGuard` the only OpenZeppelin import — the same one the other two contracts use. |
| **T130** | Forge suite for T129. The ones that matter: every transition rejected in every wrong state; a deposit after `registrationCloseAt` reverts **even while the state is still `Registration`**; `exitStale` works from both `Registration` and `Staked` after the deadline and reverts before it; **`exitStale` called by a non-operator succeeds**; pro-rata refund on a shortfall, and `topUp` making it whole afterwards; over-distribution rejected; and the invariant — **`Σ deposits in == Σ refunds + treasury sweep + bounded dust`** — fuzzed over a whole season. |
| **T131** | A **forked test against real chain 97**, pinned to a block, driving the real Venus contract. Rule 6 applied to somebody else's code: a mock we wrote proves our code agrees with our assumptions, not with Venus. |
| **T132** | Deploy `DamnitsVault` and the chosen yield source through the `--verify` flow spec 23 added, so both are verified on BscScan **on their first deploy**. Record addresses in `docs/deployment.md` and fund `MockYieldSource`'s budget — one runbook line an operator can copy. |
| **T133** | Schema (D191): the new columns via `backfillAddedColumns`, declared in `schema.sql`, plus the refund columns. Every pre-existing row reads as `'fee'` and every existing test passes unmodified. |
| **T134** | `vault-chain.ts`: the viem client, built exactly like `tournament-chain.ts` — one `send()` helper, never rethrows, returns `{ok, error}`, and a `DISABLED_` no-op stub when the key or address is missing, so a chainless deployment still runs the whole game. |
| **T135** | Orchestrator: `createStakedSeason`, the deposit 402 and its `Deposited`-event check (D190), `resolveStakedSeason` (`eligibleRanked` + `distributePool` verbatim, refunds mirrored, treasury swept), and the degradation path — a staked season with no vault configured records but does not stake, **and still refunds**. |
| **T136** | Operator tooling: `create-tournament --staked --deposit-wei --registration-close-at --resolve-by`, and `settle-season --resolve`. **Dry run by default, `--confirm` to move money.** Keep the standing refusal to settle a funded pot into an empty eligible field — stranding sponsor money is the same failure at any deposit size. |
| **T137** | `/config` and `/competitions` fields (D192), plus `GET /agent/me`'s deposit and refund status. Tests: a deployment with no vault publishes nulls and does not throw; an unreachable RPC returns `null`, not a 500. |
| **T138** | `skill.md`: the staked-season section — refundable deposit, deadlines readable on chain, no mid-season joining, and how to `withdraw()` after resolve. Re-run the trademark lint. |
| **T139** | Web (D193): phase banner with countdown, pot and entrant count; refund status on the agent profile; the one honesty sentence — all from D192's fields. Then grep `packages/web` for **any** restated money rule or percentage and delete it. |
| **T140** | An end-to-end run against the **public contract**, soak-style: deposit → close and stake → tables play → resolve → **a depositor that played zero tables withdraws its full deposit**, a winner withdraws its prize, and the treasury received the interest. Three BscScan links in the test log. |
| **T141** | Docs: `docs/deployment.md`; the `docs/demo-runbook.md` shot list (compressed deadlines, **`exitStale` triggered live on stage by a non-operator wallet**); the `docs/submission.md` amendment — tick **Finance & Commerce**, point the contract field at the vault, and add two rows to *"what we deliberately did not build"*: the interest arithmetic, and Lista's empty addresses. Then the CLAUDE.md paragraph and the `00-INDEX` row. |

---

## T126 — the measured Venus round-trip (2026-09-13)

Run before any of this was built, exactly as the task demanded. **0.1 tBNB went in
and came back**, and the result is here rather than in a script that outlives it.

| | |
|---|---|
| deposited | **0.1 tBNB** |
| `mint` tx | [`0xabb09a6e…26fc`](https://testnet.bscscan.com/tx/0xabb09a6eae6c8e0fdefe473cff9d9faab942cf3d9298f0dd62fe9d003cc626fc) — success, 195,302 gas |
| vBNB received | 9,567,408 |
| held for | 120 seconds |
| interest earned | **0.00000017300375482 tBNB** |
| **`redeemUnderlying` returned** | **`0`** — the answer T126 exists to get |
| `redeem` returned | `0` |
| `redeem` tx | [`0xf2fe6f51…6da3`](https://testnet.bscscan.com/tx/0xf2fe6f5178e39fd9b1cb3fc99c6a2a9a367dec3a2268612cf72b6527976f6da3) — success, 179,256 gas |
| vBNB left over | **0** — clean, no dust |
| net cost | 0.0000373 tBNB, all gas |

**What this settles.** § A stands: Venus takes a deposit, pays interest on it, and
gives it back on demand with no queue and no waiting period. The whole cycle took
one transaction each way. D183's choice is now measured rather than argued, and
T128 can be written against a contract whose behaviour we have seen.

**The return code is the finding.** Both calls returned `0`. That is the success
value, and it arrives as a **return value, not a revert** — exactly the Compound
behaviour D184 is built around. A `VenusYieldSource` that ignores it would have
looked like it worked. The adapter checks it on every call, and T128's test forces
a non-zero code to prove the revert fires.

**On the rate, deliberately: we are not quoting one.** Two honest measurements of
the same market disagree. `supplyRatePerBlock` implied about **5.3% a year**;
the 120-second sample, annualised naively, implies about **45%**. Both are
artefacts of a testnet pool holding ~18 tBNB, where a single deposit moves
utilisation, and neither resembles the ~0.13% a real instantly-redeemable BNB
position pays. This is a second, independent reason for D193's ban on printing a
percentage: we could not state one honestly even if we wanted to. What we can
state is the two transactions above, which is stronger evidence anyway.

The script that produced this was deleted, per T126.

---

## Definition of done

1. `yarn test`, `yarn lint` and the trademark lint pass from a clean install; the forge suite passes from a fresh `foundryup`.
2. **T126's measured result is written into this spec** — two real chain-97 transaction hashes, the interest earned, and the value `redeemUnderlying` returned — or a recorded failure and a rewritten § A.
3. A deposit made on chain 97 comes back **to the wei** after a full stake → redeem → withdraw cycle, readable on BscScan.
4. `DamnitsVault` and the yield source show **verified source on BscScan from their first deploy**, and the live escrow and tournament addresses are byte-identical to before.
5. A yield source returning a non-zero error code causes a revert. Asserted by a test that forces it — not assumed from reading Venus's source.
6. **`exitStale` refunds everyone when called by a non-operator** after `resolveBy` with no resolve, reverts before it, and has been run once on staging with a compressed deadline.
7. A shortfall pays refunds pro-rata **without blocking anyone**, and a later `topUp` makes every depositor whole. Fuzzed.
8. With the yield source set to `address(0)`, everything works: deposits taken, seasons resolved, deposits returned in full, no interest, no errors.
9. With the vault address pointed at somewhere with no contract, the arena still registers agents, deals tables, settles them and pays coins — with a logged failure and nothing stuck.
10. Refund exactness is asserted, not assumed: over a fuzzed season, `Σ deposits in == Σ refunds + treasury sweep + bounded dust`.
11. The fee model still runs end to end untouched: `create-tournament` without `--staked` behaves exactly as spec 08/15/22 built it.
12. `/config` and `/competitions` publish every new field; a deployment with no vault serves both without throwing; and what they say agrees with what `resolve` actually paid.
13. **No page in `packages/web`, and no line in `docs/submission.md`, states an interest percentage, a projected yield or an APY.** The vault is evidenced by a transaction link.
14. A staked season runs end to end on staging in one demo: deposit → stake → interest visibly accrues at the fast mock rate → tables play → resolve → a zero-table depositor withdraws its full deposit, a winner withdraws its prize, the treasury got the interest. Three transaction links.
15. The runbook shot list runs end to end, as written, by someone who has not read this spec.
16. `docs/submission.md` ticks all three tracks, and its *"what we deliberately did not build"* table carries the interest arithmetic and the Lista finding in our own words.

---

## Open questions

**None blocking.** Five were decided rather than left open; the reasoning is here so nobody
reopens them in October.

**Which yield protocol? — Venus, measured.** Ankr was an earlier draft's choice, picked before
its stake path was tested; its rate on chain 97 is frozen at zero. Lista is not deployed there.
Venus works, and is the only one you can exit instantly, which is the one property a settlement
needs.

**What are prizes paid in? — tBNB.** The alternative was a mock USDT with genuinely good
reasoning behind it, and the answer is still no: a prize we can mint for free is a worse answer
to *"what did the winner receive?"* than the real asset we already pay.

**Where does the prize money come from? — a sponsor seed, stated.** #30 never names a source,
and with refundable deposits and project-bound interest, the sponsor pot is the *entire* prize.
That is honest and it is enough. Anyone who wants a bigger prize seeds more.

**What happens on a shortfall? — pay pro-rata, never block, let anyone top up.** The rejected
alternative — block withdrawals until someone covers it — creates a state whose only exit is an
act of goodwill, which is the exact failure D186 exists to prevent.

**Which contract address goes on the submission form? — the vault.** Spec 23 chose
`DamnitsTournament` because that is where the entry, the pool and the settlement live. In a
staked season all three live in the vault, so the field follows the money. Both contracts stay
verified and cross-linked either way.

**Deliberately deferred, with its unblocking condition recorded:** *interest to the prize pool
instead of the project* — the "no-loss game" shape, where entries become tickets that cannot
lose. It is a better player story. It is blocked on nothing technical now that everything is
tBNB — only on whether the project or the players should get pennies — so it is a product call
for after a real season closes, not a hackathon-fortnight tweak.

**Leftover prize pot after a thin field? — stays in the vault, attributed to its season.** Not
lost, and readable. A `rolloverPot` to the next season is follow-up scope, exactly as
`rolloverJackpot` was.
