import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';
import type { XIdentity, XOAuthProvider } from './xoauth';

/**
 * Sub-spec 09 — "Sign in with X" agent claiming.
 *
 * Exercises the exact arena flow end-to-end with a FAKE X provider (no network):
 * init → claimUrl → owner authorises → callback binds the X-verified owner →
 * claimed:true; plus the payout-eligibility gate and the requires_claim entry gate.
 */

/** A fake X OAuth provider — records the authorize call, returns a fixed identity. */
class FakeXOAuth implements XOAuthProvider {
  readonly enabled = true;
  lastState: string | null = null;
  lastChallenge: string | null = null;
  identity: XIdentity = { id: 'x_42', username: 'satoshi' };

  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.lastState = params.state;
    this.lastChallenge = params.codeChallenge;
    return `https://x.example/authorize?state=${params.state}`;
  }
  async exchangeCode(): Promise<string> {
    return 'fake-access-token';
  }
  async getIdentity(): Promise<XIdentity> {
    return this.identity;
  }
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  orchestrator: Orchestrator;
  xoauth: FakeXOAuth;
}

function boot(): Harness {
  const config = loadConfig({ env: { PUBLIC_BASE_URL: 'https://arena.test', MIN_RANKED_SESSIONS: '0' } });
  const db = openDatabase(':memory:');
  const xoauth = new FakeXOAuth();
  const orchestrator = new Orchestrator(db, config, { xoauth });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, orchestrator, xoauth };
}

async function register(app: FastifyInstance, displayName: string) {
  const res = await app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName } });
  const body = res.json();
  return { agentId: body.agentId as string, apiKey: body.apiKey as string };
}

const authed = (apiKey: string) => ({ 'x-arena-api-key': apiKey });

/** Drive the whole browser side of a claim, returning the callback response. */
async function ownerSignsInWithX(h: Harness, claimToken: string) {
  const login = await h.app.inject({ method: 'GET', url: `/api/arena/auth/x/login?claim=${claimToken}` });
  expect(login.statusCode).toBe(302);
  const state = h.xoauth.lastState!;
  return h.app.inject({ method: 'GET', url: `/api/arena/auth/x/callback?code=abc&state=${state}` });
}

describe('sub-spec 09 — Sign in with X claiming', () => {
  it('a fresh agent is unclaimed and gets a claim URL', async () => {
    const h = boot();
    const agent = await register(h.app, 'unclaimed');
    const status = await h.app.inject({
      method: 'GET',
      url: '/api/arena/auth/claim/status',
      headers: authed(agent.apiKey),
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.claimed).toBe(false);
    expect(body.owner).toBeNull();
    expect(body.claimUrl).toMatch(/^https:\/\/arena\.test\/claim\?token=/);
  });

  it('binds the agent to an X-verified owner through the full OAuth flow', async () => {
    const h = boot();
    const agent = await register(h.app, 'claimable');

    const init = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim/init',
      headers: authed(agent.apiKey),
    });
    const { claimToken } = init.json();

    // Owner opens the claim link → login redirects to X with PKCE + state.
    const callback = await ownerSignsInWithX(h, claimToken);
    expect(callback.statusCode).toBe(302);
    // Redirects back to the claim page in a claimed state.
    expect(callback.headers.location).toContain('/claim?token=');
    expect(callback.headers.location).toContain('claimed=1');

    // The agent now sees itself as claimed by @satoshi.
    const me = await h.app.inject({ method: 'GET', url: '/api/arena/agent/me', headers: authed(agent.apiKey) });
    expect(me.json().claimed).toBe(true);
    expect(me.json().owner).toEqual({ handle: 'satoshi', xUserId: 'x_42' });

    // PKCE challenge was an S256 hash (not the raw verifier), and state was set.
    expect(h.xoauth.lastChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a replayed / unknown OAuth state', async () => {
    const h = boot();
    const agent = await register(h.app, 'replay');
    const { claimToken } = (
      await h.app.inject({ method: 'POST', url: '/api/arena/auth/claim/init', headers: authed(agent.apiKey) })
    ).json();

    const first = await ownerSignsInWithX(h, claimToken);
    expect(first.statusCode).toBe(302);
    // Re-using the same state must fail — it was consumed.
    const replay = await h.app.inject({
      method: 'GET',
      url: `/api/arena/auth/x/callback?code=abc&state=${h.xoauth.lastState}`,
    });
    expect(replay.body).toContain("didn't complete");
  });

  it('the public claim/info endpoint names the agent without its key', async () => {
    const h = boot();
    const agent = await register(h.app, 'NamedBot');
    const { claimToken } = (
      await h.app.inject({ method: 'POST', url: '/api/arena/auth/claim/init', headers: authed(agent.apiKey) })
    ).json();

    const info = await h.app.inject({ method: 'GET', url: `/api/arena/auth/claim/info?token=${claimToken}` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ agentId: agent.agentId, displayName: 'NamedBot', claimed: false });
  });

  it('a requires_claim competition refuses entry until the agent is claimed (403 CLAIM_REQUIRED)', async () => {
    const h = boot();
    const compId = h.orchestrator.createTournament('Verified Only', '0', { requiresClaim: true });
    const agent = await register(h.app, 'gated');

    const blocked = await h.app.inject({
      method: 'POST',
      url: '/api/arena/competition/enter',
      headers: authed(agent.apiKey),
      payload: { competitionId: compId },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('CLAIM_REQUIRED');
    expect(blocked.json().claimUrl).toContain('/claim?token=');

    // Claim, then entry succeeds.
    const { claimToken } = (
      await h.app.inject({ method: 'POST', url: '/api/arena/auth/claim/init', headers: authed(agent.apiKey) })
    ).json();
    await ownerSignsInWithX(h, claimToken);

    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/arena/competition/enter',
      headers: authed(agent.apiKey),
      payload: { competitionId: compId },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().entered).toBe(true);
  });

  it('an unclaimed agent is excluded from payout eligibility; claiming includes it', async () => {
    const h = boot(); // MIN_RANKED_SESSIONS = 0, so games are not the gate here
    const compId = h.orchestrator.createTournament('Eligibility', '0');
    const agent = await register(h.app, 'earner');
    await h.app.inject({
      method: 'PATCH',
      url: '/api/arena/agent/me',
      headers: authed(agent.apiKey),
      payload: { payoutAddress: `0x${'a'.repeat(40)}` },
    });
    await h.app.inject({
      method: 'POST',
      url: '/api/arena/competition/enter',
      headers: authed(agent.apiKey),
      payload: { competitionId: compId },
    });

    // Has a payout address + entered, but unclaimed → not eligible.
    expect(h.orchestrator.eligibleRanked(compId)).toHaveLength(0);

    // After claiming → eligible.
    const { claimToken } = (
      await h.app.inject({ method: 'POST', url: '/api/arena/auth/claim/init', headers: authed(agent.apiKey) })
    ).json();
    await ownerSignsInWithX(h, claimToken);
    expect(h.orchestrator.eligibleRanked(compId)).toHaveLength(1);
  });

  it('claiming is disabled with a clear error when X is not configured', async () => {
    const config = loadConfig({ env: {} });
    const db = openDatabase(':memory:');
    const orchestrator = new Orchestrator(db, config); // no xoauth → DISABLED
    const { app } = buildServer({ db, config, orchestrator });
    const agent = await register(app, 'noX');
    const { claimToken } = (
      await app.inject({ method: 'POST', url: '/api/arena/auth/claim/init', headers: authed(agent.apiKey) })
    ).json();
    const login = await app.inject({ method: 'GET', url: `/api/arena/auth/x/login?claim=${claimToken}` });
    expect(login.statusCode).toBe(501);
    expect(login.json().error).toBe('CLAIM_X_NOT_CONFIGURED');
  });
});
