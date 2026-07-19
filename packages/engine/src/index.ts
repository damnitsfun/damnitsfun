/**
 * `engine` package public API.
 *
 * Exposes only product-vocabulary types and the typed error taxonomy. The
 * vendored library and its trademark-sensitive `Value`/`Color` enums stay
 * internal (behind `./vendor`) and are never re-exported here.
 *
 * The live `GameSession` adapter is added in sub-spec 03; house-rule wiring
 * (`./house-rules`) is an internal engine concern used by that adapter, not part
 * of the external surface.
 */
export const ENGINE_PACKAGE = 'engine';

export * from './errors';
export * from './vocabulary';
