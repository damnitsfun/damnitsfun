# Sub-spec 24 — the refundable season: stake the entries, keep the yield, pay the prizes

**Depends on:** 23 (the verified contracts, `/config` chain facts, ERC-8004 identity, `balances`),
22 (per-season coins, the pull-payment pattern, the soak lessons), 15 (unified coin scoring).
**Hands off:** a new `DamnitsVault` on chain 97 whose BNB deposits are refundable and deployed
into a yield source for the season, a sponsor-seeded MockUSDT prize pot settled by the existing
leaderboard machinery, on-chain phase deadlines with a trust-minimized public exit, and the API,
tooling and pages that publish all of it — beside an untouched fee-model tournament.

---

## Why this exists

Issue #30 replaces the tournament's forfeit buy-in with a deposit model, and this spec is its
considered answer — which also happens to be the answer to issue #20 §5's "consider" (the one
line of chidx's #20 review that spec 23 left open on purpose):

```
today (spec 08/15/22)              issue #30 (this spec)
─────────────────────────────      ─────────────────────────────────────
0.0005 tBNB buy-in, forfeited      0.01 BNB deposit, REFUNDABLE at resolve
pool = buy-ins + sponsor seed      corpus staked for the season (Ankr-shaped)
losers fund the winners            yield → project treasury, as BNB
no time promises at all (D9)       deadlines on chain, exit without the operator
prize = the pool itself            prize = sponsor-seeded MockUSDT pot, separate
```

The player-facing sentence changes from *"your entry funds the prize you compete for"* to *"your
entry is a stake — you get it back, and the season it earns funds the project."* That is a
better story for a Web3 hackathon, and it is also a real revenue line: the yield on a locked
corpus is the project's sustainable funding, stated openly (D182).

Three constraints shape everything below:

1. **The submission portal closes 30 September 2026.** Everything here is sized to land in
   weeks, not months — the staking seam is mock-first with a measured adapter behind it (D185),
   and the model *coexists* with the fee tournament rather than replacing it (D190), so a
   staking failure the week before the deadline costs a feature, not the product.
2. **A 3–6 month real season cannot be shown at Demo Day.** The mock yield source must be able
   to run fast enough that a judge watches yield accrue inside a five-minute demo, and the
   deadlines must be settable in minutes so the public exit can be triggered live (T126's
   runbook shot).
3. **What already works must not be touched.** The engine boundary is unchanged (nothing here
   enters `packages/engine`); the off-chain coin ledger stays the balance of record (spec 22
   D154 — a seat still costs 10 coins, D189); the live, verified contracts keep their addresses
   and their 4,004-table anchor (D183, for D170's exact reason).

### What was checked before any of this was written

| | |
|---|---|
| Ankr aBNBb, chain 97 | `0x93405327644eDF8aD908e41F9a2Ecbb6714769D1` — **deployed**, 2,112 bytes of code (`eth_getCode`, measured 2026-09-07) |
| Ankr ankrBNB, chain 97 | `0x3C1039C346bd5141BF2D5e855928E61655658fA7` — **deployed**, 2,112 bytes |
| probe control | the ERC-8004 registry (`0x8004A818…`) answered code on the same probe, so a zero would have meant "absent", not "broken probe" |
| the Ankr **stake path** | **NOT yet measured.** Tokens deployed ≠ the staking router still mints them for staked BNB — Ankr's own testnet address page still lists Goerli-era networks. T126 walks the full stake→redeem path with dust before any adapter is believed |
| USDT on chain 97 | no official USDT exists on BSC testnet; the prize token is a mock ERC-20 (D183) |
| BSC USDT decimals | 18 on BSC (not Ethereum's 6) — the mock pins 18 so mainnet math ports unchanged |
| tBNB faucets | ration roughly 1 tBNB/day per address — a 0.01 default deposit is hostile to onboarding; staging pins 0.001 (D187) |

---

## § A — the shape of the money (D181–D184)

**D181 — two assets, two pots, no swaps.** Deposits and yield are **native BNB**; the prize pot
is **MockUSDT**; nothing converts between them. v1 contains no swap, no price oracle, and no
mixed-numeraire accounting — the issue's draft once said "10 USDT in the form of tBNB", and the
way to never implement that bug is to never hold both denominations of the same pot. Yield
arrives in BNB and leaves in BNB (to the treasury); prizes arrive in MockUSDT and leave in
MockUSDT (to winners). One vault, one prize token, one treasury, all fixed at construction — a
second token is a second vault, not a mapping.

**D182 — the yield is the project's, and the product says so out loud.** Issue #30 §2 assigns
the yield to the project's sustainable revenue and development fund, and this spec follows it
literally: 100% of staking yield sweeps to the treasury at resolve. Two consequences are named
rather than implied. First, players' principal earns nothing *for them* — the prize pool is
sponsor money end to end, and the copy must not imply otherwise; the web carries one sentence
of honesty, rendered from config, never hard-coded (D192, for D174's reason). Second, a project
paid by lock-time is tempted to extend locks — which is exactly why the phases are enforced on
chain with a public exit (D186), not left to operator discretion. The alternative model — yield
to the prize pot, entries become no-loss tickets, the Pool Together shape — is a genuinely
better player narrative and is deliberately deferred, with its unblocking condition recorded in
Open questions.

**D183 — the prize token is a mock USDT, and that does not reopen spec 23 § D.** Spec 23 § D
rejected an on-chain token as the **coin ledger**: a chain write per seat charge and per
settlement, inside the move loop, re-implementing D150's level-tie split and D154's balance of
record in Solidity — the highest-risk change available, for a fake currency. This is the
opposite shape in every dimension that mattered there: **one ERC-20 transfer per season**, at
resolve, outside the loop, over a ranking the off-chain ledger already computed. The coin
economy is untouched. The token itself already exists as a 40-line draft on
`feat/mock-usdt-token` — that branch is adopted as the starting point, pinned to **18
decimals**, freely mintable on testnet so a sponsor can seed the pot. A judge who asks "why is
the prize a mock?" gets the true answer: chain 97 has no official USDT, the token is
mainnet-shape, and the settlement path is the real one.

**D184 — the yield source is one seam, mock-first.** The vault knows exactly one interface:

```solidity
interface IYieldSource {
    function stake(bytes32 seasonId) external payable;      // takes the corpus
    function redeem(bytes32 seasonId) external returns (uint256 returned); // returns BNB
}
```

Three implementations exist behind it. `address(0)` — **disabled**: the vault holds the corpus
itself, redeem is identity, yield is zero; this is the D67 record-but-don't-pay shape, and it is
what a chainless or broken deployment degrades to without losing refunds. **MockYieldSource** —
deterministic, configurable accrual rate *including a fast demo rate*, capped at what it has
been funded with because it cannot mint native value; this is what the demo and the forge suite
run against. **AnkrAdapter** — written against the measured testnet LST pair only after T126
proves the stake path end-to-end; if the router is dead on chain 97, the adapter stays in the
tree, exercised by fork tests, and every deployment runs the mock. Lista (also named by #30) is
the same seam; one measured adapter plus one mock is the honest testnet scope.

---

## § B — the vault, the phases, and the exit (D185–D188)

**D185 — a new `DamnitsVault`; the live contracts are not touched.** For D170's reason verbatim:
the deployed pair is verified and 4,004 settled tables anchor to those addresses, so new money
gets a new contract rather than a migration. One vault serves many seasons (the
`DamnitsTournament` shape): `openSeason` is one-shot per id and fixes the deposit amount, the
deadlines and the entrant promise; the prize token and treasury are constructor-immutable
(D181). Payout is **pull, both assets** — `owedNative` and `owedToken` credited at resolve,
drained by one `withdraw()` — which is D7's pattern applied twice, and which means a winner
whose token transfer reverts blocks nobody's refund. The fee model keeps working exactly as
built: `DamnitsTournament` still opens fee seasons, and the backend picks per season (D190).

**D186 — the phases are contract state, and the exit is public. This deliberately reverses D9
for staked seasons.** `openSeason` encodes `registrationCloseAt` and `resolveBy`; both are
readable on BscScan *before anyone deposits* — the promise "principal returns by X" is a
checkpoint, not marketing copy. `resolve` remains operator-only (the operator still names the
winners, exactly as `settleCompetition` does — the same trust boundary, anchored by
`resultRoot`). But once `resolveBy` passes unresolved, **anyone** — a player, a stranger, a bot
— may call `exitStale(seasonId)`: it redeems the corpus if staked, credits every depositor's
refund, sweeps the yield to the treasury, and marks the season refunded. No operator key
required, no governance theater. The operator can still resolve prizes afterwards (the pot is
untouched by the exit); what they can never do is hold deposits hostage. `block.timestamp` is
the clock — BSC's ~3s blocks make it exact enough for a promise measured in days.

**D187 — deposits close when registration closes, and one wallet deposits once.** `deposit` is
accepted only while the season is `Registration` *and* `block.timestamp < registrationCloseAt`
— the time check is the belt to the state check's braces, so an operator who forgets to close
still cannot accept a late deposit. D9's mid-season entry does not carry over: a staked corpus
must be fixed before it is deployed, so a late joiner's answer is the next season, and that is
stated in `skill.md` rather than discovered as a 409. One deposit per wallet per season (D12's
rule, unchanged), at the season's fixed amount — `hasDeposited`, an entrant count, and a
`depositTotal` accumulator; no per-depositor ledger needed while the amount is fixed. Refunds
go to **the wallet that paid**, not the payout address — money returns to where it came from,
and the payout address remains what it already is: where *prizes* go.

**D188 — resolve is one transaction with three effects, and a shortfall is paid honestly.**
`resolve(seasonId, winners, amounts, resultRoot)`: redeem the corpus; credit each depositor's
principal to `owedNative`; check `sum(amounts) ≤ prizePot` (the `OverDistribution` guard,
unchanged) and credit winners to `owedToken`; sweep the native remainder — the yield — to the
treasury; publish `resultRoot`. The winners and amounts come from the machinery that already
exists, unmodified: `eligibleRanked()` (the spec 08/09 gates — claimed owner, payout address,
`MIN_RANKED_SESSIONS` settled tables — ranked by net coins) feeds `distributePool()`, which is
unit-agnostic integer math and takes 18-decimals base units exactly as well as it takes wei,
dust to rank 1 included. Eligibility gates **prizes only, never refunds** — an idle bot's
deposit is a free loan, and it cannot reach the prize: the curve pays the top third capped at
ten (D168), so a horde of idle entrants dilutes nothing. If a real strategy returns less than
the corpus — impossible with the mock, possible with anything live — refunds pay pro-rata of
what came back and the shortfall is the depositors'; that is asserted in forge and written in
the docs, not discovered at resolve.

---

## § C — what the API, the operator and the pages change (D189–D192)

**D189 — the 402 contract is reused verbatim, aimed at the vault; coins are untouched.**
`POST /competition/enter` on a staked season answers `402 PAYMENT_REQUIRED` naming the vault,
the deposit and the season; the player (or its owner — the paying wallet is whoever holds tBNB,
as today) calls `vault.deposit(seasonId)`; the retry carries the txHash, which is verified
against the vault's `Deposited` event for this season and amount before an entry is recorded —
the `verifyEntry` shape, never trust on a hash. Inside the season **nothing about tables
changes**: a seat still costs 10 season-coins, settlement still runs the D150/D154 machinery,
the long-poll still wakes one agent. The deposit buys the *season*, not the seats.

**D190 — coexistence is one column, not a fork.** `competitions.entry_model` (`'fee'` |
`'staked'`, default `'fee'`) plus nullable `vault_address`, `prize_token_address`,
`yield_source_address`, `registration_close_at` (enforced on chain for staked seasons — the
advisory framing was D9's, and D186 retires it here) and `resolve_by`; `competition_entries`
gains `refund_wei` and `refund_tx_hash` for the mirror. Every existing path that does not read
the new columns behaves identically — `create-tournament` without `--staked` is byte-for-byte
the fee model, and D9 still governs *those* seasons. New tooling: `create-tournament --staked
--deposit-wei N --registration-close-at … --resolve-by …`, and `settle-season --resolve`, which
keeps the standing refusal to settle a funded pot into an empty eligible field — stranding
sponsor money is the same failure at any deposit size.

**D191 — the economy is published, because a box's `.env` outranks its code.** `/config` gains
the deployment-level facts (`stakedDepositWei`, `prizeToken`, `prizeTokenDecimals`,
`yieldSource`, `yieldSourceKind`, `treasury`) and `GET /competitions` gains the per-season ones
(`entryModel`, `vaultAddress`, `registrationCloseAt`, `resolveBy`, `depositWei`, `prizePotWei`,
`entrants`, `depositTotalWei`). Spec 22 shipped `PAYOUT_FIELD_FRACTION=0.3333` and both boxes
paid at `1.0` for days because nobody could see the live value; a deposit deadline is a promise
players check before paying, so it is served from the deployment, not from a template file.

**D192 — `balances` gains the prize token, and the pages say where the yield goes.**
`GET /agent/me` extends D180's `balances` to `{ native, prizeToken }` — same best-effort rule:
short timeout, `null` on any failure, never a throw on the onboarding path. The web renders a
phase banner (registration countdown / staked / resolved) with TVL and projected yield from
D191's fields, shows a depositor's refund status on the agent profile, and carries the honesty
sentence: *deposits are refundable; the yield they earn funds the project's development* —
rendered from config, because D174's lesson is general: no page restates a money rule as a
constant. `skill.md` gains the staked-season section: refundable deposit, deadlines readable on
chain, no mid-season entry, and how to `withdraw()` after resolve.

---

## § D — what this spec deliberately does not build

| Not building | Why |
|---|---|
| Yield → prize pool (the no-loss model) | Cross-numeraire: BNB yield ≠ MockUSDT prizes without a swap, and a testnet swap adds a DEX dependency for a narrative v1 doesn't need. Deferred with conditions (Open questions). |
| Real Ankr staking as the default demo path | The LSTs are measured deployed; the router is unproven (T126). The mock is the demo floor; the adapter is fork-tested. A demo that needs a third-party router to behave is a demo that can fail on stage. |
| A Lista adapter on testnet | Named by #30 as an alternative; same seam, mainnet-grade follow-up. One measured adapter plus one mock is the honest scope three weeks out. |
| Modifying `DamnitsTournament` / `DamnitsEscrow` | D170: live, verified, 4,004 tables anchored. New money, new contract (D185). |
| Coins on chain | Spec 23 § D, unchanged. The ledger stays the balance of record (D154), and a seat still costs 10 coins. |
| A partial-forfeit hybrid (half fee, half deposit) | The issue chose a clean model — 100% refundable. A hybrid re-opens every free-rider question it closed, for a number nobody asked for. |
| Withdrawing a deposit mid-registration | The deposit is a season stake, not a checking account; the exit is at resolve, or `exitStale` after `resolveBy` (D186). A leave-registration path is follow-up scope if players ask. |

---

## Tasks

| # | Task |
|---|---|
| **T126** | **RUN FIRST — the T118 move.** A throwaway script stakes a dust amount of tBNB through Ankr's testnet staking path (BNB in, LST out) and redeems it. Record the one-line result **in this spec** — router address, whether it minted, what redeem returned — and delete the script. This decides whether `AnkrAdapter` is testnet-live or fork-only (D184). |
| **T127** | Adopt `feat/mock-usdt-token` as `MockUSDT`: pin 18 decimals, keep free minting, add forge tests (mint/transfer bounds, decimals). Note in the PR that spec 23 § D's rejection is not reopened — one transfer per season, outside the loop (D183). |
| **T128** | `IYieldSource` + `MockYieldSource` (D184): configurable rate including a fast demo rate, accrual capped at funded balance, `redeem` pays principal + accrued. Forge tests: accrual math, the cap, a second season's stake does not see the first's yield. |
| **T129** | `DamnitsVault.sol` (D185–D188): states `None → Registration → Staked → Resolved`, `openSeason`/`deposit`/`closeRegistration` (closes **and** stakes atomically)/`seedPot`/`resolve`/`exitStale`/`withdraw`, dual `owed` maps, `ReentrancyGuard`, events mirroring the tournament contract's audit trail (`SeasonOpened`, `Deposited`, `SeasonStaked`, `PotSeeded`, `Resolved` with `resultRoot`, `Refunded`, `YieldSwept`, `Withdrawn`). |
| **T130** | Forge suite for T129: every transition rejected in every wrong state; deposit past `registrationCloseAt` reverts even while state is `Registration`; `exitStale` works from both `Registration` and `Staked` after the deadline and reverts before it; pro-rata refund on a shortfall; invariant `Σrefunds + yield + dust ≤ redeemed`; `OverDistribution`; a full season fuzz against the mock. |
| **T131** | Deploy `DamnitsVault` + `MockUSDT` + (per T126) the chosen yield source through the T111 `--verify` flow; record addresses in `docs/deployment.md`; fund `MockYieldSource`'s yield budget — one runbook line an operator can copy. |
| **T132** | Schema (D190): new columns via `backfillAddedColumns`, declared in `schema.sql`; `competition_entries` refund columns. Every pre-existing row reads as `fee` and every existing test passes unmodified. |
| **T133** | Orchestrator: `createStakedTournament`, the deposit 402 + `Deposited`-event verification, `resolveStakedSeason` (eligibleRanked + distributePool verbatim, refunds mirrored, treasury sweep), and the disabled-chain degradation — a staked season with no vault configured degrades to record-but-don't-stake and still refunds. |
| **T134** | Operator tooling: `create-tournament --staked --deposit-wei --registration-close-at --resolve-by`, `settle-season --resolve`; the funded-pot/empty-field refusal preserved; both tools dry-run by default. |
| **T135** | `/config` + `/competitions` fields (D191) with tests: a deployment with no vault publishes nulls and does not throw. |
| **T136** | `/agent/me` `balances.prizeToken` (D192) + the unreachable-RPC test D180 set the pattern for. |
| **T137** | `skill.md`: the staked-season section (D192) — refundable deposit, on-chain deadlines, no mid-season entry, `withdraw()` after resolve. Re-run the trademark lint. |
| **T138** | An API e2e against the **public contract**, soak-style: deposit → close/ stake → tables play → resolve → a depositor that played zero tables withdraws full principal, a winner withdraws MockUSDT, the treasury received the yield — three BscScan links in the test log. |
| **T139** | Web (D192): phase banner, TVL + projected-yield card, refund status on the profile, the honesty sentence — all from D191's fields; grep `packages/web` for restated money rules. |
| **T140** | Docs: `docs/deployment.md`, `docs/demo-runbook.md` shot list (compressed deadlines, **live `exitStale` on stage**), `docs/submission.md` amendment (the vault becomes the portal's contract address — D171's rationale, "where the entry, the pool and the settlement live", now points here). Then the CLAUDE.md paragraph and the 00-INDEX row for this spec. |

---

## Definition of done

1. `yarn test`, `yarn lint` and the trademark lint pass from a clean install; the forge suite passes from a fresh `foundryup`.
2. `DamnitsVault` and `MockUSDT` are **verified on BscScan on their first deploy** (the T111 flow), and the live escrow/tournament addresses are byte-identical to before.
3. T126's one-line measured result is recorded in this spec, and the yield-source kind each environment actually runs is the one that measurement selected.
4. A staked season on staging, end to end: deposit → close/stake → yield accrues (fast mock rate) → tables play → resolve → **a depositor that played zero tables withdraws its full principal**, a winner withdraws prizes in MockUSDT, and the treasury received the yield — one demo run, three tx links.
5. `exitStale` refunds everyone when called by a **non-operator** after `resolveBy` with no resolve, reverts before it, and was exercised once on staging with a compressed deadline.
6. No page in `packages/web` states a deposit amount, deadline, or yield rule as a constant; `/config` and `/competitions` agree with what `resolve` actually paid.
7. The fee model still runs end-to-end untouched: `create-tournament` without `--staked` opens a season that behaves exactly as spec 08/15/22 built it.
8. Refund exactness is asserted, not assumed: over a fuzzed season, `Σ principal in == Σ refunds + treasury yield + bounded dust`.
9. The runbook shot list runs end to end by someone who has not read this spec.
10. The submission's contract field names the vault, and the submission copy states in one sentence where the yield goes.

---

## Open questions

**None blocking.** The four that shaped this spec are decided on record:

**Where does the prize money come from? — Sponsor seed, stated.** Issue #30 never names a
source, and with refundable deposits and project-bound yield the sponsor pot is the *entire*
prize. That is honest and it is enough — anyone who wants a bigger prize seeds more MockUSDT.

**Yield to players later? — Deferred, with its unblocking condition.** The no-loss model (yield
→ prize pot, entries become tickets that cannot lose) is the natural v2. It is blocked on one
decision — swap BNB yield into the prize token, or denominate prizes in BNB — and either answer
is a real design, not a hackathon-fortnight tweak. Recorded here so nobody rediscovers the
question.

**The portal's contract address? — The vault.** D171 chose `DamnitsTournament` because that is
"where the entry fee, the prize pool and the settlement live". In a staked season all three
live in the vault, so the submission field follows the money; both contracts stay verified and
cross-linked either way.

**Residual prize pot after a partial distribution? — Stays in the vault.** If the eligible
field is thinner than the curve's cap, the pot keeps a remainder. It is not lost — it sits in
the vault, attributed to its season — and a `rolloverPot` to a next season is follow-up scope
exactly like `rolloverJackpot` was (D15).
