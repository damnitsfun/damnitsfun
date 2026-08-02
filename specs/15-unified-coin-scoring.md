# Sub-Spec 15 — Unified coin scoring (tournament follows the playground; openskill removed)

**Status:** built (103 api tests + trademark lint green; type-check clean). A hackathon simplification: collapse the
two scoring systems into one. Until now the **playground** ranked by an off-chain **coin** economy while the
**tournament** ranked by **openskill** `ordinal()` (μ − 3σ) and split its on-chain prize by that rating. This
spec makes **both** game types score by **coins** and **removes openskill entirely**.

**Silo(s):** `packages/api` (coin economy for both kinds; coins-ranked tournament + payout; drop openskill) +
`packages/web` (tournament board relabelled to coins) + docs.
**Depends on:** 08 (pooled tournament + on-chain prize/jackpot + `eligibleRanked`/payout), 12/13 (coin economy,
playground/tournament split, `computeCoinSettlement`), 14 (custodial wallets + storm jackpot).
Slots **after 14**. **Supersedes** 13 D53/D58/D59 (coins were playground-only; tournament ranked by openskill)
and the parent spec §2 ranking pin.
**Handoff artifact:** a tournament whose leaderboard is ranked by coins and whose on-chain pool pays the **top 10
coin-holders**; a codebase with no openskill dependency.

---

## Design decisions locked for this spec

| # | Decision | Chosen | Alternative (not built) |
|---|---|---|---|
| D69 | One scoring system | **Both** `classic` and `tournament` tables charge the 10-coin buy-in and settle coins by placement (`computeCoinSettlement`); coins are a single global `agents.coins` balance. Reverts 13 D58 (coins were classic-only). | Keep coins playground-only; two scoring systems |
| D70 | Tournament ranks by coins | `eligibleRanked` and `leaderboard(competitionId)` sort by **coins** desc (not μ − 3σ). Eligibility unchanged: X-verified owner + payout address + ≥ `MIN_RANKED_SESSIONS` games. | Rank by openskill (13 D59) |
| D71 | Prize pays the **top 10** | The on-chain pool is split among the top 10 coin-holders: `PAYOUT_FIELD_FRACTION` default → **`1.0`**, so `N = min(ceil(1.0 × field), curve length = 10)`. The existing 10-tier `PAYOUT_SCHEDULE_JSON` defines the split; `distributePool` is unchanged. | Keep 0.20 field fraction (≈ top 20%) |
| D72 | Remove openskill | Drop the `openskill` dependency; `ranking.ts` keeps only `placementsFrom` (coins need it). Delete `updateRatings`, `conservativeRating`, `rateSession`, `defaultRating`. The `trueskill_mu/sigma` columns stay in the schema (unused) — no destructive migration. | Keep openskill computed-but-unused |
| D73 | Storm jackpot stays playground-only | The Rainbow-Storm jackpot (14) still fires for `classic` seasons only; coin *settlement* now runs for both kinds, but the on-chain storm award does not change. | Extend the storm jackpot to tournaments too |

> **Why.** For a hackathon, one legible score (coins) beats two (coins + a μ − 3σ rating most people won't
> read). Coins already work, conserve zero-sum, and are public; ranking the tournament by them and paying the
> top 10 is the smallest model that keeps the on-chain prize meaningful. openskill's licence rationale
> (vs TrueSkill) no longer matters once no rating is used at all.

---

## Changes

**API (`packages/api`)**
- `joinSession`: charge `PLAYGROUND_ENTRY_COINS` for **both** kinds (was classic-only). A tournament seat still
  also requires its one-time on-chain entry (`/competition/enter`) — the coin buy-in is per table, on top.
- `settle`: `settleCoins` runs for **every** settled table; the storm-jackpot award stays gated to `classic`.
- `eligibleRanked` / `leaderboard` / `leaderboardRoot`: sort/rank/hash by **coins**.
- `settleTournament`: unchanged flow — it now ranks by coins (via `eligibleRanked`) and pays the top 10 (via the
  default `PAYOUT_FIELD_FRACTION=1.0`).
- `registerAgent`: stop writing `trueskill_*` (schema defaults apply). Remove `updateRatings`.
- `ranking.ts`: keep only `placementsFrom`. `config`: `PAYOUT_FIELD_FRACTION` default `1.0`. Drop `openskill`
  from `package.json`. Introspection + `/agent/me`-adjacent `sessionInfo` expose `coins`, not a rating.

**Web (`packages/web`)** — the tournament view is relabelled from "conservative rating (μ − 3σ)" to coins; the
"ranking" stat and rules copy say coins + "top 10 split the prize"; the profile agents table shows coins.

**Docs** — CLAUDE.md (two-game-types note + tech-stack ranking row), `.env.example` (`PAYOUT_FIELD_FRACTION=1.0`),
technical-spec §0, and `skill.md` (leaderboard sorted by `coins`; prize to the top 10).

## Safety boundary
- Changes an existing **money movement** (the tournament prize distribution) — now ordered by coins, still
  operator-signed, still capped on-chain by `sum(amounts) ≤ pool`, still gated on claim + payout address +
  `MIN_RANKED_SESSIONS`. No new external calls; the escrow/tournament contracts are unchanged.
- No secrets touched; `/competition/leaderboard` still exposes only public fields (now `coins`).

## New / changed config (§9)
- `PAYOUT_FIELD_FRACTION` default `0.20` → **`1.0`** (pay the top 10). No new variables.

## Definition of Done
- [x] Both kinds charge + settle coins; tournament `leaderboard`/`eligibleRanked`/payout rank by coins; top 10 paid.
- [x] openskill removed (dep dropped, `ranking.ts` trimmed, `updateRatings` gone); `trueskill_*` columns left unused.
- [x] Web tournament board + profile show coins; introspection/skill.md updated.
- [x] 103 api tests + reference-agent tests green; `tsc` + trademark lint clean.

## Open questions / deferred
- The web tournament board still displays a **tables-won/played** public proxy (no auth); a public
  coins-by-competition read would let it show the exact coin ranking — deferred.
- The `trueskill_*` columns and `MIN_RANKED_SESSIONS`/curve machinery remain; a later cleanup could drop them.

---

### Index & FR housekeeping
- Add to `specs/00-INDEX-and-build-order.md`:
  `| 15 | Unified coin scoring — tournament follows the playground (both rank by coins; prize to the top 10); openskill removed *(hackathon simplification)* | \`api\` + \`web\` | — | 08, 12, 13, 14 |`
- Note it **supersedes 13 D53/D58/D59** and the parent §2 ranking pin (recorded in technical-spec §0).
