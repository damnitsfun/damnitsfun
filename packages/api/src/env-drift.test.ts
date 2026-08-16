import { findEnvDrift, formatDrift, DRIFT_CHECKED_VARS } from './env-drift';

/**
 * The drift guard exists because of three real incidents in one day, so the tests
 * are those incidents rather than invented cases.
 */
describe('env drift', () => {
  const defaults = {
    TABLE_MIN_SIZE: '3',
    TABLE_MAX_SIZE: '6',
    TABLE_SIZE: '6',
    RAINBOW_STORM_CHANCE: '0.0006',
    DECISION_TIMEOUT_MS: '3000',
    STARTING_COINS: '1000',
  };

  it('catches the storm probability that shipped inert', () => {
    // Deployed 0.0006 in code; every server .env still said 0.00001 and won.
    const found = findEnvDrift({ RAINBOW_STORM_CHANCE: '0.00001' }, defaults);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: 'RAINBOW_STORM_CHANCE',
      envValue: '0.00001',
      codeDefault: '0.0006',
    });
  });

  it('catches a legacy TABLE_SIZE even when it equals the code default', () => {
    // The subtle one: TABLE_SIZE=6 "matches" tableMaxSize, but setting it AT ALL
    // pins the minimum too, silently disabling 3-6 seating.
    const found = findEnvDrift({ TABLE_SIZE: '6' }, defaults);
    expect(found).toHaveLength(1);
    expect(found[0]!.superseded).toMatch(/pins BOTH bounds/);
  });

  it('stays quiet when the .env follows the code', () => {
    expect(findEnvDrift({ TABLE_MIN_SIZE: '3', TABLE_MAX_SIZE: '6' }, defaults)).toEqual([]);
    expect(findEnvDrift({}, defaults)).toEqual([]);
  });

  it('does not report a value that only differs in formatting', () => {
    // 6e-4 and 0.0006 are the same number; flagging that would be noise, and
    // noise is how a warning gets ignored.
    expect(findEnvDrift({ RAINBOW_STORM_CHANCE: '6e-4' }, defaults)).toEqual([]);
    expect(findEnvDrift({ DECISION_TIMEOUT_MS: '3000.0' }, defaults)).toEqual([]);
  });

  it('ignores secrets and per-environment values entirely', () => {
    const noisy = {
      OPERATOR_PRIVATE_KEY: '0xdeadbeef',
      DATABASE_PATH: '/opt/damnits/production/data/damnits.sqlite',
      PORT: '8081',
      PUBLIC_BASE_URL: 'https://damnits.fun',
      ESCROW_CONTRACT_ADDRESS: '0xabc',
    };
    expect(findEnvDrift(noisy, defaults)).toEqual([]);
    for (const k of Object.keys(noisy)) {
      expect(DRIFT_CHECKED_VARS as readonly string[]).not.toContain(k);
    }
  });

  it('reports every real incident from the day it was written', () => {
    const staging = { TABLE_SIZE: '4', RAINBOW_STORM_CHANCE: '0.00001' };
    const found = findEnvDrift(staging, defaults);
    expect(found.map((f) => f.key).sort()).toEqual(['RAINBOW_STORM_CHANCE', 'TABLE_SIZE']);
    const report = formatDrift(found, 'staging');
    expect(report).toContain('TABLE_SIZE');
    expect(report).toContain('RAINBOW_STORM_CHANCE');
    expect(report).toContain('NOT errors');       // advisory, never fails a deploy
  });

  it('says so plainly when there is no drift', () => {
    expect(formatDrift([], 'production')).toBe('');
  });

  it('finds drift from a source that is not process.env', () => {
    // The first version of the deploy hook read process.env, but only systemd
    // loads the EnvironmentFile — so the check saw an almost-empty environment
    // and cheerfully reported "no drift" on a server that had some. A guard
    // against silently-inert changes, itself silently inert. The checker takes
    // its source as an argument precisely so the caller can hand it the FILE.
    const parsedFromFile = { DECISION_TIMEOUT_MS: '30000', RAINBOW_STORM_CHANCE: '0.00001' };
    const found = findEnvDrift(parsedFromFile, defaults);
    expect(found.map((f) => f.key).sort()).toEqual(['DECISION_TIMEOUT_MS', 'RAINBOW_STORM_CHANCE']);
  });
});
