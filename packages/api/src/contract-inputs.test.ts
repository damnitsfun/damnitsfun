import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 22 (T104) — the bad-input battery the production soak ran by hand.
 *
 * Every case here was fired at the live API during the 4,004-table run. Two came
 * back wrong and are fixed by D161/D162; the rest already answered correctly and
 * are pinned so they stay that way. They are cheap, and the class of bug they
 * catch — a nonsensical request answered with a plausible-looking result — is the
 * kind an agent author only discovers in production.
 */

function boot() {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config, { clock: () => 1_700_000_000_000 });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, config, orchestrator };
}

async function register(app: FastifyInstance, displayName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/battleground/register',
    payload: { displayName },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { agentId: string; apiKey: string };
}

describe('GET /competition/leaderboard — an unknown competition (D161)', () => {
  it('is a 404, not an empty board', async () => {
    const h = boot();
    const agent = await register(h.app, 'probe');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/competition/leaderboard?competitionId=comp_doesnotexist',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    // `/session/join` already answers 404 for this same id. Returning 200 with an
    // empty array made one typo an error on one endpoint and a success on the
    // other — and told an agent holding a rolled-over id that its season was
    // merely empty rather than gone.
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('COMPETITION_NOT_FOUND');
    await h.app.close();
  });

  it('still answers for a real competition with nobody in it', async () => {
    const h = boot();
    const agent = await register(h.app, 'probe');
    const competitionId = h.orchestrator.createCompetition('Empty Cup');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/battleground/competition/leaderboard?competitionId=${competitionId}`,
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().leaderboard).toEqual([]);
    await h.app.close();
  });
});

describe('GET /session/results — the limit (D162)', () => {
  const cases: Array<[string, number]> = [
    ['?limit=0', 400],
    ['?limit=-5', 400],
    ['?limit=-1', 400],
    ['?limit=1.5', 400],
    ['?limit=abc', 400],
    ['?limit=1', 200],
    ['?limit=50', 200],
    ['?limit=999', 200], // clamped, because skill.md documents a maximum not an error
    ['', 200],
  ];

  it.each(cases)('%s -> %i', async (query, expected) => {
    const h = boot();
    const agent = await register(h.app, 'probe');
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/battleground/session/results${query}`,
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    expect(res.statusCode).toBe(expected);
    if (expected === 400) expect(res.json().error).toBe('INVALID_REQUEST');
    await h.app.close();
  });
});

describe('the inputs that were already right', () => {
  it('rejects an empty and an over-long displayName', async () => {
    const h = boot();
    for (const displayName of ['', 'x'.repeat(500)]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/battleground/register',
        payload: { displayName },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_REQUEST');
    }
    await h.app.close();
  });

  it('rejects a malformed payout address', async () => {
    const h = boot();
    const agent = await register(h.app, 'probe');
    const res = await h.app.inject({
      method: 'PATCH',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': agent.apiKey },
      payload: { payoutAddress: 'not-an-address' },
    });
    expect(res.statusCode).toBe(400);
    await h.app.close();
  });

  it('401s on a missing and on a garbage key', async () => {
    const h = boot();
    for (const headers of [{}, { 'x-battleground-api-key': 'damnits_sk_notarealkey' }]) {
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/battleground/agent/me',
        headers,
      });
      expect(res.statusCode).toBe(401);
    }
    await h.app.close();
  });

  it('404s a join to an unknown competition and an action on an unknown session', async () => {
    const h = boot();
    const agent = await register(h.app, 'probe');
    const headers = { 'x-battleground-api-key': agent.apiKey };
    const join = await h.app.inject({
      method: 'POST',
      url: '/api/battleground/session/join',
      headers,
      payload: { competitionId: 'comp_doesnotexist' },
    });
    expect(join.statusCode).toBe(404);
    const action = await h.app.inject({
      method: 'POST',
      url: '/api/battleground/session/action',
      headers,
      payload: {
        sessionId: 'sess_nope',
        move: { type: 'drawCard' },
        reasoning: 'probe',
        idempotencyKey: 'probe-1',
      },
    });
    expect(action.statusCode).toBe(404);
    await h.app.close();
  });
});
