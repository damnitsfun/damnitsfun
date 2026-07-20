import { ColorName, PublicCard } from './vocabulary';

/**
 * Session event log (T7).
 *
 * The event log is the single source of truth both the replay UI (spec 06) and
 * the on-chain result hash (spec 05) derive from. It is produced exactly once,
 * here, and never regenerated differently by two consumers (parent spec §4).
 *
 * All payloads use product vocabulary only (PublicCard symbols, lowercase color
 * names, agentIds) — no vendored enum ever appears.
 */

export type SessionEventType =
  | 'SESSION_STARTED'
  | 'CARD_PLAYED'
  | 'CARD_DRAWN'
  | 'TURN_PASSED'
  | 'RAINBOW_STORM'
  | 'TURN_CHANGED'
  | 'GAME_ENDED';

export interface SeatInfo {
  seatIndex: number;
  agentId: string;
}

/** Why a set of cards was drawn. `draw` is a voluntary decision; the rest are effects. */
export type DrawCause = 'draw' | 'grab2' | 'megarainbow' | 'rainbowstorm';

export type PlayDirection = 'cw' | 'ccw';

export type GameEndReason = 'empty_hand' | 'timeout';

export interface SessionStartedPayload {
  seats: SeatInfo[];
  seedReveal: string | null;
  timeLimitMs: number;
  /** Rainbow Storm per-play probability in effect, so a seeded replay reproduces storm rolls. */
  rainbowStormChance: number;
  firstAgentId: string;
  /** Each seat's dealt hand, keyed by agentId (full information — post-game record). */
  hands: Record<string, PublicCard[]>;
  discard: PublicCard;
}

export interface CardPlayedPayload {
  agentId: string;
  card: PublicCard;
  /** Chosen color when the played card is a wild (else same as card.color). */
  chosenColor: ColorName | null;
  handCountAfter: number;
}

export interface CardDrawnPayload {
  agentId: string;
  cards: PublicCard[];
  count: number;
  cause: DrawCause;
  handCountAfter: number;
}

export interface TurnPassedPayload {
  agentId: string;
}

export interface RainbowStormPayload {
  agentId: string;
  victims: string[];
  drawCount: number;
}

export interface TurnChangedPayload {
  currentAgentId: string;
  direction: PlayDirection;
}

export interface GameEndedPayload {
  winnerAgentId: string;
  reason: GameEndReason;
  finalHands: Record<string, PublicCard[]>;
  handValues: Record<string, number>;
}

interface EventBase {
  /** Monotonic per session, starts at 0. */
  seq: number;
  /** Agent free-text reasoning, present on decision events only (§4). */
  reasoning: string | null;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** A structured, typed session event (discriminated on `type`). */
export type SessionEvent =
  | (EventBase & { type: 'SESSION_STARTED'; payload: SessionStartedPayload })
  | (EventBase & { type: 'CARD_PLAYED'; payload: CardPlayedPayload })
  | (EventBase & { type: 'CARD_DRAWN'; payload: CardDrawnPayload })
  | (EventBase & { type: 'TURN_PASSED'; payload: TurnPassedPayload })
  | (EventBase & { type: 'RAINBOW_STORM'; payload: RainbowStormPayload })
  | (EventBase & { type: 'TURN_CHANGED'; payload: TurnChangedPayload })
  | (EventBase & { type: 'GAME_ENDED'; payload: GameEndedPayload });

/**
 * A persisted row, shaped exactly like the §4 `session_events` table so the
 * SQLite store in spec 04 is a trivial INSERT/SELECT. The adapter writes through
 * a {@link SessionEventStore}; nothing here touches a database.
 */
export interface SessionEventRecord {
  sessionId: string;
  seq: number;
  eventType: SessionEventType;
  payloadJson: string;
  reasoning: string | null;
  createdAt: string;
}

/**
 * Persistence port. The adapter depends only on this interface; the in-memory
 * implementation satisfies spec 03, and spec 04 plugs in `better-sqlite3` without
 * touching engine code.
 */
export interface SessionEventStore {
  append(record: SessionEventRecord): void;
  readAll(sessionId: string): SessionEventRecord[];
}

/** In-memory {@link SessionEventStore} for tests and pre-DB use. */
export class InMemorySessionEventStore implements SessionEventStore {
  private readonly bySession = new Map<string, SessionEventRecord[]>();

  append(record: SessionEventRecord): void {
    const rows = this.bySession.get(record.sessionId) ?? [];
    rows.push(record);
    this.bySession.set(record.sessionId, rows);
  }

  readAll(sessionId: string): SessionEventRecord[] {
    // Return a defensive copy in seq order.
    return [...(this.bySession.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
}

/** Serialize a structured event to its persisted record form. */
export function toRecord(sessionId: string, event: SessionEvent): SessionEventRecord {
  return {
    sessionId,
    seq: event.seq,
    eventType: event.type,
    payloadJson: JSON.stringify(event.payload),
    reasoning: event.reasoning,
    createdAt: event.createdAt,
  };
}

/** Parse a persisted record back into a structured event. */
export function fromRecord(record: SessionEventRecord): SessionEvent {
  return {
    seq: record.seq,
    type: record.eventType,
    payload: JSON.parse(record.payloadJson),
    reasoning: record.reasoning,
    createdAt: record.createdAt,
  } as SessionEvent;
}
