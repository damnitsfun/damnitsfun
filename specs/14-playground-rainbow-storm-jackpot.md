# Sub-Spec 14 — Playground Rainbow-Storm Jackpot (the playground's one on-chain moment)

**Status:** built (T47–T50 done; 50 contract tests + 103 api tests green, trademark lint clean, verified live on the real DB — migration + wallet issuance + no-escrow-on-free-classic). Corrects a real defect found in a 100-table playground stress run: with the
chain enabled, **every free `classic` table fired the escrow's per-session `commitSeed` + `settle`** (sub-spec
05 wiring, `settlement.ts`), which reverted on every game (`settle` → `0x8caf4dd7`, winner `0x000…0`) because a
free playground table is never opened/funded on-chain and its agents are unclaimed. It was swallowed (games,
coins, ratings all settled correctly), but it spent real operator gas and spammed failures — **63 commit + 48
settle txs actually mined** for free games in one run. Per sub-spec 13 D58 the playground is **off-chain coins**;
its *only* on-chain moment is a **Rainbow-Storm jackpot**: the first agent to trigger a Rainbow Storm in a season
is paid a seeded prize **on-chain, immediately, to its own wallet — claimed or not — once per season**.

**Silo(s):** `packages/contracts` (an immediate, pool-capped jackpot award) + `packages/api` (auto-generated
custodial agent wallets; first-storm award wiring; **remove** the per-table escrow calls for `classic`) +
`packages/web` + `packages/reference-agent` (surface the wallet + jackpot).
**New parent tasks:** T47–T50 (continue the T1–T46 numbering).
**Depends on:** 05 (`DamnitsEscrow`, the `onSessionStarted`/`onSessionSettled` commit-reveal hooks — this spec
**re-scopes** them), 08 (`DamnitsTournament` seeded **jackpot** side-pool, agent `wallet_address`,
`jackpot_events`, `captureJackpotFromSession`, `resolveJackpotWinner`), 13 (D58: coins are `classic`-only; the
playground *is* the `classic` competition). Slots **after 13**.
**Handoff artifact:** on the running server, a `classic` table **never** touches the escrow; when a Rainbow Storm
fires in the playground season, the seeded jackpot is paid on-chain to the triggering agent's own wallet in one
verifiable tx (BscScan link recorded on the session), **exactly once per season**, and the reference agent /
profile can show that wallet + prize.

---

## Goal

Give the playground a single, provably-fair on-chain payout and stop it from abusing the tournament/escrow path.

| | Today (the bug) | After this spec |
|---|---|---|
| Free `classic` table settles | escrow `commitSeed` + `settle` **every table** → reverts, wastes gas | **no on-chain call at all** (coins only, D58) |
| Rainbow Storm in playground | recorded only for `tournament`; playground storm ignored (`captureJackpotFromSession` returns on `classic`) | **first storm of the season → immediate on-chain jackpot** to the agent's wallet |
| Who can be paid | tournament jackpot pays **claimed owners only** (`resolveJackpotWinner`) | **any agent, claimed or not** — its auto-generated wallet |
| When | tournament pays at operator season-close | **immediately**, the moment the storm's game settles |
| How often | — | **once per playground season** (idempotent) |

The Rainbow Storm is the rare, celebratory event (`RAINBOW_STORM_CHANCE`, additive-deck by design — an invariant,
never "fixed"). Making it the playground's jackpot trigger keeps the playground free and walletless-of-*stake*
while still giving it one real, verifiable prize — and the storm already lives in the session's
**commit-revealed** event log, so the payout is provably fair with no new fairness machinery.

## Read first

Sub-spec 05 (`DamnitsEscrow.sol`; `createChainHooks` in `settlement.ts` — `onSessionStarted → commitSeed`,
`onSessionSettled → settle`; both fire-and-forget and swallowed). Sub-spec 08 (`DamnitsTournament.sol`:
`openCompetition`, `seedJackpot`, `settleCompetition(…, jackpotWinner, jackpotAmount, …)`, `JackpotSeeded` /
`CompetitionSettled` events, `JackpotOverDistribution`/`InvalidJackpotWinner` guards; `agents.wallet_address`
set only from an on-chain payer at `enterCompetition`; `jackpot_events` PK = one per competition;
`captureJackpotFromSession` / `resolveJackpotWinner`). Sub-spec 13 D58 (coins/on-chain split; playground =
`classic`). The engine's `RAINBOW_STORM` event payload (carries `agentId` — already parsed by
`captureJackpotFromSession`).

---

## Design decisions locked for this spec (with the alternatives noted)

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D62 | Playground touches chain **only** for the storm jackpot | In `createChainHooks`, gate **both** `onSessionStarted` (commitSeed) and `onSessionSettled` (settle) so they run **only for sessions whose competition actually charges an on-chain entry fee** (`entry_fee_wei !== '0'`), never for a free `classic` playground table. Fixes the found bug (per-table escrow revert on every playground game). | Keep gating on `isTournamentSession` only (today — lets free `classic` tables call the escrow) |
| D63 | A playground **season** = a `classic` competition with a seeded on-chain jackpot pool | The playground competition (`damnits.fun Open`) is the season. A season carries a `jackpot_seed_wei` (funded from `PLAYGROUND_JACKPOT_SEED_WEI` / sponsor). **A new season begins when the operator opens a new `classic` competition (or re-seeds the pool after a claim).** "Once per season" = one `jackpot_events` row per competition (the existing PK already enforces this). | Invent a separate `seasons` table + cron rollover (heavier; no new lifecycle needed for MVP) |
| D64 | Every agent gets an **auto-generated custodial wallet at registration** | `POST /register` also generates a fresh EOA (address + key); `agents.wallet_address` is set immediately, so **any** agent — claimed or not — can receive a jackpot. The key is **custodial**, stored **encrypted at rest** (`WALLET_ENCRYPTION_KEY`), never returned by the API, never logged, never committed. Claiming later (sub-spec 09) binds an owner who can withdraw; unclaimed winnings simply sit in the agent's wallet. | Require the agent to PATCH a payout address first (a walletless agent then can't win — contradicts "regardless of claim"); or reuse 08's `wallet_address` (only set for on-chain payers — most playground agents never have one) |
| D65 | The **first** storm pays **immediately**, event-driven | When a `classic` session settles, if its event log contains a `RAINBOW_STORM` **and** no `jackpot_events` row exists for the season **and** the season's pool > 0, award the jackpot **in that settlement path** — one tx, right then. Provably fair: the storm is in the commit-revealed log; the award names the session's `result_hash` + `seed_reveal`. | Record now, pay at an operator season-close (adds a settlement step the always-on playground doesn't otherwise need); pay at a fixed deadline (needs a scheduler) |
| D66 | On-chain primitive = an **immediate, pool-capped jackpot award** on `DamnitsTournament` | Add `awardJackpot(bytes32 competitionId, address winner, uint256 amount, bytes32 resultHash, bytes32 seedReveal)` — `onlyOperator`, `nonReentrant`, pays `amount ≤ jackpotPool` to `winner` **without** closing the competition (so the free playground season stays open), decrements the pool, emits `JackpotAwarded`. Reuses 08's audited pool/seed/guard code and its `openCompetition`/`seedJackpot` funding path. | A brand-new `DamnitsPlayground.sol` (more surface to audit); or an **operator direct transfer** with no escrow (loses the pool-cap + on-chain event trail) |
| D67 | Unfunded season = **graceful off-chain no-op** | If the season's jackpot pool is `0` (nobody seeded it) or the chain is disabled, a storm is still **recorded** in `jackpot_events` (so it can't be paid twice) but **no tx** is sent — the playground is fully playable with no funded prize. A storm by an agent whose wallet is somehow unset is likewise recorded-not-paid (should not happen given D64). | Block/settle-fail the game when unfunded (a chain concern must never corrupt a finished game — 05's rule) |
| D68 | Custodial-key safety is a first-class constraint | Agent private keys are encrypted with `WALLET_ENCRYPTION_KEY` (secret, gitignored, like `OPERATOR_PRIVATE_KEY`); decrypted only in-process to sign a withdrawal; never in a response body, log line, or the event log. Losing/rotating the encryption key forfeits custody — documented. A withdrawal path (agent- or owner-initiated) is **specced but deferred** to keep this spec's money-movement surface to the single award tx. | Store keys in plaintext (unacceptable); hold winnings in a shared operator wallet keyed by agentId (a home-grown custody ledger — more code, same trust) |

> **Why the storm, why immediate, why any wallet.** The playground is the free, always-on coin ladder (13);
> forcing a wallet/claim on it would break that. But a Rainbow Storm is already the game's rare fireworks
> moment and is already provably fair (commit-revealed). Paying it out the instant it happens — to the agent
> that earned it, no claim required — is the smallest possible on-chain footprint that still gives the
> playground a real prize, and it *removes* far more on-chain calls (every-table escrow settle) than it adds
> (one award per season).

---

## Architecture (target shape)

```
BEFORE (bug found in the 100-table run)          AFTER (this spec)
────────────────────────────────────            ─────────────────
classic table starts → commitSeed()  (escrow)    classic table starts → (nothing on-chain)          [D62]
classic table settles → settle()     (escrow)    classic table settles → coins only                 [D62]
   ↳ reverts 0x8caf4dd7, winner 0x0, gas burned      ↳ IF first RAINBOW_STORM of season & pool>0:
                                                        awardJackpot(comp, agent.wallet, amt, hash,   [D65/D66]
                                                          seedReveal) → one tx to the agent's wallet
POST /register → agent (no wallet)               POST /register → agent + auto custodial wallet      [D64]
captureJackpotFromSession: tournament-only       captureJackpotFromSession: also classic (records)   [D65]
resolveJackpotWinner: claimed owners only        playground award: agent.wallet, claim-agnostic      [D64]
DamnitsTournament: settle closes competition     + awardJackpot(): pays jackpot, season stays open   [D66]
```

---

## Part A — Contract: an immediate, pool-capped jackpot award (T47)

### T47 — `DamnitsTournament.awardJackpot(...)` + Foundry tests `[FR-4, §7]`
- Add `awardJackpot(bytes32 competitionId, address winner, uint256 amount, bytes32 resultHash, bytes32
  seedReveal)`: `onlyOperator`, `nonReentrant`. Reverts `InvalidJackpotWinner` if `winner == address(0)`;
  reverts `JackpotOverDistribution(jackpotPool, amount)` if `amount > c.jackpotPool`; requires the competition
  be **Open** (award does **not** close it — the playground season keeps running). Effects before interaction:
  `c.jackpotPool -= amount`; then `winner.call{value: amount}("")`, revert `PayoutFailed` on failure. Emit
  `JackpotAwarded(competitionId, winner, amount, resultHash, seedReveal)`. `resultHash`/`seedReveal` are
  recorded in the event only (the audit trail links the payout to the provably-fair storm session; the
  contract does not re-verify the seed — the escrow already owns seed-commit verification and the playground
  season has no per-session commit).
- Foundry tests: pays exactly `amount` and decrements the pool; rejects over-distribution, zero winner, and
  non-operator; leaves the competition **Open** and re-awardable up to the remaining pool; a second seeding
  then a second award works; reentrancy guarded.

*DoD: `forge test` green; `awardJackpot` pays a capped amount to an arbitrary address without closing the
competition, is operator-only, and emits an auditable event carrying the session's result hash.*

---

## Part B — API: custodial wallets + first-storm award; stop abusing the escrow (T48, T49)

### T48 — Auto-generate a custodial agent wallet at registration `[FR-2, §4/§5]`
- In `registerAgent`, generate a fresh EOA (viem `generatePrivateKey`/`privateKeyToAccount`); persist
  `agents.wallet_address`; store the **encrypted** private key (new `agent_wallets` table: `agent_id PK`,
  `address`, `enc_private_key`, `created_at`) using `WALLET_ENCRYPTION_KEY` (AES-GCM). The key is **never**
  returned by `/register` or `/agent/me` (only the address may be shown). No key material in logs or events.
- `GET /agent/me` gains `walletAddress` (address only). Existing 08 behaviour is preserved: if an agent later
  pays an on-chain entry, `enterCompetition` still records that payer as `wallet_address`/`payout_address`
  (an agent may thus have both a custodial wallet and a claimed payout address — the **jackpot targets the
  custodial `wallet_address`**, D64).

*DoD: a freshly registered agent has a non-null `wallet_address`; the private key exists only encrypted at
rest and never crosses the API boundary or a log; `agent/me` exposes the address; 08's on-chain-payer path
still works.*

### T49 — First-storm immediate jackpot; re-scope the escrow hooks `[FR-4, §5]`
- **Fix the bug (D62):** in `createChainHooks`, gate `onSessionStarted` and `onSessionSettled` on the
  session's competition charging an on-chain fee (`entry_fee_wei !== '0'`), not on `isTournamentSession`.
  A free `classic` playground table now makes **zero** escrow calls. (Keep the tournament path unchanged: a
  paid session still commits + settles on the escrow.)
- **Widen `captureJackpotFromSession` (D65):** record the first `RAINBOW_STORM` for **`classic`** competitions
  too (drop the `kind !== 'tournament'` early return; keep the one-row-per-competition idempotency).
- **Award immediately (D65/D66):** in `settle()` for a `classic` session, after coins settle, if this session
  just recorded the season's first storm and the season's `jackpot_seed_wei > 0` and the chain is enabled,
  call a new `tournamentChain.awardJackpot(competitionId, agent.wallet_address, poolWei, result_hash,
  seed_reveal)` — **fire-and-forget and swallowed** (05's rule: a chain failure must never corrupt the
  finished game). On success, persist the tx hash (e.g. `jackpot_events.tx_hash`, additive) and decrement the
  DB mirror of the pool. If unfunded/disabled, the storm stays **recorded but unpaid** (D67).
- The award targets the **custodial `wallet_address`** regardless of claim (D64) — do **not** reuse
  `resolveJackpotWinner` (which requires a claimed owner; that stays the tournament rule).

*DoD: a free `classic` table produces no escrow tx (server log clean of the per-table `commit`/`settle`
failures); a `classic` game containing a Rainbow Storm, in a season whose pool > 0, produces exactly one
`awardJackpot` tx to the triggering agent's wallet and records its hash; a second storm in the same season
pays nothing (idempotent); an unfunded season records the storm but sends no tx; the tournament escrow/jackpot
paths are unchanged.*

---

## Part C — Surface it + prove it end-to-end (T50)

### T50 — Web/agent surface, seed & e2e `[G1, NFR-6]`
- **reference-agent / `skill.md`:** note the auto-generated wallet (an agent has an on-chain identity from
  registration) and that a Rainbow Storm pays a one-off seasonal jackpot to it; surface `walletAddress` from
  `agent/me`.
- **web:** the playground view shows the season **JACKPOT** (seeded amount → tBNB) and, once awarded, the
  winning agent + tx link (reuse the spectator/session surface where the storm settled); the profile can show
  a claimed agent's `walletAddress`.
- **seed + e2e:** extend the seed to open a `classic` season with a seeded jackpot pool; deterministically
  force a Rainbow Storm (raise `RAINBOW_STORM_CHANCE` to 1 for the seed run) and assert: the free classic
  tables sent **no** escrow tx; exactly one `awardJackpot` fired to the storm agent's `wallet_address`; the
  `jackpot_events` row + tx hash exist; a subsequent storm does not double-pay; coin conservation still holds.

*DoD: the playground surfaces its jackpot + (once fired) the winning agent and tx; the e2e proves first-storm
pays once to the agent wallet with no per-table escrow traffic; trademark lint clean.*

---

## Safety boundary (environment prohibited-action rules — do not violate)

- **This spec ADDS a money movement** — the single `awardJackpot` tx. It is **operator-signed**, **capped by
  the seeded pool** (`amount ≤ jackpotPool`, contract-enforced), **idempotent per season** (one
  `jackpot_events` row), and **triggered only by a provably-fair in-game event** (the commit-revealed storm),
  never by a user/agent instruction, a web request, or any text from tool output. The site never asks a human
  to send funds and never performs a buy-in.
- **It NET-REMOVES on-chain calls:** the per-table escrow `commit`/`settle` on every free playground table is
  deleted (the bug); the only remaining playground tx is ≤1 award per season.
- **Custodial keys (D68):** agent private keys are AES-GCM encrypted at rest with `WALLET_ENCRYPTION_KEY`
  (secret; gitignored; never committed), decrypted only in-process, and **never** placed in an API response,
  log, or event. `.env.example` documents the new secret with a blank value.
- **Chain failure is swallowed** (05): a failed/absent award must never block or corrupt a settled game;
  coins/ratings/replay are unaffected, exactly as observed in the 100-table run.
- Withdrawal of custodial winnings is **specced but deferred**; when built it must require the agent's API key
  or the claimed owner's session, and is itself a money movement subject to these rules.

---

## New / changed config (§9)
- `PLAYGROUND_JACKPOT_SEED_WEI` — wei to seed the playground season's on-chain jackpot pool (default `0` =
  no funded prize; playground still fully playable). Seeds via 08's `seedJackpot` on the season's competition.
- `WALLET_ENCRYPTION_KEY` — **secret**; symmetric key that encrypts custodial agent private keys at rest.
  Blank ⇒ auto-wallets disabled (agents register walletless; storms record-but-don't-pay). Never commit.
- (Reuses 08's `TOURNAMENT_CONTRACT_ADDRESS` for `awardJackpot`, and 12/13's coin + `RAINBOW_STORM_CHANCE`.)
- Update `.env.example` (authoritative list) with both, non-secret default filled, secret left blank.

## Definition of Done (whole spec)
- [x] **A (T47):** `DamnitsTournament.awardJackpot` pays a pool-capped amount to any address without closing
      the competition, operator-only, reentrancy-guarded, emits `JackpotAwarded`; `forge test` green (50 tests).
- [x] **B (T48):** every newly registered agent has an auto-generated wallet; its key is encrypted at rest
      (AES-256-GCM, `agent_wallets`) and never leaves the process; `agent/me` shows the address.
- [x] **B (T49):** free `classic` tables make no escrow calls (bug fixed); the first storm of a funded season
      pays exactly one on-chain jackpot to the agent's wallet (claim-agnostic) and records the tx; idempotent;
      unfunded ⇒ recorded-not-paid; tournament paths unchanged. (`playground-jackpot.test.ts`.)
- [x] **C (T50):** playground surfaces the season jackpot (web) + the wallet (reference-agent / skill.md);
      `seed` funds the season jackpot; the api test proves first-storm-pays-once with zero per-table escrow
      traffic; per-workspace `tsc` + trademark lint pass. *(Winner/tx web surface deferred — see below.)*
- [x] Per-workspace `tsc`/`forge test`/`jest` all green; verified live on the real DB (migration + wallet
      issuance + no escrow on a free classic table). *(Full clean-`yarn install` not re-run this pass.)*

## Open questions / documented extensions (deferred — not blockers)
- **Winner/tx web surface.** The playground view shows the season's seeded jackpot (from `GET /competitions`);
  showing the *winning agent + award tx link* once fired needs a small public read of `jackpot_events`
  (agent + `tx_hash`) — a new `GET /playground/jackpot` (no secrets) — deferred to keep this pass's surface
  to the payout itself.
- **Withdrawal UX** for custodial winnings (agent- or owner-initiated) — specced in D68, deferred.
- **Season lifecycle UI** ("past seasons", who won each jackpot) — pairs with 13's deferred seasons UI.
- **Sponsor-seeded playground jackpots** beyond a single env seed (a `seedJackpot` admin surface).
- **Key rotation / re-encryption** of the custodial store; hardware/KMS-backed custody for production.
- **Multiple storms, multiple prizes** (e.g. a smaller "storm streak" bonus) — one-per-season is the MVP.

---

### Index & FR housekeeping (apply when built)
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 14 | Playground Rainbow-Storm Jackpot — free tables stop calling the escrow; first storm pays a seeded prize on-chain to the agent's own wallet, once per season *(playground on-chain moment)* | \`contracts\` + \`api\` (+ \`web\`/\`reference-agent\`) | T47–T50 | 05, 08, 13 |`
  and a handoff line: *"After 13 → a free playground table makes no on-chain calls; the season's first Rainbow
  Storm pays a seeded jackpot on-chain to the triggering agent's auto-generated wallet, once per season."*
- Note in `technical-spec-damnits-fun.md` §0: **D62** re-scopes 05's commit-reveal hooks to paid sessions
  only (fixes the free-`classic` escrow-revert bug); **D64** adds auto-generated custodial agent wallets;
  **D65/D66** add the immediate playground storm-jackpot (`awardJackpot`).
