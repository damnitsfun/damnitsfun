# What to build next

**Updated 9 September 2026, after the stacked pull requests were merged and production was
deployed.** Submission closes **30 September — 21 days left**. Demo Day is October.

**Written in plain language on purpose.**

---

## First: what is actually true right now

I checked the live site rather than trusting the merge. Here is the real picture.

### ✅ Working

- **`main` now has spec 23.** Four pull requests merged (#25, #26, #28, #29).
- **Production is deployed and the chain facts are live.** `damnits.fun/api/battleground/config`
  now returns `chainId: 97`, both contract addresses, and the BscScan link. That was the missing
  piece last week.
- **On-chain identity is real and working.** Agent `pilot-tour-02` holds ERC-8004 identity
  **#2278**; `pilot-tour-04` holds **#2280**. Both point at the live registry
  `0x8004A818…` on chain 97. **This is your strongest BNB Chain claim and it is genuinely true.**

### ⚠️ Half-done

- **Most agents have no identity yet.** I checked five. The `pilot-tour` ones are registered. The
  `soakbot` ones come back with an **empty** registration list. The background job that registers
  them only runs when the server starts and when someone new signs up, and it does a limited number
  each time — so old agents are still queued.
- **Identity is invisible on the website.** There is **not one mention of ERC-8004 anywhere** in the
  web app. The public agent page does not show it, because the data the page loads does not include
  it. The only way to see it is to hand-type a JSON address, or visit a different website
  (8004scan). **You built the thing and left it where nobody looks.**

### ❌ Not done

- **There is still no money anywhere.** Entry fee `0`, prize pool `0`, jackpot `0`. Nothing has
  ever moved through the tournament contract.
- **Staging is still on the old code** — its `/config` has no chain fields at all.
- **The leaderboard is topped by your own test bots.** The top six are `soakbot-01` … `soakbot-18`.
  They are real agents that played real games, but to a judge it reads as *"the operator's robots
  are winning."*
- **The two spec 24 pull requests now point at the wrong branch.** When the spec 23 branch was
  deleted, GitHub re-pointed #31 and #32 at `e/fix-revamp` instead of `main`.

---

## ⚠️ The one thing to check before anything else

**Right now, your tournament probably cannot pay anybody — and the tool will refuse to try.**

To receive prize money, an agent needs **all three** of:

1. an owner who verified through X (Twitter),
2. a payout address set,
3. at least **10 finished games** in that season.

`soakbot` and `pilot-tour` agents almost certainly have **no owner**, because nobody claimed them.
If **zero** agents qualify, `settle-season` **refuses to run** — deliberately, because paying into
an empty field would lock the money in the contract forever. Production has already sat in exactly
that state, with **0 qualified agents out of 60**, for months.

**So: claim at least 3–5 agents through X and give them payout addresses. Do this first.** If you
omit it, everything below still gets built and you still cannot show a season paying out — which is
the single best thing a judge can watch.

---

## The plan

### This week (9–15 September) — make the money and the identity visible

**Step 1 — Claim some agents.** *(under an hour)*
See the warning above. Nothing else works without it.

**Step 2 — Show ERC-8004 on the website.** *(one to two hours — best value in this whole plan)*

Three small changes:
1. Add the identity number, the registration transaction, and the wallet address to the data the
   public agent page already loads (`profile.ts`).
2. On the agent page, print one line: **`identity #2278 · on chain`**, linking to the registry.
3. Link the registration transaction to BscScan, using the explorer address `/config` already
   publishes.

Why this is first among the build items: your submission calls gas-free on-chain identity *"the
part worth pausing on"* — and a judge cannot currently see it at all. This turns your best claim
from a sentence in a document into something they click. **It is a couple of hours for the single
biggest visible gain available.**

**Step 3 — Finish registering the old agents.** *(minutes, then wait)*
Restart the server a few times, or let the background job work through the queue, until the agents
at the top of the leaderboard all have an identity number. A judge will click the top one. Today
that is `soakbot-16`, and it comes back empty.

**Step 4 — Put real money in.** *(under an hour)*
- Seed the prize pool with the operator tool (`--confirm-spend`).
- Set a small tournament entry fee.
- **Send the money to the treasury, and fund the prize from the sponsor seed.** Not "entry fees
  become the prize." That one choice keeps the whole model clean and costs nothing to make now.

**Step 5 — Start a tournament that ends before 30 September.** *(planning, not code)*
Not a month-long season. You need one that **opens, runs, closes and pays out** before you submit,
so the video can show the whole loop with a transaction link at the end.

**Step 6 — Tidy the leaderboard.** *(half a day)*
Either keep the test bots out of the tournament season, or give them names that read as
opponents rather than as your own test rig. The board a judge sees is your shop window.

**Step 7 — Re-point the two spec 24 pull requests at `main`**, and decide which one you are keeping.
Three versions of one spec is confusing to anyone reviewing the repository.

### Next week (16–22 September) — two small features

**Step 8 — Fixed season lengths.** *(half a day to two days)*
Playground resets weekly, tournament monthly. Today a season ends whenever an operator decides,
which is why one sat open and unfinished for months. It also gives the website a countdown that
means something.

**Step 9 — A one-time joining fee.** *(two to three days)*
New agents pay once — about 0.001 tBNB — to activate, and that money goes to the project. This is
issue #34, the best-argued proposal anyone has made.

Why this one:
- **Smallest real build** — a roughly 20-line contract, reusing the payment flow you already have.
- Gives a **direct answer** to the judging question you currently score zero on: *"how will this
  make money?"* → *"every agent pays once to join."*
- Puts **another real transaction on the blockchain**, which is what actually scores.
- It does **not** need spec 24 first. (The issue says it does. That is wrong — they do not overlap.)

**Step 10 — Two tiny fixes.** *(one hour, together)*
- Replace casino-sounding words in code and on the site: "buy-in" → *table fee*, "prize pool" →
  *prize purse*, "jackpot" → *bonus round*. You already have a word-checking script in your build;
  just add a second word list to it.
- Add one sentence somewhere visible: *"We hold no gaming licence. This runs on a test network with
  play money."*

### Final week (23–29 September) — record and submit

**Step 11 — Record the demo video** against the **live public site**, not your laptop. Follow the
shot list already written in `docs/demo-runbook.md`. Add two new shots: the identity line on an
agent page, and the season paying out.

**Step 12 — Update the submission.** Tick **Finance & Commerce** as a third track once the joining
fee exists. Add the settled-season transaction link. Add two rows to *"what we deliberately did not
build"*: the interest-as-income arithmetic, and that Lista DAO has no test network.

**Step 13 — Leave two days of slack.** Something will break.

---

## If you only have time for three things

1. **Claim some agents** so a season can actually pay out.
2. **Show ERC-8004 on the agent page** — two hours, biggest visible gain.
3. **Seed the pool and run one tournament that settles before the deadline.**

Everything else is optional. Those three turn "we built a lot" into "here, look."

---

## What to keep saying no to

| Proposal | Why not |
|---|---|
| **Buy a power-up card (pay-to-win)** | Breaks your fairness proof **silently** — the blockchain keeps signing games it can no longer verify, because a bought card was never in the shuffled deck. Also needs editing the borrowed game engine, which your own rules forbid. Issue #33 rejects it in its own title. |
| **Humans playing** | A second product, not a feature. The website is deliberately watch-only, no browser can play, and it removes the one thing that makes you different. |
| **Paid rebuys that get more expensive** | Either they buy nothing (your ranking already subtracts rebuys), or **money buys leaderboard position**. The leaderboard is the product. |
| **Taking 5% of the entry pool** | Earns about **$20 a month**. Not wrong, just not worth a week of 21 days. And send fees to the treasury, never into the prize. |
| **Human spectators betting** | Needs a crowd you do not have. Most rounds would have one bettor and be refunded. |
| **Skins, avatars, custom names** | Each is a whole project. After the hackathon. |
| **Fake USDT prizes** | A prize you can print for free is a worse answer than the real test currency you already pay. |
| **Card scoring rules (#33 comment)** | **Already built, exactly as described**, tie-splitting included. Close it as done. |
| **The savings vault (spec 24)** | The one real "maybe". It adds a visible outside integration, which scores — but it is one to two weeks and earns $1.32 a week. Only if steps 1–10 are genuinely finished. |

---

## The honest summary

Last week the problem was that nothing was shipped. **You fixed that** — production is live with
verified contracts and real on-chain identities, which is more than most of the field will have.

The problem now is smaller and more specific: **the good parts are still invisible or empty.**
Identity works but no page shows it. The contracts are live but hold no money. The leaderboard
works but is topped by your own test bots.

None of that needs new design. It needs a few hours of plumbing, one operator command, and one
season that finishes on time.
