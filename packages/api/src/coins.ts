/**
 * Playground coin economy (sub-spec 12, T41).
 *
 * A stateful in-game currency — NOT the on-chain BNB wallets of sub-spec 08.
 * Every agent starts at {@link STARTING_COINS} and pays {@link PLAYGROUND_ENTRY_COINS}
 * to take a seat. The seat buy-ins are POOLED and paid back out to the winners at
 * settlement (not a sink), so coins are only ever redistributed — the table's
 * total is conserved over its lifecycle. At settlement, per the "how to calculate
 * coins" model (our reading, with the source game's ×multiplier removed → ×1):
 *
 *  - "points" = the value of the cards left in a seat's hand at game end
 *    (engine `getHandValues`; the winner emptied their hand → 0 points).
 *  - The BOTTOM half of the table LOSES coins equal to their points, with a floor
 *    per finishing place (3rd ≥ 40, 4th ≥ 60, 5th ≥ 80, 6th ≥ 100). Their combined
 *    loss, PLUS the pooled entry pot, is what the winners share.
 *  - The TOP half WINS, splitting that pot so the seat with FEWER points takes the
 *    bigger share (the wider the point gap, the wider the coin gap).
 *  - Capped so nobody drops below 0 (bankruptcy): a loser never forfeits more than
 *    they hold. The returned deltas sum to `entryPot` (the buy-ins each seat was
 *    already charged on join), so the full join→settle cycle is zero-sum.
 *
 * The whole function is pure and deterministic — unit-tested in `coins.test.ts`.
 */

/** Default starting balance (also the `agents.coins` DB default). */
export const STARTING_COINS = 1000;
/** Cost, in coins, to take a seat at a table. */
export const PLAYGROUND_ENTRY_COINS = 10;

/**
 * Minimum a losing seat forfeits, by finishing place (multiplier removed → ×1).
 *
 * Sub-spec 18 (D109) continues the +20 progression to places 5 and 6. Tables were
 * fixed at four seats when this was written, so 5 and 6 could not occur and were
 * simply absent — which meant `?? 0`, i.e. NO floor at all. Once a table can seat
 * six, an unfloored 5th/6th place makes the worst finishes on the biggest tables
 * the cheapest ones to take, inverting the gradient the 40/60 pair establishes.
 */
export const LOSS_FLOOR_BY_PLACE: Readonly<Record<number, number>> = {
  3: 40,
  4: 60,
  5: 80,
  6: 100,
};

/** Smoothing for the winners' split; larger → splits stay closer to even. */
export const COIN_SPLIT_SMOOTHING = 20;

export interface CoinSettlementInput {
  /** 1-based finishing place per agent (1 = winner). */
  places: Record<string, number>;
  /** Points left in hand per agent at game end (winner = 0). */
  handValues: Record<string, number>;
  /** Current coin balance per agent, used only to cap losses (no negatives). */
  balances: Record<string, number>;
  /**
   * The pooled seat buy-ins to hand back to the winners on top of the losers'
   * forfeits (the seats were already charged this on join). Default 0.
   */
  entryPot?: number;
}

/**
 * Coin delta per agent for one settled table. Losers' deltas are negative
 * (their forfeits, capped at their balance); winners' deltas are positive and
 * split the losers' forfeits PLUS `entryPot`. The deltas therefore sum to
 * `entryPot` — the buy-ins already deducted on join — so join→settle is zero-sum.
 */
export function computeCoinSettlement(input: CoinSettlementInput): Record<string, number> {
  const { places, handValues, balances } = input;
  const entryPot = Math.max(0, input.entryPot ?? 0);
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

  // Winners split the losers' forfeits PLUS the pooled buy-ins; fewer points →
  // bigger share (K-smoothed weights). The rounding remainder goes to the top
  // seat so the whole prize is distributed exactly.
  const prize = pot + entryPot;
  if (winners.length > 0 && prize > 0) {
    const maxPts = Math.max(...winners.map((id) => handValues[id] ?? 0));
    const weights = winners.map((id) => ({
      id,
      w: maxPts - (handValues[id] ?? 0) + COIN_SPLIT_SMOOTHING,
    }));
    const totalWeight = weights.reduce((sum, x) => sum + x.w, 0);
    let assigned = 0;
    for (const { id, w } of weights) {
      const share = Math.floor((prize * w) / totalWeight);
      deltas[id] = (deltas[id] ?? 0) + share;
      assigned += share;
    }
    const top = winners.reduce((a, b) => ((places[a] ?? 0) <= (places[b] ?? 0) ? a : b));
    deltas[top] = (deltas[top] ?? 0) + (prize - assigned);
  }

  return deltas;
}
