# Adding a money model to damnits.fun — what we found

This answers issue [#30 "Improvement Economy model"](https://github.com/damnitsfun/damnitsfun/issues/30)
and its earlier version, [#20](https://github.com/damnitsfun/damnitsfun/issues/20).

**The question:** should damnits.fun add a DeFi feature, and would it help us win the
Indonesia Web3 Hackathon 2026?

**Written in plain language on purpose.** Money mechanics are simple once you strip the jargon,
and a judge with five minutes should be able to follow this page.

All numbers were checked on **7 September 2026** by asking the blockchain directly, not by reading
articles. Test network = `data-seed-prebsc-1-s1.bnbchain.org:8545` (chain 97). Real network =
`bsc-dataseed.bnbchain.org` (chain 56). BNB was about $757. Gas was about 0.05 gwei.

---

## 1. The short version

**The idea in issue #30 is worth building. The reason given for it is impossible.**

The issue says: players deposit money instead of paying a fee, we put that money in a savings
account, players get their deposit back, and **we keep the interest as income**.

The first half is good. The second half does not work, and it does not work by a very large margin.

- At the real interest rate, 1,000 players depositing 0.01 BNB for a **whole week** would earn
  **$1.32 in total**. Not each — in total.
- To earn enough interest to pay a **$1,000 weekly prize**, we would need **$5.8 million** sitting
  in the account. That is about **766 times** more money per player than the issue suggests.
- The protocol the issue names first, **Lista DAO, does not exist on the test network at all.** We
  checked its addresses and they are empty.

But the idea survives for a different reason. Forget income. Think of it as a **promise**:

> **"Play for real prizes. Win or lose, you get your deposit back."**

That is a good, true, checkable thing to say about a product. And it fixes the exact weakness we
have.

**Our recommendation:** build the savings vault using **Venus** (the one protocol that actually
works on the test network), add a **small fee** as the honest income story, and put the
disappointing interest numbers **in the submission** rather than hiding them.

---

## 2. Why this matters for the hackathon

### 2.1 We are missing a whole category

The hackathon has three categories. Our submission (`docs/submission.md`) enters two of them —
**AI Agents** and **Consumer Apps** — and skips the third, **Finance & Commerce (DeFi)**, saying it
"would be a stretch."

Two things change that.

**First, DeFi is inside a category we already entered.** The AI Agents category is worded
*"autonomous agents & AI x DeFi onchain."* DeFi is not only in the category we skipped.

**Second, prizes are per category.** Each category pays $600 / $400 / $300 for first, second and
third, plus a $1,000 grand prize. A believable third entry is worth roughly as much as moving up a
place in an existing one.

### 2.2 We score badly on one judging point, and this is the fix

BNB Chain publishes how they judge. There are five things they look at. One of them is basically:

> **"How will this project make money one day?"**

Right now damnits.fun has **no answer at all**. Nothing anywhere brings in a single cent. That is
our worst score of the five, and a money model is exactly what fills it.

A second judging point rewards **"demonstrated interaction"** with the BNB Chain ecosystem, not just
mentioning it. Right now we only use contracts we wrote ourselves. Connecting to a real BNB Chain
protocol scores higher than deploying more of our own.

### 2.3 The trap we must avoid

The best page in our submission is called **"What we deliberately did not build."** It lists
suggestions we turned down and explains why. Judges like it because it shows we thought carefully
instead of grabbing every sponsor's logo.

If we now bolt on something whose own numbers say it is pointless, we contradict our own best page.

So whatever we build has to survive the same hard questions we asked of the things we rejected.

---

## 3. The money maths (this decides everything else)

### 3.1 What BNB actually pays in interest

These are live numbers from real, large pools:

| Where | What you deposit | Size of pool | Interest per year |
|---|---|---:|---:|
| Lista liquid staking | BNB | $707M | **0.91%** |
| Venus | BNB | $323M | **0.13%** |
| Lista Lending | BNB | $367M | **0.06%** |
| Aave v3 | BNB | $86M | **0.01%** |
| Venus | USDT (dollar coin) | $68M | 2.62% |
| Aave v3 | USDT (dollar coin) | $11M | 2.86% |

We double-checked one of these ourselves rather than trusting the list. Venus publishes an interest
rate per block. We read it directly from the contract (17,855,527), multiplied by the number of
blocks in a year (70,080,000, because BNB Chain now makes a block every 0.45 seconds), and got
**0.125%** — matching the published 0.13% exactly.

**Read the table carefully.** BNB pays about **0.9% at best**, and that is real staking. *Lending*
BNB pays close to nothing, because almost nobody wants to borrow BNB, so nobody pays for it.

The 2–5% the issue mentions **does** exist — but only for **stablecoins** (coins pegged to the US
dollar). To earn it we would have to convert players' BNB into dollars, hold it, and convert back.
If BNB's price moves while we hold it, players do not get their full deposit back.

That breaks the one promise the whole design exists for. So that door is closed.

### 3.2 How much interest we would actually earn

Total across every player, at the real rate:

| Rate | Players | 1 hour | 1 day | 1 week |
|---|---:|---:|---:|---:|
| **0.91%** (real BNB rate) | 10 | $0.000079 | $0.0019 | $0.013 |
| | 100 | $0.00079 | $0.019 | $0.132 |
| | 1000 | $0.0079 | $0.189 | **$1.32** |
| 2.5% (dollar coins — breaks the promise) | 1000 | $0.022 | $0.518 | $3.63 |
| 5% (very optimistic) | 1000 | $0.043 | $1.036 | $7.25 |

**At our actual size today** — 54 agents paying 0.0005 BNB each — the entire prize pool is
**0.027 BNB, about $16**. Leaving that in a savings account for three months earns **16 cents**.

### 3.3 The number to remember

Turned around, to fund a **$1,000 weekly prize** from interest alone we would need:

- **$5.80 million** at 0.91%
- **$2.09 million** at 2.5%
- **$1.04 million** at 5%

Spread over 1,000 players that is **$5,800 each**, against the $7.57 the issue proposes.

### 3.4 Two smaller facts worth knowing

**Gas is cheap here, and that is genuinely lucky.** On BNB Chain a simple transfer costs about
$0.0008 and a settlement about $0.011. Other projects in this space have to build complicated
machinery just so that claiming a prize does not cost more than the prize. We do not have that
problem. It is a real advantage — it just is not big enough to rescue the interest maths.

**Under about a day, the interest is actually negative.** Moving money in and out costs more in fees
and price spread than an hour of interest earns. Any design that deposits and withdraws per game
loses money.

### 3.5 The honest conclusion

**Interest cannot fund prizes here, and it misses by about a thousand times — not by a little.**

Build the vault for the **promise** (you always get your deposit back) and for the **proof** (a real
BNB Chain protocol, visible on the blockchain). Never put a percentage on a slide. **Show a
transaction link instead.** If we claim "5% interest" a judge will look it up, find 0.13%, and stop
believing everything else we wrote. The transaction link is more impressive anyway — it is proof
rather than a claim.

---

## 4. The surprise: most of these protocols are not on our network

Our whole project runs on the **test network** (chain 97) — practice money, not real money. That is
normal for a hackathon.

But a savings account only helps if the bank exists on your street. We checked every address by
asking the blockchain whether any code lives there.

### 4.1 Works, and useful

| What | Address on chain 97 | Result |
|---|---|---|
| **Venus vBNB** | `0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c` | ✅ **Real and working.** We ran a practice deposit of 0.1 test-BNB through it and it succeeded. Deposits are open, there is no limit, and the pool holds 16.36 test-BNB. |
| **Venus controller** | `0x94d1820b2D1c7c7452A163983Dc888CEC546b77D` | ✅ Real |
| **ERC-8004 identity registry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ✅ Real — already used by spec 23, address confirmed correct |
| **ERC-8004 reputation registry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | ✅ Real — this is the "what's next" item in our submission |
| **BNB native staking** | `0x0000000000000000000000000000000000002002` | ✅ Real, but needs **1 BNB minimum** and a **3-day wait** to withdraw |
| **PancakeSwap v2 and v3** | factory, router | ✅ Real |

### 4.2 Not there — would have to be faked

| What | Result |
|---|---|
| **Lista DAO** (the issue's first suggestion) | ❌ **Empty.** Both `0x1adB950d…` (StakeManager) and `0xB0b84D29…` (slisBNB) return no code. Their own documentation lists **zero** test network addresses. |
| **Ankr** (the issue's second suggestion) | ⚠️ Exists, but **the interest rate is frozen at zero**. You can deposit. It will never grow. Nothing to demonstrate. |
| PancakeSwap Prediction | ❌ Empty on the test network |

### 4.3 Real network only — ignore them

Aave, Morpho, Pendle, KernelDAO (which is shutting down anyway), StakeStone, Solv, pSTAKE, Stader,
asBNB. Euler is not on BNB Chain at all.

### 4.4 What this means

**Venus is the only real option.** And it happens to have the two properties we need:

**You can take the money out instantly.** This matters more than anything else. Lista makes you wait
**7 days** after asking for your money back. BNB native staking makes you wait **3 days** and wants
at least 1 BNB. We have to pay winners the moment a season settles — we cannot tell them to come
back next week. Venus returns the money immediately.

**The number visibly moves.** On the test network Venus shows about **35% per year**. That is a
silly, fake number, because the test network is not real. But for a **demo it is perfect** — a judge
watches the screen and sees the balance actually growing. Every other option shows a frozen zero.

**One thing to say out loud in the README:** the protocol the issue names first has no test network
at all. Saying so costs one paragraph and is exactly the kind of honesty judges reward.

---

## 5. Going through issue #30 line by line

| What #30 says | Our answer |
|---|---|
| Players deposit 0.01 BNB into a tournament vault | ✅ **Good.** Note our current fee is 0.0005 BNB — twenty times smaller. |
| The vault tracks how much each player deposited | ✅ **Good, and necessary.** Today our contract only stores a yes/no "did they enter", not an amount. Without the amount we cannot refund it. |
| The deposit belongs to players, not to the project | ✅ **This is the best idea in the whole issue.** It should be the headline. |
| Put the money into Ankr or Lista | ❌ **Neither works.** Lista is not on the test network. Ankr earns exactly zero there. **Venus is the answer.** |
| The interest becomes the project's income | ❌ **Off by about a thousand times.** See section 3. Drop this claim completely. |
| Money stays deployed "throughout the tournament" | ⚠️ **Our seasons are much longer than the issue assumes.** A season closes when an operator decides — the listed end date is only a suggestion. In production a funded season stayed open for **months**. That is good for interest and costs us nothing. |
| Three phases: Registration → Tournament → Resolve | ✅ **We already have this.** On the blockchain it is `Open → EntriesClosed → Settled`. We do not need a new lifecycle — only two new hooks on the existing one. |
| Keep the prize pool in USDT, separate from deposits | ❌ **No.** We have no USDT pool today. Adding one means a second currency, a price feed or a swap, and price risk — for no benefit. Keep prizes in BNB. Keep the *separation of deposit from prize*, which is the real idea. |
| The contract needs open / close / lock / track / resolve / withdraw | ✅ **Mostly already there.** See section 7. |

**Summary:** about 60% of #30 already exists, 20% is worth building, and 20% should be politely
declined with reasons.

---

## 6. Every DeFi mechanic, explained simply, and whether it fits us

Difficulty: **1** = a few lines of code · **3** = a weekend plus proper tests · **5** = a whole
product of its own, needs a security audit.

### 6.1 Lending and borrowing — **no**

*What it is:* a big shared pot. Some people put money in and earn interest. Other people borrow from
the pot and pay interest, but only if they lock up something more valuable first. If the value of
what they locked drops too far, someone else is allowed to buy it off them at a discount.

*What it needs:* a **price feed** (to know when the collateral is worth too little) and a crowd of
people watching for bad loans.

*Why not us:* we never borrow anything. Every version of this adds a price feed and a forced-sale
system we do not need. **The one exception is simply putting money in to earn interest** — which is
section 6.3, not this one.

### 6.2 Staking — **partly**

*What it is:* lock up coins to help run the blockchain, and get paid for it.

*Liquid staking* gives you a receipt token you can still use while your coins are locked. There are
two styles: one where your balance number grows, and one where your balance stays the same but each
token becomes worth more. **The second style is much easier to work with** — no surprise balance
changes. Venus, Lista and Ankr all use it.

*Why mostly not us:* almost all of these make you **wait days** to get your money out. Lista: 7 days.
BNB native staking: 3 days, and a 1 BNB minimum. We need to pay winners the moment a season settles.
Venus is the only one with no waiting.

### 6.3 Earning interest on idle money — **yes, this is the one**

*What it is:* a **vault**. You put money in and get shares. The pot slowly grows. Later you hand
back your shares and get more money than you put in. There is a standard shape for this called
**ERC-4626**, and it is exactly "deposit, wait, withdraw" — which is exactly issue #30.

*The good news:* OpenZeppelin (the library we already use) gives us this for free, including the fix
for one nasty attack. **The attack:** the very first person to deposit puts in a tiny amount, then
sends a huge amount straight to the vault without using the deposit function. This distorts the
share price so badly that the next person's deposit rounds down to zero shares and they lose
everything. **The fix:** pretend the vault always has some invisible extra shares, which makes the
attack cost far more than it could ever earn.

*Fit:* **yes.** Difficulty 2.

### 6.4 Trading pools (AMMs) — **no**

*What it is:* instead of matching buyers to sellers, you dump two coins into a pool and a formula
sets the price automatically. People who supply the pool earn a cut of every trade.

*Why not us:* if the two coins move apart in price, **you end up with less value than if you had
just held them.** This is unavoidable — it is built into the maths. Which means a trading pool can
never promise to give your deposit back. That is the one thing we must promise.

### 6.5 Borrowing against your coins to mint a stable-value coin — **no**

*What it is:* lock BNB, receive dollar-pegged coins as a loan against it, pay a fee, and get
force-sold if BNB drops too far.

*Why not us:* needs a price feed, a forced-sale engine and bots to run it. Difficulty 5, and we have
no reason to want it.

### 6.6 Betting markets — **the interesting one**

Ways to let people bet on an outcome:

| Style | How it works | What it needs | Difficulty |
|---|---|---|---|
| **Everyone-in-one-hat** (parimutuel) | Everyone puts money in, guessing a winner. Winners split the whole pot in proportion to what they put in. | **Nothing.** No outside money, no trading partner, no price feed. | **2** |
| Order book with outcome tokens | "Yes" and "No" become tradable tokens; the price is the probability | professional traders, a matching system, and a trusted source of truth | 3–5 |
| Automatic bookmaker (LMSR) | A formula always quotes a price so you never wait for someone to bet against you | **the project must fund the losses.** That funding is the running cost. | 3 |
| House sets the odds | We quote odds and take the other side | our own bankroll, a pricing model — and legally we become a bookmaker | 3 |

**The everyone-in-one-hat style is special: it can never run out of money**, because it only ever
pays out exactly what it took in. And it needs no outside source of truth, **because our own game
already announces who won.**

Its downsides are real but manageable: you do not know your payout until betting closes (show the
current split and label it "provisional"); someone can bet at the last second with better
information (close betting early); and if everyone bets on the same player, you must refund the
round.

Its actual blockers are not technical:

1. **We run the game and we deal the cards.** The random seed must be locked on the blockchain
   **before** betting closes, and revealed after. We already do this — we just have to get the order
   right.
2. **Betting real money on a game outcome is gambling in most countries**, and running the betting
   on *your own* game is the worse version of that. That is a lawyer question, and it must be
   answered before writing the contract, not after.

### 6.7 Auctions and price curves — **no**

Dutch auctions (price falls until someone buys — genuinely the simplest way to sell something when
you do not know the price), batch auctions, bonding curves.

One warning worth writing down: **a bonding curve is a machine for moving money from the last buyer
to the first buyer.** If anyone proposes one for an agent token, that is the reason to say no.

### 6.8 Skin-in-the-game mechanics — **yes, two of them**

- **Deposit to play, get it back at the end.** This is issue #30 without the interest part.
- **Behaviour deposits.** Put down money, lose it if you cheat, time out repeatedly or spam.
  About 90 lines of code, no DeFi needed. **The catch:** whoever proves you cheated has to do real
  work, so the deposit must be worth more than that work — otherwise nobody bothers reporting and
  the whole thing is decoration.
- **A small fee (a rake).** The house takes a small percentage of the pot. **This is the only
  income model that grows as the game grows**, and it is the easiest thing in this entire document
  to build. Difficulty 1.

### 6.9 Agent-specific tools — **already mostly done**

- **ERC-8004** — a standard for giving AI agents an identity, a reputation and a validation record
  on the blockchain. **We already do identity** (spec 23). **Reputation is live on our network** and
  is already named in our submission as the next step.
- **Smart accounts and gas sponsorship** — lets an agent transact without holding any BNB. We already
  use this for identity registration.
- **x402** (agent payment standard) — live on BNB Chain, but it buys us nothing today because our
  agents already log in with an API key.

### 6.10 Insurance — **no**

Nothing to insure when the pool is $16.

### 6.11 The closest existing example: PoolTogether

PoolTogether is a real product doing exactly what issue #30 describes: deposit, always get your
money back, and the pooled interest becomes a prize. Two things we learned from it.

**It never solved the short-deposit problem — it avoids it.** It works because a very large pool
sits still for months and the interest is then handed out in exciting lumps. It does not make small
short deposits productive. Nothing does.

**Two ideas worth copying anyway:**

1. **Measure balances over time, not at a moment.** If a reward depends on how much someone holds,
   measure their *average* balance across the period. Otherwise everyone deposits five minutes
   before the deadline and takes the same reward as someone who was there all season. Directly
   relevant if we ever reward coin balances instead of game results.
2. **Let people check if they won without changing anything.** They made "did I win?" a read-only
   calculation anyone can run themselves. The blockchain only does work for the actual winners, not
   for every participant. Useful if we ever pay out to part of a large field.

---

## 7. What we should build, ranked

### F1. A savings vault using Venus — **build it, this answers #30**

**What:** when entries close, the prize pool goes into Venus. When the season settles, it comes back
out. Every player's deposit is tracked and always returnable. Interest is kept in a separate bucket.

**Why it fits:** it is the only option that is live on our network, instantly withdrawable, and
visibly growing during a demo. And it fits our **existing** three phases — we need two hooks, not a
new lifecycle.

**Two traps that will definitely bite us:**

1. **Venus does not throw an error when a withdrawal fails.** It returns a number. Zero means it
   worked. Anything else means **the money did not move, but our code will think it did.** This is
   the single most common bug when connecting to this family of protocols. We must check that
   number.
2. **The pool can run dry.** If lots of people withdraw at once, there may not be enough left for us
   right when we need it. This — not hackers — is the real risk to a "you always get your money
   back" promise. The fix is a check before settlement: if we cannot get the full amount out, keep
   the money as plain BNB instead. About ten lines, and it is what makes the promise true instead of
   just marketing.

**A risk to state honestly:** Venus has been hacked four times since 2021, losing over $112 million
in total, most recently in March 2026. On the test network with $16 of practice money this does not
matter. But naming the risk is exactly what our submission already does well.

**Difficulty 2–3.**

### F2. A small fee — **build it, this is the real income story**

Take a small percentage of the prize pool. Two details make it trustworthy:

- **Put a hard ceiling in the contract that nobody can ever change** — not even us. "This fee can
  never exceed 10%, and that is permanent." A limit you can raise yourself is not a limit.
- **Lock the fee when a season opens.** If people joined at 3%, we cannot raise it to 8% halfway
  through. That changes the deal they agreed to.

**Be honest about the size.** 3% of our current $16 pool is about one cent. At today's scale *no*
income model earns anything real. The claim to make is **"the mechanism is real, it is on the
blockchain, and it grows with the game"** — not "we earn money."

**Difficulty 1.**

### F3. Agents betting on each other — **best idea, biggest build**

The most original thing available to us, and a perfect match for a category literally named
*"autonomous agents & AI x DeFi onchain."*

**The problem everyone misses:** a betting pool needs bettors. At a demo maybe five people are
watching. Most rounds would have one bettor or none, we would refund everyone, and there would be
nothing to show.

**The fix: let the agents bet.** We have 54 agents and 15,344 finished games. Let an agent bet on
tables it is **not playing at**. This is much better than spectator betting because:

- The crowd is always there — the agents supply it themselves.
- It becomes a **second way to measure how smart an agent is.** Not just "can it play cards" but
  "can it judge other agents." That is genuinely new.
- It is exactly the "agents that actually do things on the blockchain" pattern BNB Chain judges have
  been rewarding.

**And the safety trick: use coins, not real money.** We already have a coin system with a
per-season ledger that survived a 4,004-game stress test. A coin betting pool is pure arithmetic —
**no contract, no gambling exposure, no new trust assumptions.** If it works, upgrade it to real
money later, after a lawyer has looked at it.

**Difficulty 2** in coins, **3** on the blockchain. With 23 days left, only the coin version fits.

### F4. On-chain reputation — **cheap, already planned**

The ERC-8004 reputation registry is live on our network at `0x8004B663…`. Our submission already
names it as next and already has the right design (summarise a whole season into one write, not one
per game). Most projects wanting on-chain reputation have to invent the data. We have 15,344 real
games of it. **Difficulty 2.**

### F5. Contract fixes — **small, and two are real bugs**

Found while tracing where our money goes. Nothing to do with DeFi.

1. **Money can get permanently stuck.** Our check that stops us paying out a prize pool when nobody
   is eligible to win it lives in a **script** — something a human chooses to run. It can be
   skipped or forgotten. If it is, the money is locked in the contract **forever**, with no way to
   recover it. Production actually sat in this dangerous state — funded pool, zero eligible
   players — for months. This check belongs **inside the contract**, where nothing can skip it.
2. **Leftover money vanishes.** If the prizes we pay add up to less than the pool, the remainder
   sits there and nothing ever reads it again.
3. **The per-table escrow pushes money instead of letting people pull it.** If a winner's address
   refuses to accept the payment, the whole pot is stuck with no way out. Our tournament contract
   already does this correctly; the older escrow does not. It is unused in production, so the cheap
   answer is to **either fix it or officially retire it** — not leave it ambiguous.
4. **Record the payout split on the blockchain when we settle.** We once shipped a setting change
   and both servers kept using the old value for days, because a server's own config file overrides
   the code. Publishing it on the website was half the fix. Recording it on the blockchain is the
   other half.

**Difficulty 1–2**, and the first one protects money that can never be recovered.

### F6. Removing ourselves from holding agent keys — **real, but not now**

Today one password protects every agent's private key, and **there is no way for an agent to move
its own money at all.** A jackpot paid to an agent's wallet can only be moved by whoever holds that
password. This is worth fixing, and it is a prerequisite for any "the agent invests its own
winnings" story. But it is not a hackathon feature. **Difficulty 2–3.**

### F7. Everything we should say no to, and why

| Idea | Why not |
|---|---|
| Interest as income | $1.32 per week at 1,000 players. Needs $5.8M locked to fund a $1,000 prize. |
| Lista DAO | Not on the test network. We checked both addresses; they are empty. |
| Ankr | On the test network, but the rate is frozen at zero. Earns literally nothing. |
| A USDT prize pool | A second currency, needs a price feed or a swap, adds price risk, gains nothing. |
| BNB native staking | Needs 1 BNB minimum and a 3-day wait. Cannot fit our settlement. |
| Trading pools / liquidity | Losing value is built into the maths. Breaks the deposit promise. |
| Lending, stablecoin loans, futures, options, Pendle, restaking, insurance | Each one adds a price feed, a forced-sale system, or a trading partner we do not have. |
| A router across many yield protocols | One is enough. Add a second when a second exists on our network — today there is not one. |
| Async withdrawal support | Only needed if Lista arrives on the test network. Venus withdraws instantly. |
| A bonding curve for an agent token | A machine for moving money from the last buyer to the first. |
| x402 | Live on BNB Chain, but our agents already log in with an API key. Buys nothing. |

---

## 8. The plan

23 days remain before the 30 September deadline, and our rules say one sub-spec at a time.

**Sub-spec 24 — the money model.** F1 (Venus vault) + F2 (fee) + F5 (contract fixes). One new
contract, one interface, four small fixes, plus operator tools with the same "dry run by default,
`--confirm` to actually move money" safety as our existing scripts. This answers #30, fills the
judging gap, and gives us a real connection to the BNB Chain ecosystem instead of only our own
contracts.

**Sub-spec 25 — agent betting in coins (F3), if time allows.** No blockchain, no legal exposure.
Highest originality, and the only addition that makes agents *do* something new.

**Not now:** F4 (already correctly scheduled for after a season closes), F6 (real, but not a
submission item).

**Then update the submission:**

- **Tick Finance & Commerce.** It is no longer a stretch.
- Add the vault under "Built with BNB Chain", with a **transaction link — never a percentage**.
- Add two rows to **"What we deliberately did not build"**:
  - *"Interest as income — no. It earns $1.32 per week at 1,000 players, and would need $5.8 million
    locked to fund a $1,000 prize."*
  - *"Lista DAO — no. It has no test network deployment. We checked the addresses; they are empty."*

Those two rows are the strongest proof in the whole submission that we checked the numbers instead
of repeating what sounded good. Most hackathon projects cannot say that about anything.

---

## 9. Rules none of this may break

From tracing the money flow. These are not negotiable.

1. **The game engine stays the only thing that decides legal moves.** Nothing about money may affect
   what a player is allowed to do.
2. **Do not put money events into the game event log.** That log is hashed to prove the game was
   fair. Adding a new kind of event changes every future hash and ties our money system to our
   fairness proof. **Use a separate table.**
3. **Keep one hashing scheme.** A second one makes the blockchain record and our own record unable
   to check each other.
4. **The coin settlement function stays pure and blind to player IDs**, and must keep passing the
   replay test over 3,186 real finished games: shares add up exactly, the table is zero-sum, nobody
   loses more than they put in, and tied players are paid equally.
5. **The per-season table is the real balance.** The lifetime total must never decide rankings,
   charges or payouts.
6. **Startup checks must keep passing** — no setting may ever produce a fractional coin, and the
   payout percentages must add to exactly 100.
7. **A blockchain failure must never break a game.** Every blockchain call today is fire-and-forget
   and fully swallowed. A money call that can crash a settlement breaks how this project works.
8. **Publish every new setting on `GET /config`**, so anyone outside can check what the live value
   actually is. We learned this the hard way.
9. The trademark check applies to new contract code, docs and website text too.

---

## 10. Things we could not verify

Listed so nobody quotes them as fact.

1. Whether Venus's separate "isolated pools" exist on the test network.
2. Three secondary Venus test network addresses — taken from their official deployment file but not
   checked on the blockchain ourselves.
3. Lista's fee percentage. The blockchain says one thing and their documentation says another. Do
   not quote either.
4. Whether gas sponsorship still works on the test network. Spec 23 measured it working once, but we
   did not re-check it here.
5. The address of the ERC-8004 validation registry on our network.
6. Whether "Probable" (a BNB Chain betting market) has actually launched or is only announced.
7. Any claim that BNB staking pays more than about 1%. The live rate is 0.91%; articles quoting
   2.79% or 4–8% disagree with what the blockchain says.
