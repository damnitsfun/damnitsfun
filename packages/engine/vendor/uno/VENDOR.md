# Vendored: `danguilherme/uno` (npm `uno-engine`)

- **Upstream:** https://github.com/danguilherme/uno
- **Tag:** `v2.0.3` (Apr 2024)
- **Pinned commit:** `8b3754e6958b2607600727cd9ef04805612a4a51`
- **License:** MIT (see `LICENSE`)
- **Vendored on:** 2026-07-19

## Why vendored

Per parent spec §1: copy the source in and pin it so our patches (commit-reveal
seed injection) are stable and auditable, rather than depending on the live npm
package.

## Permitted modifications (keep this diff minimal)

The **only** edit allowed inside this directory is the RNG-injection patch to
`src/deck.ts` (task T2 / parent spec §1 Gap 1) — the `Deck` constructor is
patched to accept an optional seed and thread a seeded RNG through the `shuffle`
package's `random` option (confirmed supported by `shuffle@0.2.5`).

Everything else — typed errors, house rules, product vocabulary — is layered
*around* this code in `packages/engine/src/`, never inside `vendor/uno`, so
future upstream merges stay tractable.

Each patch below the fence is marked in-source with a `DAMNITS-PATCH` comment.

## Modifications log

- **T2 (deck.ts):** `Deck` constructor accepts an optional `rngSeed?: string`;
  when provided, a seeded PRNG is passed as `shuffle({ deck, random })` so the
  shuffle order is fully determined by the seed. Unseeded behavior is unchanged
  (falls back to the `shuffle` package's default `Math.random`).

## Running the vendored test suite

The vendored Jest suite runs unmodified as the `vendor-uno` project of this
workspace's Jest config (`packages/engine/jest.config.js`), using this folder's
own `tsconfig.json`. Run it with `yarn workspace engine test`.
