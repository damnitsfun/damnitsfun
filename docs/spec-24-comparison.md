# Two versions of sub-spec 24 — a side-by-side

> **Settled — this page is kept as the reasoning, not as an open question.** The recommendation
> at the bottom was taken: the merge of A's structure and B's evidence was written up and is now
> [`specs/24-economic-model.md`](../specs/24-economic-model.md), which supersedes both drafts.
> Neither draft file exists on `main` any more; the two branches are kept read-only so the file
> paths cited below still resolve. Read this to understand *why* spec 24 says what it says —
> then read the spec, which is the only one that governs.

There are **two specs numbered 24**, written separately, answering the same issue
([#30](https://github.com/damnitsfun/damnitsfun/issues/30)). Only one can be merged, because
both renumber the decision list and the task list from the same starting point.

This page compares them so somebody can choose. **Written in plain language on purpose.**

| | **Version A** | **Version B** |
|---|---|---|
| Branch | `spec-24-adjust-improvement-economy-model` | `e/economic-model` |
| File | `specs/24-adjust-improvement-economy-model.md` | `specs/24-economic-model.md` |
| Title | "the refundable season" | "money that comes back" |
| Length | 284 lines | 376 lines |
| Decisions | D180–D192 | D181–D193 |
| Tasks | T126–T140 | T126–T141 |
| Extra documents | none | `docs/defi-economic-model-research.md` (574 lines of research) |

**Short answer: neither should be merged as-is. Version A has the better skeleton. Version B
has the better evidence. The right spec 24 is A's structure with B's facts.** The details are
below, and the merge list is at the end.

---

## 1. What they agree on

This is most of it. The two were written without seeing each other and still landed in the same
place on nine things:

1. **A new contract called `DamnitsVault`.** Both refuse to change the two live contracts,
   because they cannot be upgraded and 15,344 finished games point at their addresses. Both cite
   the same earlier decision for it.
2. **The deposit comes back.** That is the whole point in both.
3. **Deposits reuse the payment flow agents already know** — the "402, here is where to pay,
   send me the transaction hash, I will check the receipt" pattern.
4. **The yield source hides behind a small interface** with a fake version for tests.
5. **Players pull their money; the contract never pushes it.** One bad address must not freeze
   everybody.
6. **Every new setting is published on `GET /config`**, because a server's own config file beats
   the code and we already got burned by that once.
7. **A measuring task runs before any code exists** (both call it T126, both copy the same
   earlier task that measured gas sponsorship instead of guessing).
8. **The coin system is not touched.** A seat still costs 10 coins.
9. **Operator tools do nothing by default and need `--confirm` to move money.**

So the argument is not about the shape. It is about five specific choices.

---

## 2. Where they actually differ

| Question | **Version A** | **Version B** |
|---|---|---|
| Which protocol earns the interest? | **Ankr** (plus a fake one for demos) | **Venus** |
| Who gets the interest? | 100% to the project | To the prize pool, minus a capped fee |
| What are prizes paid in? | **MockUSDT** — a new fake token | **tBNB** — what we already pay |
| Is there a deadline? | **Yes, on the blockchain** | No — the operator closes when they choose |
| Can players rescue their own money? | **Yes — anyone can trigger refunds** | No |
| Does the old fee model survive? | Yes, decided — a column picks per season | Left as an open question |
| Demo speed | A fake yield source with a **fast demo rate** | Relies on the real testnet rate |

---

## 3. The five real arguments, one at a time

### 3.1 Ankr or Venus? — **Version B is right, and this is the biggest factual gap**

Version A picks **Ankr**. It checked that Ankr's *tokens* exist on the test network (they do)
and is honest that it has **not** checked whether you can actually stake into it: its own notes
say *"NOT yet measured… Ankr's own testnet address page still lists Goerli-era networks."* Its
first task is to go and find out.

Version B already did that measurement. The finding:

> **Ankr's `ratio()` on the test network is frozen at 1e18. It never moves. Money deposited
> there earns exactly nothing, forever.**

So Version A's first task is likely to come back a failure, and its fallback is the fake yield
source. Version B checked Venus instead and ran a practice deposit of 0.1 test-BNB through it
successfully — deposits open, no limit, and the rate visibly changes.

Venus also has a property Version A's choice does not: **you can take the money out instantly.**
Ankr and Lista both make you wait days. We pay winners the moment a season settles.

**Verdict: Version B, clearly.** Not a preference — one was measured and one was not.

### 3.2 Where does the interest go? — **Version B is right, but only just**

Version A gives **100% of the interest to the project** and says so openly. That is exactly what
issue #30 asked for, and Version A deserves credit for following the issue literally instead of
quietly changing it.

The problem is the number. Version B did the arithmetic:

- 1,000 players depositing 0.01 BNB for a **whole week** earn **$1.32 in total**.
- To pay a **$1,000 weekly prize** from interest you need **$5.8 million** locked.
- Our pool today is **$16**. Three months of interest on it is **16 cents**.

Version A's headline claim is *"the yield on a locked corpus is the project's sustainable
funding."* A judge with a calculator can disprove that in one minute. Version B treats the
interest as **too small to matter** and makes the promise itself the product: *"win or lose you
get your deposit back."*

Version A also does something Version B warns against directly: it puts a **"projected yield"
card on the website** (its D192). Version B's rule is *"show a transaction link, never a
percentage"* — because if we print 5% and a judge finds 0.13%, they stop believing the rest of
the page.

**Verdict: Version B's honesty, Version A's simplicity.** Version A is right that "yield goes to
the project" is cleaner than routing it back to prizes. Version B is right that we must never
call it revenue. **Do both: keep A's simple routing, delete the revenue claim and the projected
yield card.**

### 3.3 MockUSDT prizes, or keep tBNB? — **Version B is right**

Version A introduces a new fake token, **MockUSDT**, and pays prizes in it. Its reasoning is
good: there is no real USDT on the test network, keeping two currencies apart means we never
need a swap or a price feed, and it matches what a real-network version would look like.

But there is a problem it does not solve. **MockUSDT can be minted for free by anyone.** A judge
who asks *"what did the winner actually receive?"* gets *"a token we can print."* Today, winners
receive real test-BNB — the same asset the entry fee is paid in, from a contract that has been
settling real games for months.

Version B keeps prizes in tBNB and rejects USDT for that reason plus a simpler one: it adds a
second currency for no benefit that survives testnet.

Worth noting: an earlier spec already rejected putting a mock token in this system. Version A
argues carefully that this is a different shape (one transfer per season, not one per move) and
**that argument is correct** — it is genuinely not the thing that was rejected. It just is not a
reason to *want* it.

**Verdict: Version B.** Keep prizes in tBNB. Version A's two-currency discipline is good
thinking applied to a currency we do not need.

### 3.4 Deadlines and the public exit — **Version A is right, and this is its best idea**

This is the biggest gap in Version B, and it is a serious one.

Version B leaves seasons as they are today: **they end when an operator decides to end them.**
There is no deadline anywhere. Version B's own companion research points out that in production
a funded season sat open, with nobody able to win it, **for months**.

Version A fixes this properly:

- `openSeason` writes two deadlines **onto the blockchain**, readable by anyone **before they
  deposit**. "Your money comes back by this date" becomes something you can check, not something
  we say.
- After the deadline passes with nothing resolved, **anyone at all** — a player, a stranger, a
  bot — can call `exitStale()`. It pulls the money out, credits everybody's refund, and marks
  the season done. **No operator key needed.**

Version A also names the reason this matters, which is sharper than the mechanism: *a project
that is paid by lock-time is tempted to extend locks.* So it removes its own ability to.

That is the strongest single idea in either document. Version B has nothing like it, and
"the operator will close it eventually" is not a promise you can put in front of a judge next
to the words "your deposit is refundable."

**Verdict: Version A, decisively. This must be in the merged spec.**

### 3.5 Demo speed — **Version A is right, and Version B has a factual error here**

Version B claims Venus's ~35% test-network rate makes the balance "visibly move" during a demo.

**Do the maths and that is wrong.** 35% a year on a $16 pool, over a five-minute demo, is about
0.00000009 BNB. Invisible. Version B's claim only holds over days, not over a Demo Day slot.

Version A saw this and solved it: its fake yield source has a **configurable fast demo rate**,
so a judge actually watches a number climb. It also keeps the real adapter in the tree, tested
against a real forked chain, so the real path is not fiction.

**Verdict: Version A.** Version B's "visibly moving" line needs deleting or fixing.

---

## 4. Smaller things, and who thought of them

Things only **one** version considered at all. This is a fair measure of how carefully each was
written.

### Only in Version A

| | Why it matters |
|---|---|
| **No mid-season joining** | A staked pot must be fixed before it is invested. Version B never says what happens to a late joiner. |
| **Refunds go to the wallet that paid**, not the payout address | Money returns where it came from. Prizes go to the payout address. Version B does not distinguish them. |
| **Being eligible gates prizes only, never refunds** | An idle bot gets its deposit back but cannot reach the prize. Version B leaves this ambiguous. |
| **`entry_model` column** so old and new seasons coexist | Clean, one column, everything that ignores it behaves identically. Version B leaves this as an open question. |
| **Test-BNB faucets ration ~1 per address per day** | Which makes issue #30's 0.01 deposit hostile to new players. Nobody else spotted this. |
| **Which contract address goes on the submission form** | It should follow the money to the vault. Version B never thinks about it. |
| **Leftover prize money stays attributed to its season** | Version B does not address leftovers in the new contract at all. |

### Only in Version B

| | Why it matters |
|---|---|
| **Venus returns an error code instead of failing** | Zero means success; anything else means **the money did not move and our code will think it did**. The classic bug in this family of protocols. Version A picked a protocol where this does not apply — but if the merged spec uses Venus, this must come along. |
| **A fee with a permanent ceiling** | `MAX_YIELD_FEE_BPS` as a constant nobody can raise, ever. Version A takes 100% of the interest with no ceiling at all, which is worse optics for the same money. |
| **A shortfall is recorded publicly and blocks withdrawals** until covered, with a `topUp` to cover it | Version A pays out pro-rata and the loss is the depositors'. **A's answer is arguably more honest; B's is friendlier.** Both are defensible; they should be argued, not merged by accident. |
| **"Show a transaction, never a percentage"** | The rule that stops us making a claim a judge can disprove. |
| **574 lines of research behind it** | Every number checked against the live chain, with a list of what could not be verified. Version A's checking table is good but shorter. |
| **Two real bugs found in the existing contract** | Money that gets permanently stuck, and a safety check that lives in a script instead of the contract. Neither spec fixes them, but only B wrote them down. |

---

## 5. Honest scorecard

| | Version A | Version B |
|---|---|---|
| Picked a protocol that actually works | ❌ unmeasured, and probably dead | ✅ measured working |
| Believable money claims | ❌ calls the interest "sustainable funding" | ✅ proves it is pennies and says so |
| Prize currency | ❌ a token anyone can print | ✅ real test-BNB |
| Deadlines and a way out without us | ✅ **excellent** | ❌ missing entirely |
| Works in a five-minute demo | ✅ fast fake rate | ❌ claim does not survive the maths |
| Contract details thought through | ✅ more of them | ⚠️ fewer |
| Old model keeps working | ✅ decided and designed | ⚠️ left open |
| Traps in the code named | ⚠️ one | ✅ the important one |
| Research behind it | ⚠️ a table | ✅ a whole document |
| Length vs. content | ✅ tighter | ⚠️ longer for similar ground |

**5 clear wins each.** They are not the same five, and that is the useful part.

---

## 6. What the merged spec should be

Take **Version A as the base document** — it is tighter, its contract design is more thought
through, and it already decided things Version B left open. Then change six things using
Version B's findings:

1. **Swap Ankr for Venus.** Ankr's test-network rate is frozen at zero; Venus was measured
   working and is the only one you can exit instantly. Keep A's mock-first structure and its
   fast demo rate — that part is better than B's.
2. **Carry over the error-code check.** If the merged spec uses Venus, the "returns a number
   instead of failing" trap is live and it is the bug that ships.
3. **Delete every claim that the interest is revenue.** Keep A's simple "interest goes to the
   project" routing; remove "sustainable funding", and remove the projected-yield card from the
   website. Put B's arithmetic ($1.32 a week, $5.8M needed) into *"what we deliberately did not
   build"* instead — it is the strongest evidence in the whole submission that we checked
   rather than assumed.
4. **Drop MockUSDT. Pay prizes in tBNB.** A prize a judge can watch move on BscScan beats a
   prize we can mint for free. This also deletes a whole task and a whole contract.
5. **Keep A's deadlines and `exitStale` exactly as written.** This is the best idea in either
   document and it is what makes "refundable" a promise rather than a word.
6. **Decide the shortfall rule on purpose.** A refunds pro-rata and the loss is the depositors'.
   B blocks withdrawals and lets anyone top it up. Pick one deliberately — do not let a merge
   choose it by accident.

Everything else in Version A stands.

**Rough effect:** the merged spec is shorter than either — Venus replaces a protocol that needs
proving, MockUSDT and its task disappear, and the yield-as-revenue argument collapses into two
rows of a table we were writing anyway.

---

## 7. What still is not solved by either

Worth writing down so nobody thinks the merge finishes the job.

- **Neither fixes the two real bugs in the live contract.** Prize money that nothing can ever
  read again, and a safety check that lives in a script a human can forget to run. Both specs
  decline for the same correct reason (fixing them means redeploying, which orphans real rows).
  It is still true that production sat in the dangerous state for months.
- **Neither addresses that the deposit is trivially small.** 54 agents × 0.01 BNB is about $400
  at best, and $16 today. The vault is real machinery around an amount that does not matter yet.
  That is fine — but the submission must not imply otherwise.
- **Both leave agents betting on each other to a later spec.** Correct call in both. It is the
  most original idea available and it deserves better than a deadline.
