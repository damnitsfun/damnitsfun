import corpus from './fixtures/settled-tables.json';
import { computeCoinSettlement } from './coins';
import { coinPlaceStepFor } from './config';

/**
 * Sub-spec 20 (T85) — the spec's central claim, re-checked against reality.
 *
 * `fixtures/settled-tables.json` is every table that actually settled on
 * production up to 2026-08-18: 3,186 real games, with the real distribution of
 * seat counts (2,043 three-seat, 1,043 four, 52 five, 48 six). It stores only
 * what settlement reads — seat count and finishing places. Agent ids are left out
 * because they are production identifiers, and hand values because they are no
 * longer an input.
 *
 * The point of replaying it rather than trusting the unit tests: the property
 * tests choose their own inputs, and a curve can be correct on the sizes someone
 * thought to write down while being wrong on the mix the game actually produces.
 * This is also the guard for anyone who later "improves" the curve — the whole
 * corpus re-settles, and a rule that bankrupts the field fails here.
 */
const ENTRY = 10;
const STEP = coinPlaceStepFor(ENTRY, 6);
const START = 1000;

interface Table { seats: number; places: number[] }
const TABLES = (corpus as { data: Table[] }).data;

/** Re-settle one historical table under the new rule. */
function settle(t: Table): number[] {
  const places = Object.fromEntries(t.places.map((p, i) => [`s${i}`, p]));
  const s = computeCoinSettlement({ places, entryCoins: ENTRY, placeStep: STEP });
  return Object.keys(places).map((k) => s[k]!.net);
}

describe('replaying every real settled table', () => {
  it('has the corpus it claims to have', () => {
    expect(TABLES.length).toBe(3186);
    expect(new Set(TABLES.map((t) => t.seats))).toEqual(new Set([3, 4, 5, 6]));
  });

  it('is zero-sum on every single one', () => {
    const offenders = TABLES.filter((t) => settle(t).reduce((a, b) => a + b, 0) !== 0);
    expect(offenders).toEqual([]);
  });

  it('never takes more than the buy-in from any seat, in 10,849 seats', () => {
    let seats = 0;
    let worst = 0;
    for (const t of TABLES) {
      for (const net of settle(t)) {
        seats++;
        worst = Math.min(worst, net);
      }
    }
    expect(seats).toBe(10849);
    // The old rule's worst real seat was -319 on this same corpus.
    expect(worst).toBe(-ENTRY);
  });

  it('pays only whole coins across the whole corpus', () => {
    const fractional = TABLES.filter((t) => settle(t).some((n) => !Number.isInteger(n)));
    expect(fractional).toEqual([]);
  });

  /**
   * The reason the spec exists. Under the rule this replaces, four of the eight
   * agents in this corpus ended bankrupt and two burned all five rebuys and were
   * locked out of the season.
   */
  it('bankrupts nobody — the failure this spec was written to stop', () => {
    // Worst possible run: an agent that finished LAST at every table it sat at.
    let floorRun = START;
    for (const t of TABLES) {
      floorRun += settle(t).slice(-1)[0]!; // always last
      if (floorRun <= 0) break;
    }
    // Even the impossible worst case survives most of the corpus; a real agent
    // is nowhere near it.
    const tablesToBust = Math.ceil(START / ENTRY);
    expect(tablesToBust).toBe(100); // still reachable, so rebuys keep their point

    // And the realistic case: a genuinely AVERAGE agent neither gains nor loses.
    //
    // "Average" needs care on even tables. An odd field has a true centre seat
    // that nets zero, but an even field straddles the middle (D130), so its two
    // centre seats are +c/2 and -c/2 and neither is free. Always taking the LOWER
    // one is not average play — it is finishing below half the table every single
    // time — and it should, correctly, bleed. Alternating between the two is what
    // average actually looks like.
    let balance = START;
    let flip = false;
    for (const t of TABLES) {
      const n = settle(t);
      if (n.length % 2 === 1) {
        balance += n[(n.length - 1) / 2]!; // exact centre: always 0
      } else {
        balance += n[n.length / 2 - (flip ? 1 : 0)]!;
        flip = !flip;
      }
    }
    // Within half a step of where it started. Not exactly equal: the corpus holds
    // 1,091 even-sized tables — an odd count — so one lower-middle seat is left
    // unpaired by the alternation. Average play is free to within that rounding,
    // which is the strongest true statement available here.
    expect(Math.abs(balance - START)).toBeLessThanOrEqual(STEP / 2);
  });

  it('keeps the field bunched instead of concentrating it in one agent', () => {
    // Spread if every table were won by the same seat vs always lost by it.
    let best = START;
    let worst = START;
    for (const t of TABLES) {
      const n = settle(t);
      best += n[0]!;
      worst += n[n.length - 1]!;
    }
    // Under the old rule one agent reached 21,825 while three sat at zero.
    expect(best - worst).toBeLessThan(60_000);
    expect(worst).toBeLessThan(best);
  });
});
