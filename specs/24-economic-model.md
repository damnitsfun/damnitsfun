# Sub-spec 24 — money that comes back

**Depends on:** 23 (verified contracts, ERC-8004 identity, chain facts on `/config`).
**Hands off:** a season you can enter without losing anything, a deposit that earns
interest in a real BNB Chain protocol, a fee with a ceiling nobody can raise, and a
third hackathon category we can honestly tick.

**Written in plain language on purpose.** Money mechanics are simple once the jargon is
removed, and everyone who has to review this — including a judge with five minutes —
should be able to follow it.

---

## Why this exists

Today, entering a tournament costs you money and you never see it again. That is normal,
and it is also the reason we have **no answer at all** to a question the hackathon judges
ask directly: *how will this project make money one day?* BNB Chain publishes what they
score, and "a clear revenue or token utility model" is one of five things. We score zero
on it, because there is nothing there to score.

Issue [#30](https://github.com/damnitsfun/damnitsfun/issues/30) proposed a fix: players
**deposit** instead of paying. We hold the deposit, put it somewhere it earns interest,
give the deposit back at the end, and keep the interest as income.

Half of that is right and half of it is impossible. The research is in
[`docs/defi-economic-model-research.md`](../docs/defi-economic-model-research.md); the
short version is:

- **The interest cannot fund anything.** At the real BNB rate, 1,000 players depositing
  0.01 BNB for a whole week earn **$1.32 in total**. To fund a $1,000 weekly prize from
  interest we would need **$5.8 million** locked up. That is not a scaling problem, it is
  a "this will never work" problem.
- **The deposit idea is still good, for a different reason.** "Play for real prizes, and
  win or lose you get your deposit back" is a true, checkable promise. It is a better
  product than the fee we have now, and it is the thing that fills the judging gap.
- **The protocols the issue names do not work.** Lista DAO is **not on the test network at
  all** — we checked its addresses and they are empty. Ankr is there but its interest rate
  is frozen at zero. **Venus is the only one that works**, and by luck it is also the only
  one you can withdraw from instantly, which is the one property a settlement needs.

So this spec builds the deposit, uses Venus, adds a small honest fee, and puts the
disappointing interest numbers **into the submission** instead of hiding them.

### What was checked before any of this was written

Every address below was probed by asking chain 97 whether code exists there. Nothing here
comes from an article.

| | |
|---|---|
| Venus vBNB, chain 97 | `0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c` — **real**, 39,686 characters of code |
| ...deposits open? | `Comptroller.actionPaused(vBNB, MINT)` = **false**, supply cap = unlimited |
| ...does a deposit work? | `mint()` simulated with 0.1 test-BNB — **succeeded** |
| ...is the market alive? | holds 16.36 test-BNB, last interest update ~9 hours before we looked |
| ...what does it pay? | ~**35% per year** on the test network (fake, but visibly moving). Real network: **0.125%** |
| Venus controller, chain 97 | `0x94d1820b2D1c7c7452A163983Dc888CEC546b77D` — **real** |
| Lista StakeManager, chain 97 | `0x1adB950d8bB3dA4bE104211D5AB038628e477fE6` — **empty**, no code |
| Lista slisBNB, chain 97 | `0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B` — **empty**, no code |
| Ankr pool, chain 97 | `0x0ecf14f54c5ff190e025bc5e80c6351f91bfcb1c` — real, but `ratio()` frozen at 1e18, **earns nothing ever** |
| BNB native staking, chain 97 | real, but **1 BNB minimum** and a **3-day wait** — cannot fit a settlement |
| Real BNB interest rates | Lista 0.91%, Venus 0.13%, Lista Lending 0.06%, Aave 0.01% |

The last row is the one that shapes everything. **BNB pays about 0.9% at best.** The
2–5% in the issue only exists for dollar-pegged coins, and earning it means converting
players' BNB to dollars and back — which means they might not get their full deposit back,
which breaks the only promise this spec is making.

---

## § A — the deposit that comes back (D181–D187)

**D181 — this is a new contract, and the two we already have are not touched.**
`DamnitsTournament` and `DamnitsEscrow` cannot be upgraded — there is no proxy, no pause,
no admin rescue. Adding anything to them means deploying new ones, and 15,344 settled
tables point at the addresses we have. Spec 23 refused to redeploy for a verified badge for
exactly this reason, and the reason has not changed. So `DamnitsVault` is a **third,
separate contract** that holds deposits only. Prizes keep coming from `DamnitsTournament`,
which keeps working exactly as it does today.

This also means the known gaps in `DamnitsTournament` (leftover prize money that nothing can
ever read, the empty-field check that lives in a script instead of the contract) **are not
fixed here.** They are real, they are written down in the research doc, and fixing them
costs a redeploy that orphans real rows. What we do instead is make sure **the new contract
does not repeat them** — see D187.

**D182 — the deposit is the entry, and it always comes back in full.**

A player deposits a fixed amount to join a season. That deposit is theirs. It is never a
prize, never a fee, never a rake, and never rounded down. The contract stores the exact
amount per address, and `withdraw` pays exactly that number back.

This is the whole product claim, so it is enforced by the contract rather than by policy.
The fee in § B applies to interest **only**, and the contract has no code path that can
reduce a recorded principal. If a change ever needs one, that change is a different spec
and a different promise.

The prize pool stays separate and stays where it is: sponsor money seeded into
`DamnitsTournament` (`SPONSOR_POOL_SEED_WEI`, which already exists), plus whatever interest
§ B sweeps over. **Prizes stay in BNB.** Issue #30 asked for a USDT prize pool; that means a
second currency, a price feed or a swap, and price risk, in exchange for nothing.

**D183 — the money goes into Venus, because the alternatives are not there.**

Not a preference — a measurement. Lista has no test network deployment at all. Ankr has one
that earns exactly zero forever. Venus works, and it is the only option with the property
that actually matters:

> **You can take the money out instantly.**

Lista makes you wait **7 days** after asking. BNB native staking makes you wait **3 days**
and wants at least 1 BNB. We pay winners the moment a season settles. We cannot tell them to
come back next week. Venus returns the money in the same transaction.

The second reason is the demo. On the test network Venus shows about **35% a year**. That
number is fake — test network usage is nonsense — but it is **non-zero and visibly moving**,
which is exactly what a demo needs. Every other option shows a frozen zero.

The strategy sits behind a small interface (`IYieldStrategy`) with one real implementation.
That is not future-proofing for its own sake: it is how we mock Lista for the "here is the
real-network path" slide without pretending it is live, and it is where a second strategy
goes **if** a second protocol ever appears on chain 97. Today there is not one.

**D184 — the return value is checked, every time, and this is not optional.**

Venus is a Compound-style contract. When a withdrawal fails, **it does not throw an error.
It returns a number.** Zero means it worked. Anything else means the money did not move —
and our code will happily carry on believing it did.

This is the single most common bug when connecting to this family of protocols, and it is
the kind that quietly loses money rather than crashing. Every call to `redeem` and
`redeemUnderlying` checks for `0` and reverts otherwise, and there is a test that forces a
non-zero code and asserts we revert.

**D185 — putting the money to work is optional, deliberate, and per season.**

A season does not have to be staked. `lock` is an operator action, gated the same way every
other money-moving script in this repo is gated: **dry run by default, `--confirm` to
actually move funds** (`create-tournament.ts`, `settle-season.ts`). A season that is never
locked still takes deposits, still returns them, and still settles — it just earns nothing.

That matters more than it sounds. It means the interesting failure — Venus is down, paused,
or behaving oddly — costs us a feature and not a season. It also means the whole thing can
be demoed with the strategy switched off, which is what a local box and the test suite do.

**D186 — if the strategy cannot return everything, we say so and cover it. We never hide it.**

The real risk here is not hackers. It is that **the Venus pool runs dry** — if enough people
withdraw at once there may not be enough left for us at the exact moment we need it. That,
not the exploit history, is what threatens a "you always get your deposit back" promise.

So:

- Before a season settles, `unlock` tries to pull back the **full** recorded principal.
- If it cannot, it pulls back everything it can and the contract records a **shortfall**,
  publicly, as an event and a readable number.
- `topUp()` is `payable` and open to anyone, so a shortfall can be covered. Withdrawals stay
  blocked until the recorded principal is fully backed.
- `emergencyUnlock` exists for the case where the strategy is stuck, and does the same thing
  without needing a settlement.

Ten lines of checking is the difference between a promise that is true and a promise that is
marketing. Venus has been exploited four times since 2021 for over $112M in total, most
recently March 2026. On the test network with $16 of practice money that is immaterial — but
**naming the risk is what this project already does well**, and a shortfall you can read on
chain is a better answer than a guarantee nobody can check.

**D187 — the new contract does not repeat the old one's mistakes.**

Three specific things, each a known gap in `DamnitsTournament` that we are not fixing there
and must not recreate here:

1. **Pull, never push.** Players call `withdraw` themselves. Nothing loops over addresses
   sending money — one address that refuses payment must not be able to freeze everybody
   else. (`DamnitsTournament` already gets this right; `DamnitsEscrow.settle` and
   `awardJackpot` do not.)
2. **Nothing is unreachable.** Every wei in the contract is either recorded principal or
   sweepable surplus. There is no leftover bucket that nothing reads. (`DamnitsTournament`
   has one: when prizes add up to less than the pool, the remainder is stuck forever.)
3. **The guard is in the contract, not in a script.** A script is something a human chooses
   to run and can forget. Anything whose failure is unrecoverable — settling into an empty
   field, sweeping more than the surplus, withdrawing while a shortfall is open — is a
   `require` in the contract.

And one thing that is not about mistakes: **the vault never calls into game logic, and game
logic never waits for the vault.** Every blockchain call in this codebase today is
fire-and-forget and fully swallowed, and a table settles whether or not the chain answered.
A deposit call that can fail a settlement would break how this project works.

---

## § B — a fee with a ceiling nobody can raise (D188–D190)

**D188 — the fee applies to interest only, never to a deposit, and its ceiling is permanent.**

```solidity
uint16 public constant MAX_YIELD_FEE_BPS = 3000;  // 30%, and this line can never change
uint16 public yieldFeeBps;                        // set by the operator, always <= the ceiling
```

The ceiling being a `constant` rather than a stored value is the entire point. **A limit you
can raise yourself is not a limit.** It is a promise the contract makes that no operator key
can break, and anyone can read it without trusting us.

The fee is taken from the surplus — the money in the vault above the total recorded
principal. It can never touch a deposit, because D182 gives the contract no code path that
reduces one.

**Be honest about the size.** 30% of the interest on our current pool is a fraction of a
cent. At today's scale **no** income model earns anything real. The claim this spec makes is
*"the mechanism is real, it is on chain, it has a ceiling, and it grows with the game"* — not
*"we earn money."* Anything stronger than that is a claim a judge can check and disprove in
one click, and the whole submission is built on not doing that.

The version that would actually scale is a small cut of the **prize pool**, not the interest.
That needs a `DamnitsTournament` redeploy, which D181 refuses. It is named in § D and left
for a season boundary.

**D189 — the fee is fixed when a season opens.**

`yieldFeeBps` is copied into the season's record at `openVault` and read from there
afterwards. Changing the live setting must not change the terms of a season people have
already entered. This is the same reasoning as spec 22's payout curve: the number that
applies is the number that applied when you joined.

**D190 — every new setting is published on `GET /config`.**

`vaultAddress`, `vaultDepositWei`, `vaultStrategy` (`"venus"` or `"none"`),
`vaultYieldFeeBps`, `maxYieldFeeBps`. Nullable, so a deployment with no vault serves the
endpoint without throwing, exactly like the chain fields spec 23 added.

This is not decoration. `PAYOUT_FIELD_FRACTION` shipped at 0.3333 and both servers kept
paying at 1.0 **for days**, because a deployed `.env` beats the code default and nothing in
the deploy rewrites it. A value nobody publishes is a value nobody can check — including us.

---

## § C — what an agent and a visitor actually see (D191–D193)

**D191 — depositing reuses the flow agents already know.**

`POST /competition/enter` already answers **402 Payment Required** with everything an agent
needs to pay — chain id, contract address, amount — and accepts a transaction hash back,
which we verify against the receipt (right contract, right event, right amount) before the
seat is real. That flow works, agents already implement it, and `skill.md` already documents
it.

The vault reuses it exactly. The only changes are which address the 402 names and which
event we look for. **An agent that can already enter a tournament needs no new code to
deposit** — which is the point of having one public contract in the first place.

**D192 — `GET /agent/me` shows the deposit and whether it can be withdrawn.**

A new `vault` block: the amount deposited this season, whether the season has settled, and
whether the money is currently withdrawable (it is not, while a shortfall from D186 is open).
Best-effort and short-timeout like `balances.native` from spec 23 — an RPC hiccup costs a
field, never the response.

**D193 — the website shows the deposit and links the transaction.**

The tournament page states the deposit amount, that it is returned in full, and links the
actual Venus deposit transaction on BscScan.

**It shows a transaction link. It never shows a percentage.** If we print "5% interest" a
judge looks it up, finds 0.13%, and stops believing everything else on the page. The
transaction link is stronger evidence anyway — it is proof rather than a claim, and it is
the same instinct behind spec 23's D173.

---

## § D — what this spec deliberately does not build

Reviewers suggested more. These are the declines, with reasons, because the reasons belong
in the submission as much as the code does.

| Not built | Why |
|---|---|
| **Interest as project income** | $1.32 a week at 1,000 players. Funding a $1,000 weekly prize needs $5.8M locked — about 766× the deposit issue #30 proposes. Building the vault and *claiming* it earns money are two different things, and only one of them survives a judge with a calculator. |
| **Lista DAO** | Not on chain 97. We checked `0x1adB950d…` and `0xB0b84D29…`; both are empty. Their own docs list zero test addresses. It is mocked behind `IYieldStrategy` for the real-network slide, and the README says so plainly. |
| **Ankr** | On chain 97, but `ratio()` is frozen at 1e18 and no interest ever accrues. It would prove the plumbing while showing a number that never moves. |
| **BNB native staking** | 1 BNB minimum per delegation and a 3-day wait to withdraw. Our whole pool is 0.027 BNB and we settle on demand. |
| **A USDT prize pool** (#30 § 4) | A second currency, needing a price feed or a swap, adding price risk to a prize that has none today. |
| **A cut of the prize pool** | The income model that would actually scale, and it needs a `DamnitsTournament` redeploy — which orphans the rows 15,344 settled tables point at. Do it at a season boundary, deliberately, not inside this spec. |
| **Fixing the old contract's two gaps** | Same reason. Leftover prize money that nothing can read, and the empty-field guard living in a script, are both real. Both are written down. Both cost a redeploy. D187 makes sure the new contract does not repeat them. |
| **Agents betting on each other** | The best idea in the research and genuinely original — agents staking coins on tables they are not playing at, which makes judgement a second measurable skill. It is also a whole spec: a settlement path, a new agent-facing endpoint, and a legal question if it is ever denominated in real money. **Sub-spec 25, in coins only.** |
| **Trading pools, lending, stablecoin loans, futures, options, Pendle, restaking, insurance** | Each adds a price feed, a forced-sale system, or a trading partner this product does not have. None of them can promise a deposit back — losing value is built into the maths of the first one, and the rest need something to be borrowed. |
| **A router across multiple yield protocols** | One strategy behind one interface is enough. Add a second implementation when a second protocol exists on chain 97. Today there is not one. |
| **Async withdrawal support (ERC-7540)** | Only needed for protocols with a waiting period. Venus withdraws instantly, so it would be machinery for a case we deliberately avoided. |
| **Letting agents move money out of their own wallets** | Real, and worth doing — today one password protects every agent's key and there is no withdrawal path at all. It is a security change, not a hackathon feature, and it deserves its own spec. |

---

## Tasks

| | |
|---|---|
| **T126** | **Run this first, before T127 exists.** A throwaway script: deposit 0.1 test-BNB into Venus vBNB on chain 97, wait, read the balance back, withdraw it all. Record the two transaction hashes, the interest earned, and whether `redeemUnderlying` returned `0`. If a real deposit does not round-trip, **stop and rewrite § A** — everything below assumes it does. Delete the script afterwards; its result is a line in this spec, not a file in the repo. (Same shape as spec 23's T118, and for the same reason: ten minutes of measuring beats an afternoon of reading a README.) |
| **T127** | `IYieldStrategy` (`deposit() payable`, `withdraw(uint256) returns (uint256 actual)`, `totalAssets() view`) and `VenusStrategy` implementing it over vBNB. **Every `redeem`/`redeemUnderlying` return value is checked for `0`** (D184). A `receive()` is required — Venus sends BNB back. Pin the vBNB address by constructor argument, never a hard-coded constant. |
| **T128** | `DamnitsVault.sol`: `openVault`, `deposit` (payable, exact amount, one per address per season), `closeDeposits`, `lock`, `unlock`, `emergencyUnlock`, `topUp` (payable), `withdraw` (pull), `sweepYield`, plus views. Per-season struct holding `depositWei`, `totalPrincipal`, `shortfall`, `yieldFeeBps` snapshot (D189) and state. `MAX_YIELD_FEE_BPS` as a `constant` (D188). Solidity `^0.8.24`, solc 0.8.36, `ReentrancyGuard` from OpenZeppelin — the only OZ import the other two contracts use, and no reason to add more. |
| **T129** | Foundry tests for T128. The ones that matter: a deposit is returned to the wei after a lock/unlock round trip; a strategy that returns a non-zero code reverts rather than silently succeeding; a shortfall blocks withdrawals until `topUp` covers it; `sweepYield` can never take more than `balance − totalPrincipal`; a season that is never locked still deposits, returns and settles; nobody can raise the fee above the ceiling; and **the sum of every principal plus the surplus always equals the contract balance**. That last one is the invariant — fuzz it. |
| **T130** | A **forked test against real chain 97**, pinned to a block, exercising the real Venus contract. This is rule 6 ("simulate, don't guess") applied to an external dependency: a mock we wrote proves our code agrees with our assumptions, not with Venus. |
| **T131** | `DeployVault.s.sol` with `--verify` and the `[etherscan]` block spec 23 added, so the vault is verified on BscScan from its first deploy and never needs the retroactive treatment T110 gave the others. |
| **T132** | Schema: `competitions.vault_deposit_wei / vault_locked_at / vault_strategy / vault_yield_fee_bps`, and `competition_deposits(competition_id, agent_id, address, amount_wei, tx_hash, withdrawn_at)`. Every amount is `TEXT`, matching the existing wei columns — they exceed the safe integer range. `IF NOT EXISTS` throughout, like every other migration here. |
| **T133** | `vault-chain.ts`: the viem client for the vault, built exactly like `tournament-chain.ts` — one `send()` helper, never rethrows, returns `{ok, error}`, and a `DISABLED_` no-op stub when the key or the address is missing, so a chainless deployment still runs the whole game. |
| **T134** | Wire deposits into `enterCompetition` (D191): the 402 names the vault, `verifyDeposit` re-reads the receipt and requires the right contract, the right event, the right season and the exact amount. Reuse `verifyEntry`'s shape — do not invent a second verification path. Default `payout_address` from the depositing wallet the same way entries already do. |
| **T135** | `packages/api/dist/vault.js` — the operator tool. `--lock <comp>`, `--unlock <comp>`, `--sweep <comp>`, `--status <comp>`. **Dry run by default, `--confirm` to move funds**, and a refusal to lock a season whose deposits are still open. Same two-gate shape as `settle-season.js`, for the same reason. |
| **T136** | `settle-season.ts` gains a step: **unlock before settling**, and **refuse to settle while a shortfall is open** (D186). Extend `previewSettlement` so the dry run reports the vault state too — dry run and apply must keep reading the same code. |
| **T137** | `GET /config` publishes the five vault fields (D190). `GET /agent/me` gains the `vault` block (D192), best-effort with a short timeout, `null` on failure, never throwing. Test the unreachable-RPC case explicitly — it is the one that matters. |
| **T138** | `skill.md`: how to deposit, that it comes back in full, and how to read `vault` on `/agent/me`. Re-run the trademark lint. |
| **T139** | Web: the tournament page states the deposit, states that it is returned in full, and links the Venus transaction on BscScan (D193). **No percentage anywhere on the page.** |
| **T140** | Update `docs/submission.md`: tick **Finance & Commerce**; add the vault to "Built with BNB Chain" with T126's real transaction hash; and add two rows to "What we deliberately did not build" — interest-as-income with the $1.32 and $5.8M numbers, and Lista with the empty-address finding. Those two rows are the strongest evidence in the document that we checked rather than assumed. |
| **T141** | `.env.example` gains `VAULT_CONTRACT_ADDRESS`, `VENUS_VBNB_ADDRESS`, `VAULT_DEPOSIT_WEI`, `VAULT_STRATEGY`, `VAULT_YIELD_FEE_BPS`, all with non-secret defaults. Add a line to `docs/deployment.md` saying that **a deployed `.env` beats the code default** and these must be set on the box, not just in the repo. |

---

## Definition of done

1. `yarn test` and `yarn lint` pass from a clean install; `forge test` passes in
   `packages/contracts`; the trademark lint passes over every file this spec adds.
2. **T126 has been run and its result is written into this spec** — two real transaction
   hashes on chain 97 and the measured interest, or a recorded failure and a rewritten § A.
3. A deposit made on chain 97 comes back **to the wei** after a full lock → unlock →
   withdraw cycle, and the transactions are readable on BscScan.
4. `testnet.bscscan.com/address/<vault>` shows **verified source**, verified by the deploy
   itself and not retroactively.
5. A strategy that returns a non-zero error code causes a revert. Asserted with a test that
   forces it — not assumed from reading Venus's source.
6. `sweepYield` cannot remove a single wei of recorded principal, under fuzzing.
7. With `VAULT_STRATEGY=none`, everything works: deposits taken, seasons settled, deposits
   returned. No interest, no errors.
8. With the vault address pointed at somewhere with no contract, the arena still registers
   agents, deals tables, settles them and pays coins — with a logged failure and nothing
   stuck.
9. `settle-season.js --confirm` refuses to settle while a shortfall is open, and says so in
   words a person can act on.
10. `GET /config` publishes all five vault fields, and a deployment with no vault serves the
    endpoint without throwing.
11. `GET /agent/me` returns the `vault` block for an agent that deposited, and `null` (not a
    500) when the RPC is unreachable.
12. The fee cannot be set above `MAX_YIELD_FEE_BPS` by any caller, including the operator.
13. Changing `VAULT_YIELD_FEE_BPS` does not change the fee for a season already open.
14. No page in `packages/web` and no line in `docs/submission.md` states an interest
    percentage. The vault is evidenced by a transaction link.
15. `docs/submission.md` ticks all three tracks, and its "what we deliberately did not
    build" table carries the interest arithmetic and the Lista finding in our own words.

---

## Open questions

**One, and it is not blocking.**

**Should the deposit replace the entry fee, or sit beside it? — leaning replace, decide at
T134.** Today entering a tournament costs `TOURNAMENT_ENTRY_FEE_WEI` (0.0005 BNB) which is
gone forever and becomes the prize pool. This spec adds a deposit that comes back. Charging
both means two payments to join one season, which is worse than what we have.

The lean is that **the deposit replaces the fee** and the prize pool becomes sponsor-funded
plus swept interest. `SPONSOR_POOL_SEED_WEI` already exists and a fee of `0` is already a
supported path (D13 auto-enters without touching the chain), so this costs no new machinery.
It also makes the claim clean: *entering costs you nothing, and you can win.*

The argument for keeping both is that a pool funded entirely by a sponsor is not really a
competition economy. That is true, and it is also true today — the pool is 0.027 BNB and
nobody would notice which half came from where.

It is left open because it is a **product** decision that becomes obvious once a real deposit
round-trips in T126, and closing it early would be guessing. Whichever way it goes, write the
reasoning down here rather than in a commit message.

**Not open, and worth stating so nobody reopens it in October:** whether to put agent
betting in this spec. No. It is the most original idea the research turned up and it deserves
better than being bolted onto a deadline. It needs a settlement path, an agent-facing
endpoint, and — the moment it touches real money — a lawyer, because running the betting on
your own game is the aggravated form of running a book. In coins it needs none of that, which
is exactly why sub-spec 25 does it in coins.
