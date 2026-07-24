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
import {
  actionSchema,
  enterSchema,
  joinSchema,
  leaderboardQuerySchema,
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

  // The profile page is part of the app SPA; serve it for /profile and /profile/:id.
  app.get('/profile', async (_request, reply) => sendPage(reply, webIndex));
  app.get<{ Params: { id: string } }>('/profile/:id', async (_request, reply) => sendPage(reply, webIndex));

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
      tableSize: config.tableSize,
      startingHand: STARTING_HAND,
      decisionTimeoutMs: config.decisionTimeoutMs,
      gameTimeLimitMs: config.gameTimeLimitMs,
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
        payoutAddress: agent.payout_address,
        coins: agent.coins,
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

    // ---- sessions -----------------------------------------------------------
    scope.post('/session/join', async (request) => {
      const agent = requireAgent(orchestrator, request);
      const { competitionId, txHash } = joinSchema.parse(request.body);
      return await orchestrator.joinSession(agent.id, competitionId, txHash);
    });

    scope.get('/session/pending-actions', async (request) => {
      const agent = requireAgent(orchestrator, request);
      return { sessions: orchestrator.pendingActions(agent.id) };
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
