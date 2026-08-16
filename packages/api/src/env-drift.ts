/**
 * Detect a `.env` that is pinning a value the code has since moved on from.
 *
 * This exists because the same failure shipped three times in one day. A tunable
 * gets a new default in code, the change is reviewed, merged and deployed — and
 * does nothing, because every server's `.env` was copied from `.env.example`
 * months earlier and still sets the old value explicitly. An explicit `.env`
 * entry always wins, so the deploy is green and the behaviour is unchanged:
 *
 *   TABLE_SIZE=4              pinned both new seat bounds to 4 (twice)
 *   RAINBOW_STORM_CHANCE=1e-5 pinned the storm to "never" after it was retuned
 *
 * Nothing was broken in any of those cases, which is exactly what made them
 * expensive: the only symptom was that a fix silently had no effect.
 *
 * Only TUNABLES are checked. Secrets, per-environment values (ports, paths,
 * origins, contract addresses) and anything with no meaningful code default are
 * deliberately excluded — they are *supposed* to differ, and warning about them
 * would train everyone to ignore the output.
 */

/** Env vars whose code default is the intended value unless deliberately tuned. */
export const DRIFT_CHECKED_VARS = [
  'DECISION_TIMEOUT_MS',
  'GAME_TIME_LIMIT_MS',
  'GAME_LIMIT_MIN_ROUNDS',
  'RAINBOW_STORM_CHANCE',
  'TABLE_SIZE',
  'TABLE_MIN_SIZE',
  'TABLE_MAX_SIZE',
  'LOBBY_COUNTDOWN_MS',
  'LOBBY_ABANDON_MS',
  'STARTING_COINS',
  'PLAYGROUND_ENTRY_COINS',
  'REBUY_LIMIT',
  'REBUY_COINS',
  'MIN_RANKED_SESSIONS',
  'PAYOUT_FIELD_FRACTION',
  'SPECTATOR_DELAY_MS',
] as const;

/**
 * `TABLE_SIZE` is not merely stale — it is a legacy name that silently pins BOTH
 * new bounds. Worth calling out separately from an ordinary override.
 */
const SUPERSEDED: Readonly<Record<string, string>> = {
  TABLE_SIZE: 'superseded by TABLE_MIN_SIZE / TABLE_MAX_SIZE — it pins BOTH bounds to one value',
};

export interface DriftFinding {
  key: string;
  envValue: string;
  codeDefault: string;
  superseded?: string;
}

/**
 * Compare an env source against the code defaults.
 *
 * `defaults` is the config the loader produces from an EMPTY environment, mapped
 * back to env-var names by the caller — this module deliberately does not import
 * the config loader, so it stays usable from a deploy script without pulling in
 * chain clients and the rest of the server.
 */
export function findEnvDrift(
  env: Record<string, string | undefined>,
  defaults: Record<string, string>,
): DriftFinding[] {
  const findings: DriftFinding[] = [];
  for (const key of DRIFT_CHECKED_VARS) {
    const envValue = env[key];
    if (envValue === undefined || envValue === '') continue; // not pinned — fine
    const codeDefault = defaults[key];
    if (codeDefault === undefined) continue; // no comparable default

    // Compare numerically where both look numeric, so "0.0006" and "6e-4" — or
    // "120000" and "120000.0" — do not read as a difference.
    const a = Number(envValue);
    const b = Number(codeDefault);
    const same = Number.isFinite(a) && Number.isFinite(b) ? a === b : envValue === codeDefault;
    if (same && !SUPERSEDED[key]) continue;

    findings.push({
      key,
      envValue,
      codeDefault,
      ...(SUPERSEDED[key] ? { superseded: SUPERSEDED[key] } : {}),
    });
  }
  return findings;
}

/** Human-readable report. Empty string when there is nothing to say. */
export function formatDrift(findings: DriftFinding[], environment: string): string {
  if (findings.length === 0) return '';
  const lines = [
    `.env drift — ${environment}: ${findings.length} tunable(s) pinned to a value the code no longer defaults to.`,
    `These are NOT errors. But a code change to any of them will have NO effect here until the`,
    `.env line is removed or updated, which is how three fixes shipped inert in one day.`,
    '',
  ];
  for (const f of findings) {
    lines.push(`  ${f.key}`);
    lines.push(`      .env = ${f.envValue}   code default = ${f.codeDefault}`);
    if (f.superseded) lines.push(`      NOTE: ${f.superseded}`);
  }
  return lines.join('\n');
}
