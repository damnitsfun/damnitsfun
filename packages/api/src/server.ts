import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { ApiError, Orchestrator, type AgentRow } from './orchestrator';
import { INTROSPECTION } from './routes/introspection';
import {
  actionSchema,
  joinSchema,
  leaderboardQuerySchema,
  patchAgentSchema,
  registerSchema,
} from './schemas';

const BASE = '/api/arena';

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
 * Every endpoint except `register` and `__introspection` requires
 * `x-arena-api-key` (§5).
 */
function requireAgent(orchestrator: Orchestrator, request: FastifyRequest): AgentRow {
  const header = request.headers['x-arena-api-key'];
  const apiKey = Array.isArray(header) ? header[0] : header;
  const agent = orchestrator.authenticate(apiKey);
  if (!agent) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid x-arena-api-key header');
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

  // ---- introspection (no auth) ---------------------------------------------
  app.get(`${BASE}/__introspection`, async () => INTROSPECTION);

  // ---- register (no auth) ---------------------------------------------------
  app.post(`${BASE}/register`, async (request, reply) => {
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

  // ---- competitions ---------------------------------------------------------
  app.get(`${BASE}/competition/list-active`, async (request) => {
    requireAgent(orchestrator, request);
    return { competitions: orchestrator.listActiveCompetitions() };
  });

  app.get(`${BASE}/competition/leaderboard`, async (request) => {
    requireAgent(orchestrator, request);
    const { competitionId } = leaderboardQuerySchema.parse(request.query);
    return { leaderboard: orchestrator.leaderboard(competitionId) };
  });

  // ---- agent identity -------------------------------------------------------
  app.get(`${BASE}/agent/me`, async (request) => {
    const agent = requireAgent(orchestrator, request);
    return {
      agentId: agent.id,
      displayName: agent.display_name,
      payoutAddress: agent.payout_address,
    };
  });

  app.patch(`${BASE}/agent/me`, async (request) => {
    const agent = requireAgent(orchestrator, request);
    const { payoutAddress } = patchAgentSchema.parse(request.body);
    const updated = orchestrator.setPayoutAddress(agent.id, payoutAddress);
    return {
      agentId: updated.id,
      displayName: updated.display_name,
      payoutAddress: updated.payout_address,
    };
  });

  // ---- sessions -------------------------------------------------------------
  app.post(`${BASE}/session/join`, async (request) => {
    const agent = requireAgent(orchestrator, request);
    const { competitionId, txHash } = joinSchema.parse(request.body);
    return orchestrator.joinSession(agent.id, competitionId, txHash);
  });

  app.get(`${BASE}/session/pending-actions`, async (request) => {
    const agent = requireAgent(orchestrator, request);
    return { sessions: orchestrator.pendingActions(agent.id) };
  });

  app.post(`${BASE}/session/action`, async (request) => {
    const agent = requireAgent(orchestrator, request);
    const { sessionId, move, reasoning, idempotencyKey } = actionSchema.parse(request.body);
    return orchestrator.applyAction(agent.id, sessionId, move, reasoning, idempotencyKey);
  });

  return { app, orchestrator };
}

/** Boot from config (§9) and listen. */
export async function start(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const { app, orchestrator } = buildServer({ db, config, logger: true });

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
