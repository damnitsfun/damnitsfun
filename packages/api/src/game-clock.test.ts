import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * The game clock (retrospection finding 3).
 *
 * `GAME_TIME_LIMIT_MS` is a flat budget while the time a table can legitimately
 * consume scales with the seat count AND the decision timeout — so two individually
 * reasonable settings can be jointly broken. Staging shipped 4 seats / 30s decisions
 * / 120s game: exactly four missed decisions, i.e. ONE round. A real table burned its
 * full 120s on 8 moves and ended on the points tiebreak with nobody having played.
 */
function orch(env: Record<string, string>): Orchestrator {
  const config = loadConfig({ env });
  return new Orchestrator(openDatabase(':memory:'), config);
}

describe('effectiveGameTimeLimitMs', () => {
  it('widens the limit when the configured value cannot survive one round of silence', () => {
    // The exact staging configuration that produced the defect.
    const o = orch({ DECISION_TIMEOUT_MS: '30000', GAME_TIME_LIMIT_MS: '120000' });

    // 4 seats x 30s = 120s for a SINGLE round — the configured limit to the ms.
    expect(o.effectiveGameTimeLimitMs(4)).toBe(4 * 30_000 * 3);
    expect(o.effectiveGameTimeLimitMs(4)).toBeGreaterThan(120_000);
  });

  it('scales with the seat count, because a bigger table needs longer', () => {
    const o = orch({ DECISION_TIMEOUT_MS: '30000', GAME_TIME_LIMIT_MS: '120000' });
    expect(o.effectiveGameTimeLimitMs(6)).toBeGreaterThan(o.effectiveGameTimeLimitMs(3));
    expect(o.effectiveGameTimeLimitMs(6)).toBe(6 * 30_000 * 3);
  });

  it('leaves a generous configured limit alone', () => {
    // Fast agents, long game budget: the floor is already ample, so nothing changes.
    const o = orch({ DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '600000' });
    expect(o.effectiveGameTimeLimitMs(4)).toBe(600_000); // 4*3000*3 = 36s < 600s
  });

  it('treats 0 rounds as an explicit opt-out, not as a broken setting', () => {
    const o = orch({
      DECISION_TIMEOUT_MS: '30000',
      GAME_TIME_LIMIT_MS: '1000',
      GAME_LIMIT_MIN_ROUNDS: '0',
    });
    // Needed by harnesses that pair a huge decision timeout with a tiny game limit
    // on purpose; the floor would otherwise inflate that pairing into hours.
    expect(o.effectiveGameTimeLimitMs(4)).toBe(1000);
  });

  it('is honoured by /config so the site cannot advertise the wrong number', () => {
    const o = orch({
      DECISION_TIMEOUT_MS: '30000',
      GAME_TIME_LIMIT_MS: '120000',
      TABLE_MAX_SIZE: '6',
      TABLE_MIN_SIZE: '3',
    });
    // What a full table actually plays under — not the 120s floor.
    expect(o.effectiveGameTimeLimitMs(6)).toBe(540_000);
  });
});
