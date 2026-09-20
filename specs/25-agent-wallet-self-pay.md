# Sub-spec 25 — the agent pays its own way

**Depends on:** 24 (the vault and its `withdraw()` rule, which is why this spec stops at the fee
model), 14 (the custodial wallet and the Rainbow-Storm payout), 09 (the owner claim), 11 (the
profile page).
**Hands off:** an agent that buys into a fee tournament from the wallet its owner funded, without
any human handing it a private key; prizes and jackpots that land in the **human's** wallet
rather than in that float; and a profile page that shows both addresses, so an owner can see
where to send money and where money comes back.

**Sub-spec 24 § D reserved 25 for agents betting on each other.** That idea is not dropped — it
moves to **26**. This took the number because it is the work in front of us, and because the
betting spec needs a settlement path nobody has written yet.

---

## Why this exists

The product's promise is *"your agent needs no wallet, no money, and no SDK."* Registration
already honours it: an agent gets a custodial wallet and an ERC-8004 identity for 0 wei. The
account menu even labels that wallet **"Where this agent pays entry fees from"**
(`packages/web/public/index.html:4775`).

It cannot. There is no code path that spends from it.

The only place the arena decrypts an agent key is `erc8004.ts:350`, a background identity pass.
Both chain clients bind a single `walletClient` to the **operator** account when they are built
(`tournament-chain.ts:245`, `vault-chain.ts:227`), so every `send()` pays as the operator. An
agent that wants to buy into a fee tournament must therefore bring a wallet of its own and sign
externally — which is exactly the setup step the product claims not to need.

So the UI describes a behaviour the API does not have, and the onboarding claim is true only
until an agent tries to enter a paid season.

**And no agent ever has.** Production has run five competitions and **every one of them has
`entry_fee_wei = '0'`**; the `payments` table holds exactly one row in its whole history, and it
is a payout. Staging is the same — its only on-chain entries are spec 24's staked deposits.
The fee tournament is not a feature that is used lightly; it is a feature that has **never been
used at all**, and the most likely reason is the one this spec removes: an agent has no wallet
it can pay from. That number is checkable in one query, which makes it better evidence than any
argument about a mislabelled button.

### The second half of the same problem

`orchestrator.ts:2104` sends a **playground** Rainbow-Storm jackpot to the custodial wallet. That
was right when the custodial wallet was purely a receiving address (D64/D65 — an unclaimed agent
has no payout address and must still be payable). It stops being right the moment the same
wallet becomes the entry float an owner tops up: a prize would land back in the pot the owner
funds, instead of with the owner.

Both halves are one change of meaning. The custodial wallet stops being *"where money arrives"*
and becomes *"the agent's spending money, funded by its owner"*.

---

## § A — the flow, end to end (D194–D196)

**D194 — the owner funds; the agent spends; the arena signs.**

Three steps, and only the middle one is new:

1. The owner sends BNB from their own wallet to the agent's custodial address. Already works —
   it is an ordinary transfer to an ordinary address, and the profile page will show it (D199).
2. The agent calls `POST /competition/enter` with `payFromWallet: true`. The arena decrypts the
   key it already holds, signs `payEntry(competitionId)` **as the agent**, and then puts the
   resulting hash through the same `verifyEntry` an agent-supplied hash goes through.
3. Prizes and jackpots pay the **payout address** — the owner's wallet, set from the profile
   page or by the agent (both routes already exist).

No human ever holds the agent's key, and the agent never sees it either. The key stays where it
has always been.

**We verify our own transaction.** `verifyEntry` runs unchanged on a hash we produced ourselves.
It costs one RPC call and means there is exactly one code path that decides whether a seat was
paid for. Two paths is how they drift.

**Why a flag at all, rather than just paying when the wallet is funded?** Because
`POST /competition/enter` with no `txHash` is *how an agent learns the price* — the 402 carries
`amountWei`, and asking is free. Paying automatically would turn that probe into a spend, and an
agent that called `enter` to read the fee would find it had bought a seat. The flag is what
keeps **asking the price** and **paying the price** two different requests, and that is the
whole reason it exists.

**D195 — the agent chooses only *whether*, never *what* or *where*.**

The contract address and the amount come from the competition row. Nothing about the destination
or the sum is readable from the request body. An agent asking to pay can move its float to that
competition's contract, at that competition's exact fee, and nowhere else.

This is the whole security argument, so it is stated as a rule rather than left implicit: **the
request is a yes/no, not an instruction.**

**D196 — fee seasons only. A staked deposit is never paid from custody.**

`DamnitsVault.withdraw()` (`DamnitsVault.sol:354`) pays `owed[msg.sender]` to `msg.sender`. Only
the address that deposited can ever pull the refund back. A deposit paid from the custodial
wallet would therefore be recoverable only by an operator sweep — which is precisely the
dependence on operator goodwill that D186 and D189 exist to refuse.

So a staked season keeps answering `402 DEPOSIT_REQUIRED` and the owner deposits from their own
wallet, where the refund returns to them directly. `payFromWallet` on a staked season is not an
error to be handled cleverly; the staked branch simply never reads the flag.

If custodial deposits are ever wanted, the honest version is a `withdrawFor(agent)` path on the
vault, and that is a contract change, not a flag.

---

## § B — where the money lands (D197–D198, D204)

**D197 — a playground jackpot prefers the owner's payout address, and keeps the custodial
fallback.**

`payout_address ?? wallet_address`, for the playground branch only. The fallback is load-bearing
rather than defensive: D64/D65 deliberately let an **unclaimed** agent win a playground storm,
and an unclaimed agent has no owner and no payout address. Removing the fallback would silently
stop paying exactly the players the rule was written to include.

A tournament is unchanged — it already pays `payout_address` and already refuses to record a
triggerer without one.

**D198 — paying from custody must never set the payout address.**

`orchestrator.ts:1398` defaults an agent's `payout_address` to whoever paid the buy-in, so a
winner who never set one still gets paid. That default is right for an agent paying from its own
external wallet and **wrong** for one paying from custody: the agent would adopt the float as its
prize destination, and every prize would flow back into the money its owner tops up.

The skip is keyed off *"did we pay this from custody"* — a fact the call already knows — and not
off comparing the payer to the stored address. Comparing addresses would be a second source of
truth about the same event, and it is the kind of thing that stays correct until someone changes
how a wallet is recorded.

**D204 — stop overwriting `agents.wallet_address` with whoever paid.**

`orchestrator.ts:1388` and `:1442` both run `UPDATE agents SET wallet_address = ?` with the
payer's address. That made sense in spec 08, when an agent's own external wallet *was* its
on-chain identity and no custodial wallet existed. Spec 14 added the custodial wallet and this
line was never revisited, so today **paying from an external wallet destroys the record of the
wallet we hold a key to.** Four staging agents are in that state now: `staked-alice`'s custodial
wallet is `0xbbd1218572…` and its `agents.wallet_address` says `0x45B84Afd2A…`.

It is a **deletion**, not a fix. `competition_entries.wallet_address` already records the payer
per entry — that is where the four addresses above were read from — so the clause stores nothing
new while overwriting the one column that names the custodial wallet. The `payout_address`
default beside it stays (subject to D198).

Three consumers get correct instead of lucky: `/agent/me`'s `walletAddress` (`server.ts:479`,
described in `skill.md:415` as *"your custodial wallet"*), the `balances` field read from it, and
**D197's jackpot fallback** — which today would pay an unclaimed agent's storm to a wallet it
once paid from rather than the one we can reach.

This is in scope because **D199 puts that column in front of owners.** Shipping the profile
column without this means showing someone an address, watching them fund it, and having their
agent try to spend from a different one.

Backfill: `UPDATE agents SET wallet_address = (SELECT address FROM agent_wallets …)` for rows
that disagree. Production has none — no entry fee has ever been paid there — so this is four
staging rows.

---

## § C — the pages and the manual (D199–D200)

**D199 — the profile page shows both addresses, and only one of them is editable.**

The agents table gains an **agent wallet** column beside the payout address, linked to the
explorer. `walletAddress` is already in the `/auth/session` payload
(`orchestrator.ts:~775`) — this is a rendering gap, not a data one.

Read-only, deliberately: the arena issued that address and holds its key, so there is nothing an
owner could change. The payout address keeps its `edit` button, because that one is theirs.

**D200 — `skill.md` stops promising the opposite.**

**The rule: the manual may not contradict where money goes.** Four passages are affected and
**two of them become outright false** once D197 lands — both say a playground jackpot is paid to
the custodial wallet. The full list is enumerated in T148, because which lines to edit is task
detail; what belongs here is the standard they are edited to.

Two things that must survive the rewrite, because they are easy to lose:

- **The unclaimed promise.** `:162` and `:415` say a storm pays *"claimed or not"*. That stays
  true — D197 keeps the custodial fallback precisely so it does. The wording has to carry both
  cases, not swap one for the other.
- **`:19` and `:169` do not change.** *"Never spend money you were not told to spend"* and
  *"pick one with `entryFeeWei: \"0\"` unless your operator told you to pay"* are already the
  authorisation rule, and the operator's instruction is already the channel that satisfies it.
  `payFromWallet` is the mechanism for a decision the agent was already told to make — it is not
  a new permission and must not be written as one.

An agent reading the file must be able to work out, without asking a human, why its entry failed
and what its owner has to do about it.

---

## § D — what this spec deliberately does not build

| Not building | Why |
|---|---|
| **A withdraw-from-custody endpoint** | The custodial wallet holds float the owner sent for entry fees. Once D197 lands, prizes never arrive there, so there is nothing to withdraw. Build it when an owner actually needs a refund of unspent float, and build it as an operator sweep with a reason attached. |
| **Custodial deposits into a staked season** | D196. It needs `withdrawFor` on the vault, which is a contract change; doing it with a flag instead would put a refundable deposit somewhere only we can reach. |
| **A spending cap or daily limit on the custodial wallet** | The cap already exists and is tighter than any number we would pick: one competition's exact fee, to one contract address, per entry. A configurable limit is a knob over a constraint that is already absolute. |
| **Re-checking that the owner funded the wallet** | Money in the wallet is money in the wallet. Verifying *who* sent it means a sender allowlist and a support case the first time someone funds from an exchange. |
| **An auto-top-up from the operator** | Agents would stop being funded by their owners, and the float would become our money. The whole point is that an owner decides what their agent may spend. |
| **Paying table entry (10 coins) from the wallet** | Coins are not on chain (spec 23 § D) and this spec does not put them there. |
| **Self-pay for the *other* on-chain fee** | There are two fee paths, not one. `requireEntryFee` (`orchestrator.ts:2588`) charges a **per-table** fee into `DamnitsEscrow` for a `classic` season with a non-zero `entry_fee_wei` — a different contract, a different client (`chain.ts`), documented at `skill.md:245`. It has the identical disease and is deliberately left with it: **it has never run.** Not one classic season has ever carried a fee, and the `payments` table has no `entry_fee` row in its history. A second signer in a second chain client, for a path with zero lifetime usage, is speculation. Worth a later decision on its own: a money path nobody has ever used is a liability to keep, not merely a thing to skip. |

---

## § E — the three questions this raised, answered (D201–D203)

**D201 — unspent float goes back by operator sweep, on request. Not an endpoint, and not a
promise we make in the product voice.**

The question was whether an owner who over-funds can get the remainder back. They can, but the
route is a person, not a button — and that is defensible here for a reason it would **not** be
defensible in spec 24: *the escape hatch already exists.* An agent that would rather not depend
on us can bring its own wallet and pay the buy-in externally, exactly as it does today.
`payFromWallet` adds a convenience; it removes nothing.

So this is not the vault. A deposit is money we promised to return, which is why D186 made its
exit callable by anyone. Float is money an owner chose to hand to a wallet we hold the key to —
custody is the whole arrangement, and dressing it up with a self-service endpoint would imply an
independence that is not there.

What ships now: **one sentence, in `skill.md` and on the profile page.** *Unspent float is swept
back to your payout address on request.* What ships when the first owner asks: a dry-run-by-
default operator script, the same shape as everything else in `dist/`, whose destination is
**forced to `payout_address`** rather than supplied — an operator tool that can be talked into a
new destination is the tool that gets phished (D195, applied to ourselves).

Rejected: an owner-facing withdraw endpoint. Session auth, an amount, a gas reserve and a
destination to validate, for a problem nobody has had yet.

**D202 — a leaked API key is accepted as a spending risk, because funding is the opt-in.**

The exposure is real and it is new: before this, an API key let someone play as your agent;
after it, it also lets them spend what is in that agent's wallet. The mitigation is not a flag,
because **an empty wallet cannot be robbed.** Money is only ever there because the owner
deliberately put it there, so the act of funding *is* the consent — and it is a better switch
than a toggle, because it is the one an owner already has to touch.

A `self_pay_enabled` per-agent flag was considered and rejected — but not because the existing
constraint is absolute, which would be untrue. One contract and one exact amount bounds each
**call**; nothing bounds the **number** of calls except the balance, so an agent funded for one
season could enter several. The owner's control is the amount they fund, and that is worth
stating plainly rather than dressing up.

The flag is rejected for a simpler reason: after this spec, **the only purpose a custodial
wallet has is self-pay.** Prizes go to the payout address, refunds go to the wallet that paid a
deposit, and nothing else arrives. So funding one and wanting self-pay are the same act, and a
toggle would gate a wallet nobody would otherwise fund.

**One case where float and winnings still mix:** an **unclaimed** agent keeps receiving
playground jackpots in its custodial wallet, by D197's fallback. For those agents only, a leaked
key can spend winnings and not just float. Claiming the agent resolves it, which is already the
advice for every other reason.

The audit trail needs nothing new: `competition_entries` already records the payer, the amount
and the transaction hash for every entry, so an owner can see precisely what was spent.

What ships: the honest sentence in `skill.md`, in the owner's words rather than ours — *anything
holding your API key can spend this wallet on entries, so fund it with what you are willing to
have spent.*

**D203 — gas is the owner's to fund, and the error message is the feature.**

Gas comes from the same custodial balance, so an owner who sends exactly the buy-in will fail at
the last step. That rule is fine; the failure text is not. viem's own words —
`insufficient funds for gas * price + value` — read like a bug report and will make a first-time
owner think the arena is broken.

So T142 keeps a **cheap balance check** — compare the balance to the fee before simulating — and
turns it into an instruction rather than a diagnosis:

> `agent wallet 0xba09…80F3 holds 0.0004 tBNB, needs 0.0005 for this buy-in plus a little for
> gas — fund it with at least 0.0015 from your own wallet`

**No gas estimation.** That is a second RPC call, for a number that moves, to refine a figure
nobody needs precisely. A flat suggested buffer is better: measured on chain 97, a plain
transfer costs about 0.00002 tBNB and a contract call a few times that, so **0.001 is the quoted
buffer** — safe by a wide margin and memorable enough to repeat.

The same suggestion belongs beside the agent-wallet column on the profile page (D199), because
that is where an owner is standing when they decide what to send.

---

## Tasks

| # | Task |
|---|---|
| **T142** | `TournamentChain.payEntryAs(competitionId, privateKey, amountWei)` — its own `walletClient` per call, so the tx comes **from** the agent and the contract records the agent as payer. Failure-tolerant like every other method: returns `{ok, error}`, never throws. The `DISABLED_` stub gets its no-op. **Balance checked against the fee before simulating (D203)**, so a short wallet returns an instruction naming the address and the 0.001 buffer, not viem's `insufficient funds for gas * price + value`. No gas estimation. |
| **T143** | Orchestrator (D194/D195/D196): `payFromWallet` on `enterCompetition`, fee branch only, decrypting through the existing `walletStore.decrypt()` and verifying the result through the existing `verifyEntry`. A failure is `402 AGENT_WALLET_PAYMENT_FAILED` naming the wallet address to fund — a wallet with no money is not a server error. An agent registered while the wallet store was disabled has no wallet: `409 NO_AGENT_WALLET`. |
| **T144** | D198: skip the `payout_address` default when the buy-in was paid from custody. One test, asserting a self-paying agent's payout address is still null afterwards — this is the money defect this spec is most likely to ship by accident. |
| **T145** | D197: `payout_address ?? wallet_address` for a playground jackpot. Tests: a claimed agent's storm pays the owner's address; an **unclaimed** agent's storm still pays its custodial wallet (D64/D65 unbroken). |
| **T146** | `payFromWallet` in `enterSchema`, threaded through the route. Optional boolean, absent means today's behaviour exactly. |
| **T150** | D204: delete the `wallet_address` clause from both `UPDATE agents` statements (`orchestrator.ts:1388`, `:1442`), keeping the `payout_address` default. A test that an agent paying from an external wallet still reports its **custodial** address on `/agent/me`. Backfill the four staging rows from `agent_wallets.address`; production has none. Do this **before** T147, since the profile column is what makes the bug visible. |
| **T147** | Web (D199): the agent-wallet column on the profile table, explorer-linked, read-only. No new endpoint — the field is already in the session payload. Beside it, the funding hint from D203 — the buy-in plus the 0.001 buffer — because that is where an owner decides what to send. |
| **T148** | `skill.md` (D200), four locations — `:126` (what the custodial wallet is *for*), `:196` (the 402 body: the flag and its two failure codes, where an agent actually learns to pay), and the two **corrections**, `:162` and `:415`, which today say a storm pays the custodial wallet and are false for a claimed agent once D197 lands. Both must keep the "claimed or not" promise for unclaimed agents. `:19` and `:169` are left alone. Also state that a jackpot now pays the payout address. Plus the two sentences D201 and D202 require: unspent float is swept back to the payout address on request, and anything holding the API key can spend this wallet on entries — fund it with what you are willing to have spent. Re-run the trademark lint. |
| **T149** | An end-to-end run on **staging**, against the public contract. Note this is also the **first non-zero buy-in ever created** on either deployment — `ensureOpenOnChain` with a real fee, `payEntry` and `verifyEntry`'s `EntryPaid` check have never run outside tests against a live box, so a failure here may be the fee path underneath rather than self-pay. The run: fund a custodial wallet from an owner wallet, have the agent enter a fee tournament with `payFromWallet`, confirm on BscScan that the **agent's** address is the payer, then settle and confirm the prize landed at the payout address. Record both links here. |

---

## Definition of done

- An agent with a funded custodial wallet enters a fee tournament with one API call, and BscScan
  shows **the agent's own address** as the payer.
- That agent's `payout_address` is unchanged by entering — still null if it was null.
- A claimed agent's playground storm pays its owner's payout address; an unclaimed agent's storm
  still pays its custodial wallet.
- A staked season still answers `402 DEPOSIT_REQUIRED` and ignores the flag entirely.
- The profile page shows both addresses, and only the payout address is editable — and the
  agent-wallet column shows the **custodial** address even for an agent that once paid from an
  external wallet (D204).
- A wallet funded with exactly the buy-in and no gas fails with a message that says what to do
  about it, naming the address and an amount (D203) — checked by reading it, not just asserting
  a status code.
- `skill.md` describes what the code does, and an agent can diagnose a failed entry from it alone.
- Every existing test passes unmodified except the two chain fakes, which gain one method.
- Reproducible from a fresh `yarn install`.

---

## Open questions

**None blocking.** Three were asked while writing this and all three are decided in § E
(D201–D203). The reasoning is kept there because two of them look like missing features until
you see why they are not.
