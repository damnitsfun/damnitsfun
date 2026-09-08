import { createWalletStore } from './agent-wallet';
import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import {
  isPubliclyResolvable,
  reconcileIdentities,
  type IdentityRegistrar,
  type RegistrationResult,
} from './erc8004';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 23 (T120, D176): the reconciler.
 *
 * Everything asserted here is a FAILURE path, because the success path is the
 * one a real chain already proved (T118) and the failure paths are the ones that
 * decide whether an outage takes the battleground down with it. The standing
 * rule from `chain.ts` applies: a chain problem is recorded, never thrown, and an
 * agent without an identity plays exactly as it did before this spec existed.
 */
const WALLET_KEY = 'test-key-for-agent-wallets';

function boot(env: Record<string, string> = {}) {
  const config = loadConfig({
    env: {
      DECISION_TIMEOUT_MS: '3000',
      GAME_TIME_LIMIT_MS: '120000',
      TABLE_SIZE: '4',
      PUBLIC_BASE_URL: 'https://damnits.fun',
      WALLET_ENCRYPTION_KEY: WALLET_KEY,
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  return { db, config, orchestrator, app: buildServer({ db, config, orchestrator }).app };
}

function deps(db: Db, config: Config, registrar: IdentityRegistrar | null) {
  return {
    db,
    registrar,
    walletStore: createWalletStore(config.walletEncryptionKey),
    publicBaseUrl: config.publicBaseUrl,
    apiBaseUrl: `${config.publicBaseUrl}/api/battleground`,
    chainId: config.bscChainId,
  };
}

/** A registrar that hands out sequential ids and remembers what it was asked. */
function stubRegistrar(): IdentityRegistrar & { calls: string[] } {
  let next = 1;
  const calls: string[] = [];
  return {
    calls,
    async register({ agentId, agentUri }): Promise<RegistrationResult> {
      calls.push(agentId);
      expect(agentUri).toContain(`/agent/${agentId}/erc8004.json`);
      return { agentId: next++, txHash: `0xtx${next}`, gasPrice: '0' };
    },
  };
}

function failingRegistrar(message = 'registry unreachable'): IdentityRegistrar {
  return {
    async register() {
      throw new Error(message);
    },
  };
}

async function register(app: ReturnType<typeof boot>['app'], displayName: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/battleground/register',
    payload: { displayName },
  });
  return (res.json() as { agentId: string }).agentId;
}

describe('identity reconciler (T120)', () => {
  it('registers pending agents and records id, tx and time', async () => {
    const { app, db, config } = boot();
    const id = await register(app, 'alpha');
    const summary = await reconcileIdentities(deps(db, config, stubRegistrar()));

    expect(summary).toEqual({ registered: 1, failed: 0, skipped: 0 });
    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.erc8004_agent_id).toBe(1);
    expect(row.erc8004_tx_hash).toBe('0xtx2');
    expect(row.erc8004_registered_at).toEqual(expect.any(String));
  });

  it('leaves a failed agent playable, with a null identity, and never throws', async () => {
    const { app, db, config } = boot();
    const id = await register(app, 'bravo');

    const summary = await reconcileIdentities(deps(db, config, failingRegistrar()));
    expect(summary).toEqual({ registered: 0, failed: 1, skipped: 0 });

    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.erc8004_agent_id).toBeNull();
    // The agent is untouched in every way that matters: it still authenticates,
    // still holds its coins, and its document still resolves.
    const doc = await app.inject({
      method: 'GET',
      url: `/api/battleground/agent/${id}/erc8004.json`,
    });
    expect(doc.statusCode).toBe(200);
    expect(doc.json().registrations).toEqual([]);
  });

  it('retries a previously failed agent on the next pass', async () => {
    const { app, db, config } = boot();
    const id = await register(app, 'charlie');

    await reconcileIdentities(deps(db, config, failingRegistrar()));
    const summary = await reconcileIdentities(deps(db, config, stubRegistrar()));

    expect(summary.registered).toBe(1);
    expect(
      (db.prepare(`SELECT erc8004_agent_id AS x FROM agents WHERE id = ?`).get(id) as { x: number })
        .x,
    ).toBe(1);
  });

  it('is idempotent — a second pass never re-registers an agent that has an id', async () => {
    const { app, db, config } = boot();
    await register(app, 'delta');
    const registrar = stubRegistrar();

    await reconcileIdentities(deps(db, config, registrar));
    const second = await reconcileIdentities(deps(db, config, registrar));

    expect(registrar.calls).toHaveLength(1);
    expect(second).toEqual({ registered: 0, failed: 0, skipped: 0 });
  });

  it('does nothing at all when no registrar is configured', async () => {
    const { app, db, config } = boot();
    const id = await register(app, 'echo');
    expect(await reconcileIdentities(deps(db, config, null))).toEqual({
      registered: 0,
      failed: 0,
      skipped: 0,
    });
    expect(
      (db.prepare(`SELECT erc8004_agent_id AS x FROM agents WHERE id = ?`).get(id) as { x: null })
        .x,
    ).toBeNull();
  });

  it('does nothing when auto-wallets are off — there is no key to sign with', async () => {
    // A deployment without WALLET_ENCRYPTION_KEY registers agents walletless
    // (sub-spec 14). There is no EOA to own an identity, and the pass must not
    // try to decrypt a key that does not exist.
    const { app, db, config } = boot({ WALLET_ENCRYPTION_KEY: '' });
    await register(app, 'foxtrot');
    const registrar = stubRegistrar();
    expect(await reconcileIdentities(deps(db, config, registrar))).toEqual({
      registered: 0,
      failed: 0,
      skipped: 0,
    });
    expect(registrar.calls).toHaveLength(0);
  });

  it('caps a pass so a large backlog cannot hold up boot, and finishes on later passes', async () => {
    const { app, db, config } = boot();
    for (let i = 0; i < 5; i += 1) await register(app, `bulk${i}`);
    const registrar = stubRegistrar();

    const first = await reconcileIdentities({ ...deps(db, config, registrar), limit: 2 });
    expect(first.registered).toBe(2);
    const rest = await reconcileIdentities({ ...deps(db, config, registrar), limit: 10 });
    expect(rest.registered).toBe(3);
  });

  it('keeps going after one agent fails, rather than abandoning the pass', async () => {
    const { app, db, config } = boot();
    await register(app, 'good1');
    await register(app, 'bad');
    await register(app, 'good2');
    let call = 0;
    const flaky: IdentityRegistrar = {
      async register() {
        call += 1;
        if (call === 2) throw new Error('transient');
        return { agentId: call, txHash: `0x${call}`, gasPrice: '0' };
      },
    };
    const summary = await reconcileIdentities(deps(db, config, flaky));
    expect(summary).toEqual({ registered: 2, failed: 1, skipped: 0 });
  });
});

describe('POST /register is not slowed by the registry (D175)', () => {
  it('answers at the same speed whether the registry is fine, broken or hanging', async () => {
    const hang: IdentityRegistrar = {
      register: () => new Promise<RegistrationResult>(() => {}), // never settles
    };
    const time = async (registrar: IdentityRegistrar | null) => {
      const config = loadConfig({
        env: {
          DECISION_TIMEOUT_MS: '3000',
          GAME_TIME_LIMIT_MS: '120000',
          TABLE_SIZE: '4',
          WALLET_ENCRYPTION_KEY: WALLET_KEY,
        },
      });
      const db = openDatabase(':memory:');
      const app = buildServer({ db, config, registrar }).app;
      const started = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/api/battleground/register',
        payload: { displayName: 'speed' },
      });
      expect(res.statusCode).toBe(201);
      return Date.now() - started;
    };

    // The hanging registrar is the case that would break a naive implementation:
    // an awaited call here would leave the endpoint waiting forever.
    expect(await time(hang)).toBeLessThan(500);
    expect(await time(failingRegistrar())).toBeLessThan(500);
    expect(await time(null)).toBeLessThan(500);
  });
});

describe('unregisterable deployments are skipped, not retried forever', () => {
  it('knows which base URLs the registry can actually fetch', () => {
    // ERC-8004 resolves the agentUri behind an SSRF guard before accepting a
    // registration, so a loopback document is unregisterable by construction.
    expect(isPubliclyResolvable('https://damnits.fun/api/battleground')).toBe(true);
    expect(isPubliclyResolvable('http://localhost:8080/api')).toBe(false);
    expect(isPubliclyResolvable('http://127.0.0.1:8080/api')).toBe(false);
    expect(isPubliclyResolvable('http://192.168.1.10/api')).toBe(false);
    expect(isPubliclyResolvable('http://10.0.0.4/api')).toBe(false);
    expect(isPubliclyResolvable('http://172.20.0.1/api')).toBe(false);
    expect(isPubliclyResolvable('http://169.254.1.1/api')).toBe(false);
    expect(isPubliclyResolvable('not a url')).toBe(false);
  });

  it('reports pending agents as SKIPPED on a local box, and never calls the registry', async () => {
    // Without this, every dev box retries forever and logs a confusing
    // "Failed to parse agent URI" per agent per pass.
    const { app, db, config } = boot({ PUBLIC_BASE_URL: 'http://localhost:8123' });
    await register(app, 'localbot');
    const registrar = stubRegistrar();
    const summary = await reconcileIdentities({
      ...deps(db, config, registrar),
      apiBaseUrl: 'http://localhost:8123/api/battleground',
    });
    expect(summary).toEqual({ registered: 0, failed: 0, skipped: 1 });
    expect(registrar.calls).toHaveLength(0);
  });
});
