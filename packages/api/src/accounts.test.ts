import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import type { GoogleIdentity, GoogleOAuthProvider } from './googleoauth';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';
import type { XIdentity, XOAuthProvider } from './xoauth';

/**
 * Sub-spec 11 — web accounts: Google sign-in, connect X, claim-link agents (1:1).
 *
 * Google is the browser login; X (09) maps the account to a public identity; an
 * agent is claimed to the account via its claim link, under arena's rule — one
 * agent per X, one claim per agent.
 */

class FakeGoogle implements GoogleOAuthProvider {
  readonly enabled = true;
  lastState: string | null = null;
  identity: GoogleIdentity = { sub: 'g_1', email: 'a@example.com', name: 'Alice' };
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.lastState = p.state;
    return `https://google.example/authorize?state=${p.state}`;
  }
  async exchangeCode(): Promise<string> {
    return 'g-access-token';
  }
  async getIdentity(): Promise<GoogleIdentity> {
    return this.identity;
  }
}

class FakeX implements XOAuthProvider {
  readonly enabled = true;
  lastState: string | null = null;
  identity: XIdentity = { id: 'x_7', username: 'alice_x' };
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    this.lastState = p.state;
    return `https://x.example/authorize?state=${p.state}`;
  }
  async exchangeCode(): Promise<string> {
    return 'x-access-token';
  }
  async getIdentity(): Promise<XIdentity> {
    return this.identity;
  }
}

interface Harness {
  app: FastifyInstance;
  google: FakeGoogle;
  xoauth: FakeX;
  orchestrator: Orchestrator;
}

function boot(): Harness {
  const config = loadConfig({ env: { PUBLIC_BASE_URL: 'https://arena.test', MIN_RANKED_SESSIONS: '0' } });
  const db = openDatabase(':memory:');
  const google = new FakeGoogle();
  const xoauth = new FakeX();
  const orchestrator = new Orchestrator(db, config, { googleoauth: google, xoauth });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, google, xoauth, orchestrator };
}

/** Extract the `sid=…` cookie from a Set-Cookie header for reuse on later requests. */
function sidFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : (raw as string);
  return header.split(';')[0]!; // "sid=<token>"
}

/** Full Google sign-in; returns the session cookie string. */
async function signInWithGoogle(h: Harness): Promise<string> {
  await h.app.inject({ method: 'GET', url: '/api/arena/auth/google/login' });
  const cb = await h.app.inject({
    method: 'GET',
    url: `/api/arena/auth/google/callback?code=abc&state=${h.google.lastState}`,
  });
  expect(cb.statusCode).toBe(302);
  return sidFrom(cb);
}

async function connectX(h: Harness, cookie: string): Promise<void> {
  await h.app.inject({ method: 'GET', url: '/api/arena/auth/x/login?mode=connect', headers: { cookie } });
  const cb = await h.app.inject({
    method: 'GET',
    url: `/api/arena/auth/x/callback?code=abc&state=${h.xoauth.lastState}`,
  });
  expect(cb.statusCode).toBe(302);
  expect(cb.headers.location).toContain('/profile');
}

async function registerAgentWithClaim(h: Harness, name: string): Promise<string> {
  const reg = (await h.app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName: name } })).json();
  const init = (
    await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim/init',
      headers: { 'x-arena-api-key': reg.apiKey },
    })
  ).json();
  return init.claimToken as string;
}

const session = async (h: Harness, cookie?: string) =>
  (await h.app.inject({ method: 'GET', url: '/api/arena/auth/session', headers: cookie ? { cookie } : {} })).json();

describe('sub-spec 11 — web accounts', () => {
  it('logged out: /auth/session has no account but reports providers', async () => {
    const h = boot();
    const s = await session(h);
    expect(s.account).toBeNull();
    expect(s.providers).toEqual({ google: true, x: true });
  });

  it('Google sign-in opens a session; connect X maps the account', async () => {
    const h = boot();
    const cookie = await signInWithGoogle(h);

    let s = await session(h, cookie);
    expect(s.account.email).toBe('a@example.com');
    expect(s.account.name).toBe('Alice');
    expect(s.x).toBeNull();
    expect(s.agents).toEqual([]);

    await connectX(h, cookie);
    s = await session(h, cookie);
    expect(s.x).toEqual({ handle: 'alice_x', xUserId: 'x_7' });
  });

  it('claims one agent to the account; enforces the 1:1 rule', async () => {
    const h = boot();
    const cookie = await signInWithGoogle(h);

    const token1 = await registerAgentWithClaim(h, 'AgentOne');
    // Cannot claim before connecting X.
    const early = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim-agent',
      headers: { cookie },
      payload: { claimToken: token1 },
    });
    expect(early.statusCode).toBe(403);
    expect(early.json().error).toBe('CONNECT_X_FIRST');

    await connectX(h, cookie);
    const ok = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim-agent',
      headers: { cookie },
      payload: { claimToken: token1 },
    });
    expect(ok.statusCode).toBe(200);

    const s = await session(h, cookie);
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0].displayName).toBe('AgentOne');
    expect(s.agents[0].claimed).toBe(true);

    // A second agent, same X account → rejected (one agent per X).
    const token2 = await registerAgentWithClaim(h, 'AgentTwo');
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim-agent',
      headers: { cookie },
      payload: { claimToken: token2 },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('X_ALREADY_HAS_AGENT');

    // Re-claiming the already-claimed agent → rejected (one claim per agent).
    const again = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim-agent',
      headers: { cookie },
      payload: { claimToken: token1 },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('ALREADY_CLAIMED');
  });

  it('accepts a full claim link, not just a bare token', async () => {
    const h = boot();
    const cookie = await signInWithGoogle(h);
    await connectX(h, cookie);
    const token = await registerAgentWithClaim(h, 'LinkBot');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/arena/auth/claim-agent',
      headers: { cookie },
      payload: { claimLink: `https://arena.test/claim?token=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((await session(h, cookie)).agents).toHaveLength(1);
  });

  it('rename + logout', async () => {
    const h = boot();
    const cookie = await signInWithGoogle(h);
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: '/api/arena/auth/account',
      headers: { cookie },
      payload: { name: 'Alice A.' },
    });
    expect(renamed.json().name).toBe('Alice A.');
    expect((await session(h, cookie)).account.name).toBe('Alice A.');

    await h.app.inject({ method: 'POST', url: '/api/arena/auth/logout', headers: { cookie } });
    expect((await session(h, cookie)).account).toBeNull();
  });

  it('anonymous connect-X and claim are rejected; disabled providers reported', async () => {
    const h = boot();
    // No cookie → connect-X login redirects fail with 401.
    const connect = await h.app.inject({ method: 'GET', url: '/api/arena/auth/x/login?mode=connect' });
    expect(connect.statusCode).toBe(401);

    // Disabled providers: a fresh orchestrator with neither configured.
    const config = loadConfig({ env: {} });
    const db = openDatabase(':memory:');
    const orchestrator = new Orchestrator(db, config); // no google/x → disabled
    const { app } = buildServer({ db, config, orchestrator });
    const s = (await app.inject({ method: 'GET', url: '/api/arena/auth/session' })).json();
    expect(s.providers).toEqual({ google: false, x: false });
    const login = await app.inject({ method: 'GET', url: '/api/arena/auth/google/login' });
    expect(login.statusCode).toBe(501);
  });
});
