import type { ColorName, Move } from './client';

/**
 * The reference heuristic.
 *
 * Deliberately simple and readable — it exists to prove the public API is
 * sufficient to play well enough, and to give agent authors a starting point.
 *
 * It only ever returns a move drawn from `legalMoves`; it never reasons about
 * what *would* be legal. That is the battleground's job, and it is the single rule an
 * agent author must not break.
 */

const COLORS: ColorName[] = ['red', 'blue', 'green', 'yellow'];

/** Cards worth keeping back: they are playable on anything, so they never go stale. */
const ANY_COLOUR = new Set(['RAINBOW', 'MEGARAINBOW']);
/** Cards that cost an opponent tempo. */
const DISRUPTIVE = new Set(['GRAB2', 'PASS', 'UTURN']);

export interface Decision {
  move: Move;
  reasoning: string;
}

export interface DecideContext {
  /** Anyone at one card is about to win — worth spending a disruptive card on. */
  opponentIsClosing?: boolean;
}

export function decide(legalMoves: Move[], context: DecideContext = {}): Decision {
  if (legalMoves.length === 0) {
    throw new Error('decide() called with no legal moves');
  }

  const plays = legalMoves.filter(
    (m): m is Extract<Move, { type: 'playCard' }> => m.type === 'playCard',
  );

  // Nothing playable: draw if we may, else pass. (The battleground only ever offers one
  // of the two, so this is a single branch in practice.)
  if (plays.length === 0) {
    const draw = legalMoves.find((m) => m.type === 'drawCard');
    if (draw) return { move: draw, reasoning: 'nothing playable — drawing' };
    const pass = legalMoves.find((m) => m.type === 'passTurn');
    if (pass) return { move: pass, reasoning: 'drew and still cannot play — passing' };
    return { move: legalMoves[0]!, reasoning: 'no better option' };
  }

  // Count colours we can play, as a proxy for which colour keeps most options open.
  const colourWeight = new Map<ColorName, number>();
  for (const play of plays) {
    const colour = play.card.color;
    if (colour) colourWeight.set(colour, (colourWeight.get(colour) ?? 0) + 1);
  }

  const plain = plays.filter((p) => !ANY_COLOUR.has(p.card.symbol) && !DISRUPTIVE.has(p.card.symbol));
  const disruptive = plays.filter((p) => DISRUPTIVE.has(p.card.symbol));
  const anyColour = plays.filter((p) => ANY_COLOUR.has(p.card.symbol));

  // Someone is one card from winning: spend tempo to slow them down.
  if (context.opponentIsClosing && disruptive.length > 0) {
    const pick = disruptive[0]!;
    return { move: pick, reasoning: `an opponent is one card away — playing ${pick.card.symbol} to slow them` };
  }

  // Prefer plain numbers: they are the cards that go stale.
  if (plain.length > 0) {
    const pick = bestByColour(plain, colourWeight);
    return { move: pick, reasoning: `playing ${pick.card.symbol} and keeping my flexible cards back` };
  }

  if (disruptive.length > 0) {
    const pick = bestByColour(disruptive, colourWeight);
    return { move: pick, reasoning: `no plain card — playing ${pick.card.symbol}` };
  }

  // Last resort: an any-colour card. Choose the colour we hold most of.
  const pick = anyColour[0]!;
  const colour = strongestColour(colourWeight);
  return {
    move: { type: 'playCard', card: { symbol: pick.card.symbol, color: colour } },
    reasoning: `only flexible cards left — playing ${pick.card.symbol} and calling ${colour}`,
  };
}

function bestByColour(
  plays: Array<Extract<Move, { type: 'playCard' }>>,
  weights: Map<ColorName, number>,
): Extract<Move, { type: 'playCard' }> {
  let best = plays[0]!;
  let bestScore = -1;
  for (const play of plays) {
    const score = play.card.color ? (weights.get(play.card.color) ?? 0) : 0;
    if (score > bestScore) {
      bestScore = score;
      best = play;
    }
  }
  // An any-colour card still needs a colour chosen before it can be submitted.
  if (best.card.color === null) {
    return { type: 'playCard', card: { symbol: best.card.symbol, color: strongestColour(weights) } };
  }
  return best;
}

function strongestColour(weights: Map<ColorName, number>): ColorName {
  let best: ColorName = COLORS[0]!;
  let bestCount = -1;
  for (const colour of COLORS) {
    const count = weights.get(colour) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = colour;
    }
  }
  return best;
}
