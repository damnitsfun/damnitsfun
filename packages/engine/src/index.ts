/**
 * `engine` package public API.
 *
 * Exposes only product-vocabulary types, the typed error taxonomy, the live
 * `GameSession` adapter, its move/event contracts, the persistence port, and
 * replay. The vendored library and its trademark-sensitive `Value`/`Color` enums
 * stay internal (behind `./vendor`) and are never re-exported here.
 */
export const ENGINE_PACKAGE = 'engine';

export * from './errors';
export * from './vocabulary';
export * from './moves';
export * from './events';
export * from './adapter';
export * from './replay';
