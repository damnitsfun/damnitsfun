/**
 * Playground coin economy (sub-spec 12, T41).
 *
 * A stateful in-game currency — NOT the on-chain BNB wallets of sub-spec 08.
 * Every agent starts at {@link STARTING_COINS} and pays {@link PLAYGROUND_ENTRY_COINS}
 * to take a seat. At settlement, coins move between seats per the "how to
 * calculate coins" model (our reading, with the source game's ×multiplier
 * removed → ×1):
 *
 *  - "points" = the value of the cards left in a seat's hand at game end
 *    (engine `getHandValues`; the winner emptied their hand → 0 points).
 *  - The BOTTOM half of the table LOSES coins equal to their points, with a floor
 *    per finishing place (3rd ≥ 40, 4th ≥ 60). Their combined loss is the pot.
 *  - The TOP half WINS, splitting the pot so the seat with FEWER points takes the
 *    bigger share (the wider the point gap, the wider the coin gap).
 *  - Zero-sum among the seats, and capped so nobody drops below 0 (bankruptcy):
 *    a loser never forfeits more than they hold, and winners split only what is
 *    actually collected.
 *
 * The whole function is pure and deterministic — unit-tested in `coins.test.ts`.
 */

/** Default starting balance (also the `agents.coins` DB default). */
export const STARTING_COINS = 1000;
/** Cost, in coins, to take a seat at a table. */
export const PLAYGROUND_ENTRY_COINS = 10;

/** Minimum a losing seat forfeits, by finishing place (multiplier removed → ×1). */
export const LOSS_FLOOR_BY_PLACE: Readonly<Record<number, number>> = { 3: 40, 4: 60 };

/** Smoothing for the winners' split; larger → splits stay closer to even. */
export const COIN_SPLIT_SMOOTHING = 20;

export interface CoinSettlementInput {
  /** 1-based finishing place per agent (1 = winner). */
  places: Record<string, number>;
  /** Points left in hand per agent at game end (winner = 0). */
  handValues: Record<string, number>;
  /** Current coin balance per agent, used only to cap losses (no negatives). */
  balances: Record<string, number>;
}

/**
 * Coin delta per agent for one settled table. Sums to 0 (zero-sum among the
 * seats) and never drives a balance below 0.
 */
export function computeCoinSettlement(input: CoinSettlementInput): Record<string, number> {
  const { places, handValues, balances } = input;
  const agentIds = Object.keys(places);
  const deltas: Record<string, number> = {};
  for (const id of agentIds) deltas[id] = 0;
  if (agentIds.length === 0) return deltas;

  const half = Math.ceil(agentIds.length / 2);
  const winners = agentIds.filter((id) => (places[id] ?? agentIds.length) <= half);
  const losers = agentIds.filter((id) => (places[id] ?? agentIds.length) > half);

  // Losers forfeit their points (floored by place), capped at what they hold.
  let pot = 0;
  for (const id of losers) {
    const floor = LOSS_FLOOR_BY_PLACE[places[id] ?? 0] ?? 0;
    const intended = Math.max(handValues[id] ?? 0, floor);
    const capped = Math.min(intended, Math.max(0, balances[id] ?? 0));
    deltas[id] = -capped;
    pot += capped;
  }

  // Winners split the pot; fewer points → bigger share (K-smoothed weights). The
  // rounding remainder goes to the top seat so the sum stays exactly zero.
  if (winners.length > 0 && pot > 0) {
    const maxPts = Math.max(...winners.map((id) => handValues[id] ?? 0));
    const weights = winners.map((id) => ({
      id,
      w: maxPts - (handValues[id] ?? 0) + COIN_SPLIT_SMOOTHING,
    }));
    const totalWeight = weights.reduce((sum, x) => sum + x.w, 0);
    let assigned = 0;
    for (const { id, w } of weights) {
      const share = Math.floor((pot * w) / totalWeight);
      deltas[id] = (deltas[id] ?? 0) + share;
      assigned += share;
    }
    const top = winners.reduce((a, b) => ((places[a] ?? 0) <= (places[b] ?? 0) ? a : b));
    deltas[top] = (deltas[top] ?? 0) + (pot - assigned);
  }

  return deltas;
}
