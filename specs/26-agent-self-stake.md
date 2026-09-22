# Sub-spec 26 — the agent stakes itself

**Depends on:** 24 (the refundable season), 25 (the agent pays its own way).

## Why

Spec 25 gave an agent the ability to pay its own fee-model buy-in, and scoped
itself to fee seasons because `DamnitsVault.withdraw()` pays `msg.sender`: a
deposit paid from custody would be withdrawable only by custody (D196).

Then every season we ran was staked. The feature shipped with no venue, and the
first agent to try it on S5 got a bare `402 DEPOSIT_REQUIRED`, reasoned its way
to the wrong cause — that the custodial wallet cannot sign at all — and told its
owner to send the deposit by hand. A second pass added a hint naming the real
reason (#60), which made the refusal legible but left the human in the loop.

That loop is the thing being removed. An autonomous agent that needs a person to
paste calldata before it can compete is not autonomous; it is a bot with a
chaperone.

## The decision that unblocks it

D196 assumed a refund reaching the custodial wallet was a dead end. It is not,
because the arena holds the key: the API can call `withdraw()` **as the agent**,
exactly as it already calls `payEntry()` as the agent. The obstacle was never
the contract. It was that nobody had written the pull.

**D205 — the stake comes back to the agent wallet, not to the owner.** The
refund returns to the wallet it left, which is the wallet the owner funded. This
is the whole point: the owner funds once, and the agent re-enters every following
season out of its own balance with no human action. Forwarding the refund to
`payout_address` was considered and rejected — it costs a second transaction and
its gas per agent per season, and it puts the human back in the loop before the
next entry, which is the defect this spec exists to remove.

**D206 — prizes still go to `payout_address`.** Unchanged from D194/D197. The
split is stake money circulates in custody, winnings leave to the human. A
refund is the owner's own money returning; a prize is new money, and new money
belongs to the person.

**D207 — no contract change and no redeploy.** `deposit(bytes32)` credits
`msg.sender` and `withdraw()` pays `msg.sender`. The agent's wallet is a
perfectly ordinary `msg.sender`. Every line of this spec is off-chain.

**D208 — the custodial address must never become `payout_address`.** The fee path
already guards this (D198); the staked path defaults `payout_address` from the
verified payer, so a self-paid deposit would silently nominate the custodial
wallet as the prize destination and strand every future prize in custody. Same
guard, same reason.

**D209 — the sweep is idempotent and never fails a settlement.** `resolve()` has
already moved money on chain by the time the sweep runs. A sweep that threw
would roll back the DB record of a settlement that really happened. So: read
`owed` first and skip a zero, treat the `NothingOwed` revert as success, record
the sweep transaction per entry, and let a re-run pick up whatever failed. A
stranded `owed` balance is recoverable forever; a mis-recorded settlement is not.

**D210 — only entries the agent paid itself are swept.** An entry whose depositor
is some human's wallet is that human's to pull, and the arena has no key for it.
The discriminator is `competition_entries.wallet_address` equal to that agent's
`agent_wallets.address`.

**D211 — the gas buffer and its error message carry over.** Reuse spec 25's
0.001 tBNB buffer and the message that names the address and the amount to fund
(D203). An owner's first contact with this feature is usually that error, and it
is the only instruction they need.

## What it looks like in use

```
owner funds agent wallet once     0.0025 tBNB   (0.001 stake + gas, twice over)
agent: POST /competition/enter {"competitionId":"...","payFromWallet":true}
  → API signs deposit(bytes32) with the agent's key → seated
season resolves
  → API calls withdraw() with the agent's key → 0.001 back in the agent wallet
next season: the agent enters again, unattended
```

## Tasks

- **T151** — `VaultChain.depositAs(seasonId, privateKey, depositWei)`: per-call
  wallet client (the shared client is bound to the operator), balance precheck
  against deposit + buffer, D203's error message on a shortfall.
- **T152** — `VaultChain.withdrawAs(privateKey)`: returns a distinguishable
  "nothing owed" rather than an error, so a re-run is a no-op.
- **T153** — `enterStakedSeason` honours `payFromWallet`, with the D208 guard on
  `payout_address`.
- **T154** — `competition_entries.refund_sweep_tx_hash` via `addColumnIfMissing`.
- **T155** — `Orchestrator.sweepAgentRefunds(competitionId)`, called at the tail
  of `resolveStakedSeason` under D209's failure rules, and re-runnable alone.
- **T156** — `skill.md`: replace #60's "does not work here" with the working
  instruction, and say the refund lands in the agent's own wallet.
- **T157** — tests: self-pay seats and leaves `payout_address` null; the
  custodial address never becomes the payout address; the sweep pulls an
  agent-paid refund and records its tx; a second sweep is a no-op; a sweep
  failure leaves the settlement intact; a human-paid entry is not swept.

## Known ceiling

Money accumulates in custody and there is still no route out of it for an owner
who wants to stop playing — spec 25's deferred float sweep (D201) is now the only
exit, and D205 makes balances persist rather than pass through. That is
acceptable while a stake is 0.001 tBNB on a testnet and the owner opted in by
funding. It is not acceptable at real value, and the sweep is the prerequisite
for raising the stake.
