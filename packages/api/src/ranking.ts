/**
 * Placement ranking for a settled table.
 *
 * openskill was removed for the hackathon: BOTH game types now score by the
 * playground **coin** economy (`coins.ts`) — the tournament's on-chain prize is
 * split among the top coin-holders, not a μ − 3σ rating. The only ranking
 * primitive still needed is turning a finished game into finishing places, which
 * the coin settlement consumes.
 */

/**
 * Rank seats for a finished game: the winner places 1st, everyone else is ordered
 * by remaining hand value (lower is better, matching the timeout resolution rule).
 * Equal hand values share a place.
 */
export function placementsFrom(
  winnerAgentId: string | null,
  handValues: Record<string, number>,
): Record<string, number> {
  const agentIds = Object.keys(handValues);
  const losers = agentIds.filter((id) => id !== winnerAgentId);
  losers.sort((a, b) => (handValues[a] ?? 0) - (handValues[b] ?? 0));

  const places: Record<string, number> = {};
  let nextPlace = 1;
  if (winnerAgentId !== null && agentIds.includes(winnerAgentId)) {
    places[winnerAgentId] = 1;
    nextPlace = 2;
  }

  let previousValue: number | null = null;
  let previousPlace = nextPlace;
  losers.forEach((agentId, index) => {
    const value = handValues[agentId] ?? 0;
    const place = previousValue !== null && value === previousValue ? previousPlace : nextPlace + index;
    places[agentId] = place;
    previousValue = value;
    previousPlace = place;
  });

  return places;
}

/**
 * The tie-break chain for a coin-ranked competition.
 *
 * Coins alone do not separate a field. Deltas are bounded integers, so agents
 * land on identical totals often — measured over 36 agents on production's real
 * table-size mix, **29.4% share a total with someone after ~50 tables each**
 * (16.9% after 200). `eligibleRanked` orders the on-chain payout, and the curve
 * pays place 1 more than place 2, so a tie is not cosmetic: it decides money.
 * Breaking one on `agentId` alone settles roughly one prize in six by a string
 * comparison.
 *
 * So the chain asks progressively weaker questions, and only reaches the id when
 * the agents are genuinely indistinguishable on the record:
 *
 *   1. net coins   — the score (rebuys netted out, sub-spec 18 D100)
 *   2. tables won  — outright wins, the least ambiguous evidence of strength
 *   3. placeScore  — how high it finishes when it does not win
 *   4. agentId     — stability only; carries no meaning, and says so
 *
 * `placeScore` MUST be normalised by table size, not a raw mean place. Tables
 * seat 3–6 (sub-spec 18 D103), and 3rd of 6 is a good table while 3rd of 3 is
 * last. On the real corpus the two disagree sharply: the agent with the *best*
 * normalised score sits 6th of 8 by raw mean, purely because it plays big
 * tables. A raw mean would quietly penalise agents for taking the fuller table.
 */
export interface RankStats {
  agentId: string;
  netCoins: number;
  tablesWon: number;
  /** Mean finish scaled 0 (always first) → 1 (always last); null with no games. */
  placeScore: number | null;
}

/** Scale one finish to 0..1 so tables of different sizes are comparable. */
export function normalisedPlace(place: number, tableSize: number): number {
  if (tableSize <= 1) return 0; // a one-seat table has no ordering to express
  return (place - 1) / (tableSize - 1);
}

/** Compare two agents for a coin-ranked board. Best first. */
export function compareRank(a: RankStats, b: RankStats): number {
  if (a.netCoins !== b.netCoins) return b.netCoins - a.netCoins;
  if (a.tablesWon !== b.tablesWon) return b.tablesWon - a.tablesWon;
  if (a.placeScore !== b.placeScore) {
    // No games played is not "finished badly" — it is no evidence at all, so it
    // sorts last rather than winning a tie against an agent with a record.
    if (a.placeScore === null) return 1;
    if (b.placeScore === null) return -1;
    return a.placeScore - b.placeScore;
  }
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}
