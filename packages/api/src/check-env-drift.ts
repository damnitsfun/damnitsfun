/**
 * `node dist/check-env-drift.js` — deploy-time warning for a stale `.env`.
 *
 * Run from `remote-deploy.sh` after the build. Always exits 0: a pinned tunable
 * is a legitimate choice, and a deploy must never fail because someone
 * deliberately overrode one. The point is that the override becomes VISIBLE at
 * the moment it would otherwise silently swallow a change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import { findEnvDrift, formatDrift } from './env-drift';

/**
 * Read the .env FILE rather than trusting process.env.
 *
 * The deploy runs this as an ad-hoc command, and only the systemd unit loads the
 * EnvironmentFile — so process.env is nearly empty here and the check found
 * "no drift" on an environment that had some. A guard against silently-inert
 * changes that was itself silently inert.
 */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, as dotenv does.
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

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
  // The file is the source of truth for what this deployment pins; process.env
  // only fills in when the check is run somewhere that already has it loaded.
  const envPath = process.env.ENV_FILE ?? join(process.cwd(), '.env');
  const fromFile = readEnvFile(envPath);
  const source = { ...process.env, ...fromFile };
  if (Object.keys(fromFile).length === 0) {
    process.stdout.write(`  (no .env read at ${envPath}; checking process env only)\n`);
  }
  const findings = findEnvDrift(source, codeDefaults());
  const report = formatDrift(findings, environment);
  if (report) {
    process.stdout.write(`\n${report}\n\n`);
  } else {
    process.stdout.write(`.env drift — ${environment}: none. Every tunable follows the code default.\n`);
  }
}

main();
