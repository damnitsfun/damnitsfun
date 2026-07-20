import { ArenaClient, ArenaError, type Competition } from './client';
import { decide } from './decide';

/**
 * Reference autonomous agent (T17).
 *
 * Uses the public `/api/arena/*` contract and nothing else — no engine import,
 * no database access. It follows exactly the onboarding sequence documented in
 * `skill.md`, so running it is also the practical proof that the skill file is
 * complete and correct (T16).
 *
 * Run: `yarn workspace reference-agent play -- --name my-agent --base http://localhost:8080`
 */

export interface AgentOptions {
  baseUrl: string;
  displayName: string;
  /** Stop after this many tables (default 1). */
  tables?: number;
  /** Poll interval in ms (default 300). */
  pollMs?: number;
  /** Give up on a table after this long with no progress (default 120s). */
  idleTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface TableResult {
  sessionId: string;
  movesMade: number;
  won: boolean | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickCompetition(competitions: Competition[]): Competition | null {
  if (competitions.length === 0) return null;
  // skill.md's stated preference: free tables unless told otherwise.
  return competitions.find((c) => c.entryFeeWei === '0') ?? competitions[0]!;
}

export async function runAgent(options: AgentOptions): Promise<TableResult[]> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const pollMs = options.pollMs ?? 300;
  const tables = options.tables ?? 1;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;

  const client = new ArenaClient(`${options.baseUrl.replace(/\/$/, '')}/api/arena`);

  // 1. Register — the key comes back exactly once.
  const { agentId } = await client.register(options.displayName);
  log(`[${options.displayName}] registered as ${agentId}`);

  const results: TableResult[] = [];

  for (let table = 0; table < tables; table++) {
    // 2. Choose a competition.
    const competition = pickCompetition(await client.listActiveCompetitions());
    if (!competition) {
      log(`[${options.displayName}] no active competition — stopping`);
      break;
    }

    // 3. Take a seat.
    let sessionId: string;
    try {
      const joined = await client.join(competition.id);
      sessionId = joined.sessionId;
      log(`[${options.displayName}] seated at ${sessionId} (${joined.status})`);
    } catch (error) {
      if (error instanceof ArenaError && error.status === 409) {
        // Already seated somewhere — go straight to polling, per skill.md.
        const pending = await client.pendingActions();
        if (pending.length === 0) throw error;
        sessionId = pending[0]!.sessionId;
        log(`[${options.displayName}] already seated at ${sessionId}`);
      } else if (error instanceof ArenaError && error.status === 402) {
        log(`[${options.displayName}] entry fee required and not authorised — stopping`);
        break;
      } else {
        throw error;
      }
    }

    // 4. Poll and act until the table leaves our pending list.
    let movesMade = 0;
    let step = 0;
    const startedAt = Date.now();
    let lastProgressAt = Date.now();

    for (;;) {
      if (Date.now() - lastProgressAt > idleTimeoutMs) {
        log(`[${options.displayName}] table ${sessionId} went quiet — moving on`);
        break;
      }

      let pending;
      try {
        pending = await client.pendingActions();
      } catch (error) {
        log(`[${options.displayName}] poll failed: ${String(error)}`);
        await sleep(pollMs);
        continue;
      }

      const mine = pending.find((s) => s.sessionId === sessionId);
      // 5. Gone from the pending list -> the table has ended. A table that has
      // not started yet is still listed (status 'lobby'), so absence is
      // unambiguous and we never mistake "waiting to fill" for "finished".
      if (!mine) break;

      if (mine.status !== 'in_progress' || !mine.yourTurn) {
        await sleep(pollMs);
        continue;
      }

      const { move, reasoning } = decide(mine.legalMoves);
      try {
        await client.act(sessionId, move, reasoning, `${agentId}-${sessionId}-${step++}`);
        movesMade++;
        lastProgressAt = Date.now();
      } catch (error) {
        if (error instanceof ArenaError && (error.status === 410 || error.status === 404)) break;
        if (error instanceof ArenaError && error.status === 409) {
          // Someone else moved first (or the arena auto-acted) — just re-poll.
          await sleep(pollMs);
          continue;
        }
        throw error;
      }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`[${options.displayName}] table ${sessionId} done — ${movesMade} moves in ${elapsed}s`);
    results.push({ sessionId, movesMade, won: null });
  }

  return results;
}

function parseArgs(argv: string[]): AgentOptions {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    baseUrl: get('--base', process.env.ARENA_URL ?? 'http://localhost:8080')!,
    displayName: get('--name', `ref-agent-${Math.random().toString(36).slice(2, 7)}`)!,
    tables: Number(get('--tables', '1')),
    pollMs: Number(get('--poll', '300')),
  };
}

if (require.main === module) {
  runAgent(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exit(1);
    });
}

export { decide } from './decide';
export { ArenaClient } from './client';
export const REFERENCE_AGENT_PACKAGE = 'reference-agent';
