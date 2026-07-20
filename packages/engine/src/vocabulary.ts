import { Card, Color, Value } from './vendor';

/**
 * Vocabulary translation layer (T5 / parent spec §6).
 *
 * The vendored library's `Value` enum names (`SKIP`, `REVERSE`, `WILD`, …) are
 * trademark-sensitive and MUST NOT cross the engine boundary. Every value that
 * leaves `packages/engine` (API, DB, UI, skill.md) uses the **product symbols**
 * defined here. This module is the single translation point; it is the only
 * place outside the vendored code allowed to name `Value.*` members.
 *
 * | Vendored Value  | Public symbol   | Product name   |
 * |-----------------|-----------------|----------------|
 * | ZERO..NINE      | "0".."9"        | (numbers)      |
 * | SKIP            | "PASS"          | Pass           |
 * | REVERSE         | "UTURN"         | U-Turn         |
 * | DRAW_TWO        | "GRAB2"         | Grab 2         |
 * | WILD            | "RAINBOW"       | Rainbow        |
 * | WILD_DRAW_FOUR  | "MEGARAINBOW"   | Mega Rainbow   |
 * | (house rule)    | "RAINBOWSTORM"  | Rainbow Storm  |
 */

/** Product symbol for a card value. `RAINBOWSTORM` is a house-rule-only symbol. */
export type CardSymbol =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'PASS'
  | 'UTURN'
  | 'GRAB2'
  | 'RAINBOW'
  | 'MEGARAINBOW'
  | 'RAINBOWSTORM';

/**
 * Public color name. Lowercase to match the §5 API `Move` contract
 * (`color: "red"|"blue"|"green"|"yellow"|null`). Colors are generic (not
 * trademark-sensitive) but routed here to keep one translation point.
 */
export type ColorName = 'red' | 'blue' | 'green' | 'yellow';

/** A card as it appears on the public surface. `color` is null for un-colored wilds. */
export interface PublicCard {
  symbol: CardSymbol;
  color: ColorName | null;
}

const VALUE_TO_SYMBOL: Record<Value, CardSymbol> = {
  [Value.ZERO]: '0',
  [Value.ONE]: '1',
  [Value.TWO]: '2',
  [Value.THREE]: '3',
  [Value.FOUR]: '4',
  [Value.FIVE]: '5',
  [Value.SIX]: '6',
  [Value.SEVEN]: '7',
  [Value.EIGHT]: '8',
  [Value.NINE]: '9',
  [Value.DRAW_TWO]: 'GRAB2',
  [Value.REVERSE]: 'UTURN',
  [Value.SKIP]: 'PASS',
  [Value.WILD]: 'RAINBOW',
  [Value.WILD_DRAW_FOUR]: 'MEGARAINBOW',
};

const SYMBOL_TO_VALUE: ReadonlyMap<CardSymbol, Value> = new Map(
  (Object.entries(VALUE_TO_SYMBOL) as Array<[string, CardSymbol]>).map(
    ([value, symbol]) => [symbol, Number(value) as Value],
  ),
);

const COLOR_TO_NAME: Record<Color, ColorName> = {
  [Color.RED]: 'red',
  [Color.BLUE]: 'blue',
  [Color.GREEN]: 'green',
  [Color.YELLOW]: 'yellow',
};

const NAME_TO_COLOR: ReadonlyMap<ColorName, Color> = new Map(
  (Object.entries(COLOR_TO_NAME) as Array<[string, ColorName]>).map(
    ([color, name]) => [name, Number(color) as Color],
  ),
);

/** Human-readable product name for each symbol (for UI / skill.md). */
export const SYMBOL_PRODUCT_NAME: Record<CardSymbol, string> = {
  '0': '0',
  '1': '1',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  PASS: 'Pass',
  UTURN: 'U-Turn',
  GRAB2: 'Grab 2',
  RAINBOW: 'Rainbow',
  MEGARAINBOW: 'Mega Rainbow',
  RAINBOWSTORM: 'Rainbow Storm',
};

/** The house-rule-only symbol with no vendored `Value` equivalent. */
export const RAINBOW_STORM_SYMBOL: CardSymbol = 'RAINBOWSTORM';

export function valueToSymbol(value: Value): CardSymbol {
  const symbol = VALUE_TO_SYMBOL[value];
  if (symbol === undefined) {
    throw new Error(`Unknown card value: ${String(value)}`);
  }
  return symbol;
}

/**
 * Inverse of {@link valueToSymbol}. Throws for `RAINBOWSTORM`, which is a house
 * rule with no vendored card value.
 */
export function symbolToValue(symbol: CardSymbol): Value {
  const value = SYMBOL_TO_VALUE.get(symbol);
  if (value === undefined) {
    throw new Error(`Symbol "${symbol}" has no vendored card value.`);
  }
  return value;
}

export function colorToName(color: Color): ColorName {
  const name = COLOR_TO_NAME[color];
  if (name === undefined) {
    throw new Error(`Unknown color: ${String(color)}`);
  }
  return name;
}

export function nameToColor(name: ColorName): Color {
  const color = NAME_TO_COLOR.get(name);
  if (color === undefined) {
    throw new Error(`Unknown color name: "${name}"`);
  }
  return color;
}

/**
 * Translate a vendored `Card` to its public representation.
 *
 * A wild always reports `color: null`. Playing a wild mutates the card instance's
 * colour in place (the vendored engine requires it), and the vendored deck
 * re-mints the SAME `Card` instances when the draw pile is exhausted — so a wild
 * that was once played as red can come back around still carrying that colour.
 * A wild's identity is its symbol; the colour a player *chose* when playing one
 * is carried separately (the `chosenColor` field on CARD_PLAYED), never by the
 * card itself. Without this normalisation the log self-contradicts, reporting the
 * same physical card drawn as RAINBOW:red and later played as RAINBOW:blue.
 */
export function cardToPublic(card: Card): PublicCard {
  if (card.isWildCard()) return { symbol: valueToSymbol(card.value), color: null };
  return {
    symbol: valueToSymbol(card.value),
    color: card.color === undefined ? null : colorToName(card.color),
  };
}

/**
 * Build a vendored `Card` from a public symbol + optional color. Used by the
 * adapter (spec 03) to translate an incoming move into a vendored play. Wild
 * symbols (`RAINBOW`, `MEGARAINBOW`) may carry a chosen color; number/action
 * symbols require one.
 */
export function publicToCard(symbol: CardSymbol, colorName?: ColorName | null): Card {
  const value = symbolToValue(symbol);
  const color = colorName === undefined || colorName === null ? undefined : nameToColor(colorName);
  return new Card(value, color);
}
