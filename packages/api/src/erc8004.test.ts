import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { identityRegistryAddress, registrationDocument } from './erc8004';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 23 (T117, D178): the ERC-8004 registration document.
 *
 * This is what the on-chain identity POINTS AT, so the case that matters is the
 * one that exists for every agent between `POST /register` and the next
 * reconciler pass — and permanently on a deployment with no chain wiring: no
 * token id yet, and a document that must still be valid and resolvable.
 */
function boot(env: Record<string, string> = {}) {
  const config = loadConfig({
    env: {
      DECISION_TIMEOUT_MS: '3000',
      GAME_TIME_LIMIT_MS: '120000',
      TABLE_SIZE: '4',
      PUBLIC_BASE_URL: 'https://damnits.fun',
      WALLET_ENCRYPTION_KEY: 'test-key-for-agent-wallets',
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  return { app: buildServer({ db, config, orchestrator }).app, db, orchestrator };
}

async function register(app: ReturnType<typeof boot>['app'], displayName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/battleground/register',
    payload: { displayName },
  });
  return res.json() as { agentId: string; apiKey: string };
}

describe('identity registry addresses', () => {
  it('knows the deterministic ERC-8004 registry on BSC mainnet and testnet', () => {
    // Verified with eth_getCode against BSC testnet before this shipped: the
    // chain-97 address holds a deployed proxy. A wrong address here would fail
    // SILENTLY — a call to a codeless address returns success and empty data.
    expect(identityRegistryAddress(97)).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e');
    expect(identityRegistryAddress(56)).toBe('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432');
  });

  it('returns null for a chain with no known registry', () => {
    expect(identityRegistryAddress(31337)).toBeNull();
  });
});

describe('registration document (D178)', () => {
  const agent = {
    id: 'agent_abc',
    display_name: 'testbot',
    wallet_address: '0x3333333333333333333333333333333333333333',
    erc8004_agent_id: null as number | null,
  };
  const opts = {
    publicBaseUrl: 'https://damnits.fun',
    apiBaseUrl: 'https://damnits.fun/api/battleground',
    chainId: 97,
  };

  it('is a valid document with an EMPTY registrations array before registration', () => {
    const doc = registrationDocument({ agent, ...opts });
    expect(doc.type).toBe('https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
    expect(doc.name).toBe('testbot');
    expect(doc.registrations).toEqual([]);
    // Still resolvable and still useful: the services are what make the identity
    // worth looking up, and they do not depend on the token id.
    expect(doc.services.length).toBeGreaterThan(0);
  });

  it('names the agent’s own wallet, not the operator that holds the token (D177)', () => {
    expect(registrationDocument({ agent, ...opts }).walletAddress).toBe(agent.wallet_address);
  });

  it('points its web service at the same profileUrl GET /agent/me hands the operator', () => {
    const doc = registrationDocument({ agent, ...opts });
    const web = doc.services.find((s) => s.name === 'web');
    expect(web?.endpoint).toBe('https://damnits.fun/agent/agent_abc');
  });

  it('fills registrations once a token id exists, in CAIP-10 form', () => {
    const doc = registrationDocument({ agent: { ...agent, erc8004_agent_id: 4242 }, ...opts });
    expect(doc.registrations).toEqual([
      {
        agentId: 4242,
        agentRegistry: 'eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e',
      },
    ]);
  });

  it('leaves registrations empty on a chain with no registry, even with a token id', () => {
    // Belt and braces: a token id from another chain must never be published
    // against a registry address we do not have.
    const doc = registrationDocument({
      agent: { ...agent, erc8004_agent_id: 7 },
      ...opts,
      chainId: 31337,
    });
    expect(doc.registrations).toEqual([]);
  });
});

describe('GET /agent/:agentId/erc8004.json (T117)', () => {
  it('is public — no API key — because an identity nobody can resolve is not one', async () => {
    const { app } = boot();
    const { agentId } = await register(app, 'publicbot');
    const res = await app.inject({
      method: 'GET',
      url: `/api/battleground/agent/${agentId}/erc8004.json`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('publicbot');
  });

  it('serves a freshly registered agent an empty registrations array, not an error', async () => {
    const { app } = boot();
    const { agentId } = await register(app, 'freshbot');
    const doc = (
      await app.inject({ method: 'GET', url: `/api/battleground/agent/${agentId}/erc8004.json` })
    ).json();
    expect(doc.registrations).toEqual([]);
    expect(doc.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('reflects the token id once the column is set, with no second on-chain write', async () => {
    // D178's whole point: the document is LIVE, so recording the id locally is
    // enough — there is no setAgentUri follow-up to get wrong.
    const { app, db } = boot();
    const { agentId } = await register(app, 'idbot');
    db.prepare(`UPDATE agents SET erc8004_agent_id = ? WHERE id = ?`).run(99, agentId);
    const doc = (
      await app.inject({ method: 'GET', url: `/api/battleground/agent/${agentId}/erc8004.json` })
    ).json();
    expect(doc.registrations[0].agentId).toBe(99);
  });

  it('404s for an unknown agent', async () => {
    const { app } = boot();
    const res = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/agent_nope/erc8004.json',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('AGENT_NOT_FOUND');
  });

  it('does not shadow GET /agent/me', async () => {
    // The three-segment shape is load-bearing; pin it rather than trusting the
    // comment above the route.
    const { app } = boot();
    const { apiKey } = await register(app, 'mebot');
    const res = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('mebot');
  });
});

describe('GET /agent/me balances (T122, D180)', () => {
  it('returns null rather than a 500 when the RPC is unreachable', async () => {
    // The case that matters. `/agent/me` is on the onboarding path skill.md sends
    // every new agent down; a chain outage must cost this ONE field and nothing
    // else. The address here is unroutable, so the read fails for real.
    const { app } = boot({ BSC_TESTNET_RPC_URL: 'http://127.0.0.1:1/never' });
    const { apiKey } = await register(app, 'offlinebot');
    const res = await app.inject({
      method: 'GET',
      url: '/api/battleground/agent/me',
      headers: { 'x-battleground-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().balances).toEqual({ native: null });
    // Everything else on the response is unaffected.
    expect(res.json().displayName).toBe('offlinebot');
    expect(res.json().coins).toBeGreaterThan(0);
  });

  it('reports a null identity until a reconciler pass registers one', async () => {
    const { app } = boot({ BSC_TESTNET_RPC_URL: 'http://127.0.0.1:1/never' });
    const { apiKey } = await register(app, 'unidentified');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/battleground/agent/me',
        headers: { 'x-battleground-api-key': apiKey },
      })
    ).json();
    expect(body.erc8004AgentId).toBeNull();
  });

  it('reports null balances for a walletless agent without calling the chain', async () => {
    const { app } = boot({ WALLET_ENCRYPTION_KEY: '' });
    const { apiKey } = await register(app, 'walletless');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/battleground/agent/me',
        headers: { 'x-battleground-api-key': apiKey },
      })
    ).json();
    expect(body.walletAddress).toBeNull();
    expect(body.balances).toEqual({ native: null });
  });
});
