import { CardSymbol, ColorName } from './vocabulary';

/**
 * Product-vocabulary move, matching the §5 API `Move` shape exactly. This is the
 * only move representation in the system — the API passes these through verbatim,
 * and `GameSession.getLegalMoves` / `applyMove` are the sole authority over which
 * are legal (Requirements NFR-2). Colors are lowercase per §5; symbols are the §6
 * product symbols.
 */
export type Move =
  | { type: 'playCard'; card: { color: ColorName | null; symbol: CardSymbol } }
  | { type: 'drawCard' }
  | { type: 'passTurn' }
  | { type: 'callLastCard' }
  | { type: 'challengeLastCard'; targetAgentId: string };

export type MoveType = Move['type'];
