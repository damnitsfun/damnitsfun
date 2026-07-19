import { Card, CardPlayEvent, Color, Game, Value, setNextDeckSeed } from './vendor';
import {
  CardSymbol,
  cardToPublic,
  colorToName,
  nameToColor,
  publicToCard,
  symbolToValue,
  valueToSymbol,
} from './vocabulary';

/**
 * T5 — vocabulary translation (§6). A full game round-tripped through the public
 * surface must show ONLY product vocabulary; no vendored enum name may leak.
 */

const ALLOWED_SYMBOLS: ReadonlySet<string> = new Set<CardSymbol>([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'PASS', 'UTURN', 'GRAB2', 'RAINBOW', 'MEGARAINBOW', 'RAINBOWSTORM',
]);

// The vendored enum member names that must never appear on the public surface.
const LEAKED_TERMS = [
  'SKIP', 'REVERSE', 'DRAW_TWO', 'WILD', 'WILD_DRAW_FOUR',
  'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
];

const COLORS = [Color.RED, Color.BLUE, Color.GREEN, Color.YELLOW];

describe('value <-> symbol round-trip', () => {
  it('every vendored Value maps to an allowed symbol and back', () => {
    const values = [
      Value.ZERO, Value.ONE, Value.TWO, Value.THREE, Value.FOUR, Value.FIVE,
      Value.SIX, Value.SEVEN, Value.EIGHT, Value.NINE, Value.DRAW_TWO,
      Value.REVERSE, Value.SKIP, Value.WILD, Value.WILD_DRAW_FOUR,
    ];
    for (const value of values) {
      const symbol = valueToSymbol(value);
      expect(ALLOWED_SYMBOLS.has(symbol)).toBe(true);
      expect(symbolToValue(symbol)).toBe(value);
    }
  });

  it('applies the §6 translation table exactly', () => {
    expect(valueToSymbol(Value.SKIP)).toBe('PASS');
    expect(valueToSymbol(Value.REVERSE)).toBe('UTURN');
    expect(valueToSymbol(Value.DRAW_TWO)).toBe('GRAB2');
    expect(valueToSymbol(Value.WILD)).toBe('RAINBOW');
    expect(valueToSymbol(Value.WILD_DRAW_FOUR)).toBe('MEGARAINBOW');
    expect(valueToSymbol(Value.FIVE)).toBe('5');
  });

  it('RAINBOWSTORM has no vendored value', () => {
    expect(() => symbolToValue('RAINBOWSTORM')).toThrow();
  });
});

describe('color <-> name round-trip', () => {
  it('round-trips every color', () => {
    for (const color of COLORS) {
      expect(nameToColor(colorToName(color))).toBe(color);
    }
  });
});

describe('card <-> public round-trip', () => {
  it('round-trips a colored card', () => {
    const card = publicToCard('GRAB2', 'BLUE');
    const pub = cardToPublic(card);
    expect(pub).toEqual({ symbol: 'GRAB2', color: 'BLUE' });
    expect(cardToPublic(publicToCard(pub.symbol, pub.color))).toEqual(pub);
  });

  it('represents an un-colored wild with a null color', () => {
    expect(cardToPublic(new Card(Value.WILD))).toEqual({ symbol: 'RAINBOW', color: null });
  });
});

describe('full-game public surface contains only product vocabulary (T5 DoD)', () => {
  it('plays a game to the end and leaks no vendored enum name', () => {
    setNextDeckSeed('vocab-round-trip');
    const game = new Game(['A', 'B', 'C', 'D']);

    const publicEventLog: unknown[] = [];

    game.on('cardplay', (event: CardPlayEvent) => {
      publicEventLog.push({
        type: 'CARD_PLAYED',
        player: event.player.name,
        card: cardToPublic(event.card),
      });
    });

    let ended = false;
    game.on('end', (e: { winner: { name: string } }) => {
      publicEventLog.push({ type: 'GAME_ENDED', winner: e.winner.name });
      ended = true;
    });

    // Minimal legal-move driver (vendored primitives only).
    let steps = 0;
    while (!ended && steps < 2000) {
      const player = game.currentPlayer;
      const top = game.discardedCard;
      const playable = player.hand.filter((c) => c.isWildCard() || c.matches(top));
      if (playable.length > 0) {
        const card = playable[Math.floor(Math.random() * playable.length)]!;
        if (card.isWildCard()) card.color = COLORS[Math.floor(Math.random() * COLORS.length)]!;
        game.play(card);
      } else {
        game.draw();
        game.pass();
      }
      steps++;
    }

    expect(ended).toBe(true);
    expect(publicEventLog.length).toBeGreaterThan(0);

    // Every card symbol emitted is a product symbol.
    for (const entry of publicEventLog) {
      const card = (entry as { card?: { symbol: string } }).card;
      if (card) expect(ALLOWED_SYMBOLS.has(card.symbol)).toBe(true);
    }

    // No vendored enum name appears anywhere in the serialized public log.
    const serialized = JSON.stringify(publicEventLog);
    for (const term of LEAKED_TERMS) {
      expect(serialized).not.toContain(term);
    }
  });
});
