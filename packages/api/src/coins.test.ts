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

/**
 * Sub-spec 22 (T98/T99) — ties.
 *
 * `placementsFrom` lets equal hand values share a place. Settlement used to pay
 * those seats by RANK anyway and separate them with `agentId < agentId`, so two
 * seats reported at the same place got different money. On production that fired
 * on 10.2% of tables and went the same way **142 times out of 142** — a permanent
 * advantage keyed to a registration string. These pin the fix.
 */
describe('computeCoinSettlement — tied seats (D150–D152)', () => {
  /** Settle an explicit place map (ties allowed). */
  const settlePlaces = (
    places: Record<string, number>,
    seatOrder?: readonly string[],
  ): Record<string, SeatSettlement> =>
    computeCoinSettlement({ places, entryCoins: ENTRY, placeStep: STEP, seatOrder });

  it('pays seats that share a place identically', () => {
    // Two seats tie for 2nd at a six-seat table: they split ranks 2 and 3.
    const s = settlePlaces({ a: 1, b: 2, c: 2, d: 4, e: 5, f: 6 });
    expect(s.b!.net).toBe(s.c!.net);
    expect(s.b!.net).toBe((6 + 2) / 2); // mean of rank 2 and rank 3
  });

  it('splits a three-way tie across the three ranks it spans', () => {
    const s = settlePlaces({ a: 1, b: 2, c: 2, d: 2, e: 5, f: 6 });
    expect(s.b!.net).toBe(s.c!.net);
    expect(s.c!.net).toBe(s.d!.net);
    expect(s.b!.net).toBe((6 + 2 + -2) / 3); // ranks 2, 3, 4
  });

  it('is unchanged by the agent ids — the bias that was measured', () => {
    // Same table, same finishing order, different names. Under the old rule the
    // ids decided who took the better half of every tie; now they decide nothing.
    const shape = [1, 2, 2, 4, 4, 6];
    const namesA = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const namesB = ['z9', 'y8', 'x7', 'w6', 'v5', 'u4'];
    const byIndexA = settlePlaces(Object.fromEntries(namesA.map((id, i) => [id, shape[i]!])), namesA);
    const byIndexB = settlePlaces(Object.fromEntries(namesB.map((id, i) => [id, shape[i]!])), namesB);
    expect(namesA.map((id) => byIndexA[id]!.net)).toEqual(namesB.map((id) => byIndexB[id]!.net));
  });

  it('does not care what order the seats are handed to it', () => {
    const places: Record<string, number> = { a: 1, b: 2, c: 2, d: 4, e: 5, f: 6 };
    const forwards = settlePlaces(places);
    // Built by walking the entries back to front by index rather than with the
    // obvious array method, whose name is one of the vendored card terms the CI
    // trademark lint guards outside packages/engine.
    const entries = Object.entries(places);
    const flipped: Record<string, number> = {};
    for (let i = entries.length - 1; i >= 0; i--) flipped[entries[i]![0]] = entries[i]![1];
    const backwards = settlePlaces(flipped);
    for (const id of Object.keys(places)) expect(backwards[id]!.net).toBe(forwards[id]!.net);
  });

  /**
   * Exhaustive rather than sampled: every way a field of 3–6 can tie is a small
   * enough space to enumerate, and the properties must hold on all of them.
   */
  it('keeps the pool exact and the table zero-sum on every tie arrangement, 3–6 seats', () => {
    let checked = 0;
    for (let n = 3; n <= 6; n++) {
      // Every "shared place" pattern: walk the seats in finishing order, and at
      // each step either share the previous place or start a new one.
      for (let mask = 0; mask < 1 << (n - 1); mask++) {
        const places: number[] = [1];
        for (let i = 1; i < n; i++) {
          places.push((mask >> (i - 1)) & 1 ? places[i - 1]! : i + 1);
        }
        const ids = Array.from({ length: n }, (_, i) => `s${i}`);
        const s = settlePlaces(Object.fromEntries(ids.map((id, i) => [id, places[i]!])), ids);
        const credits = ids.map((id) => s[id]!.credit);
        const nets = ids.map((id) => s[id]!.net);

        expect(credits.reduce((a, b) => a + b, 0)).toBe(ENTRY * n); // pool exact
        expect(nets.reduce((a, b) => a + b, 0)).toBe(0);            // zero-sum
        for (const c of credits) expect(c).toBeGreaterThanOrEqual(0); // never below the buy-in
        for (const net of nets) expect(net).toBeGreaterThanOrEqual(-ENTRY);
        for (const c of credits) expect(Number.isInteger(c)).toBe(true);

        // Seats sharing a place are paid the same, by construction.
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            if (places[i] === places[j]) expect(nets[i]).toBe(nets[j]);
          }
        }
        checked++;
      }
    }
    expect(checked).toBe(4 + 8 + 16 + 32);
  });
});

/**
 * Sub-spec 22 (T108/D167) — the sizes production stops dealing.
 *
 * Table size is bimodal under load: over the last 1,000 settled seats of the
 * 4,004-table run, 944 were six-seat and 56 three-seat, with **no four- or
 * five-seat tables at all**. The lobby rule is right (fill to six, or deal on the
 * countdown at the minimum) and a thin field still produces the middle sizes — but
 * a busy one does not, so production traffic cannot be trusted to exercise them.
 * That coverage has to live here instead.
 */
describe('every table size the battleground can deal (D167)', () => {
  const config = loadConfig({ env: {} });

  it('brackets the sizes it advertises', () => {
    expect(config.tableMinSize).toBeGreaterThanOrEqual(2);
    expect(config.tableMaxSize).toBeGreaterThanOrEqual(config.tableMinSize);
    // The step is derived from the MAXIMUM seat count, so a settlement at any
    // smaller table is a prefix of the same curve rather than a separate rule.
    expect(coinPlaceStepFor(config.playgroundEntryCoins, config.tableMaxSize)).toBeGreaterThan(0);
  });

  it('settles correctly at every size in that range, tied and untied', () => {
    const entry = config.playgroundEntryCoins;
    const step = coinPlaceStepFor(entry, config.tableMaxSize);
    for (let n = config.tableMinSize; n <= config.tableMaxSize; n++) {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);

      const clean = computeCoinSettlement({
        places: Object.fromEntries(ids.map((id, i) => [id, i + 1])),
        entryCoins: entry,
        placeStep: step,
        seatOrder: ids,
      });
      const cleanNets = ids.map((id) => clean[id]!.net);
      expect(cleanNets.reduce((a, b) => a + b, 0)).toBe(0);
      expect(Math.min(...cleanNets)).toBeGreaterThanOrEqual(-entry);
      // Strictly descending: without a tie, every place is worth more than the next.
      for (let i = 1; i < n; i++) expect(cleanNets[i]!).toBeLessThan(cleanNets[i - 1]!);

      // ...and with the whole field tied, which is the extreme of D150.
      const allTied = computeCoinSettlement({
        places: Object.fromEntries(ids.map((id) => [id, 1])),
        entryCoins: entry,
        placeStep: step,
        seatOrder: ids,
      });
      const tiedNets = ids.map((id) => allTied[id]!.net);
      expect(tiedNets.reduce((a, b) => a + b, 0)).toBe(0);
      expect(new Set(tiedNets).size).toBe(1); // level finish, level money
    }
  });
});
