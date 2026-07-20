/**
 * Typed error taxonomy (T3 / FR-1.2, parent spec §7).
 *
 * The vendored library throws plain `Error("string message")` everywhere. This
 * module defines this project's typed error classes and a string-match table
 * (`translateVendorError`) that the adapter boundary uses to convert those plain
 * errors into typed ones. We deliberately do NOT patch the vendored throw sites
 * — matching their (consistent, human-readable) messages keeps the vendored diff
 * to just the T2 deck patch.
 */

/** Base class for every error that crosses the engine's public boundary. */
export class EngineError extends Error {
  /** Stable machine-readable code for API responses / logging. */
  readonly code: string;

  constructor(message: string, code = 'ENGINE_ERROR') {
    super(message);
    this.name = new.target.name;
    this.code = code;
    // Preserve prototype chain when compiled to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The requesting agent is not the player whose turn it is. Adapter-enforced. */
export class NotYourTurnError extends EngineError {
  constructor(message = 'It is not your turn') {
    super(message, 'NOT_YOUR_TURN');
  }
}

/** The attempted card play is illegal (wrong card, unset/mismatched color, …). */
export class InvalidCardError extends EngineError {
  constructor(message = 'Invalid card') {
    super(message, 'INVALID_CARD');
  }
}

/** A pass was attempted before drawing (mirrors the vendored draw-before-pass rule). */
export class MustDrawFirstError extends EngineError {
  constructor(message = 'You must draw at least one card before passing') {
    super(message, 'MUST_DRAW_FIRST');
  }
}

/** An invalid last-card call/challenge ("Call Last Card" / "Challenge Last Card"). */
export class InvalidFinalCallError extends EngineError {
  constructor(message = 'Invalid last-card call') {
    super(message, 'INVALID_FINAL_CALL');
  }
}

/** An action was attempted on a session whose game has already ended. */
export class SessionEndedError extends EngineError {
  constructor(message = 'The session has already ended') {
    super(message, 'SESSION_ENDED');
  }
}

/** The referenced session or player does not exist. */
export class SessionNotFoundError extends EngineError {
  constructor(message = 'Session or player not found') {
    super(message, 'SESSION_NOT_FOUND');
  }
}

/**
 * The move is well-formed and it is the agent's turn, but the move is not
 * currently legal (e.g. drawing a second time in one turn). Adapter-enforced:
 * `getLegalMoves` is the sole authority, and `applyMove` rejects anything it did
 * not offer. Maps to HTTP 400 (illegal move) in the API layer.
 */
export class IllegalMoveError extends EngineError {
  constructor(message = 'That move is not legal right now') {
    super(message, 'ILLEGAL_MOVE');
  }
}

type Matcher = { test: RegExp; make: (msg: string) => EngineError };

/**
 * Ordered match table: the first pattern whose regex matches the vendored
 * message wins. Patterns key off the stable portion of each message (player and
 * card names are interpolated, so those parts are wildcarded).
 *
 * Reference — vendored throw sites in vendor/uno/src (v2.0.3):
 *   game.ts, card/card.ts, player.ts, events/cancelable-emitter.ts.
 */
const MATCHERS: Matcher[] = [
  // --- illegal card plays (game.ts) ---
  { test: /does not have card .* at hand/, make: (m) => new InvalidCardError(m) },
  { test: /from discard pile, does not match/, make: (m) => new InvalidCardError(m) },
  { test: /^Card must have its color set before playing$/, make: (m) => new InvalidCardError(m) },
  { test: /^Discarded cards cannot have theirs colors as null$/, make: (m) => new InvalidCardError(m) },

  // --- draw-before-pass (game.ts) ---
  {
    test: /must draw at least one card before passing/,
    make: (m) => new MustDrawFirstError(m),
  },

  // --- card construction / mutation (card/card.ts) ---
  { test: /^Only wild cards can be initialized with no color$/, make: (m) => new InvalidCardError(m) },
  { test: /^Card values cannot be changed\.$/, make: (m) => new InvalidCardError(m) },
  { test: /^The value must be a value from Value enum\.$/, make: (m) => new InvalidCardError(m) },
  { test: /^Only wild cards can have theirs colors changed\.$/, make: (m) => new InvalidCardError(m) },
  { test: /^The color must be a value from Color enum\.$/, make: (m) => new InvalidCardError(m) },
  {
    test: /^Both cards must have theirs colors set before comparing$/,
    make: (m) => new InvalidCardError(m),
  },

  // --- unknown / missing player (game.ts, player.ts) ---
  { test: /^The given player does not exist$/, make: (m) => new SessionNotFoundError(m) },
  { test: /^Player is mandatory$/, make: (m) => new SessionNotFoundError(m) },
  { test: /^Player must have a name$/, make: (m) => new SessionNotFoundError(m) },
];

/**
 * Convert an error thrown by the vendored library into a typed {@link EngineError}.
 *
 * Gameplay-move failures map to one of the six taxonomy classes above. Setup and
 * internal-invariant messages (player count, duplicate names, invalid direction,
 * emitter misuse) have no dedicated gameplay class and fall back to the
 * {@link EngineError} base — so a raw vendored `Error` never leaks past the
 * boundary. A non-`Error` throw is wrapped verbatim.
 */
export function translateVendorError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;

  const message = error instanceof Error ? error.message : String(error);

  for (const matcher of MATCHERS) {
    if (matcher.test.test(message)) return matcher.make(message);
  }

  return new EngineError(message);
}
