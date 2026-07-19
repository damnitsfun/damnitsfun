import { Card, Color, Game, Value } from './vendor';
import {
  EngineError,
  InvalidCardError,
  MustDrawFirstError,
  SessionNotFoundError,
  translateVendorError,
} from './errors';

/**
 * T3 — every vendored Error message pattern maps to the correct typed class.
 *
 * The first block asserts the string-match table directly (comprehensive, one
 * case per vendored throw site). The second block drives the *live* vendored
 * library into throwing, proving the messages we match are still current in
 * v2.0.3 — so the table can't silently rot.
 */

describe('translateVendorError — vendored string -> typed class (T3)', () => {
  const cases: Array<[string, new (...a: any[]) => EngineError]> = [
    // game.ts — gameplay
    ['RED SEVEN does not have card BLUE TWO at hand', InvalidCardError],
    ['BLUE TWO, from discard pile, does not match RED THREE', InvalidCardError],
    ['Card must have its color set before playing', InvalidCardError],
    ['Discarded cards cannot have theirs colors as null', InvalidCardError],
    ['Alice must draw at least one card before passing', MustDrawFirstError],
    // card/card.ts
    ['Only wild cards can be initialized with no color', InvalidCardError],
    ['Card values cannot be changed.', InvalidCardError],
    ['The value must be a value from Value enum.', InvalidCardError],
    ['Only wild cards can have theirs colors changed.', InvalidCardError],
    ['The color must be a value from Color enum.', InvalidCardError],
    ['Both cards must have theirs colors set before comparing', InvalidCardError],
    // game.ts / player.ts — identity
    ['The given player does not exist', SessionNotFoundError],
    ['Player is mandatory', SessionNotFoundError],
    ['Player must have a name', SessionNotFoundError],
  ];

  it.each(cases)('maps %j to the expected typed class', (message, Expected) => {
    const translated = translateVendorError(new Error(message));
    expect(translated).toBeInstanceOf(Expected);
    expect(translated).toBeInstanceOf(EngineError);
    expect(translated.message).toBe(message);
  });

  it('falls back to the base EngineError for setup/internal messages (never leaks a raw Error)', () => {
    for (const message of [
      'There must be 2 to 10 players in the game',
      'Player names must be different',
      'Invalid direction',
      'Event dispatching must be done via #dispatchEvent',
    ]) {
      const translated = translateVendorError(new Error(message));
      expect(translated).toBeInstanceOf(EngineError);
      expect(translated.constructor).toBe(EngineError);
      expect(translated.message).toBe(message);
    }
  });

  it('passes an already-typed EngineError through unchanged', () => {
    const original = new InvalidCardError('nope');
    expect(translateVendorError(original)).toBe(original);
  });

  it('wraps a non-Error throw verbatim', () => {
    const translated = translateVendorError('raw string throw');
    expect(translated).toBeInstanceOf(EngineError);
    expect(translated.message).toBe('raw string throw');
  });

  it('typed errors carry a stable machine-readable code', () => {
    expect(new InvalidCardError().code).toBe('INVALID_CARD');
    expect(new MustDrawFirstError().code).toBe('MUST_DRAW_FIRST');
    expect(new SessionNotFoundError().code).toBe('SESSION_NOT_FOUND');
  });
});

describe('translateVendorError against the live vendored library (T3)', () => {
  it('maps a real "must draw before passing" throw', () => {
    const game = new Game(['Alice', 'Bob']);
    let caught: unknown;
    try {
      game.pass(); // no draw yet
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(translateVendorError(caught)).toBeInstanceOf(MustDrawFirstError);
  });

  it('maps a real "does not have card at hand" throw', () => {
    const game = new Game(['Alice', 'Bob']);
    const current = game.currentPlayer;
    // Find a card the current player provably does NOT hold, then try to play it.
    const held = new Set(current.hand.map((c) => c.toString()));
    let missing: Card | undefined;
    for (const color of [Color.RED, Color.BLUE, Color.GREEN, Color.YELLOW]) {
      for (let v = Value.ZERO as Value; v <= Value.NINE; v++) {
        const card = new Card(v, color);
        if (!held.has(card.toString())) {
          missing = card;
          break;
        }
      }
      if (missing) break;
    }
    expect(missing).toBeDefined();

    let caught: unknown;
    try {
      game.play(missing!);
    } catch (e) {
      caught = e;
    }
    expect(translateVendorError(caught)).toBeInstanceOf(InvalidCardError);
  });

  it('maps a real card-construction throw', () => {
    let caught: unknown;
    try {
      // Non-wild card with no color.
      // eslint-disable-next-line no-new
      new Card(Value.ZERO);
    } catch (e) {
      caught = e;
    }
    expect(translateVendorError(caught)).toBeInstanceOf(InvalidCardError);
  });
});
