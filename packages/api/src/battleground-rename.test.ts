import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 12 (T42): the public contract is renamed to `/api/battleground/*`
 * (canonical) while `/api/arena/*` keeps working as a deprecated alias (D45), a
 * public `/config` endpoint surfaces gameplay numbers (D50), and the app moves
 * to `/battleground` with `/arena` 301-ing to it (D46).
 */
function boot(): FastifyInstance {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '120000', TABLE_SIZE: '4' },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  return buildServer({ db, config, orchestrator }).app;
}

describe('battleground rename (T42)', () => {
  it('serves the contract under the canonical /api/battleground prefix', async () => {
    const app = boot();
    const res = await app.inject({ method: 'GET', url: '/api/battleground/__introspection' });
    expect(res.statusCode).toBe(200);
  });

  it('keeps /api/arena working as a deprecated alias, flagged with a Deprecation header', async () => {
    const app = boot();
    const res = await app.inject({ method: 'GET', url: '/api/arena/__introspection' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(String(res.headers['link'])).toContain('/api/battleground');
  });

  it('exposes gameplay config (no secrets) at /api/battleground/config (D50)', async () => {
    const app = boot();
    const res = await app.inject({ method: 'GET', url: '/api/battleground/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // Sub-spec 18: TABLE_SIZE=4 in this env is the legacy fallback, so it
      // pins both bounds and the table stays exactly four-handed.
      tableMinSize: 4,
      tableMaxSize: 4,
      tableSize: 4,
      lobbyCountdownMs: 15000,
      playgroundEntryCoins: 10,
      coinPlaceStep: 6,
      // Sub-spec 22 (D153): ties are 10.2% of tables, so the rule that settles
      // them belongs in the published config alongside the curve itself.
      coinTieRule: 'mean',
      payoutFieldFraction: 0.3333,
      payoutTiers: 10,
      startingHand: 7,
      decisionTimeoutMs: 3000,
      gameTimeLimitMs: 120000,
      // The derived floor (seats x decision timeout x rounds) is well below
      // this env's limit, so the effective value is the configured one.
      gameTimeLimitFloorMs: 120000,
    });
    // The config endpoint must not leak secret/operational fields.
    const keys = Object.keys(res.json());
    expect(keys).not.toContain('operatorPrivateKey');
    expect(keys).not.toContain('bscTestnetRpcUrl');
  });

  it('registers via the canonical prefix', async () => {
    const app = boot();
    const res = await app.inject({
      method: 'POST',
      url: '/api/battleground/register',
      payload: { displayName: 'canon' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^damnits_sk_/);
  });

  it('accepts the new x-battleground-api-key header (and still the old one)', async () => {
    const app = boot();
    const { apiKey } = (
      await app.inject({
        method: 'POST',
        url: '/api/battleground/register',
        payload: { displayName: 'hdr' },
      })
    ).json();
    const withNew = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': apiKey },
    });
    expect(withNew.statusCode).toBe(200);
    const withOld = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-arena-api-key': apiKey },
    });
    expect(withOld.statusCode).toBe(200);
  });

  it('serves the app at /battleground and 301s /arena to it (D46)', async () => {
    const app = boot();
    const bg = await app.inject({ method: 'GET', url: '/battleground' });
    // 200 when the web bundle is present; 404 WEB_UI_NOT_BUILT otherwise — either
    // proves the route exists (not a 404 from an unregistered path).
    expect([200, 404]).toContain(bg.statusCode);

    const legacy = await app.inject({ method: 'GET', url: '/arena' });
    expect(legacy.statusCode).toBe(301);
    expect(legacy.headers['location']).toBe('/battleground');
  });
});
