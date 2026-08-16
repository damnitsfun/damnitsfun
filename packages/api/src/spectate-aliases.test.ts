import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * The spectator paths are inconsistent: the list is `/spectate/sessionS` while
 * the detail routes are `/spectate/session/:id`. An agent that generalises from
 * the one it was shown to the one it wasn't gets a 404 — which happened twice on
 * production, along with a guess at `/spectate/replay/:id`.
 *
 * The inconsistency is ours. These tests pin the aliases that absorb it.
 */
function boot(): { app: FastifyInstance; sessionId: string } {
  const config = loadConfig({ env: { TABLE_MIN_SIZE: '2', TABLE_MAX_SIZE: '2' } });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  const { app } = buildServer({ db, config, orchestrator });
  return { app, sessionId: 'sess_whatever' };
}

describe('spectator route aliases', () => {
  const cases: Array<[string, string]> = [
    ['/api/battleground/spectate/sessions/SID', '/api/battleground/spectate/session/SID'],
    [
      '/api/battleground/spectate/sessions/SID/events',
      '/api/battleground/spectate/session/SID/events',
    ],
    ['/api/battleground/spectate/replay/SID', '/api/battleground/spectate/session/SID/events'],
  ];

  for (const [alias, canonical] of cases) {
    it(`redirects ${alias} to the canonical path`, async () => {
      const { app, sessionId } = boot();
      const res = await app.inject({ method: 'GET', url: alias.replace('SID', sessionId) });
      expect(res.statusCode).toBe(308); // preserves the method; teaches the real path
      expect(res.headers.location).toBe(canonical.replace('SID', sessionId));
    });
  }

  it('keeps the alias inside the deprecated /api/arena prefix rather than jumping namespaces', async () => {
    const { app, sessionId } = boot();
    const res = await app.inject({
      method: 'GET',
      url: `/api/arena/spectate/sessions/${sessionId}`,
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`/api/arena/spectate/session/${sessionId}`);
  });

  it('still 404s an unknown session after following the alias', async () => {
    const { app } = boot();
    const res = await app.inject({
      method: 'GET',
      url: '/api/battleground/spectate/session/sess_does_not_exist',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'SESSION_NOT_FOUND' });
  });
});
