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
    // sub-spec 09 defaults: claim URL origin + disabled X login.
    expect(c.publicBaseUrl).toBe('http://localhost:8080');
    expect(c.xClientId).toBeNull();
    expect(c.xScopes).toBe('tweet.read users.read');
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
        TOURNAMENT_CONTRACT_ADDRESS: '0xtourney',
        TOURNAMENT_ENTRY_FEE_WEI: '123',
        SPONSOR_POOL_SEED_WEI: '456',
        JACKPOT_SEED_WEI: '789',
        PAYOUT_SCHEDULE_JSON: '[60,40]',
        PAYOUT_FIELD_FRACTION: '0.25',
        MIN_RANKED_SESSIONS: '3',
        PUBLIC_BASE_URL: 'https://damnits.example',
        X_CLIENT_ID: 'x-client',
        X_CLIENT_SECRET: 'x-secret',
        X_OAUTH_SCOPES: 'tweet.read users.read',
        CLAIM_TOKEN_TTL_MS: '3600000',
        GOOGLE_CLIENT_ID: 'g-client',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GOOGLE_OAUTH_SCOPES: 'openid email profile',
        WEB_SESSION_TTL_MS: '600000',
        SPECTATOR_MODE: 'archive',
        SPECTATOR_DELAY_MS: '15000',
      },
    });
    expect(c).toEqual({
      port: 3000,
      databasePath: '/tmp/x.sqlite',
      publicBaseUrl: 'https://damnits.example',
      xClientId: 'x-client',
      xClientSecret: 'x-secret',
      xScopes: 'tweet.read users.read',
      claimTokenTtlMs: 3600000,
      googleClientId: 'g-client',
      googleClientSecret: 'g-secret',
      googleScopes: 'openid email profile',
      webSessionTtlMs: 600000,
      bscTestnetRpcUrl: 'https://rpc.example',
      bscChainId: 56,
      operatorPrivateKey: '0xdeadbeef',
      escrowContractAddress: '0xabc',
      tournamentContractAddress: '0xtourney',
      tournamentEntryFeeWei: '123',
      sponsorPoolSeedWei: '456',
      jackpotSeedWei: '789',
      payoutSchedule: [60, 40],
      payoutFieldFraction: 0.25,
      minRankedSessions: 3,
      decisionTimeoutMs: 1000,
      gameTimeLimitMs: 60000,
      rainbowStormChance: 0.5,
      tableSize: 2,
      spectatorMode: 'archive',
      spectatorDelayMs: 15000,
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
