import { Deck, setNextDeckSeed } from './vendor';

/**
 * T2 — RNG injection patch (FR-1.5). Proves the commit-reveal fairness hook:
 * a seed fully determines the shuffle order, while unseeded behavior is
 * unchanged (still random per the `shuffle` package's default RNG).
 */

/** Serialize a deck's current card order to a comparable string. */
function order(deck: Deck): string {
  return deck.cards.map((c) => c.toString()).join('|');
}

describe('Deck RNG injection (T2)', () => {
  it('produces a full 108-card deck', () => {
    expect(new Deck().length).toBe(108);
  });

  it('same seed -> identical shuffle order', () => {
    const a = new Deck('commit-reveal-seed-abc');
    const b = new Deck('commit-reveal-seed-abc');
    expect(order(a)).toBe(order(b));
  });

  it('different seeds -> different shuffle order', () => {
    const a = new Deck('seed-one');
    const b = new Deck('seed-two');
    expect(order(a)).not.toBe(order(b));
  });

  it('a seeded deck deals cards deterministically', () => {
    const a = new Deck('deal-seed');
    const b = new Deck('deal-seed');
    // Draw enough to exercise the shuffle sequence, not just the top card.
    const drawA = a.draw(30).map((c) => c.toString());
    const drawB = b.draw(30).map((c) => c.toString());
    expect(drawA).toEqual(drawB);
  });

  it('unseeded decks are (essentially always) different — behavior unchanged', () => {
    // Two default decks colliding on all 108 positions is astronomically
    // unlikely; this guards that we did NOT accidentally make unseeded
    // construction deterministic.
    const a = new Deck();
    const b = new Deck();
    expect(order(a)).not.toBe(order(b));
  });

  describe('setNextDeckSeed — one-shot seed for engine-created decks', () => {
    it('seeds exactly the next Deck, then resets', () => {
      setNextDeckSeed('one-shot-seed');
      const seeded = new Deck();
      // A second unseeded construction must NOT reuse the consumed seed.
      const afterConsume = new Deck();

      const reference = new Deck('one-shot-seed');
      expect(order(seeded)).toBe(order(reference));
      expect(order(afterConsume)).not.toBe(order(reference));
    });

    it('an explicit constructor seed takes precedence over a pending seed', () => {
      setNextDeckSeed('pending-seed');
      const explicit = new Deck('explicit-seed');
      expect(order(explicit)).toBe(order(new Deck('explicit-seed')));
      // The pending seed was consumed (cleared), so the next deck is unseeded.
      expect(order(new Deck())).not.toBe(order(new Deck('pending-seed')));
    });
  });
});
