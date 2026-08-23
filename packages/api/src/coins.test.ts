import { coinPlaceStepFor, fractionalShareSizes, loadConfig } from './config';
import {
  computeCoinSettlement,
  PLAYGROUND_ENTRY_COINS,
  STARTING_COINS,
  type SeatSettlement,
} from './coins';

/**
 * Sub-spec 20 (T84) — placement settlement.
 *
 * The rule these replace took `max(points, floor)` from the bottom half of the
 * table. Measured over 4,318 real losing seats, 47.8% forfeited MORE than the
 * points they held, and the worst single-table loss was -319 coins on a 10-coin
 * seat. Everything below exists to pin the two properties that fix that: the
 * table is zero-sum, and no seat can lose more than its buy-in.
 */
const ENTRY = 10;
const STEP = coinPlaceStepFor(ENTRY, 6); // 4

/** Seat n agents 1st..nth. */
const table = (n: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i + 1}`, i + 1]));

const settle = (n: number, entry = ENTRY, step = STEP): Record<string, SeatSettlement> =>
  computeCoinSettlement({ places: table(n), entryCoins: entry, placeStep: step });

const nets = (s: Record<string, SeatSettlement>): number[] =>
  Object.keys(s)
    .sort()
    .map((k) => s[k]!.net);

describe('computeCoinSettlement — the shape of the curve', () => {
  it('pays the table the spec advertises, seat for seat', () => {
    expect(nets(settle(3))).toEqual([4, 0, -4]);
    expect(nets(settle(4))).toEqual([6, 2, -2, -6]);
    expect(nets(settle(5))).toEqual([8, 4, 0, -4, -8]);
    expect(nets(settle(6))).toEqual([10, 6, 2, -2, -6, -10]);
  });

  it('breaks even in the middle — the property the whole curve is built on', () => {
    // Odd fields have a true centre seat; it is its own mirror, so it nets zero.
    expect(nets(settle(3))[1]).toBe(0);
    expect(nets(settle(5))[2]).toBe(0);
    // Even fields straddle the centre symmetrically instead.
    const four = nets(settle(4));
    expect(four[1]).toBe(-four[2]!);
    const six = nets(settle(6));
    expect(six[2]).toBe(-six[3]!);
  });

  it('is antisymmetric about the middle at every table size', () => {
    for (const n of [3, 4, 5, 6]) {
      const v = nets(settle(n));
      // Stated as "each mirrored pair sums to zero" rather than `a === -b`, which
      // trips on JS signed zero at the centre seat (-0 is not Object.is 0).
      for (let i = 0; i < n; i++) expect(v[i]! + v[n - 1 - i]!).toBe(0);
    }
  });

  it('separates every adjacent pair by exactly one step', () => {
    for (const n of [3, 4, 5, 6]) {
      const v = nets(settle(n));
      for (let i = 1; i < n; i++) expect(v[i - 1]! - v[i]!).toBe(STEP);
    }
  });
});

describe('the two guarantees', () => {
  it('is zero-sum: nets cancel and credits pay out the pool exactly', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const s = settle(n);
      const totalNet = Object.values(s).reduce((t, x) => t + x.net, 0);
      const totalCredit = Object.values(s).reduce((t, x) => t + x.credit, 0);
      expect(totalNet).toBe(0);
      expect(totalCredit).toBe(ENTRY * n); // the pooled buy-ins, returned whole
    }
  });

  it('never lets a seat lose more than its buy-in — the headline promise', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      for (const seat of Object.values(settle(n))) {
        expect(seat.credit).toBeGreaterThanOrEqual(0); // never claws back
        expect(seat.net).toBeGreaterThanOrEqual(-ENTRY);
      }
    }
  });

  it('takes exactly the buy-in from last place at a FULL table, and no more', () => {
    const last = nets(settle(6))[5];
    expect(last).toBe(-ENTRY);
  });
});

describe('integer coins', () => {
  it('pays whole coins at every table size and every sane entry', () => {
    for (const entry of [10, 25, 50, 100]) {
      const step = coinPlaceStepFor(entry, 6);
      for (const n of [3, 4, 5, 6]) {
        for (const seat of Object.values(settle(n, entry, step))) {
          expect(Number.isInteger(seat.credit)).toBe(true);
          expect(Number.isInteger(seat.net)).toBe(true);
        }
      }
    }
  });

  it('scales linearly with the entry — structure and stakes are separate knobs', () => {
    expect(nets(settle(6, 50, coinPlaceStepFor(50, 6)))).toEqual([50, 30, 10, -10, -30, -50]);
  });

  /**
   * The step is floored to an even whole number precisely so that EVERY legal
   * seat-bound pairing is integral — the undivided form was exact only at a
   * 6-seat maximum, which would have made a 4-seat deployment unbootable.
   */
  it('is integral for every legal table maximum, not just the one we run', () => {
    for (const max of [2, 3, 4, 5, 6, 10]) {
      expect(fractionalShareSizes(10, coinPlaceStepFor(10, max), 2, max)).toEqual([]);
    }
  });

  it('keeps the step even, so half-step seats on even tables stay whole', () => {
    for (const max of [2, 3, 4, 5, 6, 10]) {
      expect(coinPlaceStepFor(10, max) % 2).toBe(0);
    }
  });

  it('refuses to boot when the entry is too small to separate the places', () => {
    // entry 1 across a 6-seat table floors to a step of 0: every seat paid the
    // same, finishing order meaningless. Better to fail loudly than rank nothing.
    expect(() =>
      loadConfig({ env: { PLAYGROUND_ENTRY_COINS: '1', TABLE_MIN_SIZE: '3', TABLE_MAX_SIZE: '6' } }),
    ).toThrow(/too small to separate/i);
  });
});

describe('edge cases', () => {
  it('returns nothing for an empty table rather than throwing', () => {
    expect(computeCoinSettlement({ places: {}, entryCoins: ENTRY, placeStep: STEP })).toEqual({});
  });

  /**
   * `placementsFrom` lets equal hand values SHARE a place, so two seats can both
   * be 2nd. Paying by the raw place value would hand out the same share twice and
   * break the pool; seats are paid by rank instead.
   */
  it('stays exact when two seats share a place', () => {
    const s = computeCoinSettlement({
      places: { w: 1, x: 2, y: 2, z: 4 },
      entryCoins: ENTRY,
      placeStep: STEP,
    });
    expect(Object.values(s).reduce((t, v) => t + v.credit, 0)).toBe(ENTRY * 4);
    expect(Object.values(s).reduce((t, v) => t + v.net, 0)).toBe(0);
  });

  it('is deterministic regardless of key order', () => {
    const a = computeCoinSettlement({
      places: { z: 3, a: 1, m: 2 },
      entryCoins: ENTRY,
      placeStep: STEP,
    });
    const b = computeCoinSettlement({
      places: { a: 1, m: 2, z: 3 },
      entryCoins: ENTRY,
      placeStep: STEP,
    });
    expect(a).toEqual(b);
  });

  it('exposes the configured economy constants', () => {
    expect(STARTING_COINS).toBe(1000);
    expect(PLAYGROUND_ENTRY_COINS).toBe(10);
  });
});
