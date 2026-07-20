import { GameSession } from './adapter';
import {
  IllegalMoveError,
  InvalidCardError,
  InvalidFinalCallError,
  MustDrawFirstError,
  NotYourTurnError,
  SessionEndedError,
  SessionNotFoundError,
} from './errors';
import { InMemorySessionEventStore, SessionEvent } from './events';
import { Move } from './moves';
import { createSeededRandom } from './prng';
import { ColorName } from './vocabulary';

const SEATS = ['A', 'B', 'C', 'D'];
const COLORS: ColorName[] = ['red', 'blue', 'green', 'yellow'];

function makeSession(seed = 'adapter-seed', store = new InMemorySessionEventStore()): GameSession {
  return new GameSession(SEATS, { seedReveal: seed, sessionId: 'sess_test', store });
}

/** Concretize a wild playCard by choosing a color; other moves pass through. */
function concretize(move: Move, rng: () => number): Move {
  if (move.type === 'playCard' && move.card.color === null) {
    return { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
  }
  return move;
}

/** Drive a session to the end using ONLY getLegalMoves (the sole rules authority). */
function playToEnd(session: GameSession, rng: () => number, cap = 3000): SessionEvent[] {
  const applied: SessionEvent[] = [];
  let steps = 0;
  while (!session.isEnded && steps < cap) {
    const agent = session.currentAgentId!;
    const moves = session.getLegalMoves(agent);
    expect(moves.length).toBeGreaterThan(0);
    const move = concretize(moves[Math.floor(rng() * moves.length)]!, rng);
    applied.push(...session.applyMove(agent, move, { reasoning: `chose ${move.type}` }));
    steps++;
  }
  return applied;
}

describe('GameSession construction + SESSION_STARTED', () => {
  it('deals 4 hands of 7 and emits a well-formed opening event', () => {
    const session = makeSession();
    const events = session.getEvents();
    expect(events[0]!.type).toBe('SESSION_STARTED');
    const payload = events[0]!.payload as import('./events').SessionStartedPayload;

    expect(payload.seats).toEqual([
      { seatIndex: 0, agentId: 'A' },
      { seatIndex: 1, agentId: 'B' },
      { seatIndex: 2, agentId: 'C' },
      { seatIndex: 3, agentId: 'D' },
    ]);
    expect(payload.seedReveal).toBe('adapter-seed');
    expect(SEATS).toContain(payload.firstAgentId);
    for (const seat of SEATS) expect(payload.hands[seat]).toHaveLength(7);
    expect(payload.discard.symbol).toBeDefined();
  });

  it('is deterministic: same seed -> same deal, start, and first legal moves', () => {
    const a = makeSession('dup');
    const b = makeSession('dup');
    expect(a.currentAgentId).toBe(b.currentAgentId);
    expect(a.getPublicHands()).toEqual(b.getPublicHands());
    expect(a.getLegalMoves(a.currentAgentId!)).toEqual(b.getLegalMoves(b.currentAgentId!));
  });
});

describe('getLegalMoves is the sole rules authority', () => {
  it('returns [] for a player when it is not their turn', () => {
    const session = makeSession();
    const current = session.currentAgentId!;
    for (const seat of SEATS) {
      if (seat === current) continue;
      expect(session.getLegalMoves(seat)).toEqual([]);
    }
  });

  it('offers drawCard before drawing and passTurn after', () => {
    const session = makeSession();
    const current = session.currentAgentId!;
    const before = session.getLegalMoves(current);
    expect(before.some((m) => m.type === 'drawCard')).toBe(true);
    expect(before.some((m) => m.type === 'passTurn')).toBe(false);

    session.applyMove(current, { type: 'drawCard' });

    const after = session.getLegalMoves(current);
    expect(after.some((m) => m.type === 'passTurn')).toBe(true);
    expect(after.some((m) => m.type === 'drawCard')).toBe(false);
  });

  it('rejects a second drawCard in one turn — no deck-fishing exploit', () => {
    // Regression: applyMove used to call game.draw() with no gate, letting an
    // agent draw unlimited cards in a single turn to fish for a specific card,
    // even though getLegalMoves stops offering drawCard after the first draw.
    const session = makeSession();
    const current = session.currentAgentId!;

    session.applyMove(current, { type: 'drawCard' });
    const handAfterOne = session.getPublicHands()[current]!.length;
    const eventsAfterOne = session.getEvents().length;

    expect(session.getLegalMoves(current).some((m) => m.type === 'drawCard')).toBe(false);
    expect(() => session.applyMove(current, { type: 'drawCard' })).toThrow(IllegalMoveError);

    // The rejected draw changed nothing.
    expect(session.getPublicHands()[current]!).toHaveLength(handAfterOne);
    expect(session.getEvents()).toHaveLength(eventsAfterOne);
  });

  it('rejects any move getLegalMoves did not offer (the structural NFR-2 gate)', () => {
    const session = makeSession('gate');
    const current = session.currentAgentId!;
    const legal = session.getLegalMoves(current);

    // passTurn is not offered before drawing.
    expect(legal.some((m) => m.type === 'passTurn')).toBe(false);
    expect(() => session.applyMove(current, { type: 'passTurn' })).toThrow();

    // A card the player does not hold is not offered.
    const offeredSymbols = new Set(
      legal.filter((m) => m.type === 'playCard').map((m) => (m as { card: { symbol: string } }).card.symbol),
    );
    const unofferedSymbol = (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const).find(
      (s) => !offeredSymbols.has(s),
    );
    if (unofferedSymbol) {
      expect(() =>
        session.applyMove(current, { type: 'playCard', card: { symbol: unofferedSymbol, color: 'red' } }),
      ).toThrow();
    }
  });

  it('every offered playCard is accepted by applyMove (legality round-trips)', () => {
    // Across many seeds, whatever getLegalMoves offers must be applyable.
    for (let i = 0; i < 25; i++) {
      const session = makeSession(`roundtrip-${i}`);
      const rng = createSeededRandom(`moves-${i}`);
      expect(() => playToEnd(session, rng)).not.toThrow();
      expect(session.isEnded).toBe(true);
    }
  });
});

describe('applyMove — typed errors', () => {
  it('NotYourTurnError when a non-current agent acts', () => {
    const session = makeSession();
    const other = SEATS.find((s) => s !== session.currentAgentId)!;
    expect(() => session.applyMove(other, { type: 'drawCard' })).toThrow(NotYourTurnError);
  });

  it('SessionNotFoundError for an unseated agent', () => {
    const session = makeSession();
    expect(() => session.applyMove('stranger', { type: 'drawCard' })).toThrow(SessionNotFoundError);
  });

  it('MustDrawFirstError when passing before drawing', () => {
    const session = makeSession();
    const current = session.currentAgentId!;
    expect(() => session.applyMove(current, { type: 'passTurn' })).toThrow(MustDrawFirstError);
  });

  it('InvalidCardError when playing a card not held', () => {
    const session = makeSession();
    const current = session.currentAgentId!;
    // A symbol/color the current player provably does not hold as a playable card.
    const held = new Set(
      session.getPublicHands()[current]!.map((c) => `${c.symbol}:${c.color}`),
    );
    let ghost: Move | null = null;
    for (const symbol of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const) {
      for (const color of COLORS) {
        if (!held.has(`${symbol}:${color}`)) {
          ghost = { type: 'playCard', card: { symbol, color } };
          break;
        }
      }
      if (ghost) break;
    }
    expect(ghost).not.toBeNull();
    expect(() => session.applyMove(current, ghost!)).toThrow(InvalidCardError);
  });

  it('InvalidFinalCallError for challengeLastCard (disabled in MVP)', () => {
    const session = makeSession();
    const current = session.currentAgentId!;
    expect(() =>
      session.applyMove(current, { type: 'challengeLastCard', targetAgentId: 'B' }),
    ).toThrow(InvalidFinalCallError);
  });

  it('InvalidFinalCallError for callLastCard — must never reach the vendored uno()', () => {
    // Regression: the vendored uno()'s lie-penalty branch silently draws 2 cards
    // to a caller holding >2 cards, emitting NO event — which would desync the
    // engine from the event log that backs replay and the on-chain resultHash.
    const session = makeSession();
    const current = session.currentAgentId!;
    const handBefore = session.getPublicHands()[current]!.length;
    const eventsBefore = session.getEvents().length;

    expect(() => session.applyMove(current, { type: 'callLastCard' })).toThrow(InvalidFinalCallError);

    // Rejected moves mutate nothing: no penalty draw, no event.
    expect(session.getPublicHands()[current]!).toHaveLength(handBefore);
    expect(session.getEvents()).toHaveLength(eventsBefore);
  });

  it('SessionEndedError after the game is over', () => {
    const session = makeSession('ends-fast');
    playToEnd(session, createSeededRandom('ef'));
    expect(session.isEnded).toBe(true);
    const anyAgent = SEATS[0]!;
    expect(() => session.applyMove(anyAgent, { type: 'drawCard' })).toThrow(SessionEndedError);
  });
});

describe('no hidden state changes: the log accounts for every card (regression)', () => {
  // Regression for the vendored `uno()` lie-penalty. `yellers[p]` is cleared only
  // by the public draw(); forced GRAB2/MEGARAINBOW draws use privateDraw, which
  // leaves it set. A player who reached 1 card, got force-drawn back up, then
  // returned to 1 card used to hit uno()'s else-branch via the auto-call listener
  // and silently gain 2 cards emitting NO event. Nothing may call uno() now.
  it('every hand change is explained by a logged event, across a large corpus', () => {
    for (let i = 0; i < 80; i++) {
      const store = new InMemorySessionEventStore();
      const sessionId = `sess_acct_${i}`;
      const session = new GameSession(SEATS, {
        seedReveal: `acct-${i}`,
        sessionId,
        store,
      });
      const rng = createSeededRandom(`acct-${i}:moves`);

      // Track hand sizes ourselves and reconcile against the emitted events.
      const sizes: Record<string, number> = {};
      const started = JSON.parse(store.readAll(sessionId)[0]!.payloadJson);
      for (const seat of SEATS) sizes[seat] = started.hands[seat].length;

      let steps = 0;
      while (!session.isEnded && steps < 3000) {
        const agent = session.currentAgentId!;
        const moves = session.getLegalMoves(agent);
        const move = concretize(moves[Math.floor(rng() * moves.length)]!, rng);
        const emitted = session.applyMove(agent, move, { reasoning: 'r' });

        // Apply the emitted events to our own tally.
        for (const event of emitted) {
          if (event.type === 'CARD_PLAYED') sizes[event.payload.agentId]! -= 1;
          else if (event.type === 'CARD_DRAWN') sizes[event.payload.agentId]! += event.payload.count;
        }

        // The tally must match reality exactly — any silent draw shows up here.
        const actual = session.getPublicHands();
        for (const seat of SEATS) {
          expect({ seat, size: sizes[seat] }).toEqual({ seat, size: actual[seat]!.length });
        }
        steps++;
      }
    }
  });

  it('rejects seat ids the vendored engine would silently trim', () => {
    // A padded id never matches getPlayer(), so that seat would read as empty —
    // its dealt cards missing from the log — and the session would deadlock.
    expect(() => new GameSession(['A ', 'B', 'C', 'D'])).toThrow(SessionNotFoundError);
    expect(() => new GameSession([' A', 'B', 'C', 'D'])).toThrow(SessionNotFoundError);
    expect(() => new GameSession(['', 'B', 'C', 'D'])).toThrow(SessionNotFoundError);
    // Prototype keys would silently vanish from every Record the engine emits.
    expect(() => new GameSession(['__proto__', 'B', 'C', 'D'])).toThrow(SessionNotFoundError);
    expect(() => new GameSession(['constructor', 'B', 'C', 'D'])).toThrow(SessionNotFoundError);
  });

  it('reports an out-of-contract wild colour as an InvalidCardError', () => {
    const session = makeSession('badcolor');
    const current = session.currentAgentId!;
    const wild = session
      .getLegalMoves(current)
      .find((m) => m.type === 'playCard' && m.card.color === null);
    if (wild && wild.type === 'playCard') {
      expect(() =>
        session.applyMove(current, {
          type: 'playCard',
          card: { symbol: wild.card.symbol, color: 'purple' as never },
        }),
      ).toThrow(InvalidCardError);
    }
  });

  it('gives a consistent snapshot when a read resolves the timeout', () => {
    // Reads used to split into clock-aware and clock-blind groups, so a payload
    // built in source order could serialise a log missing its own GAME_ENDED.
    let now = 0;
    const session = new GameSession(SEATS, {
      seedReveal: 'snapshot',
      sessionId: 'sess_snap',
      clock: () => now,
      timeLimitMs: 100,
    });
    now = 5000;
    const snapshot = {
      records: session.getRecords(),
      winner: session.winnerAgentId,
      currentAgentId: session.currentAgentId,
      ended: session.isEnded,
    };
    expect(snapshot.ended).toBe(true);
    expect(snapshot.currentAgentId).toBeNull();
    expect(snapshot.winner).not.toBeNull();
    expect(snapshot.records[snapshot.records.length - 1]!.eventType).toBe('GAME_ENDED');
  });

  it('an expired session stops advertising a live turn on the READ path', () => {
    // getLegalMoves/isEnded must enforce the wall clock too; otherwise a polling
    // agent is offered a move that applyMove then rejects, and a stalled table is
    // never resolved.
    let now = 0;
    const session = new GameSession(SEATS, {
      seedReveal: 'read-timeout',
      sessionId: 'sess_rt',
      clock: () => now,
      timeLimitMs: 1000,
    });
    const agent = session.currentAgentId!;
    expect(session.getLegalMoves(agent).length).toBeGreaterThan(0);

    now = 5000; // clock expires with nobody moving
    expect(session.getLegalMoves(agent)).toEqual([]);
    expect(session.isEnded).toBe(true);
    expect(session.currentAgentId).toBeNull();
  });

  it('rejects a non-finite rainbowStormChance rather than silently defaulting on replay', () => {
    expect(() => new GameSession(SEATS, { rainbowStormChance: Number.NaN })).toThrow(/finite/);
    expect(() => new GameSession(SEATS, { rainbowStormChance: Infinity })).toThrow(/finite/);
    expect(() => new GameSession(SEATS, { rainbowStormChance: 1.5 })).toThrow(/\[0, 1\]/);
  });
});

describe('wild cards always report a null colour publicly (regression)', () => {
  // Playing a wild colours the card instance in place, and the vendored deck
  // re-mints the SAME instances on reshuffle — so a wild could be logged as
  // RAINBOW:red while sitting uncoloured in a hand, contradicting the log.
  it('never logs a coloured wild in a hand or a draw', () => {
    for (let i = 0; i < 40; i++) {
      const store = new InMemorySessionEventStore();
      const sessionId = `sess_wild_${i}`;
      const session = new GameSession(SEATS, { seedReveal: `wild-${i}`, sessionId, store });
      playToEnd(session, createSeededRandom(`wild-${i}:moves`));

      for (const record of store.readAll(sessionId)) {
        const payload = JSON.parse(record.payloadJson);
        const cards: Array<{ symbol: string; color: string | null }> = [];
        if (record.eventType === 'CARD_DRAWN') cards.push(...payload.cards);
        if (record.eventType === 'SESSION_STARTED') {
          for (const hand of Object.values(payload.hands)) cards.push(...(hand as typeof cards));
        }
        if (record.eventType === 'GAME_ENDED') {
          for (const hand of Object.values(payload.finalHands)) cards.push(...(hand as typeof cards));
        }
        for (const card of cards) {
          if (card.symbol === 'RAINBOW' || card.symbol === 'MEGARAINBOW') {
            expect({ evt: record.eventType, card }).toEqual({
              evt: record.eventType,
              card: { symbol: card.symbol, color: null },
            });
          }
        }
      }
    }
  });

  it('still records the chosen colour on CARD_PLAYED', () => {
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, { seedReveal: 'wild-choice', sessionId: 'sess_wc', store });
    const rng = createSeededRandom('wc');
    let sawWild = false;
    let steps = 0;
    while (!session.isEnded && steps < 3000) {
      const agent = session.currentAgentId!;
      const moves = session.getLegalMoves(agent);
      const wild = moves.find((m) => m.type === 'playCard' && m.card.color === null);
      const move = concretize(wild ?? moves[Math.floor(rng() * moves.length)]!, rng);
      const emitted = session.applyMove(agent, move);
      for (const event of emitted) {
        if (event.type !== 'CARD_PLAYED') continue;
        if (event.payload.card.symbol !== 'RAINBOW' && event.payload.card.symbol !== 'MEGARAINBOW') continue;
        sawWild = true;
        expect(event.payload.card.color).toBeNull();
        expect(COLORS).toContain(event.payload.chosenColor);
      }
      steps++;
    }
    expect(sawWild).toBe(true);
  });
});

describe('event log persistence + integrity', () => {
  it('persists every event through the store with monotonic seq and attached reasoning', () => {
    const store = new InMemorySessionEventStore();
    const session = makeSession('persist', store);
    playToEnd(session, createSeededRandom('persist-moves'));

    const records = store.readAll('sess_test');
    // Store and in-memory event list agree.
    expect(records).toHaveLength(session.getEvents().length);
    // seq is 0..n-1 monotonic.
    records.forEach((r, i) => expect(r.seq).toBe(i));
    // Decision events carry reasoning; the opening/effect events do not.
    const played = records.find((r) => r.eventType === 'CARD_PLAYED');
    if (played) expect(played.reasoning).toMatch(/chose/);
    expect(records[0]!.reasoning).toBeNull(); // SESSION_STARTED
    // Ends with a GAME_ENDED naming a real winner.
    const last = records[records.length - 1]!;
    expect(last.eventType).toBe('GAME_ENDED');
  });

  it('leaks no vendored enum name into the serialized log', () => {
    const store = new InMemorySessionEventStore();
    const session = makeSession('vocab', store);
    playToEnd(session, createSeededRandom('vocab-moves'));

    const serialized = JSON.stringify(store.readAll('sess_test'));
    for (const term of ['SKIP', 'REVERSE', 'DRAW_TWO', 'WILD', 'WILD_DRAW_FOUR']) {
      expect(serialized).not.toContain(term);
    }
  });

  it('the winner ends with an empty hand on a natural finish', () => {
    const session = makeSession('winner');
    playToEnd(session, createSeededRandom('winner-moves'));
    const winner = session.winnerAgentId!;
    expect(session.getPublicHands()[winner]).toHaveLength(0);
  });
});

describe('checkTimeout — wall-clock resolution', () => {
  it('resolves by lowest hand value and emits GAME_ENDED(reason=timeout)', () => {
    let now = 0;
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, {
      seedReveal: 'timeout-seed',
      sessionId: 'sess_to',
      store,
      clock: () => now,
      timeLimitMs: 1000,
    });

    // Play a few real moves so hands diverge.
    const rng = createSeededRandom('to-moves');
    for (let i = 0; i < 8 && !session.isEnded; i++) {
      const agent = session.currentAgentId!;
      const moves = session.getLegalMoves(agent);
      session.applyMove(agent, concretize(moves[Math.floor(rng() * moves.length)]!, rng));
    }

    now = 5000; // jump past the cap
    const resolution = session.checkTimeout();
    expect(resolution).not.toBeNull();
    expect(session.isEnded).toBe(true);

    const records = store.readAll('sess_to');
    const ended = records[records.length - 1]!;
    expect(ended.eventType).toBe('GAME_ENDED');
    const payload = JSON.parse(ended.payloadJson) as import('./events').GameEndedPayload;
    expect(payload.reason).toBe('timeout');
    const minValue = Math.min(...Object.values(payload.handValues));
    expect(payload.handValues[payload.winnerAgentId]).toBe(minValue);
  });
});
