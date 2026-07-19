import { shuffle } from 'shuffle';

import { Card, Color, colors, Value } from './card';

function createUnoDeck() {
  /*
    108 cards

    76x numbers (0-9, all colors)
    8x draw two (2x each color)
    8x reverse (2x each color)
    8x skip (2x each color)
    4x wild
    4x wild draw four
  */

  const deck: Card[] = [];

  const createCards = (qty: number, value: Value, color?: Color) => {
    const cards = [];

    for (let i = 0; i < qty; i++) cards.push(new Card(value, color));

    return cards;
  };

  // for each color...
  colors.forEach((color) => {
    // CREATE NUMBERS
    deck.push.apply(deck, createCards(1, Value.ZERO, color));
    for (let n = Value.ONE; n <= Value.NINE; n++) {
      deck.push.apply(deck, createCards(2, n, color));
    }

    deck.push.apply(deck, createCards(2, Value.DRAW_TWO, color));
    deck.push.apply(deck, createCards(2, Value.SKIP, color));
    deck.push.apply(deck, createCards(2, Value.REVERSE, color));
  });

  deck.push.apply(deck, createCards(4, Value.WILD));
  deck.push.apply(deck, createCards(4, Value.WILD_DRAW_FOUR));

  return deck;
}

// ---------------------------------------------------------------------------
// DAMNITS-PATCH (T2 — RNG injection for commit-reveal fairness). See VENDOR.md.
// This is the ONLY permitted modification inside vendor/uno. It makes the deck
// shuffle deterministic when a seed is provided, so the on-chain committed seed
// fully determines the card order and can be verified after reveal.
// ---------------------------------------------------------------------------

/**
 * Deterministic PRNG in [0, 1) derived from a string seed.
 * xmur3 (seed hashing) -> mulberry32 (generation). Both are small, public-domain
 * algorithms; identical seeds always produce an identical number sequence, which
 * is exactly what the `shuffle` package's `random` option consumes.
 */
function createSeededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;

  return function seededRandom() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One-shot seed for the *next* `Deck` constructed without an explicit seed.
 *
 * The vendored `Game` creates its `Deck` internally (`new Deck()` in
 * `newGame()`), so the engine adapter (packages/engine/src/adapter.ts, spec 03)
 * cannot pass a seed through the constructor. Instead it calls
 * `setNextDeckSeed(seed)` synchronously immediately before `new Game(...)`; the
 * seed is consumed exactly once by the next `Deck`. This keeps the vendored diff
 * confined to this file (game.ts is never edited) while still threading the
 * commit-reveal seed into the shuffle.
 *
 * Because construction is fully synchronous, this is safe even with multiple
 * concurrent sessions: no `await` ever occurs between `setNextDeckSeed` and the
 * `new Game(...)` that consumes it.
 */
let pendingDeckSeed: string | undefined;
export function setNextDeckSeed(seed: string | undefined): void {
  pendingDeckSeed = seed;
}

export class Deck {
  private originalDraw: Function;
  private shuffle = shuffle({ deck: createUnoDeck() });

  get cards() {
    return this.shuffle.cards;
  }

  get length() {
    return this.shuffle.length;
  }

  constructor(rngSeed?: string) {
    // DAMNITS-PATCH: a seed (explicit arg, else the one-shot pending seed) makes
    // the shuffle deterministic. Unseeded behavior is unchanged — the field
    // initializer above already built an unseeded deck via the default RNG.
    const seed = rngSeed !== undefined ? rngSeed : pendingDeckSeed;
    pendingDeckSeed = undefined;
    if (seed !== undefined) {
      this.shuffle = shuffle({
        deck: createUnoDeck(),
        random: createSeededRandom(seed),
      } as { deck: Card[] });
    }
  }

  draw(num?: number) {
    num = num || 1;
    let cards: Card[] = [];

    // if the amount to draw is more than the cards we have...
    if (num >= this.length) {
      const length = this.length;

      // draw all we have...
      cards = cards.concat(this.shuffle.draw.call(this, length));

      // regenerate the draw pile
      this.shuffle.reset();
      this.shuffle.shuffle();

      // then draw the rest we need
      num = num - length;
      if (num === 0) return cards;
    }

    return cards.concat(this.shuffle.draw(num));
  }
}
