/**
 * `node dist/check-env-drift.js` — deploy-time warning for a stale `.env`.
 *
 * Run from `remote-deploy.sh` after the build. Always exits 0: a pinned tunable
 * is a legitimate choice, and a deploy must never fail because someone
 * deliberately overrode one. The point is that the override becomes VISIBLE at
 * the moment it would otherwise silently swallow a change.
 */
import { loadConfig } from './config';
import { findEnvDrift, formatDrift } from './env-drift';

/**
 * The code defaults, expressed as env-var strings. Derived from a config loaded
 * with an EMPTY environment, so this cannot drift from the loader itself.
 */
function codeDefaults(): Record<string, string> {
  const d = loadConfig({ env: {} });
  return {
    DECISION_TIMEOUT_MS: String(d.decisionTimeoutMs),
    GAME_TIME_LIMIT_MS: String(d.gameTimeLimitMs),
    GAME_LIMIT_MIN_ROUNDS: String(d.gameLimitMinRounds),
    RAINBOW_STORM_CHANCE: String(d.rainbowStormChance),
    // TABLE_SIZE has no default of its own any more — it is the legacy alias.
    // Compare it against the max so a lingering `TABLE_SIZE=4` is reported.
    TABLE_SIZE: String(d.tableMaxSize),
    TABLE_MIN_SIZE: String(d.tableMinSize),
    TABLE_MAX_SIZE: String(d.tableMaxSize),
    LOBBY_COUNTDOWN_MS: String(d.lobbyCountdownMs),
    LOBBY_ABANDON_MS: String(d.lobbyAbandonMs),
    STARTING_COINS: String(d.startingCoins),
    PLAYGROUND_ENTRY_COINS: String(d.playgroundEntryCoins),
    REBUY_LIMIT: String(d.rebuyLimit),
    REBUY_COINS: String(d.rebuyCoins),
    MIN_RANKED_SESSIONS: String(d.minRankedSessions),
    PAYOUT_FIELD_FRACTION: String(d.payoutFieldFraction),
    SPECTATOR_DELAY_MS: String(d.spectatorDelayMs),
  };
}

function main(): void {
  const environment = process.env.ENV_NAME ?? 'this environment';
  const findings = findEnvDrift(process.env, codeDefaults());
  const report = formatDrift(findings, environment);
  if (report) {
    process.stdout.write(`\n${report}\n\n`);
  } else {
    process.stdout.write(`.env drift — ${environment}: none. Every tunable follows the code default.\n`);
  }
}

main();
