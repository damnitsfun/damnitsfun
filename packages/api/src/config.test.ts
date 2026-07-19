import { loadConfig, ConfigError } from './config';

describe('config loader (spec §9)', () => {
  it('applies non-secret defaults when env is empty', () => {
    const c = loadConfig({ env: {} });
    expect(c.port).toBe(8080);
    expect(c.databasePath).toBe('./data/damnits.sqlite');
    expect(c.bscChainId).toBe(97);
    expect(c.decisionTimeoutMs).toBe(3000);
    expect(c.gameTimeLimitMs).toBe(120000);
    expect(c.rainbowStormChance).toBeCloseTo(0.00001);
    expect(c.tableSize).toBe(4);
  });

  it('reads every §9 variable from the env source', () => {
    const c = loadConfig({
      env: {
        PORT: '3000',
        DATABASE_PATH: '/tmp/x.sqlite',
        BSC_TESTNET_RPC_URL: 'https://rpc.example',
        BSC_CHAIN_ID: '56',
        OPERATOR_PRIVATE_KEY: '0xdeadbeef',
        ESCROW_CONTRACT_ADDRESS: '0xabc',
        DECISION_TIMEOUT_MS: '1000',
        GAME_TIME_LIMIT_MS: '60000',
        RAINBOW_STORM_CHANCE: '0.5',
        TABLE_SIZE: '2',
      },
    });
    expect(c).toEqual({
      port: 3000,
      databasePath: '/tmp/x.sqlite',
      bscTestnetRpcUrl: 'https://rpc.example',
      bscChainId: 56,
      operatorPrivateKey: '0xdeadbeef',
      escrowContractAddress: '0xabc',
      decisionTimeoutMs: 1000,
      gameTimeLimitMs: 60000,
      rainbowStormChance: 0.5,
      tableSize: 2,
    });
  });

  it('treats secrets as optional by default (null when absent)', () => {
    const c = loadConfig({ env: {} });
    expect(c.operatorPrivateKey).toBeNull();
    expect(c.escrowContractAddress).toBeNull();
  });

  it('fails fast with a clear error when a required secret is missing', () => {
    expect(() => loadConfig({ env: {}, requireSecrets: true })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, requireSecrets: true })).toThrow(/OPERATOR_PRIVATE_KEY/);
  });

  it('rejects a non-integer numeric var with a clear error', () => {
    expect(() => loadConfig({ env: { PORT: 'not-a-number' } })).toThrow(/PORT/);
  });

  it('returns a frozen object', () => {
    const c = loadConfig({ env: {} });
    expect(Object.isFrozen(c)).toBe(true);
  });
});
