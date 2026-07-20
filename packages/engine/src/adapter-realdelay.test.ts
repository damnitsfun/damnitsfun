import { GameSession } from './adapter';
import { GameEndedPayload, InMemorySessionEventStore } from './events';
import { Move } from './moves';
import { createSeededRandom } from './prng';
import { ColorName } from './vocabulary';

/**
 * T6 — the single most important test in the project (FR-1.6).
 *
 * Proves the engine tolerates REAL wall-clock gaps between calls: a full
 * 4-player game is driven one move at a time with a real `setTimeout` delay
 * (hundreds of ms) between EVERY move — no mocked/fake timers. Inspection alone
 * cannot prove this; only real elapsed time can.
 *
 * Run 10× (10 seeded games) to catch flakiness. The games run concurrently so
 * the suite stays ~one game long in wall time while still exercising 10 full
 * games across real delays — and the interleaved timers add extra stress.
 */

const SEATS = ['A', 'B', 'C', 'D'];
const COLORS: ColorName[] = ['red', 'blue', 'green', 'yellow'];

/** Real (not fake) timer delay — hundreds of ms between moves, as T6 demands. */
const DELAY_MS = 300;
const GAMES = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RealDelayResult {
  seed: string;
  ended: boolean;
  reason: string;
  winner: string | null;
  winnerHandSize: number;
  moves: number;
  eventCount: number;
  seqMonotonic: boolean;
}

async function playWithRealDelays(session: GameSession, store: InMemorySessionEventStore, seed: string): Promise<RealDelayResult> {
  const rng = createSeededRandom(`${seed}:moves`);
  let moves = 0;

  while (!session.isEnded && moves < 3000) {
    // The heart of the test: a real wall-clock gap before every single move.
    await delay(DELAY_MS);

    const agent = session.currentAgentId!;
    const legal = session.getLegalMoves(agent);
    // Prefer playing when possible (a realistic agent, and it keeps games from
    // degenerating into endless draw/pass cycles). Draw/pass only when forced.
    const plays = legal.filter((m) => m.type === 'playCard');
    const pool = plays.length > 0 ? plays : legal;
    let move: Move = pool[Math.floor(rng() * pool.length)]!;
    if (move.type === 'playCard' && move.card.color === null) {
      move = { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
    }
    session.applyMove(agent, move, { reasoning: 'real-delay move' });
    moves++;
  }

  const records = store.readAll(session.sessionId);
  const last = records[records.length - 1]!;
  const endPayload = last.eventType === 'GAME_ENDED' ? (JSON.parse(last.payloadJson) as GameEndedPayload) : null;
  const winner = session.winnerAgentId;

  return {
    seed,
    ended: session.isEnded,
    reason: endPayload?.reason ?? 'none',
    winner,
    winnerHandSize: winner ? session.getPublicHands()[winner]!.length : -1,
    moves,
    eventCount: records.length,
    seqMonotonic: records.every((r, i) => r.seq === i),
  };
}

describe('GameSession drives across REAL wall-clock delays (T6 / FR-1.6)', () => {
  it(
    `plays ${GAMES} full 4-player games with real ${DELAY_MS}ms gaps between every move`,
    async () => {
      // Construct all sessions synchronously up front (seed injection is a
      // synchronous one-shot), then drive them concurrently across real delays.
      const runs = Array.from({ length: GAMES }, (_, i) => {
        const seed = `realdelay-${i}`;
        const store = new InMemorySessionEventStore();
        const session = new GameSession(SEATS, {
          seedReveal: seed,
          sessionId: `rt_${seed}`,
          store,
          // This test deliberately burns real wall-clock time, and its longest
          // seed needs ~65s of it. The default 120s cap would leave a slow CI
          // runner ending these games by timeout, turning the `empty_hand`
          // assertion into a flake. The wall-clock rule has its own tests; here
          // we are proving the engine survives real gaps, so give it room.
          timeLimitMs: 30 * 60_000,
        });
        return { session, store, seed };
      });

      const results = await Promise.all(runs.map((r) => playWithRealDelays(r.session, r.store, r.seed)));

      for (const result of results) {
        // Every game reached a natural end across the real gaps...
        expect(result.ended).toBe(true);
        // ...by a player emptying their hand, NOT a spurious wall-clock timeout.
        expect(result.reason).toBe('empty_hand');
        expect(result.winner).not.toBeNull();
        expect(result.winnerHandSize).toBe(0);
        // ...and the persisted log is intact.
        expect(result.eventCount).toBeGreaterThan(0);
        expect(result.seqMonotonic).toBe(true);
        expect(result.moves).toBeGreaterThan(0);
      }
    },
    90_000, // generous timeout: ~one game of real-delay wall time.
  );
});
