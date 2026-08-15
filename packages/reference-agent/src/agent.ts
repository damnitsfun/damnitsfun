import { BattlegroundClient, BattlegroundError, type Competition, type PaymentRequired } from './client';
import { decide } from './decide';
import { payTournamentEntry } from './wallet';

/**
 * Reference autonomous agent (T17).
 *
 * Uses the public `/api/battleground/*` contract and nothing else — no engine import,
 * no database access. It follows exactly the onboarding sequence documented in
 * `skill.md`, so running it is also the practical proof that the skill file is
 * complete and correct (T16).
 *
 * Run: `yarn workspace reference-agent play -- --name my-agent --base http://localhost:8080`
 */

export interface AgentOptions {
  baseUrl: string;
  displayName: string;
  /**
   * Play as an already-registered agent instead of registering a new one. The
   * demo harness uses this: it registers identities and pays their entry fees
   * with operator tooling (agents never hold keys), then hands each process a
   * key to play with.
   */
  apiKey?: string;
  /**
   * Stop after this many tables. Defaults to **unlimited**: skill.md's
   * "Playing continuously" section makes table-after-table the expected mode, and
   * this agent exists to demonstrate that contract, so it must not stop after one.
   * Pass `0` (or omit) for unlimited; pass a positive count to bound a demo or test.
   */
  tables?: number;
  /** Pause between tables, ms (default 2000) — skill.md asks for a beat, not a tight re-join loop. */
  betweenTablesMs?: number;
  /** Poll interval in ms (default 300). */
  pollMs?: number;
  /** Give up on a table after this long with no progress (default 120s). */
  idleTimeoutMs?: number;
  /**
   * Agent-held wallet (T19). When set alongside `payEntry`, the agent signs its
   * OWN tournament buy-in from this key — the arena never sees it. Without these,
   * the agent only plays free competitions.
   */
  walletPrivateKey?: string;
  rpcUrl?: string;
  /** Authorise spending the buy-in. Off by default: money is never spent unbidden. */
  payEntry?: boolean;
  log?: (message: string) => void;
}

export interface TableResult {
  sessionId: string;
  movesMade: number;
  won: boolean | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickCompetition(competitions: Competition[], authorizedToPay: boolean): Competition | null {
  if (competitions.length === 0) return null;
  // skill.md's stated preference: free tables unless the operator authorised a
  // buy-in — in which case a paid tournament is a valid choice.
  if (authorizedToPay) {
    return (
      competitions.find((c) => c.kind === 'tournament' && c.entryFeeWei !== '0') ??
      competitions.find((c) => c.entryFeeWei === '0') ??
      competitions[0]!
    );
  }
  return competitions.find((c) => c.entryFeeWei === '0') ?? competitions[0]!;
}

/**
 * Ensure the agent has entered `competition` before it joins a table (T19).
 * Returns false when a buy-in is required but not authorised (the caller stops).
 *
 * Classic competitions have no entry step — their per-table fee (if any) is
 * handled at join time. Tournaments are entered once here; a paid one is paid
 * from the agent's own wallet, then retried with the txHash.
 */
async function ensureEntered(
  client: BattlegroundClient,
  competition: Competition,
  options: AgentOptions,
  log: (m: string) => void,
): Promise<boolean> {
  if (competition.kind !== 'tournament') return true;

  try {
    const res = await client.enter(competition.id);
    if (res.warning) log(`[${options.displayName}] ${res.warning}`);
    return true;
  } catch (error) {
    // This competition needs an X-verified owner (sub-spec 09). We cannot claim
    // ourselves — a human must open the claim URL and "Sign in with X" — so we
    // surface the link and stop.
    if (error instanceof BattlegroundError && error.status === 403) {
      const claimUrl =
        (error.body as { claimUrl?: string }).claimUrl ?? (await client.claimStatus()).claimUrl;
      log(`[${options.displayName}] this competition requires a claimed agent. Ask your owner to claim you:`);
      log(`[${options.displayName}]   ${claimUrl}`);
      return false;
    }
    if (!(error instanceof BattlegroundError) || error.status !== 402) throw error;

    const pr = (error.body as { paymentRequired?: PaymentRequired }).paymentRequired;
    if (!options.payEntry || !options.walletPrivateKey || !pr?.contractAddress) {
      log(`[${options.displayName}] tournament buy-in required and not authorised — stopping`);
      return false;
    }

    log(`[${options.displayName}] paying buy-in ${pr.amountWei} wei into ${pr.contractAddress}`);
    const txHash = await payTournamentEntry({
      rpcUrl: options.rpcUrl ?? 'https://bsc-testnet-dataseed.bnbchain.org',
      privateKey: options.walletPrivateKey,
      contractAddress: pr.contractAddress,
      competitionId: pr.competitionId ?? competition.id,
      amountWei: pr.amountWei,
    });
    log(`[${options.displayName}] buy-in tx ${txHash} — retrying entry`);
    await client.enter(competition.id, txHash);
    return true;
  }
}

export async function runAgent(options: AgentOptions): Promise<TableResult[]> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const pollMs = options.pollMs ?? 300;
  // 0 / absent / negative all mean "keep playing" (see AgentOptions.tables).
  const tables = options.tables && options.tables > 0 ? options.tables : Infinity;
  const betweenTablesMs = options.betweenTablesMs ?? 2000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000;

  const client = new BattlegroundClient(
    `${options.baseUrl.replace(/\/$/, '')}/api/battleground`,
    options.apiKey,
  );

  // 1. Register — the key comes back exactly once. When an identity was supplied
  // we reuse it instead (the harness already registered and funded this agent).
  let agentId: string;
  if (options.apiKey) {
    agentId = (await client.me()).agentId;
    log(`[${options.displayName}] playing as ${agentId}`);
  } else {
    agentId = (await client.register(options.displayName)).agentId;
    log(`[${options.displayName}] registered as ${agentId}`);
  }

  // Ownership claim (sub-spec 09): claiming is what makes an agent payout-eligible.
  // We can't claim ourselves — surface the link so the owner can "Sign in with X".
  try {
    const claim = await client.claimStatus();
    if (claim.claimed) {
      log(`[${options.displayName}] claimed by @${claim.owner?.handle ?? '?'} — payout-eligible`);
    } else {
      log(`[${options.displayName}] not yet claimed. To be eligible for prizes, ask your owner to claim you:`);
      log(`[${options.displayName}]   ${claim.claimUrl}`);
    }
  } catch {
    /* claim status is advisory; a failure here must not stop play */
  }

  // On-chain identity (sub-spec 14): the arena issues every agent a custodial
  // wallet at registration. It is where a one-off seasonal Rainbow-Storm jackpot
  // is paid — claimed or not — so it is worth surfacing. Advisory only.
  try {
    const wallet = (await client.me()).walletAddress;
    if (wallet) {
      log(`[${options.displayName}] wallet ${wallet} — a Rainbow Storm pays this a one-off seasonal jackpot`);
    }
  } catch {
    /* wallet address is advisory; a failure here must not stop play */
  }

  const results: TableResult[] = [];

  for (let table = 0; table < tables; table++) {
    // 2. Choose a competition.
    const authorizedToPay = Boolean(options.payEntry && options.walletPrivateKey);
    const competition = pickCompetition(await client.listActiveCompetitions(), authorizedToPay);
    if (!competition) {
      log(`[${options.displayName}] no active competition — stopping`);
      break;
    }

    // 2b. Enter it if needed (pooled tournaments; pays its own buy-in — T19).
    if (!(await ensureEntered(client, competition, options, log))) break;

    // 3. Take a seat.
    let sessionId: string;
    try {
      const joined = await client.join(competition.id);
      sessionId = joined.sessionId;
      // Sub-spec 18: a table now deals at capacity OR on a countdown, so say which
      // we are waiting on rather than printing an unqualified "seated".
      const when =
        joined.status === 'seated'
          ? 'table full — dealing'
          : joined.startsInMs != null
            ? `deals in ${Math.round(joined.startsInMs / 1000)}s`
            : 'waiting for more agents';
      log(`[${options.displayName}] seated at ${sessionId} (${joined.status} — ${when})`);
      // A rebuy is never silent (D102): it is the single most important thing that
      // can happen to this agent's standing, so it goes in the log every time.
      if (joined.rebuy) {
        log(
          `[${options.displayName}] was out of coins — took a rebuy: +${joined.rebuy.granted} ` +
            `(${joined.rebuy.used} used, ${joined.rebuy.remaining} left this season). ` +
            `Rebuys are netted out of the standings, so this buys time, not rank.`,
        );
        if (joined.rebuy.remaining === 0) {
          log(`[${options.displayName}] that was the LAST rebuy — the next bust ends the season.`);
        }
      }
    } catch (error) {
      if (error instanceof BattlegroundError && error.status === 409) {
        // Already seated somewhere — go straight to polling, per skill.md.
        const pending = await client.pendingActions();
        if (pending.length === 0) throw error;
        sessionId = pending[0]!.sessionId;
        log(`[${options.displayName}] already seated at ${sessionId}`);
      } else if (error instanceof BattlegroundError && error.status === 402) {
        // Two different 402s share this status. INSUFFICIENT_COINS is terminal —
        // there is no top-up endpoint, so no amount of retrying or paying helps and
        // the operator has to be told. An unpaid entry fee is merely unauthorised.
        if ((error.body as { error?: string }).error === 'INSUFFICIENT_COINS') {
          // Reached only once the season's rebuys are ALSO gone (sub-spec 18) — the
          // arena bails a broke agent out automatically until then. There is nothing
          // to retry and nothing to pay, so say what actually unblocks it.
          log(
            `[${options.displayName}] out of coins AND out of rebuys for this season — ` +
              `nothing to retry until the next season opens. ` +
              `Stopping after ${results.length} tables.`,
          );
        } else {
          log(`[${options.displayName}] entry fee required and not authorised — stopping`);
        }
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

      // A table that has not been dealt yet is not "quiet" — the arena resolves every
      // lobby, either by dealing it or by reaping and refunding it (sub-spec 18), and
      // it drops out of this list when that happens. Counting the wait toward the idle
      // timeout would make the agent abandon a table that was about to start.
      if (mine.status !== 'in_progress') {
        lastProgressAt = Date.now();
        await sleep(pollMs);
        continue;
      }
      if (!mine.yourTurn) {
        await sleep(pollMs);
        continue;
      }

      const { move, reasoning } = decide(mine.legalMoves);
      try {
        await client.act(sessionId, move, reasoning, `${agentId}-${sessionId}-${step++}`);
        movesMade++;
        lastProgressAt = Date.now();
      } catch (error) {
        if (error instanceof BattlegroundError && (error.status === 410 || error.status === 404)) break;
        if (error instanceof BattlegroundError && error.status === 409) {
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

    // A beat between tables, per skill.md: re-join promptly, but do not hammer.
    if (table + 1 < tables) await sleep(betweenTablesMs);
  }

  return results;
}

function parseArgs(argv: string[]): AgentOptions {
  const get = (flag: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const payEntry = argv.includes('--pay-entry');
  return {
    baseUrl: get('--base', process.env.ARENA_URL ?? 'http://localhost:8080')!,
    // skill.md "Your name": the name is permanent and NOT unique, so an unnamed
    // agent must not fall back to a bare shared label — it takes a random suffix,
    // which is what a fleet launched with one shared instruction should also do.
    displayName: get('--name', `ref-agent-${Math.random().toString(36).slice(2, 7)}`)!,
    apiKey: get('--api-key', process.env.ARENA_API_KEY),
    // 0 = unlimited, and unlimited is the default: an agent that plays one table and
    // exits is the single most common way to misread the contract.
    tables: Number(get('--tables', '0')),
    pollMs: Number(get('--poll', '300')),
    // T19: an agent-held key. Passing --pay-entry authorises spending the buy-in.
    walletPrivateKey: get('--wallet-key', process.env.AGENT_WALLET_KEY),
    rpcUrl: get('--rpc', process.env.BSC_TESTNET_RPC_URL),
    payEntry,
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
export { BattlegroundClient, ArenaClient } from './client';
export const REFERENCE_AGENT_PACKAGE = 'reference-agent';
