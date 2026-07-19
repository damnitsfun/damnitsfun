import { CardPlayEvent, Game } from '../vendor';

/**
 * Rainbow Storm house rule (T4, prior-work design).
 *
 * On every card play there is an independent 1-in-100,000 roll
 * (`RAINBOW_STORM_CHANCE`, §9). When it hits, a "Rainbow Storm" fires: every
 * OTHER player draws 6 cards and is skipped, and the turn returns to the actor
 * (who plays again). The storm supersedes the played card's normal effect.
 *
 * **Additive-to-108 invariant (documented, do NOT "fix"):** the storm's draws
 * come from the vendored `Deck`, whose `draw()` re-mints the full 108-card deck
 * when the draw pile is exhausted (see `Deck`/`shuffle.reset`). Heavy storm
 * draws therefore push the total number of card instances in play *above* 108.
 * That is by design — see CLAUDE.md rule 5 and the fuzz test's explicit
 * assertion. The 108 figure is the base deck definition, not a conserved total.
 */

export interface RainbowStormOptions {
  /** Per-play trigger probability. Default 0.00001 (1 in 100,000). */
  chance?: number;
  /** Injected trigger, overrides `chance`. Default `() => Math.random() < chance`. */
  roll?: () => boolean;
  /** Cards each other player draws when the storm fires. Default 6. */
  drawCount?: number;
  /** Optional hook, called when a storm fires (for event-log emission in spec 03). */
  onStorm?: (actor: string, victims: string[]) => void;
}

/**
 * Install the Rainbow Storm rule on a game.
 */
export function rainbowStorm(game: Game, options: RainbowStormOptions = {}): void {
  const chance = options.chance ?? 0.00001;
  const roll = options.roll ?? (() => Math.random() < chance);
  const drawCount = options.drawCount ?? 6;

  game.on('cardplay', (event: CardPlayEvent): boolean => {
    const actor = event.player;

    // Never override a winning play: at cardplay time the card is already out of
    // hand, so an empty hand means the actor just won — let the normal end flow run.
    if (actor.hand.length === 0) return true;
    if (!roll()) return true;

    const victims: string[] = [];
    for (const player of game.players) {
      if (player.name === actor.name) continue;
      // silent: don't fire before/draw events (no interplay with the timeout guard).
      game.draw(player, drawCount, { silent: true });
      victims.push(player.name);
    }

    options.onStorm?.(actor.name, victims);

    // Returning false cancels the remainder of `play()` — including the automatic
    // advance to the next player — so the turn returns to the actor.
    return false;
  });
}
