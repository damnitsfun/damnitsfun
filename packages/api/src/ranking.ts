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
