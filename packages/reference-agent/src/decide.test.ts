import type { Move } from './client';
import { decide } from './decide';

/**
 * The reference heuristic. The invariant that matters most: `decide` may only
 * ever return a move the arena offered — with the single documented exception of
 * filling in a colour for an any-colour card, which the contract requires.
 */

const play = (symbol: string, color: string | null): Move =>
  ({ type: 'playCard', card: { symbol, color } }) as Move;

describe('decide()', () => {
  it('draws when nothing is playable', () => {
    const { move } = decide([{ type: 'drawCard' }]);
    expect(move).toEqual({ type: 'drawCard' });
  });

  it('passes when it has drawn and still cannot play', () => {
    const { move } = decide([{ type: 'passTurn' }]);
    expect(move).toEqual({ type: 'passTurn' });
  });

  it('prefers playing over drawing', () => {
    const { move } = decide([play('7', 'red'), { type: 'drawCard' }]);
    expect(move.type).toBe('playCard');
  });

  it('keeps flexible cards back while a plain card is available', () => {
    const { move } = decide([play('RAINBOW', null), play('3', 'blue'), { type: 'drawCard' }]);
    expect(move).toMatchObject({ type: 'playCard', card: { symbol: '3' } });
  });

  it('always supplies a colour for an any-colour card', () => {
    const { move } = decide([play('MEGARAINBOW', null), { type: 'drawCard' }]);
    expect(move.type).toBe('playCard');
    if (move.type === 'playCard') {
      expect(move.card.symbol).toBe('MEGARAINBOW');
      // Never submit the null the arena offered — the contract requires a choice.
      expect(['red', 'blue', 'green', 'yellow']).toContain(move.card.color);
    }
  });

  it('spends a disruptive card when an opponent is one card away', () => {
    const { move } = decide([play('5', 'red'), play('GRAB2', 'red')], { opponentIsClosing: true });
    expect(move).toMatchObject({ card: { symbol: 'GRAB2' } });
  });

  it('favours the colour it can follow up on', () => {
    // Two playable colours; blue is better represented, so prefer the blue card.
    const { move } = decide([play('4', 'red'), play('6', 'blue'), play('9', 'blue')]);
    expect(move).toMatchObject({ card: { color: 'blue' } });
  });

  it('only ever returns a move the arena offered', () => {
    const offered: Move[] = [play('7', 'green'), play('PASS', 'green'), { type: 'drawCard' }];
    for (let i = 0; i < 50; i++) {
      const { move } = decide(offered);
      const matches = offered.some(
        (m) =>
          m.type === move.type &&
          (m.type !== 'playCard' ||
            (move.type === 'playCard' && m.card.symbol === move.card.symbol)),
      );
      expect(matches).toBe(true);
    }
  });

  it('always explains itself — reasoning is recorded publicly', () => {
    const { reasoning } = decide([play('7', 'red'), { type: 'drawCard' }]);
    expect(reasoning.length).toBeGreaterThan(0);
  });

  it('throws rather than inventing a move when nothing is legal', () => {
    expect(() => decide([])).toThrow();
  });
});
