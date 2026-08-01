/**
 * Typed environment / configuration loader (parent spec §9).
 *
 * Single source of truth for every §9 variable. Uses Node 24's built-in
 * `process.loadEnvFile()` (no dotenv dependency) to hydrate `.env`, then parses
 * and validates each variable into a typed, frozen config object.
 *
 * A missing REQUIRED variable (one with no default) fails fast with a clear
 * error naming the variable. Secrets (OPERATOR_PRIVATE_KEY) are only required
 * when `requireSecrets` is set — foundation/dev runs don't need them, but
 * settlement code paths (sub-spec 05) will opt in.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertValidCurve } from './payout';

export interface Config {
  /** api */
  port: number;
  databasePath: string;
  /**
   * Publicly reachable origin of this server, used to build the claim URL and the
   * X OAuth redirect URI (sub-spec 09). Must match the callback registered in the
   * X developer app. Defaults to `http://localhost:<port>` for local runs.
   */
  publicBaseUrl: string;
  /** "Sign in with X" identity (sub-spec 09). Absent → claim/link is disabled. */
  xClientId: string | null;
  xClientSecret: string | null;
  xScopes: string;
  claimTokenTtlMs: number;
  /** Google web sign-in (sub-spec 11). Absent → web login is disabled. */
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleScopes: string;
  webSessionTtlMs: number;
  /** chain (api + contracts) */
  bscTestnetRpcUrl: string;
  bscChainId: number;
  operatorPrivateKey: string | null;
  escrowContractAddress: string | null;
  /** pooled tournament + jackpot (sub-spec 08, §9 additions) */
  tournamentContractAddress: string | null;
  tournamentEntryFeeWei: string;
  sponsorPoolSeedWei: string;
  jackpotSeedWei: string;
  payoutSchedule: number[];
  payoutFieldFraction: number;
  minRankedSessions: number;
  /** orchestration / engine tunables */
  decisionTimeoutMs: number;
  gameTimeLimitMs: number;
  rainbowStormChance: number;
  tableSize: number;
  /** playground coin economy (sub-spec 12) */
  startingCoins: number;
  playgroundEntryCoins: number;
  /** playground on-chain Rainbow-Storm jackpot seed, in wei (sub-spec 14). 0 = unfunded. */
  playgroundJackpotSeedWei: string;
  /**
   * Secret (sub-spec 14): symmetric key that encrypts custodial agent wallet keys
   * at rest. Blank/null disables auto-wallets (agents register walletless; a storm
   * is recorded but not paid). Never commit — treat like OPERATOR_PRIVATE_KEY.
   */
  walletEncryptionKey: string | null;
  /** spectator (sub-spec 10). The public feed only ever serves finished sessions. */
  spectatorMode: SpectatorMode;
  spectatorDelayMs: number;
}

/**
 * `delayed` (default, arena parity): the UI auto-airs the most-recently-finished
 * session as a continuously-advancing replay. `archive`: on-demand browsing only.
 * Neither ever exposes an in-progress table — both replay only finished sessions.
 */
export type SpectatorMode = 'delayed' | 'archive';

export interface LoadConfigOptions {
  /** Env source. Defaults to `process.env`. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** When true, secret vars (OPERATOR_PRIVATE_KEY) become required. Default false. */
  requireSecrets?: boolean;
  /** Path to a `.env` file to load first. Default `.env` at repo root / cwd. */
  envFile?: string;
}

class ConfigError extends Error {
  override name = 'ConfigError';
}

function requireVar(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === '') {
    throw new ConfigError(
      `Missing required environment variable ${key}. See .env.example and set it in .env.`,
    );
  }
  return raw;
}

function withDefault(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  return raw === undefined || raw === '' ? null : raw;
}

function toInt(key: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new ConfigError(`Environment variable ${key} must be an integer, got "${value}".`);
  }
  return n;
}

function toFloat(key: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`Environment variable ${key} must be a number, got "${value}".`);
  }
  return n;
}

function parseSpectatorMode(value: string): SpectatorMode {
  if (value !== 'delayed' && value !== 'archive') {
    throw new ConfigError(`SPECTATOR_MODE must be "delayed" or "archive", got "${value}".`);
  }
  return value;
}

/** Parse and validate the PAYOUT_SCHEDULE_JSON base curve (must sum to 100). */
function parseCurve(value: string): number[] {
  let curve: unknown;
  try {
    curve = JSON.parse(value);
  } catch {
    throw new ConfigError(`PAYOUT_SCHEDULE_JSON must be a JSON array, got "${value}".`);
  }
  if (!Array.isArray(curve) || curve.some((w) => typeof w !== 'number')) {
    throw new ConfigError('PAYOUT_SCHEDULE_JSON must be a JSON array of numbers.');
  }
  try {
    assertValidCurve(curve as number[]);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
  return curve as number[];
}

/**
 * Load and validate configuration. Idempotent and side-effect-light: reading
 * `.env` is best-effort (skipped if absent). Throws {@link ConfigError} on any
 * missing-required or unparseable value.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const envFile = options.envFile ?? resolve(process.cwd(), '.env');
  // Only load from disk when no explicit env source is injected (tests inject).
  if (!options.env && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const env = options.env ?? process.env;

  const port = toInt('PORT', withDefault(env, 'PORT', '8080'));

  const config: Config = {
    port,
    databasePath: withDefault(env, 'DATABASE_PATH', './data/damnits.sqlite'),
    publicBaseUrl: withDefault(env, 'PUBLIC_BASE_URL', `http://localhost:${port}`).replace(/\/$/, ''),
    xClientId: optional(env, 'X_CLIENT_ID'),
    xClientSecret: optional(env, 'X_CLIENT_SECRET'),
    xScopes: withDefault(env, 'X_OAUTH_SCOPES', 'tweet.read users.read'),
    claimTokenTtlMs: toInt('CLAIM_TOKEN_TTL_MS', withDefault(env, 'CLAIM_TOKEN_TTL_MS', '86400000')),
    googleClientId: optional(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: optional(env, 'GOOGLE_CLIENT_SECRET'),
    googleScopes: withDefault(env, 'GOOGLE_OAUTH_SCOPES', 'openid email profile'),
    webSessionTtlMs: toInt('WEB_SESSION_TTL_MS', withDefault(env, 'WEB_SESSION_TTL_MS', '2592000000')),
    bscTestnetRpcUrl: withDefault(
      env,
      'BSC_TESTNET_RPC_URL',
      'https://bsc-testnet-dataseed.bnbchain.org',
    ),
    bscChainId: toInt('BSC_CHAIN_ID', withDefault(env, 'BSC_CHAIN_ID', '97')),
    operatorPrivateKey: options.requireSecrets
      ? requireVar(env, 'OPERATOR_PRIVATE_KEY')
      : optional(env, 'OPERATOR_PRIVATE_KEY'),
    escrowContractAddress: optional(env, 'ESCROW_CONTRACT_ADDRESS'),
    tournamentContractAddress: optional(env, 'TOURNAMENT_CONTRACT_ADDRESS'),
    tournamentEntryFeeWei: withDefault(env, 'TOURNAMENT_ENTRY_FEE_WEI', '500000000000000'),
    sponsorPoolSeedWei: withDefault(env, 'SPONSOR_POOL_SEED_WEI', '0'),
    jackpotSeedWei: withDefault(env, 'JACKPOT_SEED_WEI', '50000000000000000'),
    payoutSchedule: parseCurve(
      withDefault(env, 'PAYOUT_SCHEDULE_JSON', '[30,20,14,10,8,6,4.5,3,2.5,2]'),
    ),
    payoutFieldFraction: toFloat(
      'PAYOUT_FIELD_FRACTION',
      withDefault(env, 'PAYOUT_FIELD_FRACTION', '0.20'),
    ),
    minRankedSessions: toInt('MIN_RANKED_SESSIONS', withDefault(env, 'MIN_RANKED_SESSIONS', '10')),
    decisionTimeoutMs: toInt('DECISION_TIMEOUT_MS', withDefault(env, 'DECISION_TIMEOUT_MS', '3000')),
    gameTimeLimitMs: toInt('GAME_TIME_LIMIT_MS', withDefault(env, 'GAME_TIME_LIMIT_MS', '120000')),
    rainbowStormChance: toFloat(
      'RAINBOW_STORM_CHANCE',
      withDefault(env, 'RAINBOW_STORM_CHANCE', '0.00001'),
    ),
    tableSize: toInt('TABLE_SIZE', withDefault(env, 'TABLE_SIZE', '4')),
    startingCoins: toInt('STARTING_COINS', withDefault(env, 'STARTING_COINS', '1000')),
    playgroundEntryCoins: toInt(
      'PLAYGROUND_ENTRY_COINS',
      withDefault(env, 'PLAYGROUND_ENTRY_COINS', '10'),
    ),
    playgroundJackpotSeedWei: withDefault(env, 'PLAYGROUND_JACKPOT_SEED_WEI', '0'),
    walletEncryptionKey: optional(env, 'WALLET_ENCRYPTION_KEY'),
    spectatorMode: parseSpectatorMode(withDefault(env, 'SPECTATOR_MODE', 'delayed')),
    spectatorDelayMs: toInt('SPECTATOR_DELAY_MS', withDefault(env, 'SPECTATOR_DELAY_MS', '0')),
  };

  return Object.freeze(config);
}

export { ConfigError };
