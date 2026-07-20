import { createRequire } from 'node:module';
import type { Rating } from 'openskill' with { 'resolution-mode': 'import' };

/**
 * openskill publishes a working CommonJS build (`"require": "./dist/index.cjs"`)
 * but declares its types only under the "import" condition, so node16 resolution
 * refuses a plain `import` from this CommonJS package even though `require()`
 * succeeds at runtime. Load it through createRequire, and read the types under
 * the "import" condition explicitly — the runtime binding is the CJS build, and
 * the two describe the same API.
 */
const { ordinal, rate, rating } = createRequire(__filename)('openskill') as typeof import(
  'openskill',
  { with: { 'resolution-mode': 'import' } }
);

/**
 * Ranking (T11).
 *
 * Uses `openskill` (Weng-Lin / Plackett-Luce), NOT TrueSkill: TrueSkill's licence
 * restricts it to Xbox Live or non-commercial use, which is a real problem for a
 * product with a prize pool (parent spec §2). `ordinal()` defaults to μ − 3σ,
 * exactly the conservative rating the leaderboard sorts by (§5).
 *
 * The DB columns are still named `trueskill_mu` / `trueskill_sigma` because the
 * §4 schema names them that way; only the algorithm changed.
 */

export interface AgentRating {
  mu: number;
  sigma: number;
}

/** A seat's result in a settled session. Lower `place` is better; 1 is the winner. */
export interface SeatResult {
  agentId: string;
  rating: AgentRating;
  place: number;
}

export function defaultRating(): AgentRating {
  const r = rating();
  return { mu: r.mu, sigma: r.sigma };
}

/** Conservative rating (μ − 3σ) — the leaderboard sort key. */
export function conservativeRating(r: AgentRating): number {
  return ordinal(toRating(r));
}

function toRating(r: AgentRating): Rating {
  return rating({ mu: r.mu, sigma: r.sigma });
}

/**
 * Recompute ratings for one settled session.
 *
 * Every seat is its own team (free-for-all). Ties are allowed: seats sharing a
 * `place` are treated as drawn with each other.
 *
 * @returns the updated rating per agentId, in the order given.
 */
export function rateSession(results: SeatResult[]): Array<{ agentId: string; rating: AgentRating }> {
  if (results.length === 0) return [];

  const teams = results.map((r) => [toRating(r.rating)]);
  const ranks = results.map((r) => r.place);
  const updated = rate(teams, { rank: ranks });

  return results.map((result, index) => {
    const next = updated[index]?.[0];
    return {
      agentId: result.agentId,
      rating: next ? { mu: next.mu, sigma: next.sigma } : result.rating,
    };
  });
}

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
