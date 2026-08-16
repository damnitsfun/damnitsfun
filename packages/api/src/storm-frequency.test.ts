import { loadConfig } from './config';

/**
 * Rainbow Storm frequency (retrospection finding 4).
 *
 * The storm rolls independently on EVERY CARD PLAY, so the rate a human cares
 * about — storms per game — is `cardPlaysPerGame × RAINBOW_STORM_CHANCE`. That
 * multiplication is the whole trap: 1e-5 reads like a plausible "rare event"
 * number until you multiply it out and find it means one storm every ~2,565
 * games. Across every game ever played on staging it had fired zero times, while
 * the mechanic carried an on-chain jackpot, a section in skill.md and a section
 * on the homepage.
 *
 * MEASURED, not assumed (CLAUDE.md rule 6): 54 settled staging games, 2,105 card
 * plays, mean 39.0 per game. These tests pin the arithmetic against that figure so
 * the default cannot drift back to a value that never fires.
 */

/** Mean CARD_PLAYED events per settled game, measured over 54 real games. */
const MEASURED_CARD_PLAYS_PER_GAME = 39;

const stormsPerGame = (p: number): number => p * MEASURED_CARD_PLAYS_PER_GAME;
const gamesPerStorm = (p: number): number => 1 / stormsPerGame(p);

describe('rainbow storm frequency', () => {
  it('ships a default a season actually reaches', () => {
    const { rainbowStormChance } = loadConfig({ env: {} });
    const games = gamesPerStorm(rainbowStormChance);

    // The bug: one storm every ~2,565 games. Anything in that region is a mechanic
    // that exists only in documentation.
    expect(games).toBeLessThan(100);
    // ...but it must stay an EVENT, not routine. A storm every few games would make
    // the season's first-storm jackpot a race to game 1 and the card unremarkable.
    expect(games).toBeGreaterThan(15);
  });

  it('documents what the old default actually meant', () => {
    // Kept as an executable record of the finding, so the number that was wrong
    // stays legible next to the one that replaced it.
    expect(Math.round(gamesPerStorm(0.00001))).toBe(2564);
    expect(gamesPerStorm(0.0006)).toBeLessThan(50);
  });

  it('is driven by card plays, not games — the multiplication that was missed', () => {
    // A reader who treats the chance as per-GAME under-counts by ~39x, which is
    // exactly how 1e-5 came to look reasonable.
    const p = 0.0006;
    expect(stormsPerGame(p)).toBeCloseTo(0.0234, 4);
    expect(stormsPerGame(p) / p).toBe(MEASURED_CARD_PLAYS_PER_GAME);
  });

  it('still honours an explicit override in both directions', () => {
    expect(loadConfig({ env: { RAINBOW_STORM_CHANCE: '0' } }).rainbowStormChance).toBe(0);
    expect(loadConfig({ env: { RAINBOW_STORM_CHANCE: '1' } }).rainbowStormChance).toBe(1);
  });
});
