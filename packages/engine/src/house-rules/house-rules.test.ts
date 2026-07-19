import {
  Card,
  Color,
  Deck,
  Game,
  GameEndEvent,
  Player,
  Value,
  setNextDeckSeed,
} from '../vendor';
import { rainbowStorm } from './rainbow-storm';
import { timeout } from './timeout';

/**
 * T4 — house-rule DoD (parent spec §9, task T4):
 *   (a) a >=300-game 4-player fuzz confirms no game exceeds the time limit
 *       without resolving, and
 *   (b) the Rainbow Storm card-count-additive-to-108 invariant holds and is
 *       asserted explicitly (never "fixed").
 */

const COLORS = [Color.RED, Color.BLUE, Color.GREEN, Color.YELLOW];

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

/** Total card *instances* referenced across hands, draw pile, and discard. */
function countCards(game: Game): number {
  const inHands = game.players.reduce((n, p) => n + p.hand.length, 0);
  return inHands + game.deck.length + 1; // +1 discard
}

/**
 * Play one legal move for the current player using only vendored primitives.
 * (The real legal-move derivation is the adapter's job in spec 03; this is a
 * self-contained fuzz driver.)
 */
function makeRandomMove(game: Game): void {
  const player: Player = game.currentPlayer;
  const top: Card = game.discardedCard;

  const playable = player.hand.filter((c) => c.isWildCard() || c.matches(top));

  if (playable.length > 0) {
    const card = playable[randomInt(playable.length)]!;
    if (card.isWildCard()) card.color = COLORS[randomInt(COLORS.length)]!;
    game.play(card);
  } else {
    game.draw();
    game.pass();
  }
}

interface GameRun {
  ended: GameEndEvent | null;
  timedOut: boolean;
  steps: number;
}

function runFuzzGame(seed: string, limitMs: number, clockStepMs: number): GameRun {
  setNextDeckSeed(seed);
  const game = new Game(['A', 'B', 'C', 'D']);

  let now = 0;
  const controller = timeout(game, limitMs, () => now);

  let ended: GameEndEvent | null = null;
  game.on('end', (event: GameEndEvent) => {
    ended = event;
  });

  const MAX_STEPS = 5000;
  let steps = 0;
  while (ended === null && steps < MAX_STEPS) {
    now += clockStepMs;
    if (controller.check()) break; // proactive wall-clock check (mirrors adapter.checkTimeout)
    makeRandomMove(game);
    steps++;
  }

  return { ended, timedOut: controller.resolved, steps };
}

describe('Timeout house rule — 300-game fuzz (T4a)', () => {
  const GAMES = 300;
  // Advance ~1.5s of simulated time per move against the real 120s cap, so any
  // long-running random game reliably hits the wall-clock limit and must resolve.
  const LIMIT_MS = 120_000;
  const STEP_MS = 1_500;

  it('every one of 300 games resolves (natural win or timeout) — none runs unbounded', () => {
    let natural = 0;
    let timedOut = 0;

    for (let i = 0; i < GAMES; i++) {
      const run = runFuzzGame(`fuzz-${i}`, LIMIT_MS, STEP_MS);

      // (a) The game resolved — it emitted `end` and did not exhaust MAX_STEPS.
      expect(run.ended).not.toBeNull();
      expect(run.steps).toBeLessThan(5000);

      if (run.timedOut) timedOut++;
      else natural++;
    }

    // Sanity: the corpus exercised BOTH resolution paths (not a degenerate run).
    expect(natural + timedOut).toBe(GAMES);
    expect(timedOut).toBeGreaterThan(0);
    expect(natural).toBeGreaterThan(0);
  });

  it('resolves an over-time game by the lowest-hand-value rule', () => {
    setNextDeckSeed('lowest-hand');
    const game = new Game(['A', 'B', 'C', 'D']);

    let now = 0;
    const controller = timeout(game, 1_000, () => now);

    let ended: GameEndEvent | null = null;
    game.on('end', (e: GameEndEvent) => {
      ended = e;
    });

    // Play a few real moves so hands diverge, then jump the clock past the cap.
    for (let i = 0; i < 6 && ended === null; i++) makeRandomMove(game);
    now = 5_000;
    const resolution = controller.check();

    expect(resolution).not.toBeNull();
    expect(ended).not.toBeNull();

    // The declared winner must be a player with the minimum hand value.
    const minValue = Math.min(...Object.values(resolution!.handValues));
    expect(resolution!.handValues[resolution!.winner]).toBe(minValue);
    expect((ended as unknown as GameEndEvent).winner.name).toBe(resolution!.winner);
  });
});

describe('Rainbow Storm house rule (T4b)', () => {
  it('fires the storm: every other player draws 6 and the turn returns to the actor', () => {
    setNextDeckSeed('storm-effect');
    const game = new Game(['A', 'B', 'C', 'D']);

    const fired: Array<{ actor: string; victims: string[] }> = [];
    // The starting player is random, so we snapshot hand sizes at storm time
    // (inside roll, just before the victim draws) rather than assuming an actor.
    let snapshot: Map<string, number> | null = null;
    let stormActor: string | null = null;
    rainbowStorm(game, {
      roll: () => {
        if (snapshot) return false; // exactly one storm
        snapshot = new Map(game.players.map((p) => [p.name, p.hand.length]));
        stormActor = game.currentPlayer.name;
        return true;
      },
      onStorm: (actor, victims) => fired.push({ actor, victims }),
    });

    // Drive play until a card is actually played (a player may have to draw+pass first).
    let steps = 0;
    while (fired.length === 0 && steps < 500) {
      makeRandomMove(game);
      steps++;
    }

    expect(fired).toHaveLength(1);
    const actorName = fired[0]!.actor;
    expect(stormActor).toBe(actorName);

    // Victims are every other player.
    const others = game.players
      .map((p) => p.name)
      .filter((n) => n !== actorName)
      .sort();
    expect(fired[0]!.victims.slice().sort()).toEqual(others);

    // Turn returned to the actor.
    expect(game.currentPlayer.name).toBe(actorName);

    // Each victim drew exactly 6 relative to the storm-time snapshot.
    for (const p of game.players) {
      if (p.name === actorName) continue;
      expect(p.hand.length).toBe(snapshot!.get(p.name)! + 6);
    }
  });

  it('Rainbow Storm draws are ADDITIVE to the 108-card deck — invariant, not a bug', () => {
    // Base deck definition is exactly 108.
    expect(new Deck().length).toBe(108);

    // The vendored Deck re-mints the full deck when the draw pile is exhausted,
    // so drawing MORE than 108 succeeds and yields more than 108 cards. Rainbow
    // Storm's mass-draws rely on / surface this. We assert the additive behavior
    // explicitly rather than "fixing" it to conserve 108 (CLAUDE.md rule 5).
    const deck = new Deck('additive-seed');
    const first = deck.draw(100);
    const second = deck.draw(20); // 20 >= 8 remaining -> exhausts, resets to 108, draws rest
    expect(first.length + second.length).toBe(120);
    expect(first.length + second.length).toBeGreaterThan(108);

    // And through an actual forced storm: the total card instances in play can
    // exceed the 108 base once the deck has been re-minted.
    setNextDeckSeed('storm-additive');
    const game = new Game(['A', 'B', 'C', 'D']);
    rainbowStorm(game, { roll: () => true }); // storm on every play
    let guardSteps = 0;
    let ended = false;
    game.on('end', () => {
      ended = true;
    });
    while (!ended && guardSteps < 200) {
      makeRandomMove(game);
      guardSteps++;
    }
    // Never conserved down to 108 — the additive draws are real and expected.
    expect(countCards(game)).toBeGreaterThanOrEqual(108);
  });
});
