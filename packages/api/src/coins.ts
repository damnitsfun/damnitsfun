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
  /**
   * Seat order (the order seats were dealt), used for ONE purpose: resolving a
   * rounding remainder when a tied group's mean share is fractional (D152).
   *
   * It is deliberately not the agent id. Deal order is something the agent took
   * part in; its id is a string it was handed at registration, and settling money
   * on that ordered every tie in favour of the same agents forever — measured at
   * 142 of 142 tied groups on production (sub-spec 22 § A). Seats missing from
   * this list keep the order they arrived in.
   */
  seatOrder?: readonly string[];
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
 *
 * ## Tied seats are paid the same (sub-spec 22, D150)
 *
 * `placementsFrom` lets equal hand values SHARE a place. This used to pay them by
 * rank anyway and separate them with `agentId < agentId` — so two seats reported
 * at the same place received different money, and the agent whose id sorted lower
 * won. On production that was **142 of 142 tied groups, with no exceptions**, on
 * 10.2% of tables: not a tie-break but a permanent advantage keyed to a string.
 *
 * So a tied group of `k` seats spanning ranks `r … r+k-1` now splits the shares of
 * that whole span equally. The pool stays exact — the same shares are paid, just
 * redistributed inside the group — so the zero-sum and antisymmetry properties
 * above are untouched. And because averaging can only move a share UP from the
 * span's minimum (the last rank pays a credit of 0), no seat can lose more than
 * its buy-in, still by construction rather than by check.
 */
export function computeCoinSettlement(
  input: CoinSettlementInput,
): Record<string, SeatSettlement> {
  const { places, entryCoins, placeStep, seatOrder } = input;
  const agentIds = Object.keys(places);
  const out: Record<string, SeatSettlement> = {};
  const n = agentIds.length;
  if (n === 0) return out;

  // Deal order, used only to break a rounding remainder (D152). Anything absent
  // from `seatOrder` keeps the order it arrived in, which keeps the function
  // total even when a caller does not supply one.
  const dealOrder = new Map<string, number>();
  (seatOrder ?? []).forEach((id, i) => dealOrder.set(id, i));
  agentIds.forEach((id, i) => {
    if (!dealOrder.has(id)) dealOrder.set(id, (seatOrder?.length ?? 0) + i);
  });

  // Group the seats that SHARE a place. Groups are ordered by place and nothing
  // else — no agent id is read here or anywhere below (D151).
  const groups = new Map<number, string[]>();
  for (const id of agentIds) {
    const place = places[id] ?? n;
    const existing = groups.get(place);
    if (existing) existing.push(id);
    else groups.set(place, [id]);
  }
  const byPlace = [...groups.entries()].sort((a, b) => a[0] - b[0]);

  // `share(rank)` doubled, so the `(n+1)/2` midpoint stays integer arithmetic and
  // the only division left is the one the tie rule actually asks for.
  const share2 = (rank: number): number => 2 * entryCoins + placeStep * (n + 1 - 2 * rank);

  interface Draft {
    id: string;
    whole: number;
    /** Numerator of the leftover fraction, over `denominator`. */
    remainder: number;
    denominator: number;
    order: number;
  }
  const drafts: Draft[] = [];
  let rank = 1;
  for (const [, members] of byPlace) {
    const k = members.length;
    let sum2 = 0;
    for (let r = rank; r < rank + k; r++) sum2 += share2(r);
    // Every member of the group receives sum2 / (2k) — exactly, as a rational.
    const denominator = 2 * k;
    const whole = Math.floor(sum2 / denominator);
    const remainder = sum2 - whole * denominator;
    for (const id of members) {
      drafts.push({ id, whole, remainder, denominator, order: dealOrder.get(id) ?? 0 });
    }
    rank += k;
  }

  // Largest remainder, so the pool is neither short nor over. Rounding each share
  // independently would not sum: three seats splitting 5 coins would pay 6 or 3.
  // The exact credits always total the pool (they are the same shares, reordered),
  // so `leftover` is the whole-coin shortfall the floors introduced.
  const pool = entryCoins * n;
  const distributed = drafts.reduce((sum, d) => sum + d.whole, 0);
  let leftover = pool - distributed;
  const queue = [...drafts].sort((a, b) => {
    const fa = a.remainder / a.denominator;
    const fb = b.remainder / b.denominator;
    if (fa !== fb) return fb - fa;
    return a.order - b.order;
  });
  const bonus = new Map<string, number>();
  for (const draft of queue) {
    if (leftover <= 0) break;
    bonus.set(draft.id, 1);
    leftover--;
  }

  for (const draft of drafts) {
    const credit = draft.whole + (bonus.get(draft.id) ?? 0);
    out[draft.id] = { credit, net: credit - entryCoins };
  }
  return out;
}
