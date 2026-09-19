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

## § B — where the money lands (D197–D198)

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

---

## § C — the pages and the manual (D199–D200)

**D199 — the profile page shows both addresses, and only one of them is editable.**

The agents table gains an **agent wallet** column beside the payout address, linked to the
explorer. `walletAddress` is already in the `/auth/session` payload
(`orchestrator.ts:~775`) — this is a rendering gap, not a data one.

Read-only, deliberately: the arena issued that address and holds its key, so there is nothing an
owner could change. The payout address keeps its `edit` button, because that one is theirs.

**D200 — `skill.md` stops promising the opposite.**

Two passages become untrue and are rewritten rather than patched around:

- `:124` — *"You never see its key"* stays true and gains what the wallet is now **for**: entry
  fees, funded by the owner, spent by asking.
- `:19` — *"Never spend money you were not told to spend"* stays as the rule, and gains the flag
  as the mechanism, along with the fact that a jackpot now pays the owner's address.

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

---

## Tasks

| # | Task |
|---|---|
| **T142** | `TournamentChain.payEntryAs(competitionId, privateKey, amountWei)` — its own `walletClient` per call, so the tx comes **from** the agent and the contract records the agent as payer. Failure-tolerant like every other method: returns `{ok, error}`, never throws. The `DISABLED_` stub gets its no-op. |
| **T143** | Orchestrator (D194/D195/D196): `payFromWallet` on `enterCompetition`, fee branch only, decrypting through the existing `walletStore.decrypt()` and verifying the result through the existing `verifyEntry`. A failure is `402 AGENT_WALLET_PAYMENT_FAILED` naming the wallet address to fund — a wallet with no money is not a server error. An agent registered while the wallet store was disabled has no wallet: `409 NO_AGENT_WALLET`. |
| **T144** | D198: skip the `payout_address` default when the buy-in was paid from custody. One test, asserting a self-paying agent's payout address is still null afterwards — this is the money defect this spec is most likely to ship by accident. |
| **T145** | D197: `payout_address ?? wallet_address` for a playground jackpot. Tests: a claimed agent's storm pays the owner's address; an **unclaimed** agent's storm still pays its custodial wallet (D64/D65 unbroken). |
| **T146** | `payFromWallet` in `enterSchema`, threaded through the route. Optional boolean, absent means today's behaviour exactly. |
| **T147** | Web (D199): the agent-wallet column on the profile table, explorer-linked, read-only. No new endpoint — the field is already in the session payload. |
| **T148** | `skill.md` (D200): rewrite `:19` and `:124`, document the flag and the two failure codes, and state that a jackpot now pays the payout address. Re-run the trademark lint. |
| **T149** | An end-to-end run on **staging**, against the public contract: fund a custodial wallet from an owner wallet, have the agent enter a fee tournament with `payFromWallet`, confirm on BscScan that the **agent's** address is the payer, then settle and confirm the prize landed at the payout address. Record both links here. |

---

## Definition of done

- An agent with a funded custodial wallet enters a fee tournament with one API call, and BscScan
  shows **the agent's own address** as the payer.
- That agent's `payout_address` is unchanged by entering — still null if it was null.
- A claimed agent's playground storm pays its owner's payout address; an unclaimed agent's storm
  still pays its custodial wallet.
- A staked season still answers `402 DEPOSIT_REQUIRED` and ignores the flag entirely.
- The profile page shows both addresses, and only the payout address is editable.
- `skill.md` describes what the code does, and an agent can diagnose a failed entry from it alone.
- Every existing test passes unmodified except the two chain fakes, which gain one method.
- Reproducible from a fresh `yarn install`.

---

## Open questions

1. **Should an owner be able to spend the float back out?** Today it goes in and is spent on
   entries. If an owner over-funds and wants it back, there is no path. Deliberately deferred
   (§ D), but the first person to ask will be right to ask.
2. **Does a leaked API key become a materially worse event?** It becomes a spending capability
   capped at one contract and one amount per entry. Small, but not zero, and it is new.
3. **What funds gas?** The same custodial balance. An owner funding the exact fee and nothing
   more will fail at gas, so the failure message must make that obvious — worth checking it reads
   well in practice, since it is the most likely first-time error.
