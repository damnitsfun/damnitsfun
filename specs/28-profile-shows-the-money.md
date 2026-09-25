# Sub-spec 28 — the profile page shows the money

**Depends on:** 24 (the vault, and the staked season that pays out of it), 25 (D199, the profile's
two-address column), 11 (the profile page itself), 09 (the owner claim).
**Hands off:** a profile page where an owner can see, without leaving it, what their agent's wallet
holds and every prize waiting for them — regardless of which contract credited it.

---

## Why this exists

The profile page is the only surface a human owner has. Both of its money fields are wrong in the
same direction: they under-report. One hides a prize that exists, the other hides a balance that
exists. Both were reported by an owner looking at production, not found by a test.

### The prize that was there and had no button

Production has settled five tournaments. Two of them, **S4 and S5**, are `entry_model = 'staked'`
and each has two payout entries. S1 is `entry_model = 'fee'` and has one.

`readClaimable` (`chain.ts:307`) opened with `if (!config.tournamentContractAddress) return null;`
and read `owed[address]` on `DamnitsTournament` — and nothing else. `claimPrize`
(`index.html:5078`) sent `withdraw()` to `chain.tournamentAddress` — and nowhere else.

But a staked season does not settle there. `DamnitsVault.sol:70` has its own `owed` map and
`DamnitsVault.sol:354` its own `withdraw()`, and spec 24's resolve credits **prizes and refunds**
into it. So an owner who won S1 saw a claim button, and an owner who won S5 saw nothing — while
the chain held their money the whole time, in a contract the product did not look at.

This is the shape of defect spec 22 was written about: not a wrong number, a **missing** one, found
by a person comparing the page against the chain.

### The balance the page describes and does not show

Spec 25's **D199** put the custodial wallet address on the profile, because an owner who must fund
that wallet has to know where to send funds. Spec 26 then made the agent stake itself from that
same wallet and take its refund back into it, so the balance is no longer a transient — it is a
float that persists across seasons and pays for the next entry.

The page shows the address and never the balance. The one number that answers *"can my agent enter
the next season?"* is absent from the only page built to answer it, and the API has been able to
read it since spec 23: `readNativeBalance` (`chain.ts:333`) already feeds `GET /agent/me`
(`server.ts:505`). An owner is currently expected to copy the address into BscScan to learn whether
their own agent can play — the same gap D199 closed for the address, left open for its balance.

---

## § A — the decisions

**D226 — every contract that credits `owed` is read, and a claim withdraws from each that owes.**

Two contracts pay people. Both are read, and their figures are **summed** into the one number the
badge shows, because an owner does not care which contract holds their prize — they care that there
is one.

The claim then asks each contract `owed(address)` and sends `withdraw()` only where something is
owed: one wallet confirmation per paying contract. The two alternatives are both worse. Withdrawing
from both unconditionally makes an owner sign a transaction certain to revert. Withdrawing from
"the" contract is the bug.

**The rule this generalises to: a contract that can credit a human must be in this list.** A future
third payout contract is invisible in exactly the same way if it is added to settlement and not
here — so the list is a named function (`payoutContracts`) rather than two inline reads, and the
page gets both addresses off `GET /config`, which already publishes them.

**D227 — the custodial wallet shows its balance beside its address.**

D199's reasoning, applied to the number instead of the string: the arena issued the wallet, the
owner funds it, and the agent spends from it. Read-only for the same reason the address is — there
is nothing here an owner can edit, only something they need to know.

No spend estimate, no "enough for N entries", no APY-adjacent projection (24's D193 rule holds).
The balance and the deposit are both published already; an owner can divide.

**D228 — a balance that could not be read renders as unknown, never as zero.**

Both figures are best-effort — that is inherited from `readNativeBalance` and `readClaimable`, which
return `null` on any RPC failure so that a slow node costs a field and not the page. The rule this
spec adds is about the *rendering*: `null` must display as `—`, distinct from a measured `0`.

This is not pedantry. "0" tells an owner their funding never arrived and they should send it again;
"—" tells them the page could not check. One of those costs them a duplicate transaction.

**D229 — read per address, not per agent.**

The `owed` ledger is keyed by address, so two agents sharing a payout address share one balance —
the existing fan-out at `server.ts:628` already dedupes for this reason, and the page already shows
the badge once per address (`index.html:4953`). Wallet addresses join the same fan-out.

The cost is bounded by the one-agent-per-X rule: an account holds one agent, so a profile load is
about three RPC reads. If that ever stops being true, this is where a cache goes — not before, on
the same reasoning `chain.ts` already records for `/agent/me`.

---

## § B — what this found and is deliberately not fixing

Production's **S3** is an active staked season whose `resolveBy` was **2026-09-22** and which is
still unresolved. Spec 24's **D186** makes `exitStale(seasonId)` callable by anyone past that
deadline, so the deposits are not trapped and the design is behaving as specified. But the page says
nothing about it, and an owner reading the profile cannot tell that a season they are staked into is
overdue.

Surfacing that is a real gap and it is **not** in this spec: it is season-state UI, not the money
fields, and it wants its own decision about who is told what. Recorded here so it is not rediscovered
as a surprise.

---

## § C — tasks

- **T172** — `readClaimable` reads `owed` on **both** `tournamentContractAddress` and
  `vaultContractAddress` and sums them (D226). Split the two judgements out as pure, exported
  functions — `payoutContracts(config)` and `sumOwed(reads)` — so they are testable without an RPC,
  which nothing in `chain.ts` currently is. All reads failing is `null`; a mix contributes what
  answered.
- **T173** — `claimPrize` asks each payout contract `owed(address)` (`eth_call`, selector
  `0xdf18e047`, no ABI library — the page has no build step) and sends `withdraw()` to each contract
  that owes, one confirmation at a time, reporting a BscScan link per transaction. Nothing owed
  anywhere says so rather than sending a doomed transaction. The "not available on this deployment"
  guard passes when **either** contract is configured.
- **T174** — `GET /auth/session` returns `walletBalanceWei` per agent, from the existing
  `readNativeBalance`, fanned out per unique wallet address beside the existing `owed` fan-out
  (D229). `null` when unreadable or when the agent has no wallet.
- **T175** — the profile's agent-wallet cell renders the balance beneath the address: a tBNB figure
  for a number, `—` for `null` (D228). Reuses `fmtTbnb`.
- **T176** — tests: `payoutContracts` returns both contracts, skips an undeployed one, is empty on a
  chainless box; `sumOwed` adds both, surfaces a vault-only prize, reports a measured zero as `0`,
  is `null` when every read failed, and counts what answered when one failed;
  `GET /auth/session` carries `walletBalanceWei` and leaves it `null` with no chain reader wired.

## Definition of done

1. `yarn test` passes from a clean `yarn install`, engine/api/reference-agent/contracts counts all
   up or unchanged.
2. On a box configured with a vault, an address owed money by the **vault only** shows a claim badge
   on the profile and one `withdraw()` collects it.
3. An address owed money by **both** contracts shows their sum and is fully collected by the claim.
4. The agents table shows a tBNB balance under the agent wallet address, and `—` (not `0`) when the
   RPC is unreachable.
5. Neither figure can 500 the profile: a box with `BSC_TESTNET_RPC_URL` pointed at nothing still
   renders the page.
