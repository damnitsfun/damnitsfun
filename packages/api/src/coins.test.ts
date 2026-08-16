import {
  COIN_SPLIT_SMOOTHING,
  LOSS_FLOOR_BY_PLACE,
  PLAYGROUND_ENTRY_COINS,
  STARTING_COINS,
  computeCoinSettlement,
} from './coins';

/**
 * Playground coin settlement (sub-spec 12, T41). The mechanism, with the source
 * game's ×multiplier removed: the bottom half of a 4-seat table forfeits coins
 * by placement (3rd ≥ 40, 4th ≥ 60), the top half splits that pot fewer-points-
 * first, it is zero-sum, and it never drives a balance below 0.
 */
describe('computeCoinSettlement', () => {
  const rich = { a: 1000, b: 1000, c: 1000, d: 1000 };

  it('redistributes only the forfeits when no buy-in pot is passed (sums to 0)', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 10, c: 30, d: 55 },
      balances: rich,
    });
    const sum = Object.values(deltas).reduce((s, x) => s + x, 0);
    expect(sum).toBe(0);
  });

  it('pools the entry buy-ins into the winnings (deltas sum to entryPot)', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 10, c: 30, d: 55 },
      balances: rich,
      entryPot: 40,
    });
    // Losers still only forfeit their (floored) points…
    expect(deltas.c).toBeLessThan(0);
    expect(deltas.d).toBeLessThan(0);
    const lost = -(deltas.c! + deltas.d!);
    // …and the winners take those forfeits PLUS the 40-coin pool.
    expect(deltas.a! + deltas.b!).toBe(lost + 40);
    // The whole settlement returns exactly the pooled buy-ins to circulation.
    expect(Object.values(deltas).reduce((s, x) => s + x, 0)).toBe(40);
  });

  it('makes the top half win and the bottom half lose', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 10, c: 30, d: 55 },
      balances: rich,
    });
    expect(deltas.a).toBeGreaterThan(0);
    expect(deltas.b).toBeGreaterThan(0);
    expect(deltas.c).toBeLessThan(0);
    expect(deltas.d).toBeLessThan(0);
  });

  it('applies the placement floors (3rd ≥ 40, 4th ≥ 60) when hand points are low', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 5, c: 2, d: 1 }, // losers hold almost nothing
      balances: rich,
    });
    expect(-deltas.c!).toBe(LOSS_FLOOR_BY_PLACE[3]); // 40
    expect(-deltas.d!).toBe(LOSS_FLOOR_BY_PLACE[4]); // 60
    // Pot = 100; winners split it.
    expect(deltas.a! + deltas.b!).toBe(100);
  });

  it('uses points above the floor when the hand is heavy', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 10, c: 90, d: 120 },
      balances: rich,
    });
    expect(-deltas.c!).toBe(90);
    expect(-deltas.d!).toBe(120);
    expect(deltas.a! + deltas.b!).toBe(210);
  });

  it('gives the winner with fewer points the bigger share', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 40, c: 50, d: 70 }, // 2nd holds a lot → 1st wins bigger
      balances: rich,
    });
    expect(deltas.a!).toBeGreaterThan(deltas.b!);
  });

  it('never drives a balance below zero (bankruptcy cap)', () => {
    const deltas = computeCoinSettlement({
      places: { a: 1, b: 2, c: 3, d: 4 },
      handValues: { a: 0, b: 10, c: 90, d: 120 },
      balances: { a: 1000, b: 1000, c: 25, d: 5 }, // near-broke losers
    });
    expect(-deltas.c!).toBeLessThanOrEqual(25);
    expect(-deltas.d!).toBeLessThanOrEqual(5);
    // Still zero-sum: winners only split what was actually collected.
    expect(Object.values(deltas).reduce((s, x) => s + x, 0)).toBe(0);
    expect(deltas.a! + deltas.b!).toBe(30);
  });

  it('exposes the configured economy constants', () => {
    expect(STARTING_COINS).toBe(1000);
    expect(PLAYGROUND_ENTRY_COINS).toBe(10);
    expect(COIN_SPLIT_SMOOTHING).toBeGreaterThan(0);
  });

  /**
   * Sub-spec 18 (D103/D109) — tables become 3–6 seats. Everything above exercises
   * exactly four, which is how places 5 and 6 came to have no floor at all: they
   * could not occur, so nobody noticed `?? 0` standing in for one.
   */
  describe('variable table sizes (3–6 seats)', () => {
    const balances = (ids: string[]): Record<string, number> =>
      Object.fromEntries(ids.map((id) => [id, 1000]));

    it('splits a 3-seat table two winners to one loser', () => {
      const deltas = computeCoinSettlement({
        places: { a: 1, b: 2, c: 3 },
        handValues: { a: 0, b: 12, c: 44 },
        balances: balances(['a', 'b', 'c']),
        entryPot: 30,
      });
      // half = ceil(3/2) = 2 → places 1-2 win, place 3 loses.
      expect(deltas.a!).toBeGreaterThan(0);
      expect(deltas.b!).toBeGreaterThan(0);
      expect(deltas.c!).toBeLessThan(0);
      expect(Object.values(deltas).reduce((s, x) => s + x, 0)).toBe(30);
    });

    it('applies the new floors to 5th and 6th place', () => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      const deltas = computeCoinSettlement({
        places: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
        // Every loser holds a trivial hand, so the FLOOR is what must bite.
        handValues: { a: 0, b: 2, c: 3, d: 1, e: 1, f: 1 },
        balances: balances(ids),
        entryPot: 60,
      });
      expect(-deltas.d!).toBe(LOSS_FLOOR_BY_PLACE[4]);
      expect(-deltas.e!).toBe(LOSS_FLOOR_BY_PLACE[5]);
      expect(-deltas.f!).toBe(LOSS_FLOOR_BY_PLACE[6]);
      // The gradient must keep pointing the same way: further down costs more.
      expect(-deltas.f!).toBeGreaterThan(-deltas.e!);
      expect(-deltas.e!).toBeGreaterThan(-deltas.d!);
    });

    it('stays zero-sum against the entry pot at every seat count', () => {
      for (const n of [3, 4, 5, 6]) {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, n);
        const entryPot = n * PLAYGROUND_ENTRY_COINS;
        const deltas = computeCoinSettlement({
          places: Object.fromEntries(ids.map((id, i) => [id, i + 1])),
          handValues: Object.fromEntries(ids.map((id, i) => [id, i * 17])),
          balances: balances(ids),
          entryPot,
        });
        expect(Object.values(deltas).reduce((s, x) => s + x, 0)).toBe(entryPot);
      }
    });

    it('still caps a loser at what they hold on a six-seat table', () => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      const deltas = computeCoinSettlement({
        places: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
        handValues: { a: 0, b: 5, c: 9, d: 70, e: 90, f: 120 },
        balances: { ...balances(ids), f: 12 },   // nearly broke in last place
        entryPot: 60,
      });
      expect(-deltas.f!).toBe(12);               // never more than the balance
      expect(Object.values(deltas).reduce((s, x) => s + x, 0)).toBe(60);
    });
  });
});
