import { createHash } from 'node:crypto';
import {
  EngineError,
  GameSession,
  SessionNotFoundError,
  type Move,
  type PublicGameView,
  type SessionEvent,
} from 'engine';
import { keccak256, toHex } from 'viem';
import { DISABLED_CHAIN, type SettlementChain } from './chain';
import { seedCommitment } from './commit';
import type { Config } from './config';
import type { Db } from './db/index';
import { SqliteSessionEventStore } from './db/event-store';
import {
  hashApiKey,
  hashesEqual,
  newAccountId,
  newAgentId,
  newApiKey,
  newClaimToken,
  newOwnerId,
  newPaymentId,
  newSessionId,
  newSessionToken,
} from './ids';
import { DISABLED_GOOGLE_OAUTH, type GoogleOAuthProvider } from './googleoauth';
import { distributePool } from './payout';
import { placementsFrom } from './ranking';
import { computeCoinSettlement } from './coins';
import { createWalletStore, type WalletStore } from './agent-wallet';
import { DISABLED_TOURNAMENT_CHAIN, type TournamentChain } from './tournament-chain';
import {
  DISABLED_XOAUTH,
  codeChallengeOf,
  newCodeVerifier,
  newOauthState,
  type XOAuthProvider,
} from './xoauth';

/**
 * Session orchestration (T10): lifecycle, matchmaking, per-decision timeouts,
 * idempotency and settlement.
 *
 * All rules logic lives in `GameSession` (NFR-2) — this module never decides what
 * is legal, only who may act, when their turn expires, and what to persist.
 *
 * Live `GameSession` objects are held in memory for the duration of a match. The
 * durable record is `session_events`; an in-flight match does not survive a
 * process restart (acceptable at hackathon scale, and the completed log is what
 * replay and settlement consume).
 */

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface AgentRow {
  id: string;
  api_key_hash: string;
  display_name: string;
  payout_address: string | null;
  wallet_address: string | null;
  owner_id: string | null;
  claimed_at: string | null;
  trueskill_mu: number;
  trueskill_sigma: number;
  coins: number;
}

export interface OwnerRow {
  id: string;
  x_user_id: string;
  x_handle: string;
}

/** A web account (sub-spec 11) — a person signed in with Google. */
export interface AccountRow {
  id: string;
  google_sub: string;
  email: string | null;
  name: string | null;
  owner_id: string | null;
  created_at: string;
}

/** What `GET /auth/session` returns. `account` is null when logged out. */
export interface WebSessionInfo {
  account: { id: string; email: string | null; name: string | null; memberSince: string } | null;
  x: { handle: string; xUserId: string } | null;
  agents: Array<{
    agentId: string;
    displayName: string;
    payoutAddress: string | null;
    coins: number;
    claimed: boolean;
  }>;
  providers: { google: boolean; x: boolean };
}

/** Public shape of an agent's ownership claim (sub-spec 09). */
export interface ClaimStatus {
  claimed: boolean;
  owner: { handle: string; xUserId: string } | null;
  claimUrl: string;
  verifiedAt: string | null;
}

interface CompetitionRow {
  id: string;
  name: string;
  status: string;
  entry_fee_wei: string;
  contract_address: string | null;
  kind: 'classic' | 'tournament';
  pool_wei: string;
  jackpot_seed_wei: string;
  payout_schedule_json: string | null;
  entries_close_at: string | null;
  entries_closed_at: string | null;
  settled_at: string | null;
  requires_claim: number;
}

interface SessionRow {
  id: string;
  competition_id: string;
  status: 'lobby' | 'seated' | 'in_progress' | 'settled' | 'archived';
  table_size: number;
  seed_commit_hash: string | null;
  seed_reveal: string | null;
  winner_agent_id: string | null;
  result_hash: string | null;
}

interface LiveSession {
  game: GameSession;
  /** Wall-clock ms after which the current agent's turn is auto-actioned. */
  deadlineAt: number;
}

export interface PendingSession {
  sessionId: string;
  /**
   * Where this table is in its lifecycle. Included so a polling agent can tell
   * "my table has not started yet" (`lobby`) apart from "my table is over" (the
   * session drops out of the list entirely). Without it, an agent seated in a
   * lobby sees an empty list and cannot distinguish waiting from finished.
   */
  status: 'lobby' | 'seated' | 'in_progress';
  yourTurn: boolean;
  legalMoves: Move[];
  deadlineMs: number | null;
  /**
   * The partial-information board this agent may observe (sub-spec 10 T32):
   * discard top, colour in force, direction, whose turn, every seat's hand
   * *count*, and the agent's own hand. `null` until the table has been dealt
   * (`lobby`/`seated`). Removing the public live-spectator tail (T30) meant an
   * agent could no longer glean public state from the website, so it is served
   * here, on the agent's own authenticated channel, straight from the engine.
   * `legalMoves` stays the sole authority for *legality* (NFR-2); this is only
   * context for *choosing*.
   */
  view: PublicGameView | null;
}

/**
 * Observable lifecycle transitions, so sub-spec 05 (T13) can attach on-chain
 * commit-reveal without reaching into orchestration internals:
 *  - `onSessionStarted` fires after the seed is committed and before the first
 *    move, which is exactly when `commitSeed(sessionId, hash)` must be sent.
 *  - `onSessionSettled` fires once the result is durable, carrying the reveal
 *    and the result hash that `settle(...)` publishes.
 *
 * A throwing hook is swallowed: a chain outage must not corrupt a finished game.
 */
export interface SessionLifecycleHooks {
  onSessionStarted?(info: {
    sessionId: string;
    seatAgentIds: string[];
    seedCommitHash: string;
    /**
     * The raw seed, for the commit call. Server-internal only — it must not
     * reach any public surface until the session settles, or the deck could be
     * derived mid-game (the spectator feed redacts it for exactly this reason).
     */
    seed: string;
  }): void;
  onSessionSettled?(info: {
    sessionId: string;
    winnerAgentId: string | null;
    resultHash: string;
    seedReveal: string | null;
    handValues: Record<string, number>;
  }): void;
}

/** Map an engine error to its HTTP shape (§5). */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof EngineError) {
    const byCode: Record<string, number> = {
      NOT_YOUR_TURN: 409, // turn/state conflict
      SESSION_ENDED: 410, // gone
      SESSION_NOT_FOUND: 404,
      INVALID_CARD: 400, // illegal move
      MUST_DRAW_FIRST: 400,
      INVALID_FINAL_CALL: 400,
      ILLEGAL_MOVE: 400,
    };
    return new ApiError(byCode[error.code] ?? 400, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(500, 'INTERNAL_ERROR', message);
}

export class Orchestrator {
  private readonly db: Db;
  private readonly config: Config;
  private readonly clock: () => number;
  private readonly hooks: SessionLifecycleHooks;
  private readonly chain: SettlementChain;
  private readonly tournament: TournamentChain;
  private readonly xoauth: XOAuthProvider;
  private readonly googleoauth: GoogleOAuthProvider;
  private readonly wallets: WalletStore;
  private readonly live = new Map<string, LiveSession>();

  constructor(
    db: Db,
    config: Config,
    options: {
      clock?: () => number;
      hooks?: SessionLifecycleHooks;
      /** Used to open tables and verify per-session entry fees. Defaults to no chain. */
      chain?: SettlementChain;
      /** Used to verify buy-ins and settle pooled tournaments. Defaults to no chain. */
      tournamentChain?: TournamentChain;
      /** "Sign in with X" identity for agent claims (sub-spec 09). Defaults to disabled. */
      xoauth?: XOAuthProvider;
      /** "Sign in with Google" web login (sub-spec 11). Defaults to disabled. */
      googleoauth?: GoogleOAuthProvider;
      /** Custodial agent-wallet store (sub-spec 14). Defaults to config-derived. */
      walletStore?: WalletStore;
    } = {},
  ) {
    this.db = db;
    this.config = config;
    this.clock = options.clock ?? (() => Date.now());
    this.hooks = options.hooks ?? {};
    this.chain = options.chain ?? DISABLED_CHAIN;
    this.tournament = options.tournamentChain ?? DISABLED_TOURNAMENT_CHAIN;
    this.xoauth = options.xoauth ?? DISABLED_XOAUTH;
    this.googleoauth = options.googleoauth ?? DISABLED_GOOGLE_OAUTH;
    this.wallets = options.walletStore ?? createWalletStore(config.walletEncryptionKey);
  }

  /** Run a lifecycle hook without letting its failure affect the game. */
  private fire(run: () => void): void {
    try {
      run();
    } catch {
      /* hooks are observers: a failing one must never break a session */
    }
  }

  // ---- agents ---------------------------------------------------------------

  registerAgent(displayName: string): { agentId: string; apiKey: string } {
    const agentId = newAgentId();
    const apiKey = newApiKey();

    // Issue a custodial wallet (sub-spec 14) so any agent — claimed or not — can
    // receive a Rainbow-Storm jackpot. When the store is disabled (no encryption
    // key) the agent registers walletless and a storm is recorded but not paid.
    const wallet = this.wallets.generate();

    // trueskill_* columns keep their schema defaults (openskill is gone — both
    // game types now score by coins); they are left in place, unused.
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agents (id, api_key_hash, display_name, coins, wallet_address)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          hashApiKey(apiKey),
          displayName,
          this.config.startingCoins,
          wallet?.address ?? null,
        );
      if (wallet) {
        this.db
          .prepare(
            `INSERT INTO agent_wallets (agent_id, address, enc_private_key) VALUES (?, ?, ?)`,
          )
          .run(agentId, wallet.address, wallet.encPrivateKey);
      }
    });
    insert();

    return { agentId, apiKey };
  }

  /** Resolve an API key to its agent, or null. Compares hashes in constant time. */
  authenticate(apiKey: string | undefined): AgentRow | null {
    if (!apiKey) return null;
    const hash = hashApiKey(apiKey);
    const row = this.db.prepare(`SELECT * FROM agents WHERE api_key_hash = ?`).get(hash) as
      | AgentRow
      | undefined;
    if (!row) return null;
    return hashesEqual(row.api_key_hash, hash) ? row : null;
  }

  getAgent(agentId: string): AgentRow {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId) as
      | AgentRow
      | undefined;
    if (!row) throw new ApiError(404, 'AGENT_NOT_FOUND', `No such agent: ${agentId}`);
    return row;
  }

  setPayoutAddress(agentId: string, payoutAddress: string): AgentRow {
    this.db.prepare(`UPDATE agents SET payout_address = ? WHERE id = ?`).run(payoutAddress, agentId);
    return this.getAgent(agentId);
  }

  // ---- ownership claim: "Sign in with X" (sub-spec 09) ----------------------
  //
  // Exact arena.dev.fun mechanism: the agent fetches a claim URL, hands it to its
  // owner, the owner authorises a read-only X app, and we bind the agent to that
  // X-verified identity. Claiming an agent is what makes it payout-eligible.

  /** Build the owner-facing claim URL for a token. */
  private claimUrlFor(claimToken: string): string {
    return `${this.config.publicBaseUrl}/claim?token=${encodeURIComponent(claimToken)}`;
  }

  /** The X OAuth callback URI — must match the X app's registered redirect. */
  private xRedirectUri(): string {
    return `${this.config.publicBaseUrl}/api/battleground/auth/x/callback`;
  }

  /** The current live (pending, unexpired) claim token for an agent, if any. */
  private activeClaimToken(agentId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT claim_token FROM agent_claims
          WHERE agent_id = ? AND status = 'pending' AND expires_at > ?
          ORDER BY issued_at DESC LIMIT 1`,
      )
      .get(agentId, this.nowIso()) as { claim_token: string } | undefined;
    return row?.claim_token ?? null;
  }

  /** ISO timestamp on the injected clock (tests can pin time). */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * §5 `POST /auth/claim/init`. Issue (or reuse) a claim token and return the URL
   * to hand to the owner. Idempotent-ish: an existing pending token is reused so
   * the same claimUrl keeps working (arena: "if the owner lost the link, fetch it
   * again"); a fresh one is minted only when none is live.
   */
  initClaim(agentId: string): { claimToken: string; claimUrl: string; expiresAt: string } {
    this.getAgent(agentId); // 404 if unknown
    let claimToken = this.activeClaimToken(agentId);
    let expiresAt: string;
    if (claimToken) {
      expiresAt =
        (
          this.db.prepare(`SELECT expires_at FROM agent_claims WHERE claim_token = ?`).get(claimToken) as
            | { expires_at: string }
            | undefined
        )?.expires_at ?? this.nowIso();
    } else {
      claimToken = newClaimToken();
      expiresAt = new Date(this.clock() + this.config.claimTokenTtlMs).toISOString();
      this.db
        .prepare(
          `INSERT INTO agent_claims (claim_token, agent_id, status, issued_at, expires_at)
           VALUES (?, ?, 'pending', ?, ?)`,
        )
        .run(claimToken, agentId, this.nowIso(), expiresAt);
    }
    return { claimToken, claimUrl: this.claimUrlFor(claimToken), expiresAt };
  }

  /** §5 `GET /auth/claim/status`. Whether the agent is claimed, and the claim URL. */
  claimStatus(agentId: string): ClaimStatus {
    const agent = this.getAgent(agentId);
    // Always surface a working claim URL (mint one if none live), arena-style.
    const { claimUrl } = this.initClaim(agentId);
    if (agent.owner_id) {
      const owner = this.db.prepare(`SELECT * FROM owners WHERE id = ?`).get(agent.owner_id) as
        | OwnerRow
        | undefined;
      return {
        claimed: true,
        owner: owner ? { handle: owner.x_handle, xUserId: owner.x_user_id } : null,
        claimUrl,
        verifiedAt: agent.claimed_at,
      };
    }
    return { claimed: false, owner: null, claimUrl, verifiedAt: null };
  }

  /**
   * Public (unauthenticated) view of a claim token — lets the browser claim page
   * show which agent it is about without needing the agent's API key. The token
   * itself is the unguessable capability, so this leaks nothing an owner shouldn't
   * already hold.
   */
  claimInfo(claimToken: string): { agentId: string; displayName: string; claimed: boolean; ownerHandle: string | null } {
    const row = this.db
      .prepare(
        `SELECT c.agent_id, c.status, a.display_name, a.owner_id, o.x_handle
           FROM agent_claims c
           JOIN agents a ON a.id = c.agent_id
           LEFT JOIN owners o ON o.id = a.owner_id
          WHERE c.claim_token = ?`,
      )
      .get(claimToken) as
      | { agent_id: string; status: string; display_name: string; owner_id: string | null; x_handle: string | null }
      | undefined;
    if (!row) throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Unknown or expired claim link');
    return {
      agentId: row.agent_id,
      displayName: row.display_name,
      claimed: Boolean(row.owner_id),
      ownerHandle: row.x_handle,
    };
  }

  /**
   * Begin "Sign in with X" for a claim token: create the OAuth transient (CSRF
   * state + PKCE verifier) and return the X authorize URL to redirect the owner to.
   */
  startXClaim(claimToken: string): { authorizeUrl: string } {
    if (!this.xoauth.enabled) {
      throw new ApiError(501, 'CLAIM_X_NOT_CONFIGURED', 'X login is not configured on this arena');
    }
    const claim = this.db
      .prepare(`SELECT agent_id, status, expires_at FROM agent_claims WHERE claim_token = ?`)
      .get(claimToken) as { agent_id: string; status: string; expires_at: string } | undefined;
    if (!claim) throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Unknown claim link');
    if (claim.status === 'claimed') {
      throw new ApiError(409, 'ALREADY_CLAIMED', 'This agent is already claimed');
    }
    if (Date.parse(claim.expires_at) <= this.clock()) {
      throw new ApiError(410, 'CLAIM_EXPIRED', 'This claim link has expired — ask the agent for a new one');
    }

    const state = newOauthState();
    const codeVerifier = newCodeVerifier();
    const redirectUri = this.xRedirectUri();
    const expiresAt = new Date(this.clock() + 10 * 60_000).toISOString(); // 10 min to authorise
    this.db
      .prepare(
        `INSERT INTO oauth_flows (state, claim_token, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(state, claimToken, codeVerifier, redirectUri, this.nowIso(), expiresAt);

    const authorizeUrl = this.xoauth.authorizeUrl({
      state,
      codeChallenge: codeChallengeOf(codeVerifier),
      redirectUri,
    });
    return { authorizeUrl };
  }

  /**
   * Complete the X OAuth callback: verify the state, exchange the code, read the
   * owner's X identity, upsert the owner, and bind the agent to it. Returns the
   * claim token (so the callback can redirect back to the claim page) and handle.
   */
  async completeXClaim(params: {
    state: string;
    code: string;
  }): Promise<{ claimToken: string; agentId: string; handle: string }> {
    const flow = this.db
      .prepare(
        `SELECT claim_token, code_verifier, redirect_uri, expires_at FROM oauth_flows WHERE state = ?`,
      )
      .get(params.state) as
      | { claim_token: string; code_verifier: string; redirect_uri: string; expires_at: string }
      | undefined;
    if (!flow) throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Unknown or reused sign-in state');
    // Consume the transient immediately — a state is single-use.
    this.db.prepare(`DELETE FROM oauth_flows WHERE state = ?`).run(params.state);
    if (Date.parse(flow.expires_at) <= this.clock()) {
      throw new ApiError(410, 'OAUTH_STATE_EXPIRED', 'Sign-in took too long — please try again');
    }

    const claim = this.db
      .prepare(`SELECT agent_id, status FROM agent_claims WHERE claim_token = ?`)
      .get(flow.claim_token) as { agent_id: string; status: string } | undefined;
    if (!claim) throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Unknown claim link');

    const accessToken = await this.xoauth.exchangeCode({
      code: params.code,
      codeVerifier: flow.code_verifier,
      redirectUri: flow.redirect_uri,
    });
    const identity = await this.xoauth.getIdentity(accessToken);

    const ownerId = this.upsertOwner(identity.id, identity.username);
    this.bindAgentToOwner(claim.agent_id, ownerId); // 1:1 guard (sub-spec 11 D38)
    this.db
      .prepare(`UPDATE agent_claims SET status = 'claimed', claimed_at = ?, owner_id = ? WHERE claim_token = ?`)
      .run(this.nowIso(), ownerId, flow.claim_token);

    return { claimToken: flow.claim_token, agentId: claim.agent_id, handle: identity.username };
  }

  /**
   * Bind an agent to an X identity WITHOUT the OAuth round-trip — the effect half
   * of {completeXClaim}. For the no-chain/no-X demo harness and tests, which need
   * agents to reach payout-eligibility (now claim-gated) deterministically. The
   * live claim path is always the real "Sign in with X" flow.
   */
  devClaimAgent(agentId: string, xUserId: string, xHandle: string): OwnerRow {
    this.getAgent(agentId); // 404 if unknown
    const ownerId = this.upsertOwner(xUserId, xHandle);
    this.bindAgentToOwner(agentId, ownerId); // 1:1 guard (sub-spec 11 D38)
    return this.db.prepare(`SELECT * FROM owners WHERE id = ?`).get(ownerId) as OwnerRow;
  }

  /**
   * Bind an agent to an owner (a claim), enforcing arena's 1:1 rule (sub-spec 11
   * D38): each agent is claimed once, and each X owner claims at most one agent.
   * Re-binding an agent to the SAME owner is a no-op (idempotent).
   */
  private bindAgentToOwner(agentId: string, ownerId: string): void {
    const agent = this.getAgent(agentId);
    if (agent.owner_id) {
      if (agent.owner_id === ownerId) return;
      throw new ApiError(409, 'ALREADY_CLAIMED', 'This agent is already claimed');
    }
    const existing = this.db
      .prepare(`SELECT id FROM agents WHERE owner_id = ? LIMIT 1`)
      .get(ownerId) as { id: string } | undefined;
    if (existing) {
      throw new ApiError(409, 'X_ALREADY_HAS_AGENT', 'This X account has already claimed an agent');
    }
    this.db
      .prepare(`UPDATE agents SET owner_id = ?, claimed_at = ? WHERE id = ?`)
      .run(ownerId, this.nowIso(), agentId);
  }

  /** Find-or-create an owner by X user id; refresh the stored handle each time. */
  private upsertOwner(xUserId: string, xHandle: string): string {
    const existing = this.db.prepare(`SELECT id FROM owners WHERE x_user_id = ?`).get(xUserId) as
      | { id: string }
      | undefined;
    if (existing) {
      this.db.prepare(`UPDATE owners SET x_handle = ? WHERE id = ?`).run(xHandle, existing.id);
      return existing.id;
    }
    const id = newOwnerId();
    this.db
      .prepare(`INSERT INTO owners (id, x_user_id, x_handle) VALUES (?, ?, ?)`)
      .run(id, xUserId, xHandle);
    return id;
  }

  // ---- web accounts: Google login · connect X · claim (sub-spec 11) ----------

  private googleRedirectUri(): string {
    return `${this.config.publicBaseUrl}/api/battleground/auth/google/callback`;
  }

  /** Start Google web sign-in → the URL to send the browser to. */
  startGoogleLogin(): { authorizeUrl: string } {
    if (!this.googleoauth.enabled) {
      throw new ApiError(501, 'GOOGLE_NOT_CONFIGURED', 'Web login is not configured on this arena');
    }
    const state = newOauthState();
    const codeVerifier = newCodeVerifier();
    const redirectUri = this.googleRedirectUri();
    const expiresAt = new Date(this.clock() + 10 * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO web_oauth_flows (state, purpose, account_id, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?, 'google', NULL, ?, ?, ?, ?)`,
      )
      .run(state, codeVerifier, redirectUri, this.nowIso(), expiresAt);
    return {
      authorizeUrl: this.googleoauth.authorizeUrl({
        state,
        codeChallenge: codeChallengeOf(codeVerifier),
        redirectUri,
      }),
    };
  }

  /** Validate + consume a web OAuth flow of the given purpose. */
  private consumeWebFlow(
    state: string,
    purpose: 'google' | 'connect',
  ): { accountId: string | null; codeVerifier: string; redirectUri: string } {
    const flow = this.db
      .prepare(
        `SELECT purpose, account_id, code_verifier, redirect_uri, expires_at FROM web_oauth_flows WHERE state = ?`,
      )
      .get(state) as
      | { purpose: string; account_id: string | null; code_verifier: string; redirect_uri: string; expires_at: string }
      | undefined;
    if (!flow || flow.purpose !== purpose) {
      throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Unknown or reused sign-in state');
    }
    this.db.prepare(`DELETE FROM web_oauth_flows WHERE state = ?`).run(state);
    if (Date.parse(flow.expires_at) <= this.clock()) {
      throw new ApiError(410, 'OAUTH_STATE_EXPIRED', 'Sign-in took too long — please try again');
    }
    return { accountId: flow.account_id, codeVerifier: flow.code_verifier, redirectUri: flow.redirect_uri };
  }

  /** Is a given state a web connect-X flow (vs a 09 agent-claim)? Lets one X callback serve both. */
  isConnectFlow(state: string): boolean {
    const row = this.db
      .prepare(`SELECT purpose FROM web_oauth_flows WHERE state = ?`)
      .get(state) as { purpose: string } | undefined;
    return row?.purpose === 'connect';
  }

  /** Complete Google sign-in: upsert the account, open a session, return its token. */
  async completeGoogleLogin(params: { state: string; code: string }): Promise<{ sessionToken: string }> {
    const flow = this.consumeWebFlow(params.state, 'google');
    const accessToken = await this.googleoauth.exchangeCode({
      code: params.code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
    const identity = await this.googleoauth.getIdentity(accessToken);
    const accountId = this.upsertAccount(identity.sub, identity.email, identity.name);
    const token = newSessionToken();
    const expiresAt = new Date(this.clock() + this.config.webSessionTtlMs).toISOString();
    this.db
      .prepare(`INSERT INTO web_sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(token, accountId, this.nowIso(), expiresAt);
    return { sessionToken: token };
  }

  private upsertAccount(googleSub: string, email: string | null, name: string | null): string {
    const existing = this.db
      .prepare(`SELECT id FROM accounts WHERE google_sub = ?`)
      .get(googleSub) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE accounts SET email = ?, name = COALESCE(name, ?) WHERE id = ?`)
        .run(email, name, existing.id);
      return existing.id;
    }
    const id = newAccountId();
    this.db
      .prepare(`INSERT INTO accounts (id, google_sub, email, name) VALUES (?, ?, ?, ?)`)
      .run(id, googleSub, email, name ?? 'Unnamed User');
    return id;
  }

  /** The account behind a session cookie token, or null if absent/expired (expired rows are pruned). */
  private accountByToken(token: string | undefined): AccountRow | null {
    if (!token) return null;
    const row = this.db
      .prepare(
        `SELECT a.*, s.expires_at AS session_expires FROM web_sessions s
           JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`,
      )
      .get(token) as (AccountRow & { session_expires: string }) | undefined;
    if (!row) return null;
    if (Date.parse(row.session_expires) <= this.clock()) {
      this.db.prepare(`DELETE FROM web_sessions WHERE token = ?`).run(token);
      return null;
    }
    return row;
  }

  /** `GET /auth/session` payload. Always resolves (account null when logged out). */
  sessionInfo(token: string | undefined): WebSessionInfo {
    const providers = { google: this.googleoauth.enabled, x: this.xoauth.enabled };
    const account = this.accountByToken(token);
    if (!account) return { account: null, x: null, agents: [], providers };

    let x: WebSessionInfo['x'] = null;
    let agents: WebSessionInfo['agents'] = [];
    if (account.owner_id) {
      const owner = this.db
        .prepare(`SELECT x_user_id, x_handle FROM owners WHERE id = ?`)
        .get(account.owner_id) as { x_user_id: string; x_handle: string } | undefined;
      if (owner) x = { handle: owner.x_handle, xUserId: owner.x_user_id };
      const rows = this.db
        .prepare(
          `SELECT id, display_name, payout_address, coins
             FROM agents WHERE owner_id = ? ORDER BY created_at`,
        )
        .all(account.owner_id) as Array<{
        id: string;
        display_name: string;
        payout_address: string | null;
        coins: number;
      }>;
      agents = rows.map((r) => ({
        agentId: r.id,
        displayName: r.display_name,
        payoutAddress: r.payout_address,
        coins: r.coins,
        claimed: true,
      }));
    }
    return {
      account: { id: account.id, email: account.email, name: account.name, memberSince: account.created_at },
      x,
      agents,
      providers,
    };
  }

  logoutSession(token: string | undefined): void {
    if (token) this.db.prepare(`DELETE FROM web_sessions WHERE token = ?`).run(token);
  }

  /** Rename the logged-in account (the profile's EDIT). */
  renameAccount(token: string | undefined, name: string): { name: string } {
    const account = this.requireAccount(token);
    const clean = name.trim().slice(0, 40) || 'Unnamed User';
    this.db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(clean, account.id);
    return { name: clean };
  }

  private requireAccount(token: string | undefined): AccountRow {
    const account = this.accountByToken(token);
    if (!account) throw new ApiError(401, 'NOT_LOGGED_IN', 'Sign in with Google first');
    return account;
  }

  /** Start "connect X" for a logged-in account → the URL to send the browser to. */
  startConnectX(token: string | undefined): { authorizeUrl: string } {
    const account = this.requireAccount(token);
    if (!this.xoauth.enabled) {
      throw new ApiError(501, 'CONNECT_X_NOT_CONFIGURED', 'X is not configured on this arena');
    }
    const state = newOauthState();
    const codeVerifier = newCodeVerifier();
    const redirectUri = this.xRedirectUri(); // reuse 09's /auth/x/callback
    const expiresAt = new Date(this.clock() + 10 * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO web_oauth_flows (state, purpose, account_id, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?, 'connect', ?, ?, ?, ?, ?)`,
      )
      .run(state, account.id, codeVerifier, redirectUri, this.nowIso(), expiresAt);
    return {
      authorizeUrl: this.xoauth.authorizeUrl({
        state,
        codeChallenge: codeChallengeOf(codeVerifier),
        redirectUri,
      }),
    };
  }

  /** Complete "connect X": read the X identity and map it to the account (one X ↔ one account). */
  async completeConnectX(params: { state: string; code: string }): Promise<{ handle: string }> {
    const flow = this.consumeWebFlow(params.state, 'connect');
    if (!flow.accountId) throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Connect flow is missing its account');
    const accessToken = await this.xoauth.exchangeCode({
      code: params.code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
    const identity = await this.xoauth.getIdentity(accessToken);
    const ownerId = this.upsertOwner(identity.id, identity.username);
    const linkedElsewhere = this.db
      .prepare(`SELECT id FROM accounts WHERE owner_id = ? AND id != ?`)
      .get(ownerId, flow.accountId) as { id: string } | undefined;
    if (linkedElsewhere) {
      throw new ApiError(409, 'X_ALREADY_LINKED', 'That X account is already linked to another account');
    }
    this.db.prepare(`UPDATE accounts SET owner_id = ? WHERE id = ?`).run(ownerId, flow.accountId);
    return { handle: identity.username };
  }

  /** Claim an agent to the logged-in account via its claim link, under the 1:1 rule (D38). */
  claimAgentAsAccount(token: string | undefined, claimToken: string): { agentId: string; handle: string } {
    const account = this.requireAccount(token);
    if (!account.owner_id) {
      throw new ApiError(403, 'CONNECT_X_FIRST', 'Connect your X account before claiming an agent');
    }
    const claim = this.db
      .prepare(`SELECT agent_id, status, expires_at FROM agent_claims WHERE claim_token = ?`)
      .get(claimToken) as { agent_id: string; status: string; expires_at: string } | undefined;
    if (!claim) throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Unknown claim link');
    if (claim.status === 'claimed') {
      throw new ApiError(409, 'ALREADY_CLAIMED', 'This agent is already claimed');
    }
    if (Date.parse(claim.expires_at) <= this.clock()) {
      throw new ApiError(410, 'CLAIM_EXPIRED', 'This claim link has expired — ask the agent for a new one');
    }
    this.bindAgentToOwner(claim.agent_id, account.owner_id); // 1:1 guard
    this.db
      .prepare(`UPDATE agent_claims SET status = 'claimed', claimed_at = ?, owner_id = ? WHERE claim_token = ?`)
      .run(this.nowIso(), account.owner_id, claimToken);
    const owner = this.db.prepare(`SELECT x_handle FROM owners WHERE id = ?`).get(account.owner_id) as {
      x_handle: string;
    };
    return { agentId: claim.agent_id, handle: owner.x_handle };
  }

  /**
   * Gate for `requires_claim` competitions (sub-spec 09): an agent must be claimed
   * (X-verified owner) to enter. Mirrors arena's `403 must be claimed`, carrying the
   * claim URL so the agent can tell its owner exactly where to go.
   */
  private requireClaimed(agentId: string, competition: CompetitionRow): void {
    if (!competition.requires_claim) return;
    const agent = this.getAgent(agentId);
    if (agent.owner_id) return;
    throw new ApiError(403, 'CLAIM_REQUIRED', 'This competition requires an X-verified owner', {
      claimUrl: this.initClaim(agentId).claimUrl,
    });
  }

  // ---- competitions ---------------------------------------------------------

  createCompetition(name: string, entryFeeWei = '0', contractAddress: string | null = null): string {
    const id = `comp_${createHash('sha1').update(`${name}:${this.clock()}`).digest('hex').slice(0, 16)}`;
    this.db
      .prepare(
        `INSERT INTO competitions (id, name, status, entry_fee_wei, contract_address)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(id, name, entryFeeWei, contractAddress);
    return id;
  }

  /**
   * Fund a classic playground season's Rainbow-Storm jackpot (sub-spec 14). Opens
   * the season on-chain and seeds the jackpot side-pool when the tournament chain
   * is enabled, and always mirrors the amount in the DB — which is what {@link
   * settle} reads to size the immediate storm award. Chain-off ⇒ DB-only, so a
   * storm records but does not pay (D67). Operator tooling (seed/CLI), not an API.
   */
  async seedPlaygroundJackpot(competitionId: string, jackpotWei: string): Promise<void> {
    const c = this.getCompetition(competitionId);
    if (c.kind !== 'classic') {
      throw new ApiError(400, 'NOT_PLAYGROUND', `${competitionId} is not a classic playground season`);
    }
    if (BigInt(jackpotWei) > 0n && this.tournament.enabled) {
      // A free season on-chain (fee 0): the pool holds only the jackpot side-pool.
      await this.tournament.openCompetition(competitionId, '0');
      await this.tournament.seedJackpot(competitionId, jackpotWei);
    }
    this.db
      .prepare(`UPDATE competitions SET jackpot_seed_wei = ? WHERE id = ?`)
      .run(jackpotWei, competitionId);
  }

  listActiveCompetitions(): Array<{
    id: string;
    name: string;
    entryFeeWei: string;
    contractAddress: string | null;
    kind: 'classic' | 'tournament';
    poolWei: string;
    jackpotWei: string;
    entriesCloseAt: string | null;
    requiresClaim: boolean;
  }> {
    const rows = this.db
      .prepare(`SELECT * FROM competitions WHERE status = 'active' ORDER BY created_at`)
      .all() as CompetitionRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      entryFeeWei: r.entry_fee_wei,
      contractAddress: r.contract_address,
      kind: r.kind,
      poolWei: r.pool_wei,
      jackpotWei: r.jackpot_seed_wei,
      entriesCloseAt: r.entries_close_at,
      requiresClaim: Boolean(r.requires_claim),
    }));
  }

  /**
   * Public competition metadata (sub-spec 13 D56) — the active competitions with
   * their kind + prize economics + entry count, for the web's playground/tournament
   * split. No secrets: pool/jackpot/fee are public (they mirror the on-chain state).
   */
  publicCompetitions(): Array<{
    id: string;
    name: string;
    kind: 'classic' | 'tournament';
    entryFeeWei: string;
    poolWei: string;
    jackpotWei: string;
    entriesCloseAt: string | null;
    entriesCount: number;
    requiresClaim: boolean;
  }> {
    return this.listActiveCompetitions().map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      entryFeeWei: c.entryFeeWei,
      poolWei: c.poolWei,
      jackpotWei: c.jackpotWei,
      entriesCloseAt: c.entriesCloseAt,
      entriesCount: (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM competition_entries WHERE competition_id = ?`)
          .get(c.id) as { n: number }
      ).n,
      requiresClaim: c.requiresClaim,
    }));
  }

  private getCompetition(competitionId: string): CompetitionRow {
    const row = this.db.prepare(`SELECT * FROM competitions WHERE id = ?`).get(competitionId) as
      | CompetitionRow
      | undefined;
    if (!row) throw new ApiError(404, 'COMPETITION_NOT_FOUND', `No such competition: ${competitionId}`);
    return row;
  }

  // ---- pooled tournaments (sub-spec 08) -------------------------------------

  /**
   * Create and (on-chain) open a pooled tournament. The buy-in is a ONE-TIME
   * competition entry (D3) — sessions inside it are free. Operator-only, driven
   * by the seed/demo harness exactly like {createCompetition}.
   */
  createTournament(
    name: string,
    buyInWei: string,
    options: { entriesCloseAt?: string; requiresClaim?: boolean } = {},
  ): string {
    const id = this.createCompetition(name, buyInWei, this.tournament.contractAddress);
    this.db
      .prepare(
        `UPDATE competitions
            SET kind = 'tournament', payout_schedule_json = ?, entries_close_at = ?, requires_claim = ?
          WHERE id = ?`,
      )
      .run(
        JSON.stringify(this.config.payoutSchedule),
        options.entriesCloseAt ?? null,
        options.requiresClaim ? 1 : 0,
        id,
      );

    // Open it on-chain so the contract will accept buy-ins for it. Best-effort:
    // a chain outage must not block local bookkeeping.
    void this.tournament.openCompetition(id, buyInWei);
    return id;
  }

  /**
   * Seed sponsor money into a tournament's main pool and/or jackpot side-pool.
   * The pool amount MERGES with buy-ins (dev.fun "$X sponsored by …"); the jackpot
   * is a separate side-pool. Both are mirrored in the DB and sent on-chain.
   */
  async seedTournament(
    competitionId: string,
    poolWei: string,
    jackpotWei: string,
  ): Promise<{ pool: string; jackpot: string }> {
    const c = this.getCompetition(competitionId);
    if (c.kind !== 'tournament') {
      throw new ApiError(400, 'NOT_A_TOURNAMENT', `${competitionId} is not a tournament`);
    }
    if (BigInt(poolWei) > 0n) {
      await this.tournament.seedPool(competitionId, poolWei);
      this.addToPool(competitionId, poolWei);
      this.db
        .prepare(
          `UPDATE competitions SET sponsor_seed_wei = CAST(CAST(sponsor_seed_wei AS INTEGER) + ? AS TEXT) WHERE id = ?`,
        )
        .run(poolWei, competitionId);
    }
    if (BigInt(jackpotWei) > 0n) {
      await this.tournament.seedJackpot(competitionId, jackpotWei);
      this.db
        .prepare(
          `UPDATE competitions SET jackpot_seed_wei = CAST(CAST(jackpot_seed_wei AS INTEGER) + ? AS TEXT) WHERE id = ?`,
        )
        .run(jackpotWei, competitionId);
    }
    const after = this.getCompetition(competitionId);
    return { pool: after.pool_wei, jackpot: after.jackpot_seed_wei };
  }

  /** Add wei to a competition's mirrored pool balance (buy-ins + sponsor seed). */
  private addToPool(competitionId: string, amountWei: string): void {
    const row = this.db.prepare(`SELECT pool_wei FROM competitions WHERE id = ?`).get(competitionId) as
      | { pool_wei: string }
      | undefined;
    const next = BigInt(row?.pool_wei ?? '0') + BigInt(amountWei);
    this.db.prepare(`UPDATE competitions SET pool_wei = ? WHERE id = ?`).run(next.toString(), competitionId);
  }

  isEntered(agentId: string, competitionId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM competition_entries WHERE competition_id = ? AND agent_id = ?`)
      .get(competitionId, agentId) as { ok: number } | undefined;
    return Boolean(row);
  }

  /**
   * §5 `POST /competition/enter` (sub-spec 08). Buy into a tournament so the agent
   * may then join its (free) tables.
   *
   *  - Free competition (buy-in "0", D13): auto-enter, no `402`, no on-chain payment.
   *  - Already entered: idempotent success.
   *  - Paid, no txHash: `402` naming the tournament contract + amount + competitionId,
   *    with a `warning` when too little season likely remains to qualify (D11).
   *  - Paid, txHash: verified on-chain (EntryPaid for THIS competition/amount), then
   *    recorded with the paying wallet address.
   */
  async enterCompetition(
    agentId: string,
    competitionId: string,
    txHash?: string,
  ): Promise<{ entered: true; warning?: string }> {
    const c = this.getCompetition(competitionId);
    if (c.status !== 'active') {
      throw new ApiError(409, 'COMPETITION_CLOSED', `Competition ${competitionId} is not open`);
    }
    // Claim gate (sub-spec 09): a `requires_claim` competition admits only agents
    // whose owner has verified via X. Checked before entry so a buy-in is never
    // spent by an agent that then can't play or be paid.
    this.requireClaimed(agentId, c);
    if (this.isEntered(agentId, competitionId)) return { entered: true };

    const warning = this.lateEntryWarning(competitionId);

    // Free entry (D13): record and return, no chain.
    if (BigInt(c.entry_fee_wei) === 0n) {
      this.recordEntry(competitionId, agentId, null, null, '0');
      return warning ? { entered: true, warning } : { entered: true };
    }

    if (!txHash) {
      throw new ApiError(402, 'PAYMENT_REQUIRED', 'Tournament buy-in not paid', {
        paymentRequired: {
          chainId: this.config.bscChainId,
          contractAddress: c.contract_address ?? this.config.tournamentContractAddress,
          amountWei: c.entry_fee_wei,
          competitionId,
        },
        ...(warning ? { warning } : {}),
      });
    }

    const check = await this.tournament.verifyEntry(competitionId, txHash, c.entry_fee_wei);
    if (!check.ok) {
      throw new ApiError(402, 'PAYMENT_NOT_VERIFIED', `Buy-in not verified: ${check.error}`, {
        paymentRequired: {
          chainId: this.config.bscChainId,
          contractAddress: c.contract_address ?? this.config.tournamentContractAddress,
          amountWei: c.entry_fee_wei,
          competitionId,
        },
      });
    }

    this.recordEntry(competitionId, agentId, check.payer ?? null, txHash, check.amountWei ?? c.entry_fee_wei);
    this.addToPool(competitionId, check.amountWei ?? c.entry_fee_wei);
    // The paying wallet is the agent's on-chain identity; default the payout
    // address to it too, so a winner without an explicit payout address still gets paid.
    if (check.payer) {
      this.db
        .prepare(
          `UPDATE agents SET wallet_address = ?, payout_address = COALESCE(payout_address, ?) WHERE id = ?`,
        )
        .run(check.payer, check.payer, agentId);
    }
    return warning ? { entered: true, warning } : { entered: true };
  }

  private recordEntry(
    competitionId: string,
    agentId: string,
    walletAddress: string | null,
    txHash: string | null,
    amountWei: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO competition_entries
           (competition_id, agent_id, wallet_address, tx_hash, amount_wei, status)
         VALUES (?, ?, ?, ?, ?, 'confirmed')`,
      )
      .run(competitionId, agentId, walletAddress, txHash, amountWei);
  }

  /**
   * Warn a very-late joiner that it may not reach `MIN_RANKED_SESSIONS` before the
   * advisory close (D11). Heuristic: with no games recorded and the clock nearly
   * up, a buy-in is likely dead money — say so, but let them decide.
   */
  private lateEntryWarning(competitionId: string): string | undefined {
    const c = this.getCompetition(competitionId);
    if (!c.entries_close_at) return undefined;
    const closeMs = Date.parse(c.entries_close_at);
    if (Number.isNaN(closeMs)) return undefined;
    const remainingMs = closeMs - this.clock();
    if (remainingMs <= 0) return 'Entries are past their advertised close time.';
    // Rough games-per-agent budget: assume a table (~<=60s) frees a seat regularly.
    const min = this.config.minRankedSessions;
    const optimisticGames = Math.floor(remainingMs / Math.max(1, this.config.gameTimeLimitMs / 2));
    if (optimisticGames < min) {
      return `Only ~${optimisticGames} games likely remain before close; ${min} are needed to qualify for a payout. You may not qualify.`;
    }
    return undefined;
  }

  /** Mark the season closed on-chain and in the DB (operator-triggered, D9). */
  async closeTournament(competitionId: string): Promise<void> {
    const c = this.getCompetition(competitionId);
    if (c.kind !== 'tournament') {
      throw new ApiError(400, 'NOT_A_TOURNAMENT', `${competitionId} is not a tournament`);
    }
    await this.tournament.closeEntries(competitionId);
    this.db
      .prepare(`UPDATE competitions SET entries_closed_at = datetime('now') WHERE id = ?`)
      .run(competitionId);
  }

  /**
   * Settle a pooled tournament: rank the eligible field, split the pool by the
   * field-scaled curve (D14), award the jackpot to the storm triggerer (D6/D23),
   * distribute on-chain, and mark it settled. Ranking DRIVES payout.
   */
  async settleTournament(competitionId: string): Promise<{
    winners: Array<{ agentId: string; payoutAddress: string; amountWei: string }>;
    jackpot: { agentId: string; payoutAddress: string; amountWei: string } | null;
    resultRoot: string;
    txHash: string | null;
  }> {
    const c = this.getCompetition(competitionId);
    if (c.kind !== 'tournament') {
      throw new ApiError(400, 'NOT_A_TOURNAMENT', `${competitionId} is not a tournament`);
    }

    const ranked = this.eligibleRanked(competitionId);
    const poolWei = BigInt(c.pool_wei);
    const amounts = distributePool(
      poolWei,
      ranked.length,
      this.config.payoutSchedule,
      this.config.payoutFieldFraction,
    );

    const winners = amounts.map((amountWei, i) => ({
      agentId: ranked[i]!.agentId,
      payoutAddress: ranked[i]!.payoutAddress,
      amountWei: amountWei.toString(),
    }));

    const jackpot = this.resolveJackpotWinner(competitionId, BigInt(c.jackpot_seed_wei));
    const resultRoot = this.leaderboardRoot(competitionId, ranked);

    const result = await this.tournament.settleCompetition(
      competitionId,
      winners.map((w) => w.payoutAddress),
      amounts,
      jackpot?.payoutAddress ?? null,
      jackpot ? BigInt(jackpot.amountWei) : 0n,
      resultRoot,
    );

    this.db
      .prepare(
        `UPDATE competitions
            SET status = 'settled', settled_at = datetime('now'), settle_tx_hash = ?
          WHERE id = ?`,
      )
      .run(result.txHash ?? null, competitionId);

    return { winners, jackpot, resultRoot, txHash: result.txHash ?? null };
  }

  /** Carry a residual/untriggered jackpot from one settled tournament into an open one (D15). */
  async rolloverJackpot(fromCompetitionId: string, toCompetitionId: string): Promise<{ txHash: string | null }> {
    const from = this.getCompetition(fromCompetitionId);
    const to = this.getCompetition(toCompetitionId);
    if (from.kind !== 'tournament' || to.kind !== 'tournament') {
      throw new ApiError(400, 'NOT_A_TOURNAMENT', 'Both competitions must be tournaments');
    }
    const result = await this.tournament.rolloverJackpot(fromCompetitionId, toCompetitionId);
    // Mirror the carry in the DB.
    const carried = from.jackpot_seed_wei;
    this.db.prepare(`UPDATE competitions SET jackpot_seed_wei = '0' WHERE id = ?`).run(fromCompetitionId);
    this.db
      .prepare(
        `UPDATE competitions SET jackpot_seed_wei = CAST(CAST(jackpot_seed_wei AS INTEGER) + ? AS TEXT) WHERE id = ?`,
      )
      .run(carried, toCompetitionId);
    return { txHash: result.txHash ?? null };
  }

  /**
   * The payout-eligible field, ranked best-first (D8 + sub-spec 09): entered,
   * played at least `MIN_RANKED_SESSIONS` settled tables here, has a payout address
   * set, AND is claimed by an X-verified owner. Claiming is what makes an agent
   * eligible to be paid — an unclaimed agent may top the sort but is skipped here,
   * exactly like arena's "claimed + X-verified" gate.
   */
  /**
   * The payout-eligible field for a tournament, ranked by **coins** (the on-chain
   * prize is split among the top coin-holders — openskill is gone). Eligibility is
   * unchanged: an X-verified owner (`owner_id`), a payout address to receive the
   * prize, and at least `minRankedSessions` settled games in this competition.
   */
  eligibleRanked(
    competitionId: string,
  ): Array<{ agentId: string; displayName: string; coins: number; payoutAddress: string; games: number }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, COUNT(DISTINCT s.id) AS games
           FROM competition_entries e
           JOIN agents a ON a.id = e.agent_id
           LEFT JOIN session_players p ON p.agent_id = a.id
           LEFT JOIN sessions s
             ON s.id = p.session_id AND s.competition_id = e.competition_id AND s.status = 'settled'
          WHERE e.competition_id = ?
          GROUP BY a.id`,
      )
      .all(competitionId) as Array<AgentRow & { games: number }>;

    return rows
      .filter((r) => r.owner_id && r.payout_address && r.games >= this.config.minRankedSessions)
      .map((r) => ({
        agentId: r.id,
        displayName: r.display_name,
        coins: r.coins,
        payoutAddress: r.payout_address as string,
        games: r.games,
      }))
      .sort((a, b) => b.coins - a.coins);
  }

  private resolveJackpotWinner(
    competitionId: string,
    jackpotWei: bigint,
  ): { agentId: string; payoutAddress: string; amountWei: string } | null {
    if (jackpotWei <= 0n) return null;
    const row = this.db
      .prepare(
        `SELECT j.agent_id, a.payout_address, a.owner_id
           FROM jackpot_events j JOIN agents a ON a.id = j.agent_id
          WHERE j.competition_id = ?`,
      )
      .get(competitionId) as
      | { agent_id: string; payout_address: string | null; owner_id: string | null }
      | undefined;
    // No storm, or the triggerer is unclaimed / has no payout address → jackpot
    // rolls over (sub-spec 09): the seeded pool only ever pays an X-verified owner.
    if (!row || !row.payout_address || !row.owner_id) return null;
    return { agentId: row.agent_id, payoutAddress: row.payout_address, amountWei: jackpotWei.toString() };
  }

  /** Hash the final leaderboard so the payout order is verifiable against the event log. */
  private leaderboardRoot(
    competitionId: string,
    ranked: Array<{ agentId: string; coins: number }>,
  ): string {
    const canonical = ranked.map((r, i) => `${i}|${r.agentId}|${r.coins}`).join('\n');
    return keccak256(toHex(`${competitionId}\n${canonical}`));
  }

  /**
   * Record the FIRST Rainbow Storm of a SEASON as the jackpot claim. Records for
   * BOTH kinds now (sub-spec 14 D65): a tournament reads it back at
   * `settleTournament` (D6/D23), a classic playground season pays it immediately
   * (D65 — see {@link settle}). Provably fair: the storm is in this session's event
   * log, whose seed is commit-revealed. Idempotent — the PK on `jackpot_events`
   * keeps the first — so it is safe to call more than once per session.
   *
   * @returns the newly-recorded storm (`{competitionId, agentId, seq}`) ONLY when
   *   THIS call recorded the season's first storm; `null` otherwise (already
   *   recorded, no storm this session, or a malformed payload).
   */
  captureJackpotFromSession(
    sessionId: string,
  ): { competitionId: string; agentId: string; seq: number } | null {
    const comp = this.db
      .prepare(
        `SELECT c.id, c.kind FROM sessions s JOIN competitions c ON c.id = s.competition_id WHERE s.id = ?`,
      )
      .get(sessionId) as { id: string; kind: string } | undefined;
    if (!comp) return null;

    const already = this.db
      .prepare(`SELECT 1 AS ok FROM jackpot_events WHERE competition_id = ?`)
      .get(comp.id) as { ok: number } | undefined;
    if (already) return null;

    const storm = this.db
      .prepare(
        `SELECT seq, payload_json FROM session_events
          WHERE session_id = ? AND event_type = 'RAINBOW_STORM' ORDER BY seq LIMIT 1`,
      )
      .get(sessionId) as { seq: number; payload_json: string } | undefined;
    if (!storm) return null;

    let agentId: string | undefined;
    try {
      agentId = (JSON.parse(storm.payload_json) as { agentId?: string }).agentId;
    } catch {
      return null;
    }
    if (!agentId) return null;

    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO jackpot_events (competition_id, session_id, seq, agent_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(comp.id, sessionId, storm.seq, agentId);
    if (info.changes === 0) return null; // lost a race — first storm already recorded

    return { competitionId: comp.id, agentId, seq: storm.seq };
  }

  /**
   * Pay the playground's Rainbow-Storm jackpot on-chain, immediately, to the
   * triggering agent's custodial wallet — regardless of claim (sub-spec 14
   * D64/D65/D66). Called from {@link settle} only for a `classic` session that
   * just recorded the season's first storm. Fire-and-forget and fully swallowed:
   * a chain failure must never corrupt the settled game (sub-spec 05's rule), and
   * an unfunded/walletless/chain-off case is a graceful record-but-don't-pay (D67).
   */
  private awardPlaygroundStormJackpot(
    captured: { competitionId: string; agentId: string },
    sessionId: string,
    resultHash: string,
  ): void {
    if (!this.tournament.enabled) return; // chain off → recorded, not paid (D67)

    const comp = this.getCompetition(captured.competitionId);
    const poolWei = BigInt(comp.jackpot_seed_wei ?? '0');
    if (poolWei <= 0n) return; // unfunded season → recorded, not paid (D67)

    const agent = this.getAgent(captured.agentId);
    if (!agent.wallet_address) return; // no custodial wallet (auto-wallets off) → recorded, not paid

    const seedReveal =
      (
        this.db.prepare(`SELECT seed_reveal FROM sessions WHERE id = ?`).get(sessionId) as
          | { seed_reveal: string | null }
          | undefined
      )?.seed_reveal ?? '';

    const competitionId = captured.competitionId;
    const winner = agent.wallet_address;
    const amountWei = poolWei.toString();
    void this.tournament
      .awardJackpot(competitionId, winner, amountWei, resultHash, seedReveal)
      .then((res) => {
        if (res.ok && res.txHash) {
          // Mirror the payout on the jackpot_events row + drain the DB pool mirror.
          this.db
            .prepare(`UPDATE jackpot_events SET tx_hash = ?, amount_wei = ? WHERE competition_id = ?`)
            .run(res.txHash, amountWei, competitionId);
          this.db
            .prepare(`UPDATE competitions SET jackpot_seed_wei = '0' WHERE id = ?`)
            .run(competitionId);
        }
      })
      .catch(() => {
        /* swallowed: the storm stays recorded (unpaid); the game is unaffected */
      });
  }

  // ---- joining / matchmaking -------------------------------------------------

  /**
   * Seat an agent at a table for `competitionId`, creating a lobby if none is
   * open. When the table reaches TABLE_SIZE the match starts immediately.
   */
  async joinSession(
    agentId: string,
    competitionId: string,
    txHash?: string,
  ): Promise<{ sessionId: string; status: 'lobby' | 'seated'; seatIndex: number | null }> {
    const competition = this.db
      .prepare(`SELECT * FROM competitions WHERE id = ? AND status = 'active'`)
      .get(competitionId) as CompetitionRow | undefined;
    if (!competition) {
      throw new ApiError(404, 'COMPETITION_NOT_FOUND', `No active competition: ${competitionId}`);
    }

    // Claim gate (sub-spec 09): a `requires_claim` competition needs an X-verified
    // owner before a seat is taken. Belt-and-suspenders with the same check at
    // /competition/enter, and the only gate for a claim-gated classic table.
    this.requireClaimed(agentId, competition);

    const existing = this.db
      .prepare(
        `SELECT s.id FROM sessions s
           JOIN session_players p ON p.session_id = s.id
          WHERE p.agent_id = ? AND s.status IN ('lobby','seated','in_progress')`,
      )
      .get(agentId) as { id: string } | undefined;
    if (existing) {
      throw new ApiError(409, 'ALREADY_IN_SESSION', `Agent is already in session ${existing.id}`);
    }

    // Pooled tournaments (sub-spec 08): the buy-in is paid ONCE via
    // `/competition/enter`, so tables are free — but you must have entered first.
    if (competition.kind === 'tournament') {
      if (!this.isEntered(agentId, competitionId)) {
        throw new ApiError(402, 'ENTRY_REQUIRED', 'Enter the tournament before joining a table', {
          paymentRequired: {
            chainId: this.config.bscChainId,
            contractAddress: competition.contract_address ?? this.config.tournamentContractAddress,
            amountWei: competition.entry_fee_wei,
            competitionId,
          },
        });
      }
    }

    // The table must exist before a (classic) per-session fee can be paid: the
    // escrow holds a pot per session, so an agent needs a sessionId to pay into.
    // The lobby is therefore allocated first, and the 402 names it.
    const session = this.findOrCreateLobby(competition);
    if (competition.kind !== 'tournament') {
      await this.requireEntryFee(agentId, competition, session, txHash);
    }

    // Coin buy-in (sub-spec 12): taking a seat costs coins, pooled and paid back to
    // the winners at settlement. Now charged for BOTH game types (hackathon change):
    // the tournament follows the playground and is ranked by coins, so its tables
    // move coins too. Guard against bankruptcy — an agent that can't cover the
    // buy-in can't sit. (A tournament seat still ALSO requires its one-time on-chain
    // entry, handled by the `/competition/enter` gate above.)
    const entry = this.config.playgroundEntryCoins;
    if (entry > 0) {
      const balance = this.getAgent(agentId).coins;
      if (balance < entry) {
        throw new ApiError(
          402,
          'INSUFFICIENT_COINS',
          `Need ${entry} coins to join; balance is ${balance}.`,
        );
      }
      this.db.prepare(`UPDATE agents SET coins = coins - ? WHERE id = ?`).run(entry, agentId);
    }

    const seatIndex = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_players WHERE session_id = ?`)
      .get(session.id) as { n: number };

    this.db
      .prepare(`INSERT INTO session_players (session_id, agent_id, seat_index) VALUES (?, ?, ?)`)
      .run(session.id, agentId, seatIndex.n);

    // §5 reports the agent's seating, not the session row's lifecycle status:
    // 'seated' once the table is full and the match is under way, else 'lobby'.
    const seated = seatIndex.n + 1;
    if (seated >= session.table_size) {
      this.startSession(session.id);
      return { sessionId: session.id, status: 'seated', seatIndex: seatIndex.n };
    }

    this.db.prepare(`UPDATE sessions SET status = 'lobby' WHERE id = ?`).run(session.id);
    return { sessionId: session.id, status: 'lobby', seatIndex: seatIndex.n };
  }

  /**
   * Entry-fee gate (§5), enforced against the chain.
   *
   * The escrow holds a pot per session, so the 402 names the exact table to pay
   * into — `paymentRequired.sessionId` — in addition to the §5 fields. Without it
   * an agent has no way to call `payEntryFee(sessionId)`.
   *
   * A claimed txHash is never taken on trust: it is read back from the chain and
   * must be a successful call to OUR escrow that emitted `EntryFeePaid` for THIS
   * table with the right amount. Otherwise any transaction hash would buy a seat.
   */
  private async requireEntryFee(
    agentId: string,
    competition: CompetitionRow,
    session: SessionRow,
    txHash?: string,
  ): Promise<void> {
    if (competition.entry_fee_wei === '0') return;

    const paid = this.db
      .prepare(
        `SELECT id FROM payments
          WHERE agent_id = ? AND direction = 'entry_fee' AND status = 'confirmed'
            AND session_id = ?`,
      )
      .get(agentId, session.id) as { id: string } | undefined;
    if (paid) return;

    if (!txHash) {
      // Open the table on-chain so the escrow will accept payments for it. Safe
      // to attempt more than once: the contract rejects a second open.
      await this.chain.openSession(session.id, competition.entry_fee_wei);
      throw new ApiError(402, 'PAYMENT_REQUIRED', 'Entry fee not paid', {
        paymentRequired: {
          chainId: this.config.bscChainId,
          contractAddress: competition.contract_address ?? this.config.escrowContractAddress,
          amountWei: competition.entry_fee_wei,
          sessionId: session.id,
        },
      });
    }

    const check = await this.chain.verifyEntryFee(session.id, txHash, competition.entry_fee_wei);
    if (!check.ok) {
      throw new ApiError(402, 'PAYMENT_NOT_VERIFIED', `Entry fee not verified: ${check.error}`, {
        paymentRequired: {
          chainId: this.config.bscChainId,
          contractAddress: competition.contract_address ?? this.config.escrowContractAddress,
          amountWei: competition.entry_fee_wei,
          sessionId: session.id,
        },
      });
    }

    this.db
      .prepare(
        `INSERT INTO payments (id, session_id, agent_id, direction, amount_wei, tx_hash, status)
         VALUES (?, ?, ?, 'entry_fee', ?, ?, 'confirmed')`,
      )
      .run(newPaymentId(), session.id, agentId, check.amountWei ?? competition.entry_fee_wei, txHash);

    // Remember where this agent paid from: that address is the on-chain player
    // the escrow will pay if they win, and it is what `settle` must name.
    if (check.payer) {
      this.db
        .prepare(`UPDATE agents SET payout_address = COALESCE(payout_address, ?) WHERE id = ?`)
        .run(check.payer, agentId);
    }
  }

  private findOrCreateLobby(competition: CompetitionRow): SessionRow {
    const open = this.db
      .prepare(
        `SELECT s.* FROM sessions s
          WHERE s.competition_id = ? AND s.status = 'lobby'
            AND (SELECT COUNT(*) FROM session_players p WHERE p.session_id = s.id) < s.table_size
          ORDER BY s.created_at
          LIMIT 1`,
      )
      .get(competition.id) as SessionRow | undefined;
    if (open) return open;

    const id = newSessionId();
    this.db
      .prepare(
        `INSERT INTO sessions (id, competition_id, status, table_size) VALUES (?, ?, 'lobby', ?)`,
      )
      .run(id, competition.id, this.config.tableSize);
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow;
  }

  /** Deal the table: commit a seed, construct the GameSession, start the clock. */
  private startSession(sessionId: string): void {
    const seats = this.seatsOf(sessionId);
    // Commit-reveal (spec 05): the commitment is published before play; the seed
    // itself is only exposed once the session is settled. The commitment uses the
    // SAME scheme the escrow verifies (keccak256), so the recorded value and the
    // on-chain one are the same number and can be checked against each other.
    const seed = newApiKey();
    const seedCommitHash = seedCommitment(seed);

    const game = new GameSession(seats, {
      sessionId,
      seedReveal: seed,
      timeLimitMs: this.config.gameTimeLimitMs,
      rainbowStormChance: this.config.rainbowStormChance,
      store: new SqliteSessionEventStore(this.db),
      clock: this.clock,
    });

    this.db
      .prepare(
        `UPDATE sessions
            SET status = 'in_progress', seed_commit_hash = ?, seed_reveal = ?, started_at = datetime('now')
          WHERE id = ?`,
      )
      .run(seedCommitHash, seed, sessionId);

    this.live.set(sessionId, { game, deadlineAt: this.clock() + this.config.decisionTimeoutMs });

    // Attach point for sub-spec 05 (T13): publish the seed commitment on-chain
    // here, before any move is applied.
    this.fire(() =>
      this.hooks.onSessionStarted?.({ sessionId, seatAgentIds: seats, seedCommitHash, seed }),
    );
  }

  private seatsOf(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT agent_id FROM session_players WHERE session_id = ? ORDER BY seat_index`)
      .all(sessionId) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  }

  // ---- polling + acting -----------------------------------------------------

  /** §5 `GET /session/pending-actions`. Legal moves come from the engine only. */
  pendingActions(agentId: string): PendingSession[] {
    this.tick();

    // Includes tables still filling up, so a seated agent can see it is waiting.
    // A settled table drops out of this list — that is the "it is over" signal.
    const rows = this.db
      .prepare(
        `SELECT s.id, s.status FROM sessions s
           JOIN session_players p ON p.session_id = s.id
          WHERE p.agent_id = ? AND s.status IN ('lobby','seated','in_progress')`,
      )
      .all(agentId) as Array<{ id: string; status: 'lobby' | 'seated' | 'in_progress' }>;

    const out: PendingSession[] = [];
    for (const row of rows) {
      const entry = this.live.get(row.id);
      if (!entry) {
        // Seated but not yet dealt: nothing to decide yet, no board to observe.
        out.push({
          sessionId: row.id,
          status: row.status,
          yourTurn: false,
          legalMoves: [],
          deadlineMs: null,
          view: null,
        });
        continue;
      }
      const yourTurn = entry.game.currentAgentId === agentId;
      out.push({
        sessionId: row.id,
        status: 'in_progress',
        yourTurn,
        legalMoves: entry.game.getLegalMoves(agentId),
        deadlineMs: yourTurn ? Math.max(0, entry.deadlineAt - this.clock()) : null,
        view: entry.game.getPublicView(agentId),
      });
    }
    return out;
  }

  /** §5 `POST /session/action`, with FR-3.4 idempotency. */
  applyAction(
    agentId: string,
    sessionId: string,
    move: Move,
    reasoning: string,
    idempotencyKey: string,
  ): { accepted: true; resultingEvents: SessionEvent[] } {
    const replayed = this.db
      .prepare(
        `SELECT response_json FROM action_idempotency
          WHERE session_id = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(sessionId, agentId, idempotencyKey) as { response_json: string } | undefined;
    if (replayed) {
      // A retried request must never re-apply the move — return the original result.
      return JSON.parse(replayed.response_json);
    }

    this.tick();

    const entry = this.live.get(sessionId);
    if (!entry) {
      const known = this.db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
        | { status: string }
        | undefined;
      if (!known) throw new ApiError(404, 'SESSION_NOT_FOUND', `No such session: ${sessionId}`);
      throw new ApiError(410, 'SESSION_ENDED', `Session ${sessionId} is ${known.status}`);
    }
    if (!this.seatsOf(sessionId).includes(agentId)) {
      throw toApiError(new SessionNotFoundError(`Agent ${agentId} is not seated in ${sessionId}`));
    }

    let events: SessionEvent[];
    try {
      events = entry.game.applyMove(agentId, move, { reasoning });
    } catch (error) {
      throw toApiError(error);
    }

    this.afterMove(sessionId, entry);

    const response = { accepted: true as const, resultingEvents: events };
    this.db
      .prepare(
        `INSERT INTO action_idempotency (session_id, agent_id, idempotency_key, response_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, agentId, idempotencyKey, JSON.stringify(response));
    return response;
  }

  // ---- decision timeout (T10) -----------------------------------------------

  /**
   * Enforce per-decision deadlines across live sessions. Called on every relevant
   * request and, in the server, on an interval — so one unresponsive agent can
   * never stall a table.
   *
   * The auto-action is deliberately the least advantageous legal move: draw if
   * the agent has not drawn yet, otherwise pass, otherwise the first legal play.
   * A silent agent therefore draws-then-passes its way through its turns rather
   * than being handed a good card play.
   */
  tick(): void {
    const now = this.clock();
    for (const [sessionId, entry] of [...this.live]) {
      if (entry.game.isEnded) {
        this.settle(sessionId, entry);
        continue;
      }
      if (now < entry.deadlineAt) continue;

      const agentId = entry.game.currentAgentId;
      if (agentId === null) {
        this.settle(sessionId, entry);
        continue;
      }

      const move = this.autoAction(entry.game, agentId);
      if (move) {
        try {
          entry.game.applyMove(agentId, move, { reasoning: 'auto-action: decision timeout' });
        } catch {
          // The engine refused (e.g. the session just ended); settlement below handles it.
        }
      }
      this.afterMove(sessionId, entry);
    }
  }

  private autoAction(game: GameSession, agentId: string): Move | null {
    const legal = game.getLegalMoves(agentId);
    return (
      legal.find((m) => m.type === 'drawCard') ??
      legal.find((m) => m.type === 'passTurn') ??
      legal[0] ??
      null
    );
  }

  private afterMove(sessionId: string, entry: LiveSession): void {
    if (entry.game.isEnded) {
      this.settle(sessionId, entry);
      return;
    }
    entry.deadlineAt = this.clock() + this.config.decisionTimeoutMs;
  }

  // ---- settlement -----------------------------------------------------------

  /**
   * Finalize a completed session: record the winner and per-seat hand values,
   * hash the event log (the on-chain `result_hash`), and update ratings.
   */
  private settle(sessionId: string, entry: LiveSession): void {
    this.live.delete(sessionId);

    const current = this.db
      .prepare(
        `SELECT s.status AS status, c.kind AS kind
           FROM sessions s JOIN competitions c ON c.id = s.competition_id
          WHERE s.id = ?`,
      )
      .get(sessionId) as { status: string; kind: 'classic' | 'tournament' } | undefined;
    if (!current || current.status === 'settled' || current.status === 'archived') return;

    // Coins now score BOTH game types (hackathon simplification): the tournament
    // follows the playground — its on-chain prize is split among the top coin
    // holders. So every settled table moves coins. The Rainbow-Storm jackpot,
    // however, stays a PLAYGROUND (classic) feature.
    const isClassic = current.kind === 'classic';

    const winner = entry.game.winnerAgentId;
    const handValues = entry.game.getHandValues();
    const resultHash = this.hashEventLog(sessionId);

    const finalize = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sessions
              SET status = 'settled', winner_agent_id = ?, result_hash = ?, ended_at = datetime('now')
            WHERE id = ?`,
        )
        .run(winner, resultHash, sessionId);

      for (const [agentId, value] of Object.entries(handValues)) {
        this.db
          .prepare(`UPDATE session_players SET final_hand_value = ? WHERE session_id = ? AND agent_id = ?`)
          .run(value, sessionId, agentId);
      }

      this.settleCoins(winner, handValues);
    });
    finalize();

    // Record the first Rainbow Storm of the season (both kinds now, sub-spec 14
    // D65). Reads the just-persisted event log. For a `classic` playground season
    // this also triggers the immediate on-chain jackpot to the storm agent's
    // custodial wallet (a tournament instead reads it back at settleTournament).
    const capturedStorm = this.captureJackpotFromSession(sessionId);
    if (isClassic && capturedStorm) {
      this.awardPlaygroundStormJackpot(capturedStorm, sessionId, resultHash);
    }

    // Attach point for sub-spec 05 (T13): settle on-chain with the revealed seed
    // and the result hash, now that the outcome is durable.
    const seedReveal =
      (
        this.db.prepare(`SELECT seed_reveal FROM sessions WHERE id = ?`).get(sessionId) as
          | { seed_reveal: string | null }
          | undefined
      )?.seed_reveal ?? null;
    this.fire(() =>
      this.hooks.onSessionSettled?.({
        sessionId,
        winnerAgentId: winner,
        resultHash,
        seedReveal,
        handValues,
      }),
    );
  }

  /**
   * The on-chain `result_hash`: SHA-256 over the canonical `session_events` log.
   * Derived from the log exactly once, here — the same log the replay UI reads,
   * so the two can never disagree (§4).
   */
  private hashEventLog(sessionId: string): string {
    const rows = this.db
      .prepare(
        `SELECT seq, event_type, payload_json FROM session_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId) as Array<{ seq: number; event_type: string; payload_json: string }>;
    const canonical = rows.map((r) => `${r.seq}|${r.event_type}|${r.payload_json}`).join('\n');
    return createHash('sha256').update(`${sessionId}\n${canonical}`).digest('hex');
  }

  /**
   * Move coins between the seats of a settled table (sub-spec 12, T41). The
   * bottom half forfeits coins by placement; the top half splits the pot,
   * fewer-points-first. Zero-sum and never negative — see {@link computeCoinSettlement}.
   * Runs inside the settle() transaction, alongside rating updates.
   */
  private settleCoins(winner: string | null, handValues: Record<string, number>): void {
    const places = placementsFrom(winner, handValues);
    const agentIds = Object.keys(places);
    if (agentIds.length === 0) return;

    const balances: Record<string, number> = {};
    for (const agentId of agentIds) balances[agentId] = this.getAgent(agentId).coins;

    // The seat buy-ins are pooled back into the winnings (each seat paid this on
    // join), so the join→settle cycle conserves coins.
    const entryPot = agentIds.length * this.config.playgroundEntryCoins;
    const deltas = computeCoinSettlement({ places, handValues, balances, entryPot });
    for (const [agentId, delta] of Object.entries(deltas)) {
      if (delta !== 0) {
        this.db.prepare(`UPDATE agents SET coins = coins + ? WHERE id = ?`).run(delta, agentId);
      }
    }
  }

  // ---- playground standings (coins, sub-spec 12) ----------------------------

  /**
   * Public playground standings, ranked by coin balance (T41). Both boards rank by
   * coins now (openskill removed); this is the PLAYGROUND "chips" board — every
   * agent that has played a finished CLASSIC table, sorted by coins desc, with
   * tables-won / played for context. No auth — coins are public score.
   */
  playgroundStandings(competitionId?: string): Array<{
    agentId: string;
    displayName: string;
    coins: number;
    tablesWon: number;
    played: number;
  }> {
    const clause = competitionId ? `AND s.competition_id = ?` : '';
    const params = competitionId ? [competitionId] : [];
    // Playground standings count CLASSIC games only (sub-spec 13): coins are the
    // playground currency, so a tournament table never moves the coins board.
    const rows = this.db
      .prepare(
        `SELECT a.id AS agentId, a.display_name AS displayName, a.coins AS coins,
                COUNT(DISTINCT p.session_id) AS played,
                COUNT(DISTINCT CASE WHEN s.winner_agent_id = a.id THEN s.id END) AS tablesWon
           FROM agents a
           JOIN session_players p ON p.agent_id = a.id
           JOIN sessions s ON s.id = p.session_id AND s.status IN ('settled','archived') ${clause}
           JOIN competitions c ON c.id = s.competition_id AND c.kind = 'classic'
          GROUP BY a.id
          ORDER BY a.coins DESC, tablesWon DESC, played ASC`,
      )
      .all(...params) as Array<{
      agentId: string;
      displayName: string;
      coins: number;
      tablesWon: number;
      played: number;
    }>;
    return rows;
  }

  // ---- leaderboard ----------------------------------------------------------

  /**
   * The tournament leaderboard — now ranked by **coins**, the same score as the
   * playground (openskill removed). Lists every agent that has played a table in
   * this competition, highest coins first; the on-chain prize pays the top of it.
   */
  leaderboard(competitionId: string): Array<{
    agentId: string;
    displayName: string;
    coins: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT a.* FROM agents a
           JOIN session_players p ON p.agent_id = a.id
           JOIN sessions s ON s.id = p.session_id
          WHERE s.competition_id = ?`,
      )
      .all(competitionId) as AgentRow[];

    return rows
      .map((r) => ({ agentId: r.id, displayName: r.display_name, coins: r.coins }))
      .sort((a, b) => b.coins - a.coins);
  }

  /** Test/diagnostic helper: is this session still being played in memory? */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
}

export { toApiError };
