import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { explorerBaseUrl, explorerUrl } from './explorer';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 23 (T113, D173): the chain a deployment actually anchors to is
 * PUBLISHED, so the web can link the settlement it has always only described —
 * and so an outsider can check which chain and which contracts a running box is
 * really using, rather than trusting a page's own copy.
 *
 * The case that matters most here is the empty one. A local box, a test, and CI
 * all run with no contract addresses configured; `/config` must still answer,
 * and every consumer must be able to tell "no link" from "broken link".
 */
function boot(env: Record<string, string> = {}) {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '120000', TABLE_SIZE: '4', ...env },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  return buildServer({ db, config, orchestrator }).app;
}

const ESCROW = '0x1111111111111111111111111111111111111111';
const TOURNAMENT = '0x2222222222222222222222222222222222222222';

describe('explorer URLs (D173)', () => {
  it('knows the BSC mainnet and testnet explorers', () => {
    expect(explorerBaseUrl(56)).toBe('https://bscscan.com');
    expect(explorerBaseUrl(97)).toBe('https://testnet.bscscan.com');
  });

  it('returns null for a chain it has no explorer for, rather than guessing a host', () => {
    expect(explorerBaseUrl(31337)).toBeNull();
    expect(explorerUrl(31337, 'tx', '0xabc')).toBeNull();
  });

  it('builds tx and address links', () => {
    expect(explorerUrl(97, 'tx', '0xdead')).toBe('https://testnet.bscscan.com/tx/0xdead');
    expect(explorerUrl(97, 'address', ESCROW)).toBe(`https://testnet.bscscan.com/address/${ESCROW}`);
  });

  it('returns null for a missing value, so an unrecorded tx renders no link', () => {
    // `sessions.commit_tx_hash` is null on every table settled before the chain
    // was wired, and on every table played while the chain was unreachable.
    expect(explorerUrl(97, 'tx', null)).toBeNull();
    expect(explorerUrl(97, 'tx', undefined)).toBeNull();
    expect(explorerUrl(97, 'tx', '')).toBeNull();
  });
});

describe('GET /config publishes the chain (T113)', () => {
  it('reports the chain id, both contract addresses and the explorer origin', async () => {
    const app = boot({
      BSC_CHAIN_ID: '97',
      ESCROW_CONTRACT_ADDRESS: ESCROW,
      TOURNAMENT_CONTRACT_ADDRESS: TOURNAMENT,
    });
    const body = (await app.inject({ method: 'GET', url: '/api/battleground/config' })).json();
    expect(body.chainId).toBe(97);
    expect(body.escrowAddress).toBe(ESCROW);
    expect(body.tournamentAddress).toBe(TOURNAMENT);
    expect(body.explorerBaseUrl).toBe('https://testnet.bscscan.com');
  });

  it('serves nulls, not an error, when no contracts are configured', async () => {
    // The whole point of the null contract: a deployment with no chain wiring is
    // a supported deployment (chain.ts is failure-tolerant by design), and the
    // endpoint every client reads at boot must not be the thing that breaks.
    const app = boot();
    const res = await app.inject({ method: 'GET', url: '/api/battleground/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().escrowAddress).toBeNull();
    expect(res.json().tournamentAddress).toBeNull();
  });

  it('serves a null explorer for a chain nobody publishes one for', async () => {
    const app = boot({ BSC_CHAIN_ID: '31337' });
    const body = (await app.inject({ method: 'GET', url: '/api/battleground/config' })).json();
    expect(body.chainId).toBe(31337);
    expect(body.explorerBaseUrl).toBeNull();
  });

  it('still leaks no secret', async () => {
    const app = boot({ OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32) });
    const keys = Object.keys(
      (await app.inject({ method: 'GET', url: '/api/battleground/config' })).json(),
    );
    expect(keys).not.toContain('operatorPrivateKey');
    expect(keys).not.toContain('bscTestnetRpcUrl');
  });
});
