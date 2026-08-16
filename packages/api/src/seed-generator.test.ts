import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { newApiKey, newSeed } from './ids';
import { Orchestrator } from './orchestrator';
import { getPublicSession } from './routes/spectate';

/**
 * Shuffle seeds must not look like API keys.
 *
 * A seed is PUBLISHED — revealed on the public spectator feed at settlement so
 * anyone can re-derive the deal and check the commitment. An API key is the one
 * string that must never be. Both came from `newApiKey()`, so every settled game
 * emitted a public `damnits_sk_...` value: a leaked key could not be told from a
 * published seed by inspection, and a secret scanner could not either.
 *
 * Measured before the fix: 54 of 54 settled staging sessions published one.
 */
describe('seed generation (retrospection finding 5)', () => {
  it('does not mint seeds from the API-key namespace', () => {
    for (let i = 0; i < 200; i++) {
      const seed = newSeed();
      expect(seed.startsWith('damnits_sk_')).toBe(false);
      expect(seed.startsWith('damnits_seed_')).toBe(true);
    }
  });

  it('keeps the entropy that the commit-reveal depends on', () => {
    const seeds = new Set(Array.from({ length: 2000 }, () => newSeed()));
    expect(seeds.size).toBe(2000); // no collisions
    // Same shape as the key it replaced: 32 hex UUID chars + 8 id chars.
    expect(newSeed().length).toBe('damnits_seed_'.length + 40);
    expect(newSeed().length).toBeGreaterThan(newApiKey().length - 12);
  });

  it('publishes a seed that is not credential-shaped once a table settles', async () => {
    const config = loadConfig({
      env: {
        TABLE_MIN_SIZE: '2',
        TABLE_MAX_SIZE: '2',
        DECISION_TIMEOUT_MS: '1',
        GAME_LIMIT_MIN_ROUNDS: '0',
        GAME_TIME_LIMIT_MS: '1',
      },
    });
    const db = openDatabase(':memory:');
    let clock = 1_700_000_000_000;
    const o = new Orchestrator(db, config, { clock: () => clock });
    const competitionId = o.createCompetition('Seed Check');

    const a = o.registerAgent('a');
    const b = o.registerAgent('b');
    await o.joinSession(a.agentId, competitionId);
    const joined = await o.joinSession(b.agentId, competitionId);

    // Run the clock out so the table settles and the seed is revealed.
    clock += 60_000;
    o.tick();

    const published = getPublicSession(db, joined.sessionId);
    expect(published.status).toBe('ok');           // settled, so publicly readable
    const reveal = published.status === 'ok' ? published.summary.seedReveal : null;
    expect(reveal).toBeTruthy();
    // The whole point: what reaches the public feed must not read as a secret.
    expect(reveal!.startsWith('damnits_sk_')).toBe(false);
    expect(reveal!.startsWith('damnits_seed_')).toBe(true);
  });
});
