import { GameSession } from './adapter';
import {
  CardDrawnPayload,
  CardPlayedPayload,
  GameEndReason,
  GameEndedPayload,
  InMemorySessionEventStore,
  SessionEvent,
  SessionEventRecord,
  SessionStartedPayload,
  TurnPassedPayload,
  fromRecord,
} from './events';
import { Move } from './moves';
import { PublicCard } from './vocabulary';

/**
 * Replay (T7). Two independent reconstructions of a completed session's final
 * state from its persisted `session_events`, both of which must agree with the
 * live run:
 *
 *  - {@link replayByReExecution}: re-runs the engine from the revealed seed and
 *    the logged *decisions*. Proves end-to-end determinism (seed -> deck -> start
 *    -> storms -> outcome). Requires a seeded session.
 *  - {@link replayByReducer}: folds the logged *card movements* (initial deal +
 *    every play/draw) into final hands, touching no engine. Proves the log is
 *    complete on its own.
 */

export interface ReplayResult {
  winnerAgentId: string | null;
  finalHands: Record<string, PublicCard[]>;
  handValues: Record<string, number>;
}

function cardScore(card: PublicCard): number {
  switch (card.symbol) {
    case 'GRAB2':
    case 'PASS':
    case 'UTURN':
      return 20;
    case 'RAINBOW':
    case 'MEGARAINBOW':
    case 'RAINBOWSTORM':
      return 50;
    default:
      return Number(card.symbol); // '0'..'9'
  }
}

function handValues(hands: Record<string, PublicCard[]>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [agentId, cards] of Object.entries(hands)) {
    values[agentId] = cards.reduce((sum, card) => sum + cardScore(card), 0);
  }
  return values;
}

function parse(records: SessionEventRecord[]): SessionEvent[] {
  const events = [...records].sort((a, b) => a.seq - b.seq).map(fromRecord);
  // `seq` is monotonic from 0 by construction, so a gap means rows were dropped —
  // and a log missing rows is not the source of truth it is supposed to be.
  events.forEach((event, index) => {
    if (event.seq !== index) {
      throw new Error(
        `Replay mismatch: event log is not contiguous — expected seq ${index}, found ${event.seq}.`,
      );
    }
  });
  return events;
}

function requireStarted(events: SessionEvent[]): SessionStartedPayload {
  const started = events.find((e) => e.type === 'SESSION_STARTED');
  if (!started || started.type !== 'SESSION_STARTED') {
    throw new Error('Event log has no SESSION_STARTED event.');
  }
  return started.payload;
}

/**
 * Rebuild the ordered decisions (the moves agents actually made) from the log.
 * Effect events (forced draws, storm draws, turn changes) are skipped — they are
 * consequences the engine re-derives.
 */
function decisionsFromLog(events: SessionEvent[]): Array<{ agentId: string; move: Move }> {
  const decisions: Array<{ agentId: string; move: Move }> = [];
  for (const event of events) {
    switch (event.type) {
      case 'CARD_PLAYED': {
        const p = event.payload as CardPlayedPayload;
        decisions.push({
          agentId: p.agentId,
          move: { type: 'playCard', card: { symbol: p.card.symbol, color: p.chosenColor } },
        });
        break;
      }
      case 'CARD_DRAWN': {
        const p = event.payload as CardDrawnPayload;
        if (p.cause === 'draw') decisions.push({ agentId: p.agentId, move: { type: 'drawCard' } });
        break;
      }
      case 'TURN_PASSED': {
        const p = event.payload as TurnPassedPayload;
        decisions.push({ agentId: p.agentId, move: { type: 'passTurn' } });
        break;
      }
      default:
        break;
    }
  }
  return decisions;
}

/**
 * Re-execute the session from its seed + logged decisions in a fresh engine.
 * Throws if the log is from an unseeded session (not deterministically replayable).
 */
export function replayByReExecution(records: SessionEventRecord[]): ReplayResult {
  const events = parse(records);
  const started = requireStarted(events);
  if (started.seedReveal === null) {
    throw new Error('Cannot re-execute an unseeded session; use replayByReducer instead.');
  }

  const stormChance = started.rainbowStormChance;
  if (typeof stormChance !== 'number' || !Number.isFinite(stormChance)) {
    // Silently defaulting here would replay a different storm threshold against
    // the same PRNG stream and diverge. Refuse instead.
    throw new Error('Event log has no usable rainbowStormChance; cannot reproduce storm rolls.');
  }

  const seats = [...started.seats].sort((a, b) => a.seatIndex - b.seatIndex).map((s) => s.agentId);
  let now = 0;
  const replayed = new GameSession(seats, {
    seedReveal: started.seedReveal,
    timeLimitMs: started.timeLimitMs,
    // The storm chance is part of what the seed determines; replaying with a
    // different threshold would fire different storms from the same PRNG stream.
    rainbowStormChance: stormChance,
    store: new InMemorySessionEventStore(),
    // Starts frozen so fast replay cannot trip the cap; advanced deliberately
    // below if (and only if) the log says the session timed out.
    clock: () => now,
  });

  for (const { agentId, move } of decisionsFromLog(events)) {
    if (replayed.isEnded) break;
    replayed.applyMove(agentId, move);
  }

  const loggedEnd = findEnd(events);
  if (loggedEnd) {
    // A timeout resolution is not reached by replaying decisions (they empty no
    // hand). Rather than trusting the recorded winner, advance OUR clock past the
    // cap and let the replay compute the lowest-hand winner itself — that
    // reproduces the exact resolution, tie-break included.
    if (!replayed.isEnded && loggedEnd.reason === 'timeout') {
      assertTimeoutPlausible(events, started.timeLimitMs);
      now = started.timeLimitMs + 1;
      replayed.checkTimeout();
    }

    if (!replayed.isEnded) {
      throw new Error(
        `Replay mismatch: the log claims the session ended (${loggedEnd.reason}), but replaying its decisions does not end it — the log is incomplete or truncated.`,
      );
    }
    const claimed = loggedEnd.winnerAgentId || null;
    if (claimed !== null && claimed !== replayed.winnerAgentId) {
      throw new Error(
        `Replay mismatch: the log names "${claimed}" as winner, but independent replay derives "${String(replayed.winnerAgentId)}".`,
      );
    }
    assertFinalStateMatches(loggedEnd, replayed.getPublicHands(), replayed.getHandValues());
  }

  return {
    winnerAgentId: replayed.winnerAgentId,
    finalHands: replayed.getPublicHands(),
    handValues: replayed.getHandValues(),
  };
}

function findEnd(events: SessionEvent[]): GameEndedPayload | null {
  const ended = events.find((e) => e.type === 'GAME_ENDED');
  return ended && ended.type === 'GAME_ENDED' ? ended.payload : null;
}

/**
 * A timeout claim implies the wall clock actually ran past the cap. Cross-check
 * the recorded timestamps so a log truncated mid-game cannot simply be relabelled
 * as a timeout to install a different winner.
 *
 * NOTE: timestamps are self-reported by the log's producer, so this catches
 * corruption and naive tampering, not a fully malicious operator. Binding the log
 * to the chain is the on-chain `resultHash`'s job (spec 05).
 */
function assertTimeoutPlausible(events: SessionEvent[], timeLimitMs: number): void {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return;
  const elapsed = Date.parse(last.createdAt) - Date.parse(first.createdAt);
  // The timeout clock starts when the session is constructed, a moment BEFORE
  // SESSION_STARTED is stamped (dealing and payload construction sit between
  // them). Measuring from the first event therefore understates elapsed time by
  // that drift, so allow slack: rejecting an honest log would block a legitimate
  // payout, which is far worse than the weak deterrence this heuristic adds.
  // The real integrity check is assertFinalStateMatches.
  const TOLERANCE_MS = 1_000;
  if (Number.isFinite(elapsed) && elapsed < timeLimitMs - TOLERANCE_MS) {
    throw new Error(
      `Replay mismatch: the log claims a timeout, but only ${elapsed}ms elapsed between its first and last event (limit ${timeLimitMs}ms).`,
    );
  }
}

/** Canonical, order-independent form of a hand, for comparing reconstructions. */
function canonicalHand(hand: PublicCard[]): string {
  return hand.map((c) => `${c.symbol}:${String(c.color)}`).sort().join(',');
}

/**
 * Compare an independently reconstructed final state against the terminal
 * snapshot the log records in GAME_ENDED. Any disagreement means the log's
 * movement events do not add up to the outcome it claims.
 */
function assertFinalStateMatches(
  logged: GameEndedPayload,
  hands: Record<string, PublicCard[]>,
  values: Record<string, number>,
): void {
  for (const [agentId, loggedHand] of Object.entries(logged.finalHands ?? {})) {
    const rebuilt = hands[agentId];
    if (!rebuilt) {
      throw new Error(`Replay mismatch: log records a final hand for unknown seat "${agentId}".`);
    }
    if (canonicalHand(rebuilt) !== canonicalHand(loggedHand)) {
      throw new Error(
        `Replay mismatch: reconstructed final hand for "${agentId}" does not match the logged one.`,
      );
    }
  }
  for (const [agentId, loggedValue] of Object.entries(logged.handValues ?? {})) {
    if (values[agentId] !== loggedValue) {
      throw new Error(
        `Replay mismatch: reconstructed hand value for "${agentId}" is ${String(values[agentId])}, but the log records ${loggedValue}.`,
      );
    }
  }
}

/**
 * Check a logged winner is actually implied by the independently reconstructed
 * hands, per the rule that produced it. Throws if the log claims a winner the
 * reconstruction contradicts — i.e. a corrupt or forged settlement target.
 *
 * Used by the reducer, which reconstructs hands but not seating order and so
 * cannot reproduce a timeout tie-break; it therefore accepts any seat holding the
 * minimum. `replayByReExecution` derives the winner exactly.
 */
function assertWinnerConsistent(
  winner: string,
  reason: GameEndReason,
  finalHands: Record<string, PublicCard[]>,
  values: Record<string, number>,
): void {
  if (!(winner in values)) {
    throw new Error(`Replay mismatch: logged winner "${winner}" is not a seat in this session.`);
  }
  if (reason === 'empty_hand') {
    const hand = finalHands[winner] ?? [];
    if (hand.length !== 0) {
      throw new Error(
        `Replay mismatch: logged winner "${winner}" ended by empty_hand but holds ${hand.length} card(s) on replay.`,
      );
    }
    return;
  }
  // Timeout resolves by lowest hand value.
  const lowest = Math.min(...Object.values(values));
  if (values[winner] !== lowest) {
    throw new Error(
      `Replay mismatch: logged winner "${winner}" has hand value ${values[winner]}, but the lowest on replay is ${lowest}.`,
    );
  }
}

/**
 * Fold the logged card movements into final hands — no engine involved. Proves
 * the event log alone (deal + every play/draw) is a complete record of state.
 */
export function replayByReducer(records: SessionEventRecord[]): ReplayResult {
  const events = parse(records);
  const started = requireStarted(events);

  const hands: Record<string, PublicCard[]> = {};
  for (const [agentId, cards] of Object.entries(started.hands)) {
    hands[agentId] = cards.map((c) => ({ ...c }));
  }

  let winnerAgentId: string | null = null;

  const removeCard = (agentId: string, card: PublicCard, seq: number): void => {
    const hand = hands[agentId];
    if (!hand) throw new Error(`Replay mismatch: event ${seq} plays a card for unknown seat "${agentId}".`);
    const isWild = card.symbol === 'RAINBOW' || card.symbol === 'MEGARAINBOW';
    const index = hand.findIndex((c) =>
      isWild ? c.symbol === card.symbol : c.symbol === card.symbol && c.color === card.color,
    );
    // Silently ignoring a miss would let a deleted CARD_DRAWN cancel out against
    // the later play of that same card, hiding an incomplete log.
    if (index < 0) {
      throw new Error(
        `Replay mismatch: event ${seq} plays ${card.symbol}:${String(card.color)} for "${agentId}", who does not hold it in the reconstruction.`,
      );
    }
    hand.splice(index, 1);
  };

  /** Every movement event states the resulting hand size; hold the fold to it. */
  const reconcile = (agentId: string, expected: number, seq: number): void => {
    const actual = (hands[agentId] ?? []).length;
    if (actual !== expected) {
      throw new Error(
        `Replay mismatch: after event ${seq}, "${agentId}" holds ${actual} card(s) in the reconstruction but the log records ${expected}.`,
      );
    }
  };

  let endReason: GameEndReason | null = null;
  let loggedFinal: GameEndedPayload | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'CARD_PLAYED': {
        const p = event.payload as CardPlayedPayload;
        // The hand held the wild uncolored; match by symbol for wilds.
        removeCard(p.agentId, p.card, event.seq);
        reconcile(p.agentId, p.handCountAfter, event.seq);
        break;
      }
      case 'CARD_DRAWN': {
        const p = event.payload as CardDrawnPayload;
        const hand = hands[p.agentId] ?? (hands[p.agentId] = []);
        for (const card of p.cards) hand.push({ ...card });
        reconcile(p.agentId, p.handCountAfter, event.seq);
        break;
      }
      case 'GAME_ENDED': {
        const p = event.payload as GameEndedPayload;
        winnerAgentId = p.winnerAgentId || null;
        endReason = p.reason;
        loggedFinal = p;
        break;
      }
      default:
        break;
    }
  }

  const values = handValues(hands);

  // Cross-check the fold against the terminal snapshot the log itself records.
  // Without this, dropping a movement row whose owner never moves again is never
  // reconciled (the per-event check only fires on that agent's NEXT movement),
  // which silently understates a hand and can install a forged winner.
  if (loggedFinal) assertFinalStateMatches(loggedFinal, hands, values);

  // Verify the claimed winner against what this fold independently reconstructed,
  // rather than echoing the log's own assertion about who gets paid.
  if (winnerAgentId !== null && endReason !== null) {
    assertWinnerConsistent(winnerAgentId, endReason, hands, values);
  }

  return { winnerAgentId, finalHands: hands, handValues: values };
}
