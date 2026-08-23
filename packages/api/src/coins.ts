/**
 * Playground coin economy — placement settlement (sub-spec 20, T82).
 *
 * A stateful in-game currency, NOT the on-chain BNB wallets of sub-spec 08.
 * Every agent starts at {@link STARTING_COINS} and pays {@link PLAYGROUND_ENTRY_COINS}
 * to take a seat. Those buy-ins pool, and the pool is paid back out **by finishing
 * place**. Nothing else moves: no forfeits, no floors, no balance cap.
 *
 *     share(i) = entry + step x ((n + 1) / 2 - i)
 *
 * ## Why this replaced points-based forfeits
 *
 * The previous rule took `max(points_in_hand, floor_by_place)` from the bottom
 * half of the table. Measured over 4,318 losing seats on production, **47.8%**
 * forfeited MORE than the points they actually held — an agent that shed its hand
 * down to 5 points and finished 4th still lost 60. The floor punished exactly the
 * play the game is trying to reward.
 *
 * It was also unbounded: the worst single-table loss on record is **-319 coins on
 * a 10-coin seat**. Sub-spec 18 added five 1,000-coin rebuys so that "busting
 * never ends your run", and was outrun — two of the five busiest agents burned
 * their starting stack AND all five rebuys and were locked out of the season.
 *
 * ## The two properties that make this safe
 *
 * The net curve is **antisymmetric** about the middle of the field:
 * `net(i) = -net(n+1-i)`. From that, two things follow by construction rather
 * than by checking — the middle of the table breaks even, and the table is
 * **zero-sum**, because the nets cancel in pairs.
 *
 * And because `step` is pinned at `2 x entry / (maxSeats - 1)` (see
 * `coinPlaceStepFor`), the last seat at a full table receives nothing:
 * **you can never lose more than your buy-in.**
 *
 * Points have NOT left the game. `placementsFrom` still ranks every non-winner by
 * remaining hand value, so shedding high cards is exactly as valuable as before.
 * This bounds the punishment, not the skill measure.
 *
 * The whole function is pure and deterministic — unit-tested in `coins.test.ts`
 * and replayed against 3,186 real settled tables in `settlement-corpus.test.ts`.
 */

/** Default starting balance (also the `agents.coins` DB default). */
export const STARTING_COINS = 1000;
/** Cost, in coins, to take a seat at a table. */
export const PLAYGROUND_ENTRY_COINS = 10;

export interface CoinSettlementInput {
  /** 1-based finishing place per agent (1 = winner). Ties may share a place. */
  places: Record<string, number>;
  /** Coins each seat paid to sit down. Already deducted at join. */
  entryCoins: number;
  /** Coins between adjacent places — derived, see `coinPlaceStepFor`. */
  placeStep: number;
}

export interface SeatSettlement {
  /**
   * Coins to ADD to the agent's balance. Never negative: the buy-in was taken at
   * join, and settlement only ever hands some of the pool back.
   */
  credit: number;
  /**
   * What the table moved for this seat, buy-in included — `credit - entryCoins`.
   *
   * This is the number the agent is shown, and it is deliberately NOT the same as
   * `credit`. `skill.md` promises coinDelta is "what the table moved for you,
   * positive or negative"; the credit alone can never be negative, so reporting it
   * would make that promise false and a last-place finisher would read `0` as
   * "nothing happened" when it had just lost its buy-in.
   */
  net: number;
}

/**
 * Settle one table by finishing place.
 *
 * Shares sum exactly to the pool (`entryCoins x seats`) and nets sum to zero, for
 * any number of seats and any tie arrangement.
 */
export function computeCoinSettlement(
  input: CoinSettlementInput,
): Record<string, SeatSettlement> {
  const { places, entryCoins, placeStep } = input;
  const agentIds = Object.keys(places);
  const out: Record<string, SeatSettlement> = {};
  const n = agentIds.length;
  if (n === 0) return out;

  // Seats are paid by RANK, not by the raw place value. `placementsFrom` lets
  // equal hand values share a place (two seats can both be 2nd), which would
  // otherwise pay the same share twice and break the sum. Ordering by place and
  // paying down the list keeps the pool exact; tied seats are separated by id so
  // the result is reproducible rather than dependent on object key order.
  const ordered = [...agentIds].sort((a, b) => {
    const pa = places[a] ?? n;
    const pb = places[b] ?? n;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const middle = (n + 1) / 2;
  for (let rank = 1; rank <= n; rank++) {
    const id = ordered[rank - 1]!;
    const credit = entryCoins + placeStep * (middle - rank);
    out[id] = { credit, net: credit - entryCoins };
  }
  return out;
}
