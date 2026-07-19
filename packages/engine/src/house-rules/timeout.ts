import { Game, GameEndEvent, Player } from '../vendor';

/**
 * Timeout house rule (T4 / FR-1.4).
 *
 * Enforces a wall-clock cap on total game duration. When the cap is exceeded the
 * game is resolved by the **lowest-hand-value** rule: the player whose remaining
 * hand is worth the fewest points wins. Resolution ends the game exactly once by
 * dispatching the vendored `end` event, so downstream listeners (the adapter's
 * event log) see a normal game end.
 *
 * The clock is injectable so tests can drive elapsed time deterministically
 * (real `setTimeout`-delay proof lives in spec 03's integration test).
 */

export interface TimeoutResolution {
  reason: 'timeout';
  /** Winning player's name (agentId). */
  winner: string;
  /** Per-player remaining hand value at resolution time. */
  handValues: Record<string, number>;
  elapsedMs: number;
}

export interface TimeoutController {
  /**
   * If the time limit has been exceeded, resolve the game (once) and return the
   * resolution; otherwise return null. Idempotent — safe to poll. The adapter's
   * `checkTimeout()` (spec 03) calls this independently of any move.
   */
  check(): TimeoutResolution | null;
  readonly resolved: boolean;
  readonly limitMs: number;
}

function handValue(player: Player): number {
  return player.hand.reduce((sum, card) => sum + card.score, 0);
}

/**
 * Install the timeout rule on a game.
 *
 * @param game     the vendored game
 * @param limitMs  wall-clock cap in milliseconds (default 120_000, per §9)
 * @param clock    monotonic millisecond clock (default `Date.now`), injectable for tests
 */
export function timeout(
  game: Game,
  limitMs = 120_000,
  clock: () => number = () => Date.now(),
): TimeoutController {
  const startedAt = clock();
  let resolution: TimeoutResolution | null = null;

  function resolveByLowestHand(): TimeoutResolution {
    const handValues: Record<string, number> = {};
    let winner: Player | undefined;
    let best = Number.POSITIVE_INFINITY;

    for (const player of game.players) {
      const value = handValue(player);
      handValues[player.name] = value;
      if (value < best) {
        best = value;
        winner = player;
      }
    }

    return {
      reason: 'timeout',
      winner: winner ? winner.name : '',
      handValues,
      elapsedMs: clock() - startedAt,
    };
  }

  function check(): TimeoutResolution | null {
    if (resolution) return resolution;
    if (clock() - startedAt < limitMs) return null;

    resolution = resolveByLowestHand();
    const winner = game.getPlayer(resolution.winner);
    if (winner) {
      // End the game once; adapter's `end` listener persists it like a natural win.
      game.dispatchEvent(new GameEndEvent(winner, game.calculateScore()));
    }
    return resolution;
  }

  // Any attempted action after the cap is cancelled (the move's before-event
  // returns false), and the game is resolved.
  const guard = (): boolean => check() === null;
  game.on('beforedraw', guard);
  game.on('beforecardplay', guard);
  game.on('beforepass', guard);

  return {
    check,
    get resolved() {
      return resolution !== null;
    },
    limitMs,
  };
}
