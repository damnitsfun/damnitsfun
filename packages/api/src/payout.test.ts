import { assertValidCurve, distributePool, payoutRankCount } from './payout';

/** The default base curve from §9 / sub-spec 08. */
const CURVE = [30, 20, 14, 10, 8, 6, 4.5, 3, 2.5, 2];
const FRACTION = 0.2;

describe('payoutRankCount (D14 field scaling)', () => {
  it('is winner-take-all for a tiny field', () => {
    expect(payoutRankCount(4, CURVE.length, FRACTION)).toBe(1); // ceil(0.8) = 1
  });

  it('scales up with the field, capped at the curve length', () => {
    expect(payoutRankCount(10, CURVE.length, FRACTION)).toBe(2); // ceil(2.0)
    expect(payoutRankCount(15, CURVE.length, FRACTION)).toBe(3); // ceil(3.0)
    expect(payoutRankCount(50, CURVE.length, FRACTION)).toBe(10); // ceil(10) capped at 10
    expect(payoutRankCount(500, CURVE.length, FRACTION)).toBe(10); // capped
  });

  it('pays at least one rank whenever there is a field', () => {
    expect(payoutRankCount(1, CURVE.length, FRACTION)).toBe(1);
  });

  it('pays nobody when the field is empty', () => {
    expect(payoutRankCount(0, CURVE.length, FRACTION)).toBe(0);
  });
});

describe('distributePool (D14 split)', () => {
  it('gives the whole pool to rank 1 in a small field', () => {
    const pool = 1_000_000_000_000_000_000n; // 1 tBNB
    const amounts = distributePool(pool, 4, CURVE, FRACTION);
    expect(amounts).toEqual([pool]);
  });

  it('always distributes the pool exactly (dust → rank 1)', () => {
    // 7 wei across a field that pays 3 ranks — deliberately indivisible.
    const pool = 7n;
    const amounts = distributePool(pool, 15, CURVE, FRACTION);
    expect(amounts).toHaveLength(3);
    expect(amounts.reduce((s, a) => s + a, 0n)).toBe(pool);
    // Rank 1 carries the remainder, so it is >= the others.
    expect(amounts[0]).toBeGreaterThanOrEqual(amounts[1]!);
  });

  it('respects the renormalized curve proportions for a large pool', () => {
    const pool = 100_000_000_000_000_000_000n; // 100 tBNB, divisible enough
    const amounts = distributePool(pool, 15, CURVE, FRACTION); // top 3: [30,20,14] → renormalized
    expect(amounts).toHaveLength(3);
    expect(amounts.reduce((s, a) => s + a, 0n)).toBe(pool);
    // Renormalized weights: 30/64, 20/64, 14/64. Ranks strictly descending.
    expect(amounts[0]).toBeGreaterThan(amounts[1]!);
    expect(amounts[1]).toBeGreaterThan(amounts[2]!);
    // Rank 1 ≈ 30/64 of the pool (allow ±1 rank-1 dust).
    const expectedRank1 = (pool * 30n) / 64n;
    const delta = amounts[0]! - expectedRank1;
    expect(delta >= 0n && delta < 64n).toBe(true);
  });

  it('returns nothing for an empty pool or empty field', () => {
    expect(distributePool(0n, 10, CURVE, FRACTION)).toEqual([]);
    expect(distributePool(1000n, 0, CURVE, FRACTION)).toEqual([]);
  });

  it('never over-distributes (the on-chain invariant sum(amounts) <= pool holds as equality)', () => {
    for (const field of [1, 2, 3, 7, 11, 23, 40, 99]) {
      for (const pool of [1n, 3n, 5n, 999n, 10n ** 18n, 123456789n]) {
        const amounts = distributePool(pool, field, CURVE, FRACTION);
        const sum = amounts.reduce((s, a) => s + a, 0n);
        expect(sum).toBe(pool);
        expect(amounts.every((a) => a >= 0n)).toBe(true);
      }
    }
  });
});

describe('assertValidCurve', () => {
  it('accepts the default curve (sums to 100)', () => {
    expect(() => assertValidCurve(CURVE)).not.toThrow();
  });

  it('rejects a curve that does not sum to 100', () => {
    expect(() => assertValidCurve([50, 40])).toThrow(/sum to 100/);
  });

  it('rejects an empty or negative curve', () => {
    expect(() => assertValidCurve([])).toThrow();
    expect(() => assertValidCurve([120, -20])).toThrow();
  });
});
