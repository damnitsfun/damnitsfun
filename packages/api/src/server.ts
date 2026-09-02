import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { createSettlementChain } from './chain';
import type { Config } from './config';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { ApiError, Orchestrator, type AgentRow } from './orchestrator';
import { createChainHooks } from './settlement';
import { INTROSPECTION } from './routes/introspection';
import { getPublicSession, listSessions, readEvents } from './routes/spectate';
import { createTournamentChain } from './tournament-chain';
import { createXOAuth } from './xoauth';
import { createGoogleOAuth } from './googleoauth';
import { renderClaimError, renderClaimPage } from './routes/claim-page';
import { SESSION_COOKIE, parseCookies, serializeCookie } from './cookies';
import { agentProfile, agentTables } from './profile';
import { agentStyle } from './style';
import {
  actionSchema,
  enterSchema,
  joinSchema,
  leaderboardQuerySchema,
  sessionResultsQuerySchema,
  patchAgentSchema,
  registerSchema,
} from './schemas';

// The public HTTP contract (§5). Renamed to "battleground" in sub-spec 12 (D44):
// `/api/battleground/*` is canonical; `/api/arena/*` is kept as a deprecated alias
// (D45) so any agent still calling the old path keeps working for a deprecation
// window. Both prefixes serve the identical handlers.
const CANONICAL_BASE = '/api/battleground';
const ALIAS_BASE = '/api/arena';

// Fixed opening deal: seven cards to each seat (a house rule frozen for the MVP).
// Surfaced via `/config` (D50) so the frontend never hard-codes gameplay numbers.
const STARTING_HAND = 7;

export interface BuildOptions {
  db: Db;
  config: Config;
  orchestrator?: Orchestrator;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  orchestrator: Orchestrator;
}

/**
 * Every endpoint except `register` and `__introspection` requires the API-key
 * header (§5). Renamed to `x-battleground-api-key` in sub-spec 12; the old
 * `x-arena-api-key` is still accepted so in-flight agents keep working.
 */
function requireAgent(orchestrator: Orchestrator, request: FastifyRequest): AgentRow {
  const header =
    request.headers['x-battleground-api-key'] ?? request.headers['x-arena-api-key'];
  const apiKey = Array.isArray(header) ? header[0] : header;
  const agent = orchestrator.authenticate(apiKey);
  if (!agent) {
    throw new ApiError(
      401,
      'UNAUTHORIZED',
      'Missing or invalid x-battleground-api-key header',
    );
  }
  return agent;
}

export function buildServer(options: BuildOptions): BuiltServer {
  const { db, config } = options;
  const orchestrator = options.orchestrator ?? new Orchestrator(db, config);
  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      const body: Record<string, unknown> = { error: error.code, message: error.message };
      // 402 carries `paymentRequired` at the top level, per §5.
      if (error.details && typeof error.details === 'object') Object.assign(body, error.details);
      return reply.status(error.statusCode).send(body);
    }
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: 'INVALID_REQUEST', message: 'Request failed validation', issues: error.issues });
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    const status = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    return reply.status(status).send({
      error: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
      message: fastifyError.message ?? 'Unexpected error',
    });
  });

  // ---- static: spectator UI + public skill file -----------------------------
  // Served from the API origin so the UI needs no CORS and `skill.md` has one
  // stable URL to hand to an agent (T16).
  const repoRoot = join(__dirname, '..', '..', '..');
  const webDir = join(__dirname, '..', '..', 'web', 'public');
  const webIndex = join(webDir, 'index.html');
  const webHome = join(webDir, 'home.html');
  const sendPage = (reply: FastifyReply, file: string) => {
    if (!existsSync(file)) return reply.status(404).send({ error: 'WEB_UI_NOT_BUILT' });
    return reply.type('text/html; charset=utf-8').send(readFileSync(file, 'utf8'));
  };

  // `/` is the marketing homepage (sub-spec 11); the app lives at `/battleground`
  // (renamed from `/arena` in sub-spec 12, D46). `/arena` 301s to the new path so
  // old links / bookmarks keep working.
  app.get('/', async (_request, reply) => sendPage(reply, webHome));
  app.get('/battleground', async (_request, reply) => sendPage(reply, webIndex));
  app.get('/arena', async (_request, reply) => reply.redirect('/battleground', 301));

  /**
   * The tab icon (sub-spec 21 D138). Served from the API origin like every other
   * static asset here, because the web package has no build step to generate a
   * multi-resolution `.ico` from. `/favicon.ico` is requested by browsers in
   * contexts a `<link rel="icon">` does not cover (bookmarks, history, a bare API
   * 404 page), so it redirects rather than 404ing into the JSON error handler.
   */
  app.get('/favicon.svg', async (_request, reply) => {
    const icon = join(webDir, 'favicon.svg');
    if (!existsSync(icon)) return reply.status(404).send({ error: 'WEB_UI_NOT_BUILT' });
    return reply
      .type('image/svg+xml')
      .header('cache-control', 'public, max-age=86400')
      .send(readFileSync(icon, 'utf8'));
  });
  app.get('/favicon.ico', async (_request, reply) => reply.redirect('/favicon.svg', 301));

  app.get('/skill.md', async (_request, reply) => {
    const skill = join(repoRoot, 'skill.md');
    if (!existsSync(skill)) return reply.status(404).send({ error: 'SKILL_FILE_MISSING' });
    return reply.type('text/markdown; charset=utf-8').send(readFileSync(skill, 'utf8'));
  });

  // The owner-facing claim landing page (single-file, no build step). Top-level,
  // not under the API prefix; its client JS calls the API at the canonical base.
  app.get('/claim', async (request, reply) => {
    const token = (request.query as { token?: string }).token ?? '';
    return reply.type('text/html; charset=utf-8').send(renderClaimPage({ token, base: CANONICAL_BASE }));
  });

  // The OWNER's account page (a signed-in human and their linked agents).
  app.get('/profile', async (_request, reply) => sendPage(reply, webIndex));

  /**
   * `/profile/:id` was registered but its `:id` was never read — `renderProfile()`
   * looks only at the signed-in session, so `/profile/agent_abc` silently rendered
   * *the viewer's own* page, or bounced an anonymous visitor to Google. Anyone who
   * guessed that URL got a confident wrong answer with no error (sub-spec 19 D113).
   * It now points at the agent profile it was always mistaken for.
   */
  app.get<{ Params: { id: string } }>('/profile/:id', async (request, reply) =>
    reply.redirect(`/agent/${encodeURIComponent(request.params.id)}`, 301),
  );

  // The public agent profile (sub-spec 19 D112). Part of the app SPA.
  app.get<{ Params: { agentId: string } }>('/agent/:agentId', async (_request, reply) =>
    sendPage(reply, webIndex),
  );

  const cookieSecure = config.publicBaseUrl.startsWith('https://');

  // ---------------------------------------------------------------------------
  // The API surface (§5). Registered once as an encapsulated set of relative
  // routes, then mounted under BOTH the canonical `/api/battleground` prefix and
  // the deprecated `/api/arena` alias (D45). `scope` is the prefixed Fastify
  // instance; every route below is relative to whichever prefix mounted it.
  // ---------------------------------------------------------------------------
  const registerApi = (scope: FastifyInstance) => {
    // ---- introspection (no auth) --------------------------------------------
    scope.get('/__introspection', async () => INTROSPECTION);

    // ---- public gameplay config (no auth, sub-spec 12 D50) ------------------
    // The frontend renders these instead of hard-coding "30s" etc. Non-secret only.
    scope.get('/config', async () => ({
      // Sub-spec 18: a table is now a RANGE. `tableSize` is kept alongside the
      // bounds — it reports the maximum — so a client written against the fixed
      // four (including the reference agent and the site's own copy) keeps
      // reading a sensible number instead of `undefined`.
      tableMinSize: config.tableMinSize,
      tableMaxSize: config.tableMaxSize,
      tableSize: config.tableMaxSize,
      lobbyCountdownMs: config.lobbyCountdownMs,
      startingHand: STARTING_HAND,
      decisionTimeoutMs: config.decisionTimeoutMs,
      // The EFFECTIVE limit a full table plays under, not the raw floor: the
      // configured value is widened when it would not survive
      // `gameLimitMinRounds` rounds of silence. Reporting the raw number here
      // would tell agents and the rules page a game ends far sooner than it does.
      gameTimeLimitMs: orchestrator.effectiveGameTimeLimitMs(config.tableMaxSize),
      gameTimeLimitFloorMs: config.gameTimeLimitMs,
      // Sub-spec 20: the coin economy, enough to compute a table's payouts before
      // sitting down — share(place) = entry + step * ((seats + 1) / 2 - place).
      // Derived from the entry and the seat maximum, never configured directly.
      playgroundEntryCoins: config.playgroundEntryCoins,
      coinPlaceStep: config.coinPlaceStep,
      // Sub-spec 22 (D153): what happens when seats FINISH LEVEL. Ties are not an
      // edge case — 10.2% of tables on production contain one — and without this
      // an agent cannot reproduce its own settlement, because the closed form
      // above is not the whole rule. "mean" = a tied group splits the shares of
      // the ranks it spans, equally.
      coinTieRule: 'mean',
      // The payout depth, published so a DEPLOYMENT's real value is checkable
      // (sub-spec 22, D168). `.env.example` is only a template — a box whose own
      // .env pins the old 1.0 would silently keep paying the top ten, and there
      // was previously no way to tell from outside which one was live.
      payoutFieldFraction: config.payoutFieldFraction,
      payoutTiers: config.payoutSchedule.length,
    }));

    // ---- register (no auth) -------------------------------------------------
    scope.post('/register', async (request, reply) => {
    const { displayName } = registerSchema.parse(request.body);
    const { agentId, apiKey } = orchestrator.registerAgent(displayName);
    return reply.status(201).send({
      agentId,
      apiKey,
      // Stated in the body itself, not just the docs (§5).
      notice:
        'Store this apiKey now. It is shown exactly once and cannot be recovered — we store only a hash of it.',
    });
  });

    // ---- competitions -------------------------------------------------------
    scope.get('/competition/list-active', async (request) => {
      requireAgent(orchestrator, request);
      return { competitions: orchestrator.listActiveCompetitions() };
    });

    scope.get('/competition/leaderboard', async (request) => {
      requireAgent(orchestrator, request);
      const { competitionId } = leaderboardQuerySchema.parse(request.query);
      return { leaderboard: orchestrator.leaderboard(competitionId) };
    });

    // Buy into a pooled tournament (sub-spec 08). Free competitions auto-enter;
    // paid ones answer 402 with the tournament contract + amount until a verified
    // txHash is supplied.
    scope.post('/competition/enter', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const { competitionId, txHash } = enterSchema.parse(request.body);
      return await orchestrator.enterCompetition(agent.id, competitionId, txHash);
    });

    // ---- public competitions list (no auth, sub-spec 13 D56) ----------------
    // Public metadata so the web can split playground (classic) vs tournament
    // (pooled) and show the tournament's prize pool / jackpot / buy-in / entries.
    // `?status=all` also lists ARCHIVED seasons, so the app's season selector can
    // reach a rolled-over season's board and replays (sub-spec 21 D146). Anything
    // other than `all` means `active`, which is the unchanged default.
    scope.get('/competitions', async (request) => {
      const wanted = (request.query as { status?: string }).status === 'all' ? 'all' : 'active';
      return { competitions: orchestrator.publicCompetitions(wanted) };
    });

    // ---- all-time totals (no auth, sub-spec 21 T91) -------------------------
    // The site ticker. Counts the whole battleground since its first season, and
    // deliberately does NOT count reaped lobbies as tables or registered-but-never
    // -seated agents as agents — see `Orchestrator.totals`.
    scope.get('/stats/totals', async () => orchestrator.totals());

    // ---- public agent profile (no auth, sub-spec 19 T73) --------------------
    //
    // Three path segments, so these cannot capture the two-segment `/agent/me`
    // above. That is easy to break later — a future bare `GET /agent/:agentId`
    // WOULD swallow `me` — so a test pins it rather than a comment.
    //
    // Public and readable for an UNCLAIMED agent, which is the normal case: every
    // agent on production is unclaimed, so a design that gated this on ownership
    // would ship a product where every profile is broken (D114).
    scope.get<{ Params: { agentId: string } }>('/agent/:agentId/profile', async (request) => {
      const { agentId } = request.params;
      const competitionId = (request.query as { competitionId?: string }).competitionId;
      return {
        profile: agentProfile(db, agentId),
        style: agentStyle(db, agentId, competitionId),
      };
    });

    scope.get<{ Params: { agentId: string } }>('/agent/:agentId/tables', async (request) => {
      const { agentId } = request.params;
      const q = request.query as { competitionId?: string; limit?: string; before?: string };
      return agentTables(db, agentId, {
        competitionId: q.competitionId,
        limit: q.limit ? Number(q.limit) : undefined,
        before: q.before,
      });
    });

    // ---- playground standings (no auth; ranked by coins, sub-spec 12) -------
    scope.get('/playground/standings', async (request) => {
      const competitionId = (request.query as { competitionId?: string }).competitionId;
      return { standings: orchestrator.playgroundStandings(competitionId) };
    });

    // ---- agent identity -----------------------------------------------------
    scope.get('/agent/me', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const claim = orchestrator.claimStatus(agent.id);
      return {
        agentId: agent.id,
        displayName: agent.display_name,
        // Sub-spec 19 D127: so an agent can tell its owner where to watch it,
        // rather than having to be told the route in prose and getting it wrong.
        // Absolute, and built from publicBaseUrl rather than CANONICAL_BASE — the
        // latter is the API prefix, so it would have handed the owner the JSON
        // endpoint instead of the page.
        profileUrl: `${config.publicBaseUrl.replace(/\/$/, '')}/agent/${agent.id}`,
        payoutAddress: agent.payout_address,
        walletAddress: agent.wallet_address,
        // A bare `coins` is the PLAYGROUND balance (sub-spec 22, D156). It has
        // meant "your coins" since sub-spec 15 and every published agent reads
        // it, so it keeps pointing at the game type an unconfigured agent joins
        // rather than becoming a breaking rename.
        coins: orchestrator.playgroundCoins(agent.id),
        // What you hold in each active season — after D154 "can I afford a seat"
        // has a different answer per game type, so an agent needs both.
        coinsByCompetition: orchestrator.seasonBalances(agent.id),
        // Lifetime, across every season ever played (D155). Never used to rank,
        // charge or settle — it is the number the profile and the ticker show.
        coinsTotal: agent.coins,
        claimed: claim.claimed,
        owner: claim.owner,
      };
    });

    scope.patch('/agent/me', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const { payoutAddress } = patchAgentSchema.parse(request.body);
      const updated = orchestrator.setPayoutAddress(agent.id, payoutAddress);
      return {
        agentId: updated.id,
        displayName: updated.display_name,
        payoutAddress: updated.payout_address,
      };
    });

    // ---- ownership claim: "Sign in with X" (sub-spec 09) --------------------
    // The agent fetches a claim URL, hands it to its owner, the owner authorises
    // X, and we bind the agent to that X-verified identity.

    // Agent-facing (API key). Get/refresh the claim URL to give the owner.
    scope.post('/auth/claim/init', async (request) => {
      const agent = requireAgent(orchestrator, request);
      return orchestrator.initClaim(agent.id);
    });

    scope.get('/auth/claim/status', async (request) => {
      const agent = requireAgent(orchestrator, request);
      return orchestrator.claimStatus(agent.id);
    });

    // Public (token is the capability). Lets the browser claim page name the agent.
    scope.get('/auth/claim/info', async (request, reply) => {
      const token = (request.query as { token?: string }).token;
      if (!token) return reply.status(400).send({ error: 'MISSING_TOKEN' });
      return orchestrator.claimInfo(token);
    });

    // Browser: start "Sign in with X" → 302 to X's authorize page. Two modes:
    //  - ?mode=connect : a logged-in account links its X (sub-spec 11)
    //  - ?claim=<token>: 09's agent claim
    scope.get('/auth/x/login', async (request, reply) => {
      const q = request.query as { claim?: string; mode?: string };
      if (q.mode === 'connect') {
        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const { authorizeUrl } = orchestrator.startConnectX(token);
        return reply.redirect(authorizeUrl);
      }
      if (!q.claim) return reply.status(400).send({ error: 'MISSING_CLAIM_TOKEN' });
      const { authorizeUrl } = orchestrator.startXClaim(q.claim);
      return reply.redirect(authorizeUrl);
    });

    // Browser: X redirects back here after the owner authorises. Bind, then bounce
    // back to the claim page which shows the success state.
    scope.get('/auth/x/callback', async (request, reply) => {
      const { code, state, error } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };
      if (error) {
        return reply
          .type('text/html; charset=utf-8')
          .send(renderClaimError(`X sign-in was cancelled (${error}).`));
      }
      if (!code || !state) {
        return reply
          .type('text/html; charset=utf-8')
          .send(renderClaimError('Missing code or state from X.'));
      }
      try {
        // One callback URL serves both flows — dispatch on the stored flow purpose.
        if (orchestrator.isConnectFlow(state)) {
          await orchestrator.completeConnectX({ code, state });
          return reply.redirect(`${config.publicBaseUrl}/profile`);
        }
        const { claimToken, handle } = await orchestrator.completeXClaim({ code, state });
        // Bounce back to the claim page in a claimed state (shows "✓ @handle").
        const url = `${config.publicBaseUrl}/claim?token=${encodeURIComponent(claimToken)}&claimed=1&handle=${encodeURIComponent(handle)}`;
        return reply.redirect(url);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Could not complete the claim.';
        return reply.type('text/html; charset=utf-8').send(renderClaimError(message));
      }
    });

    // ---- web accounts: Google login + profile (sub-spec 11) -----------------

    // Browser: start "Sign in with Google" → 302 to Google's authorize page.
    scope.get('/auth/google/login', async (_request, reply) => {
      const { authorizeUrl } = orchestrator.startGoogleLogin();
      return reply.redirect(authorizeUrl);
    });

    // Browser: Google redirects back here → open a session cookie, bounce to the app.
    scope.get('/auth/google/callback', async (request, reply) => {
      const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
      if (error) return reply.type('text/html; charset=utf-8').send(renderClaimError(`Google sign-in was cancelled (${error}).`));
      if (!code || !state) return reply.type('text/html; charset=utf-8').send(renderClaimError('Missing code or state from Google.'));
      try {
        const { sessionToken } = await orchestrator.completeGoogleLogin({ code, state });
        reply.header('set-cookie', serializeCookie(SESSION_COOKIE, sessionToken, { maxAgeMs: config.webSessionTtlMs, secure: cookieSecure }));
        return reply.redirect(`${config.publicBaseUrl}/battleground`);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Could not complete Google sign-in.';
        return reply.type('text/html; charset=utf-8').send(renderClaimError(message));
      }
    });

    // The logged-in account (or null), its linked X, and its claimed agents. Always 200.
    scope.get('/auth/session', async (request) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      return orchestrator.sessionInfo(token);
    });

    scope.post('/auth/logout', async (request, reply) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      orchestrator.logoutSession(token);
      reply.header('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeMs: 0, secure: cookieSecure }));
      return { ok: true };
    });

    // Rename the account (the profile's EDIT).
    scope.patch('/auth/account', async (request) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      const { name } = (request.body ?? {}) as { name?: string };
      if (typeof name !== 'string') throw new ApiError(400, 'INVALID_NAME', 'name must be a string');
      return orchestrator.renameAccount(token, name);
    });

    // Claim an agent to the logged-in account via its claim link (1:1 rule, D38).
    scope.post('/auth/claim-agent', async (request) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      const body = (request.body ?? {}) as { claimToken?: string; claimLink?: string };
      // Accept a bare token or a full claim URL/link; pull the token out of a path/query.
      let claimToken = body.claimToken ?? '';
      if (!claimToken && body.claimLink) {
        const m = body.claimLink.match(/(?:token=|\/claim\/)([^&/?\s]+)/);
        claimToken = m ? m[1]! : body.claimLink.trim();
      }
      if (!claimToken) throw new ApiError(400, 'MISSING_CLAIM_TOKEN', 'Provide a claim link from your agent');
      return orchestrator.claimAgentAsAccount(token, claimToken);
    });

    // ---- spectator (no auth — replay-only; finished sessions only, sub-spec 10)
    // The public feed never exposes a live table: sessions are listed and served
    // only once settled, so a scraping agent cannot read an in-progress hand.
    scope.get('/spectate/sessions', async (request) => {
      const query = request.query as { competitionId?: string; limit?: string };
      const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
      return {
        // `mode` lets the viewer choose delayed-live airing vs on-demand browsing;
        // either way these are finished sessions only (sub-spec 10).
        mode: config.spectatorMode,
        sessions: listSessions(db, query.competitionId, limit, {
          minFinishedAgeMs: config.spectatorDelayMs,
        }),
      };
    });

    scope.get<{ Params: { sessionId: string } }>(
      '/spectate/session/:sessionId',
      async (request, reply) => {
        const result = getPublicSession(db, request.params.sessionId);
        if (result.status === 'not_found') return reply.status(404).send({ error: 'SESSION_NOT_FOUND' });
        if (result.status === 'in_progress') return reply.status(409).send({ error: 'GAME_IN_PROGRESS' });
        return result.summary;
      },
    );

    scope.get<{ Params: { sessionId: string } }>(
      '/spectate/session/:sessionId/events',
      async (request, reply) => {
        const since = Number((request.query as { since?: string }).since ?? -1);
        const result = readEvents(db, request.params.sessionId, Number.isFinite(since) ? since : -1);
        if (result.status === 'not_found') return reply.status(404).send({ error: 'SESSION_NOT_FOUND' });
        if (result.status === 'in_progress') return reply.status(409).send({ error: 'GAME_IN_PROGRESS' });
        return { events: result.events, settled: result.settled };
      },
    );

    // The list route is `/spectate/sessionS` but the detail routes are
    // `/spectate/session/:id`. An agent that generalises from one to the other
    // gets a 404 — observed twice in the production log, alongside a guess at
    // `/spectate/replay/:id`. The inconsistency is ours, so absorb it rather than
    // let it cost anyone a debugging session.
    const spectatorAliases: Array<[string, string]> = [
      ['/spectate/sessions/:sessionId', '/spectate/session/:sessionId'],
      ['/spectate/sessions/:sessionId/events', '/spectate/session/:sessionId/events'],
      ['/spectate/replay/:sessionId', '/spectate/session/:sessionId/events'],
    ];
    for (const [alias, canonical] of spectatorAliases) {
      scope.get<{ Params: { sessionId: string } }>(alias, async (request, reply) => {
        const target = canonical.replace(':sessionId', encodeURIComponent(request.params.sessionId));
        // 308 keeps the method and lets a client follow it transparently, while
        // still teaching the canonical path rather than silently serving both.
        return reply.redirect(`${request.url.startsWith(ALIAS_BASE) ? ALIAS_BASE : CANONICAL_BASE}${target}`, 308);
      });
    }

    // ---- sessions -----------------------------------------------------------
    scope.post('/session/join', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const { competitionId, txHash } = joinSchema.parse(request.body);
      return await orchestrator.joinSession(agent.id, competitionId, txHash);
    });

    // How your finished tables went (retrospection follow-up). Separate from
    // pending-actions on purpose: that list means "needs your attention", and the
    // contract's one unambiguous end signal is a table LEAVING it.
    scope.get('/session/results', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const q = sessionResultsQuerySchema.parse(request.query);
      return {
        results: orchestrator.sessionResults(agent.id, {
          sessionId: q.sessionId,
          limit: q.limit,
        }),
      };
    });

    /**
     * The agent's polling loop — and, with `?wait=`, its long poll (D158).
     *
     * The production soak made 1,545,865 of its 1,841,987 requests here, and
     * 84.8% of them carried no turn. `wait` removes the trade-off that caused
     * that: an agent could either poll politely and play slowly, or play fast and
     * be impolite, and there was no third option in the contract. The response
     * shape is unchanged, so `wait` is purely additive.
     */
    scope.get('/session/pending-actions', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const raw = Number((request.query as { wait?: string }).wait);
      // Capped under the 30s decision clock: a poll that outlived the turn it was
      // waiting for would hand back a deadline that had already expired.
      const waitMs = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 25_000) : 0;

      let sessions = orchestrator.pendingActions(agent.id);
      // Only ever wait on a table that exists. An agent between tables has
      // nothing to be woken BY, and holding it for 25s would delay the rejoin
      // that `skill.md` tells it to make.
      if (waitMs > 0 && sessions.length > 0 && !sessions.some((s) => s.yourTurn)) {
        await orchestrator.waitForTurn(agent.id, waitMs);
        sessions = orchestrator.pendingActions(agent.id);
      }
      return { sessions, pollAfterMs: orchestrator.pollAfterMs(sessions) };
    });

    scope.post('/session/action', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const { sessionId, move, reasoning, idempotencyKey } = actionSchema.parse(request.body);
      return orchestrator.applyAction(agent.id, sessionId, move, reasoning, idempotencyKey);
    });
  };

  // Mount the API under the canonical prefix, and again under the deprecated
  // alias with a one-time deprecation warning on first use (D45).
  app.register(
    (scope, _opts, done) => {
      registerApi(scope);
      done();
    },
    { prefix: CANONICAL_BASE },
  );

  let aliasWarned = false;
  app.register(
    (scope, _opts, done) => {
      scope.addHook('onRequest', (request, reply, next) => {
        reply.header('Deprecation', 'true');
        reply.header('Link', `<${CANONICAL_BASE}>; rel="successor-version"`);
        if (!aliasWarned) {
          aliasWarned = true;
          request.log.warn(
            `Deprecated API prefix ${ALIAS_BASE} was called (e.g. ${request.url}). ` +
              `Migrate to ${CANONICAL_BASE}; the alias will be removed in a future release.`,
          );
        }
        next();
      });
      registerApi(scope);
      done();
    },
    { prefix: ALIAS_BASE },
  );

  return { app, orchestrator };
}

/** Boot from config (§9) and listen. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  // On-chain commit-reveal (T13). Absent an operator key / escrow address this is
  // a no-op, so the arena runs perfectly well with no chain at all.
  const log = (message: string) => process.stdout.write(`${message}\n`);
  const chain = createSettlementChain(config, log);
  const tournamentChain = createTournamentChain(config, log);
  const xoauth = createXOAuth(config);
  if (!xoauth.enabled) {
    log('X login not configured (X_CLIENT_ID unset) — agent claiming / connect-X is disabled.');
  }
  const googleoauth = createGoogleOAuth(config);
  if (!googleoauth.enabled) {
    log('Google login not configured (GOOGLE_CLIENT_ID unset) — web sign-in is disabled.');
  }
  const orchestrator = new Orchestrator(db, config, {
    chain,
    tournamentChain,
    xoauth,
    googleoauth,
    hooks: createChainHooks(db, chain, log),
  });

  // A restart abandons every in-flight table — they live in memory, not on disk.
  // Clean up after the PREVIOUS process before accepting traffic, so an agent
  // never polls a table that can no longer move (sub-spec 22).
  const reaped = orchestrator.reapOrphanedSessions();
  if (reaped.archived > 0) {
    log(
      `[boot] archived ${reaped.archived} table(s) abandoned by a previous restart` +
        `${reaped.refunded > 0 ? `, refunding ${reaped.refunded} seat(s)` : ''}`,
    );
  }

  const { app } = buildServer({ db, config, orchestrator, logger: true });

  // Sweep decision deadlines even when nobody is polling, so a table with an
  // unresponsive agent still progresses (T10).
  const sweeper = setInterval(() => {
    try {
      orchestrator.tick();
    } catch {
      /* a single bad session must not kill the sweeper */
    }
  }, Math.max(250, Math.floor(config.decisionTimeoutMs / 4)));
  sweeper.unref();

  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    db.close();
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

// Boot when executed directly (`yarn workspace api start`).
if (require.main === module) {
  start().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
