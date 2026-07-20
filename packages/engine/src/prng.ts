/**
 * Deterministic PRNG in [0, 1) from a string seed (xmur3 hash -> mulberry32).
 *
 * Mirrors the algorithm the T2 deck patch uses internally, exposed here so the
 * adapter can derive *other* seed-determined choices — the starting player and
 * the Rainbow Storm roll — from the same commit-reveal seed. Deriving each from
 * a distinct suffix keeps the streams independent while remaining fully
 * reproducible: identical seed in, identical sequence out. This is what lets a
 * seeded session be replayed bit-for-bit from its revealed seed.
 */
export function createSeededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;

  return function seededRandom() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
