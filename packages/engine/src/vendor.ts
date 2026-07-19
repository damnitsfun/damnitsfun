/**
 * The single import boundary between our engine code and the vendored library.
 *
 * Everything our code needs from `danguilherme/uno` is re-exported here, from
 * the *built* vendor output (`vendor-dist/`, produced by `yarn build:vendor`).
 * No file under `packages/engine/src` should import from `../vendor/...` or
 * `../vendor-dist/...` directly — always go through this module. That keeps the
 * vendored surface we depend on explicit and small.
 *
 * NOTE: these vendored names (`Value`, `Color`, etc.) are the trademark-sensitive
 * vocabulary. They must NOT leak past `packages/engine` — the vocabulary layer
 * (vocabulary.ts) translates them to product terms at the boundary.
 */

// Library entry point re-exports: Card, Color(s), Value(s), events, Game.
export * from '../vendor-dist/uno-engine';

// Additional internals the adapter/house-rules need that the entry point omits.
export { Deck, setNextDeckSeed } from '../vendor-dist/deck';
export { Player } from '../vendor-dist/player';
export { GameDirection } from '../vendor-dist/game-directions';
