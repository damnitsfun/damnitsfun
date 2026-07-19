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

export interface Config {
  /** api */
  port: number;
  databasePath: string;
  /** chain (api + contracts) */
  bscTestnetRpcUrl: string;
  bscChainId: number;
  operatorPrivateKey: string | null;
  escrowContractAddress: string | null;
  /** orchestration / engine tunables */
  decisionTimeoutMs: number;
  gameTimeLimitMs: number;
  rainbowStormChance: number;
  tableSize: number;
}

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

  const config: Config = {
    port: toInt('PORT', withDefault(env, 'PORT', '8080')),
    databasePath: withDefault(env, 'DATABASE_PATH', './data/damnits.sqlite'),
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
    decisionTimeoutMs: toInt('DECISION_TIMEOUT_MS', withDefault(env, 'DECISION_TIMEOUT_MS', '3000')),
    gameTimeLimitMs: toInt('GAME_TIME_LIMIT_MS', withDefault(env, 'GAME_TIME_LIMIT_MS', '120000')),
    rainbowStormChance: toFloat(
      'RAINBOW_STORM_CHANCE',
      withDefault(env, 'RAINBOW_STORM_CHANCE', '0.00001'),
    ),
    tableSize: toInt('TABLE_SIZE', withDefault(env, 'TABLE_SIZE', '4')),
  };

  return Object.freeze(config);
}

export { ConfigError };
