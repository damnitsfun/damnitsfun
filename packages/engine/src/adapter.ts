import {
  Card,
  DrawEvent,
  Game,
  GameDirection,
  GameEndEvent,
  Player,
  Value,
  setNextDeckSeed,
} from './vendor';
import {
  EngineError,
  IllegalMoveError,
  InvalidCardError,
  InvalidFinalCallError,
  MustDrawFirstError,
  NotYourTurnError,
  SessionEndedError,
  SessionNotFoundError,
  translateVendorError,
} from './errors';
import {
  GameEndReason,
  PlayDirection,
  SessionEvent,
  SessionEventRecord,
  SessionEventStore,
  SessionEventType,
  InMemorySessionEventStore,
  toRecord,
} from './events';
import { rainbowStorm, timeout, TimeoutController, TimeoutResolution } from './house-rules';
import { Move } from './moves';
import { createSeededRandom } from './prng';
import {
  ColorName,
  PublicCard,
  cardToPublic,
  colorToName,
  nameToColor,
  symbolToValue,
  valueToSymbol,
} from './vocabulary';

const COLOR_NAMES: readonly ColorName[] = ['red', 'blue', 'green', 'yellow'];
const DEFAULT_TIME_LIMIT_MS = 120_000;
const DEFAULT_RAINBOW_STORM_CHANCE = 0.00001;
const RAINBOW_STORM_DRAW_COUNT = 6;

export interface GameSessionOptions {
  /** Stable session id. Defaults to a generated `sess_...`. */
  sessionId?: string;
  /** Commit-reveal seed. When set, the deck, starting player, and storm rolls are all deterministic. */
  seedReveal?: string;
  /** Wall-clock cap in ms (default 120_000, §9). */
  timeLimitMs?: number;
  /** Persistence port. Defaults to an in-memory store. */
  store?: SessionEventStore;
  /** Monotonic ms clock (default `Date.now`); injectable for tests. */
  clock?: () => number;
  /** Rainbow Storm per-play probability (default 0.00001, §9). */
  rainbowStormChance?: number;
  /** Injected storm trigger, overriding the seed-derived / random default (tests). */
  stormRoll?: () => boolean;
}

interface Snapshot {
  currentAgentId: string;
  direction: PlayDirection;
  ended: boolean;
  /**
   * Per-agent hand *length* before the move. Draws append to the end of the
   * hand (vendored `player.hand.concat(cards)`), so the cards a player gained
   * are exactly the ones past this index afterward. We key off length, not
   * card-instance identity: the vendored deck re-mints the SAME Card instances
   * on reshuffle, so a drawn card can be an object already held — identity
   * diffing would silently drop it and under-count the draw.
   */
  handSizes: Map<string, number>;
}

function isWildSymbol(symbol: string): boolean {
  return symbol === 'RAINBOW' || symbol === 'MEGARAINBOW';
}

/**
 * Live, incrementally-drivable session wrapping the vendored `Game` 1:1 (parent
 * spec §7). The API calls this one move at a time as real network requests
 * arrive. It is the **sole rules authority** (`getLegalMoves`) and the sole
 * producer of the durable event log — no other component re-derives legality or
 * regenerates events (Requirements NFR-2, FR-7.3).
 *
 * Pure logic: no HTTP, no DB. Persistence goes through the injected
 * {@link SessionEventStore} port.
 */
export class GameSession {
  readonly sessionId: string;
  readonly seatAgentIds: string[];
  readonly timeLimitMs: number;
  readonly seedReveal: string | null;
  readonly rainbowStormChance: number;

  private readonly game: Game;
  private readonly store: SessionEventStore;
  private readonly clock: () => number;
  private readonly timeoutController: TimeoutController;

  private seq = 0;
  private readonly events: SessionEvent[] = [];

  private ended = false;
  private endWinnerAgentId: string | null = null;
  private endReason: GameEndReason | null = null;
  private endEmitted = false;

  private hasDrawnThisTurn = false;
  private pendingStorm: { actor: string; victims: string[] } | null = null;

  constructor(seatAgentIds: string[], options: GameSessionOptions = {}) {
    // The vendored Player trims its name, so an id that is not already trimmed
    // would never match `getPlayer(agentId)`: that seat's hand would read as
    // empty (its dealt cards missing from the log) and the session would deadlock
    // with no legal moves. Reject rather than silently mangle an agent id.
    for (const agentId of seatAgentIds) {
      if (typeof agentId !== 'string' || agentId.trim() !== agentId || agentId.length === 0) {
        throw new SessionNotFoundError(
          `Invalid seat agentId ${JSON.stringify(agentId)}: must be a non-empty string with no leading/trailing whitespace.`,
        );
      }
      // Hands/values are keyed by agentId in plain objects, so a prototype key
      // would set the prototype instead of an own property and the seat would
      // vanish from every payload the engine emits.
      if (agentId === '__proto__' || agentId === 'constructor' || agentId === 'prototype') {
        throw new SessionNotFoundError(`Invalid seat agentId ${JSON.stringify(agentId)}: reserved name.`);
      }
    }
    this.seatAgentIds = [...seatAgentIds];
    this.sessionId = options.sessionId ?? `sess_${Math.random().toString(36).slice(2, 10)}`;
    this.timeLimitMs = options.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
    this.seedReveal = options.seedReveal ?? null;
    this.store = options.store ?? new InMemorySessionEventStore();
    this.clock = options.clock ?? (() => Date.now());

    // 1 + 2. Instantiate the vendored Game; seed the deck deterministically first.
    if (this.seedReveal !== null) setNextDeckSeed(this.seedReveal);
    try {
      this.game = new Game(seatAgentIds);
    } catch (error) {
      setNextDeckSeed(undefined); // don't leak a pending seed on failure
      throw translateVendorError(error);
    } finally {
      setNextDeckSeed(undefined); // belt-and-suspenders: seed is consumed once
    }

    // The vendored newGame() picks the starting player with Math.random, NOT the
    // seeded deck. Override it deterministically from the seed so a seeded session
    // is fully reproducible (deck + start + storms) and thus replayable.
    if (this.seedReveal !== null) {
      const pickStart = createSeededRandom(`${this.seedReveal}:start`);
      const startIndex = Math.floor(pickStart() * this.seatAgentIds.length);
      const startName = this.seatAgentIds[startIndex];
      const startPlayer = startName !== undefined ? this.game.getPlayer(startName) : undefined;
      if (startPlayer) this.game.currentPlayer = startPlayer;
    }

    // 3. House rules: timeout + Rainbow Storm.
    this.timeoutController = timeout(this.game, this.timeLimitMs, this.clock);

    this.rainbowStormChance = options.rainbowStormChance ?? DEFAULT_RAINBOW_STORM_CHANCE;
    // Must round-trip through JSON in SESSION_STARTED for replay to reproduce
    // storms; NaN/Infinity would serialize to null and silently fall back to the
    // default, diverging the replay.
    if (!Number.isFinite(this.rainbowStormChance) || this.rainbowStormChance < 0 || this.rainbowStormChance > 1) {
      throw new EngineError(
        `rainbowStormChance must be a finite number in [0, 1], got ${String(this.rainbowStormChance)}`,
      );
    }
    const stormRoll =
      options.stormRoll ??
      (this.seedReveal !== null
        ? this.seedDerivedStormRoll(this.seedReveal, this.rainbowStormChance)
        : undefined);
    this.installRainbowStorm(this.rainbowStormChance, stormRoll);

    // 4. Subscribe to vendored events for auto-call, turn/draw tracking, and end.
    this.installCoreListeners();

    // Emit the opening event (seq 0).
    this.emitSessionStarted();
  }

  // ---- seed-derived storm roll ------------------------------------------------

  private seedDerivedStormRoll(seed: string, chance: number): () => boolean {
    const rnd = createSeededRandom(`${seed}:storm`);
    return () => rnd() < chance;
  }

  private installRainbowStorm(chance: number, roll: (() => boolean) | undefined): void {
    rainbowStorm(this.game, {
      chance,
      roll,
      drawCount: RAINBOW_STORM_DRAW_COUNT,
      onStorm: (actor, victims) => {
        this.pendingStorm = { actor, victims };
      },
    });
  }

  private installCoreListeners(): void {
    // Auto-call last card (frozen MVP house rule) needs NO listener. The rule
    // guarantees a player at 1 card can never be caught or penalized, and the
    // only thing in the vendored engine that penalizes anyone is `Game.uno()`.
    // `applyMove` rejects both `callLastCard` and `challengeLastCard`, so nothing
    // in this package calls `uno()` — the guarantee holds by construction.
    //
    // Do NOT "mark" players by calling `uno()` here: it is only safe while
    // `yellers[name]` is unset, and that flag is cleared solely by the public
    // `draw()`. Forced GRAB2/MEGARAINBOW/storm draws go through `privateDraw`,
    // which leaves it set — so a player who reaches 1 card, is force-drawn back
    // up, then returns to 1 card would hit `uno()`'s lie-penalty branch and
    // silently draw 2 cards that emit no event, desyncing the log from state.
    this.game.on('draw', (event: DrawEvent) => {
      if (event.player.name === this.game.currentPlayer.name) this.hasDrawnThisTurn = true;
    });

    this.game.on('nextplayer', () => {
      this.hasDrawnThisTurn = false;
    });

    this.game.on('end', (event: GameEndEvent) => {
      if (this.ended) return;
      this.ended = true;
      this.endWinnerAgentId = event.winner.name;
      this.endReason = this.timeoutController.resolved ? 'timeout' : 'empty_hand';
    });
  }

  // ---- public API (parent spec §7) -------------------------------------------

  /**
   * Legal moves for `agentId` right now, in product vocabulary. Returns `[]` when
   * it is not the agent's turn or the session has ended. THE sole rules authority
   * for the whole system.
   */
  getLegalMoves(agentId: string): Move[] {
    // Enforce the wall clock on the READ path too. Otherwise an expired session
    // keeps advertising a live turn and legal moves that applyMove then refuses,
    // and a table whose agent only polls would never be resolved.
    this.checkTimeout();
    return this.legalMovesFor(agentId);
  }

  /**
   * Legal-move derivation WITHOUT a wall-clock check.
   *
   * `applyMove` checks the clock exactly once, up front, and must then act on a
   * stable view: if the gate re-checked, a cap crossed mid-call would resolve the
   * timeout inside the gate, making the move fail as "illegal" instead of
   * "session ended" and emitting a GAME_ENDED the caller never sees.
   */
  private legalMovesFor(agentId: string): Move[] {
    if (this.ended) return [];
    if (this.game.currentPlayer.name !== agentId) return [];

    const moves: Move[] = [];
    const hand = this.game.currentPlayer.hand;
    const top = this.game.discardedCard;
    const seen = new Set<string>();

    for (const card of hand) {
      if (card.isWildCard()) {
        const symbol = valueToSymbol(card.value);
        const key = `${symbol}:null`;
        if (!seen.has(key)) {
          seen.add(key);
          moves.push({ type: 'playCard', card: { symbol, color: null } });
        }
      } else if (card.matches(top)) {
        const symbol = valueToSymbol(card.value);
        const color = card.color !== undefined ? colorToName(card.color) : null;
        const key = `${symbol}:${color}`;
        if (!seen.has(key)) {
          seen.add(key);
          moves.push({ type: 'playCard', card: { symbol, color } });
        }
      }
    }

    // One draw per turn, then pass. (callLastCard/challengeLastCard are omitted:
    // last card is auto-called in MVP, so neither is ever beneficial.)
    if (this.hasDrawnThisTurn) moves.push({ type: 'passTurn' });
    else moves.push({ type: 'drawCard' });

    return moves;
  }

  /**
   * Apply `agentId`'s move: translate to the vendored call, catch vendored errors
   * and rethrow them typed, persist the resulting events, and return them.
   */
  applyMove(agentId: string, move: Move, opts: { reasoning?: string } = {}): SessionEvent[] {
    const reasoning = opts.reasoning ?? null;

    if (!this.seatAgentIds.includes(agentId)) {
      throw new SessionNotFoundError(`Agent ${agentId} is not seated in this session`);
    }
    if (this.ended) throw new SessionEndedError();

    // Enforce the wall-clock cap before acting; a resolved timeout ends the session.
    if (this.checkTimeout()) throw new SessionEndedError('Session ended: time limit exceeded');

    if (this.game.currentPlayer.name !== agentId) throw new NotYourTurnError();

    // Last-card moves are never legal here: last card is auto-called (frozen MVP
    // house rule), so calling is redundant and challenging is impossible. Reject
    // them explicitly — `callLastCard` must NEVER reach the vendored `uno()`,
    // whose lie-penalty branch would silently draw 2 unlogged cards to the caller.
    if (move.type === 'callLastCard') {
      throw new InvalidFinalCallError(
        'Calling is unnecessary: last card is auto-called in this arena (MVP house rule).',
      );
    }
    if (move.type === 'challengeLastCard') {
      throw new InvalidFinalCallError(
        'Challenging is disabled: last card is auto-called in this arena (MVP house rule).',
      );
    }

    // THE gate: nothing is applied that `getLegalMoves` did not offer. This makes
    // getLegalMoves the sole rules authority by construction (NFR-2) rather than
    // by convention — no per-move guard can be forgotten, and no move outside the
    // advertised set can mutate state or the event log.
    if (!this.isOffered(agentId, move)) {
      // Preserve the §7 taxonomy: the gate reports *why* the move was refused,
      // rather than flattening every rejection to one generic code.
      if (move.type === 'passTurn' && !this.hasDrawnThisTurn) throw new MustDrawFirstError();
      if (move.type === 'playCard') {
        throw new InvalidCardError('You cannot play that card right now');
      }
      throw new IllegalMoveError(`Move ${move.type} is not legal right now`);
    }

    const startIndex = this.events.length;
    this.pendingStorm = null;
    const snapshot = this.snapshotState();

    try {
      switch (move.type) {
        case 'playCard':
          this.applyPlay(agentId, move, reasoning, snapshot);
          break;
        case 'drawCard':
          this.applyDraw(agentId, reasoning, snapshot);
          break;
        case 'passTurn':
          this.applyPass(agentId, reasoning, snapshot);
          break;
        default: {
          const exhaustive: never = move;
          throw new EngineError(`Unknown move: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      // Typed errors pass through unchanged; vendored errors get translated.
      throw translateVendorError(error);
    }

    return this.events.slice(startIndex);
  }

  /**
   * Is `move` in the set `getLegalMoves` currently offers?
   *
   * Wild plays are offered as a template with `color: null` (the §5 contract —
   * the agent chooses the color), so a submitted wild matches on symbol alone;
   * `applyPlay` then enforces that a color was actually chosen. Every other move
   * must match exactly.
   */
  private isOffered(agentId: string, move: Move): boolean {
    const legal = this.legalMovesFor(agentId);
    if (move.type !== 'playCard') return legal.some((m) => m.type === move.type);

    return legal.some((m) => {
      if (m.type !== 'playCard' || m.card.symbol !== move.card.symbol) return false;
      // Wild template: any chosen color (including none yet) matches the offer.
      if (m.card.color === null) return true;
      return m.card.color === move.card.color;
    });
  }

  /**
   * Wall-clock check independent of any move. Returns the resolution if the time
   * limit has been exceeded (and emits GAME_ENDED once), else null. Idempotent.
   */
  checkTimeout(): TimeoutResolution | null {
    const resolution = this.timeoutController.check();
    if (resolution && !this.endEmitted) {
      // The controller's check() dispatched `end`, so the end listener has already
      // recorded winner/reason=timeout.
      this.emitGameEnded();
    }
    return resolution;
  }

  // ---- read accessors (used by replay + spec 04) ------------------------------

  // Every public read resolves the wall clock first, so a caller assembling a
  // state snapshot can never observe a half-expired session — e.g. reading the
  // log before the flags and getting a log without its GAME_ENDED. The internal
  // `*Internal` variants skip the check and are what emitGameEnded uses, so
  // resolving a timeout cannot re-enter itself.

  get isEnded(): boolean {
    this.checkTimeout(); // an expired session is over even if nobody has moved
    return this.ended;
  }

  /** The agent whose turn it is, or null once the session has ended. */
  get currentAgentId(): string | null {
    return this.isEnded ? null : this.game.currentPlayer.name;
  }

  get winnerAgentId(): string | null {
    this.checkTimeout();
    return this.endWinnerAgentId;
  }

  /** Current public hands, keyed by agentId. */
  getPublicHands(): Record<string, PublicCard[]> {
    this.checkTimeout();
    return this.publicHandsInternal();
  }

  /** Per-agent hand value (sum of card scores). */
  getHandValues(): Record<string, number> {
    this.checkTimeout();
    return this.handValuesInternal();
  }

  /** All events emitted so far (structured). */
  getEvents(): SessionEvent[] {
    this.checkTimeout();
    return [...this.events];
  }

  /** Persisted records from the store, in seq order. */
  getRecords(): SessionEventRecord[] {
    this.checkTimeout();
    return this.store.readAll(this.sessionId);
  }

  private publicHandsInternal(): Record<string, PublicCard[]> {
    const hands: Record<string, PublicCard[]> = {};
    for (const agentId of this.seatAgentIds) {
      hands[agentId] = this.handOf(agentId).map(cardToPublic);
    }
    return hands;
  }

  private handValuesInternal(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const agentId of this.seatAgentIds) {
      values[agentId] = this.handOf(agentId).reduce((sum, card) => sum + card.score, 0);
    }
    return values;
  }

  // ---- move application -------------------------------------------------------

  private applyPlay(agentId: string, move: Extract<Move, { type: 'playCard' }>, reasoning: string | null, snapshot: Snapshot): void {
    const hand = this.game.currentPlayer.hand;
    const value = symbolToValue(move.card.symbol);

    let instance: Card | undefined;
    if (isWildSymbol(move.card.symbol)) {
      instance = hand.find((c) => c.value === value);
      if (!instance) throw new InvalidCardError(`You do not hold a ${move.card.symbol}`);
      if (move.card.color == null) throw new InvalidCardError('A wild card requires a chosen color');
      // The wild template accepts any colour, so an out-of-contract value reaches
      // here straight from untrusted input; report it as an invalid card rather
      // than letting a raw translation error escape untyped.
      if (!COLOR_NAMES.includes(move.card.color)) {
        throw new InvalidCardError(`"${String(move.card.color)}" is not a valid color`);
      }
      instance.color = nameToColor(move.card.color);
    } else {
      const color = move.card.color != null ? nameToColor(move.card.color) : undefined;
      instance = hand.find((c) => c.value === value && (color === undefined || c.color === color));
      if (!instance) throw new InvalidCardError('You do not hold that card');
    }

    // The card's identity (wilds always report color: null) and, separately, the
    // colour now in force — the player's choice for a wild, else the card's own.
    const playedPublic = cardToPublic(instance);
    const chosenColor: ColorName | null =
      instance.color === undefined ? null : colorToName(instance.color);

    this.game.play(instance);

    if (this.preemptedByTimeout(snapshot)) return;

    this.emit('CARD_PLAYED', {
      agentId,
      card: playedPublic,
      chosenColor,
      handCountAfter: this.handOf(agentId).length,
    }, reasoning);

    if (this.pendingStorm) {
      const { victims } = this.pendingStorm;
      this.emit('RAINBOW_STORM', { agentId, victims, drawCount: RAINBOW_STORM_DRAW_COUNT }, null);
      for (const victim of victims) {
        this.emitDraw(victim, this.addedCards(snapshot, victim), 'rainbowstorm');
      }
      // Storm keeps the turn with the actor: no TURN_CHANGED, no end.
      return;
    }

    // Forced draws from GRAB2 / MEGARAINBOW hit the next player.
    const cause = value === Value.DRAW_TWO ? 'grab2' : value === Value.WILD_DRAW_FOUR ? 'megarainbow' : null;
    if (cause) {
      for (const other of this.seatAgentIds) {
        if (other === agentId) continue;
        const added = this.addedCards(snapshot, other);
        if (added.length > 0) this.emitDraw(other, added, cause);
      }
    }

    this.emitTurnOrEnd(snapshot);
  }

  private applyDraw(agentId: string, reasoning: string | null, snapshot: Snapshot): void {
    this.game.draw();
    if (this.preemptedByTimeout(snapshot)) return;

    const added = this.addedCards(snapshot, agentId);
    this.emit('CARD_DRAWN', {
      agentId,
      cards: added.map(cardToPublic),
      count: added.length,
      cause: 'draw',
      handCountAfter: this.handOf(agentId).length,
    }, reasoning);
    // Drawing never advances the turn or ends the game.
  }

  private applyPass(agentId: string, reasoning: string | null, snapshot: Snapshot): void {
    this.game.pass();
    if (this.preemptedByTimeout(snapshot)) return;

    this.emit('TURN_PASSED', { agentId }, reasoning);
    this.emitTurnOrEnd(snapshot);
  }

  // ---- event emission ---------------------------------------------------------

  private emitTurnOrEnd(snapshot: Snapshot): void {
    if (this.ended && !snapshot.ended) {
      this.emitGameEnded();
      return;
    }
    // Direction rides on TURN_CHANGED, so also emit when only the direction moved:
    // a UTURN at a 2-seat table flips direction but hands the turn back to the
    // actor, which would otherwise leave the log's direction permanently stale.
    if (
      this.game.currentPlayer.name !== snapshot.currentAgentId ||
      this.direction() !== snapshot.direction
    ) {
      this.emit('TURN_CHANGED', {
        currentAgentId: this.game.currentPlayer.name,
        direction: this.direction(),
      }, null);
    }
  }

  private emitDraw(agentId: string, cards: Card[], cause: 'grab2' | 'megarainbow' | 'rainbowstorm'): void {
    this.emit('CARD_DRAWN', {
      agentId,
      cards: cards.map(cardToPublic),
      count: cards.length,
      cause,
      handCountAfter: this.handOf(agentId).length,
    }, null);
  }

  private emitGameEnded(): void {
    if (this.endEmitted) return;
    this.endEmitted = true;
    this.emit('GAME_ENDED', {
      winnerAgentId: this.endWinnerAgentId ?? '',
      reason: this.endReason ?? 'empty_hand',
      finalHands: this.publicHandsInternal(),
      handValues: this.handValuesInternal(),
    }, null);
  }

  private emitSessionStarted(): void {
    this.emit('SESSION_STARTED', {
      seats: this.seatAgentIds.map((agentId, seatIndex) => ({ seatIndex, agentId })),
      seedReveal: this.seedReveal,
      timeLimitMs: this.timeLimitMs,
      rainbowStormChance: this.rainbowStormChance,
      firstAgentId: this.game.currentPlayer.name,
      hands: this.publicHandsInternal(),
      discard: cardToPublic(this.game.discardedCard),
    }, null);
  }

  private emit(type: SessionEventType, payload: unknown, reasoning: string | null): void {
    const event = {
      seq: this.seq++,
      type,
      payload,
      reasoning,
      createdAt: new Date(this.clock()).toISOString(),
    } as SessionEvent;
    this.events.push(event);
    this.store.append(toRecord(this.sessionId, event));
  }

  // ---- state helpers ----------------------------------------------------------

  private preemptedByTimeout(snapshot: Snapshot): boolean {
    // A backstop for the (practically impossible) case where the wall clock
    // crosses the cap mid-move via the house-rule guard, cancelling the move: end
    // cleanly, emit no decision event. This must key off an actual *timeout*
    // resolution — a normal winning play also sets `ended`, but its card WAS
    // played and must still produce its CARD_PLAYED decision event.
    if (this.timeoutController.resolved && !snapshot.ended) {
      this.emitGameEnded();
      return true;
    }
    return false;
  }

  private snapshotState(): Snapshot {
    const handSizes = new Map<string, number>();
    for (const agentId of this.seatAgentIds) {
      handSizes.set(agentId, this.handOf(agentId).length);
    }
    return {
      currentAgentId: this.game.currentPlayer.name,
      direction: this.direction(),
      ended: this.ended,
      handSizes,
    };
  }

  /**
   * Cards `agentId` gained during the move: everything appended past its
   * pre-move hand length. Returns [] when the hand did not grow (e.g. the actor
   * who played a card). Position-based, so re-minted duplicate instances after a
   * deck reshuffle are still counted correctly.
   */
  private addedCards(snapshot: Snapshot, agentId: string): Card[] {
    const before = snapshot.handSizes.get(agentId) ?? 0;
    const hand = this.handOf(agentId);
    return hand.length > before ? hand.slice(before) : [];
  }

  private handOf(agentId: string): Card[] {
    const player: Player | undefined = this.game.getPlayer(agentId);
    return player ? player.hand : [];
  }

  private direction(): PlayDirection {
    return this.game.playingDirection === GameDirection.CLOCKWISE ? 'cw' : 'ccw';
  }
}
