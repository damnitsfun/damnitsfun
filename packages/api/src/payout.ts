/**
 * Pooled-tournament payout distribution (sub-spec 08, decision D14).
 *
 * "Ranking drives payout": at season close the eligible field is ranked by
 * openskill conservative rating, and the prize pool is split across the top ranks
 * by a **field-scaling, renormalized percentage curve**. This module is the pure
 * arithmetic of that split — no DB, no chain — so it can be exhaustively tested
 * and so the on-chain contract only ever has to check `sum(amounts) <= pool`.
 *
 * The rules:
 *  - Pay the top `N = clamp(ceil(fieldFraction × eligibleCount), 1, curve.length)`
 *    ranks. A 4-agent field is winner-take-all; a 50-agent field pays ~top 10.
 *  - Take the first `N` weights of the base curve and **renormalize them to 100%**,
 *    so a short prefix still distributes the whole pool.
 *  - Compute integer-wei amounts (floor), then assign the rounding remainder to
 *    rank 1, so `sum(amounts) === pool` exactly — the pool is never stranded by
 *    integer division.
 */

/** How many ranks get paid, given the field size and the curve (D14). */
export function payoutRankCount(
  eligibleCount: number,
  curveLength: number,
  fieldFraction: number,
): number {
  if (eligibleCount <= 0 || curveLength <= 0) return 0;
  const scaled = Math.ceil(fieldFraction * eligibleCount);
  return Math.max(1, Math.min(curveLength, scaled));
}

/**
 * Split `poolWei` across the top ranks. Returns one wei amount per paid rank,
 * best-rank first. `amounts.length === payoutRankCount(...)`, and the amounts sum
 * to exactly `poolWei` (dust folded into rank 1). Returns `[]` for an empty pool
 * or an empty field.
 */
export function distributePool(
  poolWei: bigint,
  eligibleCount: number,
  curve: readonly number[],
  fieldFraction: number,
): bigint[] {
  const n = payoutRankCount(eligibleCount, curve.length, fieldFraction);
  if (n === 0 || poolWei <= 0n) return [];

  // Weights → integer micro-units so we can divide the wei pool with bigint math
  // and never touch a float. Any curve (incl. fractional %) folds in cleanly.
  const prefix = curve.slice(0, n);
  const scaled = prefix.map((w) => BigInt(Math.round(w * 1_000_000)));
  const totalScaled = scaled.reduce((sum, w) => sum + w, 0n);
  if (totalScaled <= 0n) {
    // Degenerate curve (all zeros): pay it all to rank 1 rather than strand it.
    const only = [poolWei];
    while (only.length < n) only.push(0n);
    return only;
  }

  const amounts = scaled.map((w) => (poolWei * w) / totalScaled);
  const distributed = amounts.reduce((sum, a) => sum + a, 0n);
  amounts[0] = amounts[0]! + (poolWei - distributed); // dust → rank 1; makes the sum exact
  return amounts;
}

/** Validate a base curve at config load: non-empty, non-negative, sums to ~100. */
export function assertValidCurve(curve: readonly number[]): void {
  if (curve.length === 0) throw new Error('PAYOUT_SCHEDULE_JSON must be a non-empty array');
  if (curve.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error('PAYOUT_SCHEDULE_JSON weights must be finite and non-negative');
  }
  const total = curve.reduce((sum, w) => sum + w, 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new Error(`PAYOUT_SCHEDULE_JSON must sum to 100, got ${total}`);
  }
}
