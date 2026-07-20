import { GameSession } from './adapter';
import { InMemorySessionEventStore } from './events';
import { createSeededRandom } from './prng';
import { replayByReExecution, replayByReducer } from './replay';
import { ColorName } from './vocabulary';

/**
 * T7 DoD — replaying a completed session's `session_events` reconstructs the
 * exact same final hands and winner as the live run. Verified two independent
 * ways (re-execution from seed, and a pure reducer over the logged movements).
 */

const SEATS = ['A', 'B', 'C', 'D'];
const COLORS: ColorName[] = ['red', 'blue', 'green', 'yellow'];

function runLiveGame(seed: string) {
  const store = new InMemorySessionEventStore();
  const sessionId = `sess_${seed}`;
  const session = new GameSession(SEATS, { seedReveal: seed, sessionId, store });
  const rng = createSeededRandom(`${seed}:moves`);

  let steps = 0;
  while (!session.isEnded && steps < 3000) {
    const agent = session.currentAgentId!;
    const moves = session.getLegalMoves(agent);
    let move = moves[Math.floor(rng() * moves.length)]!;
    if (move.type === 'playCard' && move.card.color === null) {
      move = { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
    }
    session.applyMove(agent, move, { reasoning: 'x' });
    steps++;
  }

  return {
    records: store.readAll(sessionId),
    finalHands: session.getPublicHands(),
    handValues: session.getHandValues(),
    winner: session.winnerAgentId,
  };
}

describe('replay over a large corpus — catches deck-reset draw under-counting (T7)', () => {
  // Regression: `addedCards` diffed hands by Card *instance identity*, but the
  // vendored deck re-mints the SAME Card instances when the draw pile is
  // exhausted, so a drawn duplicate of a card already held was silently dropped
  // and CARD_DRAWN under-counted. That desynced the log from live state in ~26%
  // of games — invisible to a 5-seed corpus, fatal to the resultHash. Deck
  // exhaustion needs long games, so this sweeps enough seeds to trigger it.
  const CORPUS = 60;

  it(`reconstructs identical final state across ${CORPUS} seeded games`, () => {
    let deckResetGames = 0;

    for (let i = 0; i < CORPUS; i++) {
      const live = runLiveGame(`corpus-${i}`);

      // Total cards in play exceeding the 108-card base proves the deck was
      // re-minted (the additive invariant), i.e. the failure mode was exercised.
      const dealt = Object.values(live.finalHands).reduce((n, h) => n + h.length, 0);
      const drawn = live.records
        .filter((r) => r.eventType === 'CARD_DRAWN')
        .reduce((n, r) => n + (JSON.parse(r.payloadJson).count as number), 0);
      if (drawn > 108 - 29) deckResetGames++;

      const reduced = replayByReducer(live.records);
      const reExecuted = replayByReExecution(live.records);

      // The log alone must reconstruct the live hands...
      for (const agent of SEATS) {
        expect(sortHand(reduced.finalHands[agent]!)).toEqual(sortHand(live.finalHands[agent]!));
      }
      expect(reduced.handValues).toEqual(live.handValues);
      expect(reduced.winnerAgentId).toBe(live.winner);
      // ...and so must a fresh re-execution from the seed.
      expect(reExecuted.handValues).toEqual(live.handValues);
      expect(reExecuted.winnerAgentId).toBe(live.winner);
      // No draw event may claim zero cards — that was the under-count signature.
      for (const record of live.records) {
        if (record.eventType !== 'CARD_DRAWN') continue;
        expect(JSON.parse(record.payloadJson).count).toBeGreaterThan(0);
      }
    }

    // Sanity: the corpus really did include long, deck-exhausting games.
    expect(deckResetGames).toBeGreaterThan(0);
  });
});

describe('replay reconstructs identical final state (T7)', () => {
  const seeds = ['r1', 'r2', 'r3', 'r4', 'r5'];

  it.each(seeds)('re-execution from seed matches the live run [%s]', (seed) => {
    const live = runLiveGame(seed);
    const replayed = replayByReExecution(live.records);

    expect(replayed.winnerAgentId).toBe(live.winner);
    expect(replayed.finalHands).toEqual(live.finalHands);
    expect(replayed.handValues).toEqual(live.handValues);
  });

  it.each(seeds)('reducer over the logged movements matches the live run [%s]', (seed) => {
    const live = runLiveGame(seed);
    const replayed = replayByReducer(live.records);

    expect(replayed.winnerAgentId).toBe(live.winner);
    // Compare hands as multisets (order within a hand is not significant).
    for (const agent of SEATS) {
      expect(sortHand(replayed.finalHands[agent]!)).toEqual(sortHand(live.finalHands[agent]!));
    }
    expect(replayed.handValues).toEqual(live.handValues);
  });

  it('reproduces the winner of a TIMEOUT-ended session', () => {
    // Regression: replay runs on a frozen clock, so a timeout game can never
    // re-time-out; the winner must come from the logged resolution instead of
    // silently coming back null.
    let now = 0;
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, {
      seedReveal: 'timeout-replay',
      sessionId: 'sess_tr',
      store,
      clock: () => now,
      timeLimitMs: 1000,
    });
    const rng = createSeededRandom('tr-moves');
    for (let i = 0; i < 8 && !session.isEnded; i++) {
      const agent = session.currentAgentId!;
      const moves = session.getLegalMoves(agent);
      let move = moves[Math.floor(rng() * moves.length)]!;
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
      }
      session.applyMove(agent, move);
    }
    now = 5000;
    session.checkTimeout();
    expect(session.isEnded).toBe(true);
    expect(session.winnerAgentId).not.toBeNull();

    const records = store.readAll('sess_tr');
    expect(replayByReExecution(records).winnerAgentId).toBe(session.winnerAgentId);
    expect(replayByReducer(records).winnerAgentId).toBe(session.winnerAgentId);
  });

  it('reproduces a session run with a NON-DEFAULT rainbow storm chance', () => {
    // Regression: the chance was not persisted, so replay fell back to the
    // default threshold and fired different storms from the same PRNG stream.
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, {
      seedReveal: 'stormy',
      sessionId: 'sess_storm',
      store,
      rainbowStormChance: 0.15, // storms actually fire at this rate
    });
    const rng = createSeededRandom('storm-moves');
    let steps = 0;
    while (!session.isEnded && steps < 3000) {
      const agent = session.currentAgentId!;
      const moves = session.getLegalMoves(agent);
      let move = moves[Math.floor(rng() * moves.length)]!;
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
      }
      session.applyMove(agent, move);
      steps++;
    }

    const records = store.readAll('sess_storm');
    // The scenario is only meaningful if storms actually fired.
    expect(records.some((r) => r.eventType === 'RAINBOW_STORM')).toBe(true);

    const replayed = replayByReExecution(records);
    expect(replayed.winnerAgentId).toBe(session.winnerAgentId);
    expect(replayed.finalHands).toEqual(session.getPublicHands());
  });

  it('rejects a forged winner in a timeout log instead of confirming it', () => {
    // Replay is the independent verification path behind on-chain settlement, so
    // it must not rubber-stamp whatever the log claims about who gets paid.
    let now = 0;
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, {
      seedReveal: 'forge',
      sessionId: 'sess_forge',
      store,
      clock: () => now,
      timeLimitMs: 1000,
    });
    const rng = createSeededRandom('forge-moves');
    for (let i = 0; i < 8 && !session.isEnded; i++) {
      const agent = session.currentAgentId!;
      const moves = session.getLegalMoves(agent);
      let move = moves[Math.floor(rng() * moves.length)]!;
      if (move.type === 'playCard' && move.card.color === null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: COLORS[Math.floor(rng() * 4)]! } };
      }
      session.applyMove(agent, move);
    }
    now = 5000;
    session.checkTimeout();

    const records = store.readAll('sess_forge');
    // Honest log verifies.
    expect(replayByReExecution(records).winnerAgentId).toBe(session.winnerAgentId);

    // Tamper: name a different seat as the winner.
    const forged = records.map((r) => {
      if (r.eventType !== 'GAME_ENDED') return r;
      const payload = JSON.parse(r.payloadJson);
      const other = SEATS.find((s) => s !== payload.winnerAgentId)!;
      return { ...r, payloadJson: JSON.stringify({ ...payload, winnerAgentId: other }) };
    });
    expect(() => replayByReExecution(forged)).toThrow(/Replay mismatch/);
  });

  describe('log tampering is detected, not confirmed', () => {
    // Replay is the independent check behind on-chain settlement, so a corrupted
    // or truncated log must fail loudly rather than reconstruct cleanly.
    const live = () => runLiveGame('tamper');

    it('rejects a forged winner in an empty_hand log (both paths)', () => {
      const { records, winner } = live();
      const forged = records.map((r) => {
        if (r.eventType !== 'GAME_ENDED') return r;
        const p = JSON.parse(r.payloadJson);
        const other = SEATS.find((s) => s !== p.winnerAgentId)!;
        return { ...r, payloadJson: JSON.stringify({ ...p, winnerAgentId: other }) };
      });
      expect(winner).not.toBeNull();
      expect(() => replayByReExecution(forged)).toThrow(/Replay mismatch/);
      expect(() => replayByReducer(forged)).toThrow(/Replay mismatch/);
    });

    it('rejects a log with a deleted event row', () => {
      const { records } = live();
      const firstDraw = records.findIndex((r) => r.eventType === 'CARD_DRAWN');
      expect(firstDraw).toBeGreaterThan(0);
      const gapped = records.filter((_, i) => i !== firstDraw);
      expect(() => replayByReExecution(gapped)).toThrow(/not contiguous/);
      expect(() => replayByReducer(gapped)).toThrow(/not contiguous/);
    });

    it('rejects a deleted trailing row even when seq is renumbered', () => {
      // The per-event handCountAfter check only fires on that agent's NEXT
      // movement, so deleting an agent's LAST draw was previously unreconciled —
      // it understated their hand and could install a forged winner. The fold is
      // now cross-checked against the log's own GAME_ENDED.finalHands.
      const { records } = live();
      const lastDrawIdx = records.map((r) => r.eventType).lastIndexOf('CARD_DRAWN');
      expect(lastDrawIdx).toBeGreaterThan(0);
      const renumbered = records
        .filter((_, i) => i !== lastDrawIdx)
        .map((r, i) => ({ ...r, seq: i }));

      expect(() => replayByReducer(renumbered)).toThrow(/Replay mismatch/);
    });

    it('rejects a truncated log relabelled as a timeout', () => {
      const { records } = live();
      // Cut the decisions short and claim the clock ran out, naming a new winner.
      const cut = Math.floor(records.length / 2);
      const endRecord = records[records.length - 1]!;
      const endPayload = JSON.parse(endRecord.payloadJson);
      const truncated = [
        ...records.slice(0, cut),
        {
          ...endRecord,
          seq: cut,
          payloadJson: JSON.stringify({ ...endPayload, reason: 'timeout' }),
        },
      ];
      // The elapsed-time cross-check refuses the timeout claim.
      expect(() => replayByReExecution(truncated)).toThrow(/Replay mismatch/);
    });
  });

  it('refuses to re-execute an unseeded session', () => {
    const store = new InMemorySessionEventStore();
    const session = new GameSession(SEATS, { sessionId: 'sess_unseeded', store });
    session.applyMove(session.currentAgentId!, { type: 'drawCard' });
    expect(() => replayByReExecution(store.readAll('sess_unseeded'))).toThrow(/unseeded/);
  });
});

function sortHand(hand: Array<{ symbol: string; color: string | null }>): string[] {
  return hand.map((c) => `${c.symbol}:${c.color}`).sort();
}
