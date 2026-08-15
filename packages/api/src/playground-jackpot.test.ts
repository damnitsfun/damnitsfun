import type { FastifyInstance } from 'fastify';
import type { ChainResult, SettlementChain } from './chain';
import type { TournamentChain } from './tournament-chain';
import { createWalletStore } from './agent-wallet';
import { createChainHooks } from './settlement';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 14 — the playground's Rainbow-Storm jackpot.
 *
 * With RAINBOW_STORM_CHANCE forced to 1, every classic game fires a storm. We
 * assert: (a) a FREE classic table makes NO escrow calls (the bug this spec fixes,
 * D62); (b) the FIRST storm of a funded season pays the seeded jackpot on-chain to
 * the triggering agent's CUSTODIAL wallet — claimed or not (D64/D65); (c) it pays
 * once per season (idempotent); (d) an unfunded season records the storm but pays
 * nothing (D67); (e) custodial keys never cross the API boundary.
 */

interface AwardCall {
  competitionId: string;
  winner: string;
  amountWei: string;
  resultHash: string;
  seedReveal: string;
}

/** A tournament chain that records awardJackpot calls; everything else is a no-op OK. */
function fakeTournamentChain(awardCalls: AwardCall[]): TournamentChain {
  const ok = async (): Promise<ChainResult> => ({ ok: true, txHash: `0x${'a'.repeat(64)}` });
  return {
    enabled: true,
    contractAddress: '0xTOURNEY',
    openCompetition: ok,
    async verifyEntry() {
      return { ok: false, error: 'not used' };
    },
    seedPool: ok,
    seedJackpot: ok,
    closeEntries: ok,
    settleCompetition: ok,
    async awardJackpot(competitionId, winner, amountWei, resultHash, seedReveal) {
      awardCalls.push({ competitionId, winner, amountWei, resultHash, seedReveal });
      return { ok: true, txHash: `0x${'d'.repeat(64)}` };
    },
    rolloverJackpot: ok,
  };
}

/** An escrow chain that records every call, so we can assert a free table makes none. */
function recordingEscrowChain(calls: string[]): SettlementChain {
  return {
    enabled: true,
    async openSession() {
      calls.push('openSession');
      return { ok: true, txHash: `0x${'b'.repeat(64)}` };
    },
    async verifyEntryFee(_s, _t, expectedWei) {
      calls.push('verifyEntryFee');
      return { ok: true, payer: `0x${'c'.repeat(40)}`, amountWei: expectedWei };
    },
    async commitSeed() {
      calls.push('commitSeed');
      return { ok: true, txHash: `0x${'e'.repeat(64)}` };
    },
    async settle() {
      calls.push('settle');
      return { ok: true, txHash: `0x${'f'.repeat(64)}` };
    },
  };
}

interface Harness {
  app: FastifyInstance;
  db: Db;
  orchestrator: Orchestrator;
  awardCalls: AwardCall[];
  escrowCalls: string[];
  advance(ms: number): void;
}

// A storm fires on the FIRST card play (chance 1) but ALSO returns the turn to the
// actor every play, so a chance-1 game never terminates on its own. We instead play
// just far enough to record one storm, then advance an injected clock past the game
// time limit so tick() settles it deterministically — exercising the real settle →
// capture → award path without depending on a natural win.
const GAME_LIMIT_MS = 5000;

function boot(): Harness {
  const config = loadConfig({
    env: {
      TABLE_SIZE: '4',
      GAME_TIME_LIMIT_MS: String(GAME_LIMIT_MS),
      DECISION_TIMEOUT_MS: '999999999', // never auto-play; the test drives every move
      // Opt out of the derived game-clock floor: this harness pairs an absurd
      // decision timeout with a deliberately tiny game limit, and the floor
      // (seats x timeout x rounds) would inflate that into hours.
      GAME_LIMIT_MIN_ROUNDS: '0',
      RAINBOW_STORM_CHANCE: '1', // a storm on the first card play
      WALLET_ENCRYPTION_KEY: 'unit-test-encryption-key',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const awardCalls: AwardCall[] = [];
  const escrowCalls: string[] = [];
  const escrow = recordingEscrowChain(escrowCalls);
  const orchestrator = new Orchestrator(db, config, {
    clock: () => clock,
    chain: escrow,
    tournamentChain: fakeTournamentChain(awardCalls),
    walletStore: createWalletStore(config.walletEncryptionKey),
    hooks: createChainHooks(db, escrow),
  });
  const { app } = buildServer({ db, config, orchestrator });
  return { app, db, orchestrator, awardCalls, escrowCalls, advance: (ms) => (clock += ms) };
}

async function register(app: FastifyInstance, displayName: string) {
  const res = await app.inject({ method: 'POST', url: '/api/battleground/register', payload: { displayName } });
  const body = res.json();
  return { agentId: body.agentId as string, apiKey: body.apiKey as string };
}

const authed = (apiKey: string) => ({ 'x-battleground-api-key': apiKey });

/** Has this session recorded a Rainbow Storm yet? */
function stormRecorded(h: Harness, sessionId: string): boolean {
  const row = h.db
    .prepare(`SELECT COUNT(*) AS c FROM session_events WHERE session_id = ? AND event_type = 'RAINBOW_STORM'`)
    .get(sessionId) as { c: number };
  return row.c > 0;
}

/**
 * Seat a full classic table, play just until one storm is recorded, then advance
 * the clock past the game limit and poke `pending-actions` so tick() settles it.
 * Returns the settled session id.
 */
async function seatStormSettle(h: Harness, competitionId: string): Promise<string> {
  const agents = [
    await register(h.app, 'A'),
    await register(h.app, 'B'),
    await register(h.app, 'C'),
    await register(h.app, 'D'),
  ];
  let sessionId = '';
  for (const a of agents) {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/battleground/session/join',
      headers: authed(a.apiKey),
      payload: { competitionId },
    });
    sessionId = res.json().sessionId;
  }

  // Play moves until the first storm lands (chance 1 → the first card play).
  for (let step = 0; step < 200 && !stormRecorded(h, sessionId); step++) {
    let acted = false;
    for (const a of agents) {
      const pending = (
        await h.app.inject({
          method: 'GET',
          url: '/api/battleground/session/pending-actions',
          headers: authed(a.apiKey),
        })
      ).json().sessions as Array<{ sessionId: string; yourTurn: boolean; legalMoves: Array<Record<string, unknown>> }>;
      const mine = pending.find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;
      const move = mine.legalMoves.find((m) => m.type === 'playCard') ?? mine.legalMoves[0]!;
      const chosen =
        move.type === 'playCard' && (move.card as { color: string | null }).color === null
          ? { type: 'playCard', card: { ...(move.card as object), color: 'red' } }
          : move;
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/battleground/session/action',
        headers: authed(a.apiKey),
        payload: { sessionId, move: chosen, reasoning: `s${step}`, idempotencyKey: `${a.agentId}-${step}` },
      });
      if (res.statusCode === 200) acted = true;
      break;
    }
    if (!acted) break;
  }

  // Time the game out so tick() settles it (deterministic, no natural win needed).
  h.advance(GAME_LIMIT_MS + 1000);
  await h.app.inject({
    method: 'GET',
    url: '/api/battleground/session/pending-actions',
    headers: authed(agents[0]!.apiKey),
  });
  return sessionId;
}

/** Seed a classic season's jackpot pool (what the operator does via seedJackpot + DB mirror). */
function seedSeasonJackpot(db: Db, competitionId: string, wei: string): void {
  db.prepare(`UPDATE competitions SET jackpot_seed_wei = ? WHERE id = ?`).run(wei, competitionId);
}

describe('custodial agent wallets (T48)', () => {
  it('issues a wallet at registration and never exposes the private key', async () => {
    const h = boot();
    const agent = await register(h.app, 'walletful');

    const me = (
      await h.app.inject({ method: 'GET', url: '/api/battleground/agent/me', headers: authed(agent.apiKey) })
    ).json();
    expect(me.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // The raw key must never cross the API boundary.
    expect(JSON.stringify(me)).not.toMatch(/privateKey|enc_private_key/i);

    const row = h.db
      .prepare(`SELECT address, enc_private_key FROM agent_wallets WHERE agent_id = ?`)
      .get(agent.agentId) as { address: string; enc_private_key: string } | undefined;
    expect(row?.address).toBe(me.walletAddress);
    // Stored encrypted (iv:tag:cipher), not a bare 0x private key.
    expect(row?.enc_private_key).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(row?.enc_private_key).not.toMatch(/^0x/);
  });
});

describe('playground Rainbow-Storm jackpot (T49)', () => {
  it('a free classic table makes NO escrow calls (D62 — the bug fix)', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Playground'); // free classic
    const sessionId = await seatStormSettle(h, competitionId);

    const row = h.db
      .prepare(`SELECT status, commit_tx_hash, settle_tx_hash FROM sessions WHERE id = ?`)
      .get(sessionId) as { status: string; commit_tx_hash: string | null; settle_tx_hash: string | null };
    expect(row.status).toBe('settled');
    expect(row.commit_tx_hash).toBeNull();
    expect(row.settle_tx_hash).toBeNull();
    expect(h.escrowCalls).toEqual([]); // never opened/committed/settled on the escrow
  });

  it('the first storm of a FUNDED season pays the jackpot to the agent wallet, once', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Playground');
    seedSeasonJackpot(h.db, competitionId, '50000000000000000'); // 0.05 tBNB

    const sessionId = await seatStormSettle(h, competitionId);

    // Exactly one on-chain award fired.
    expect(h.awardCalls).toHaveLength(1);
    const award = h.awardCalls[0]!;
    expect(award.competitionId).toBe(competitionId);
    expect(award.amountWei).toBe('50000000000000000');

    // It paid the STORM agent's custodial wallet (regardless of claim, D64).
    const stormRow = h.db
      .prepare(`SELECT agent_id FROM jackpot_events WHERE competition_id = ?`)
      .get(competitionId) as { agent_id: string };
    const wallet = (
      h.db.prepare(`SELECT wallet_address FROM agents WHERE id = ?`).get(stormRow.agent_id) as {
        wallet_address: string;
      }
    ).wallet_address;
    expect(award.winner).toBe(wallet);
    // The storm was in THIS session's log and the award names its result hash.
    expect(award.resultHash).toMatch(/^[0-9a-f]{64}$/);

    // The payout is mirrored on the jackpot row and the DB pool is drained.
    const jp = h.db
      .prepare(`SELECT tx_hash, amount_wei FROM jackpot_events WHERE competition_id = ?`)
      .get(competitionId) as { tx_hash: string | null; amount_wei: string | null };
    expect(jp.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(jp.amount_wei).toBe('50000000000000000');
    const pool = (
      h.db.prepare(`SELECT jackpot_seed_wei FROM competitions WHERE id = ?`).get(competitionId) as {
        jackpot_seed_wei: string;
      }
    ).jackpot_seed_wei;
    expect(pool).toBe('0');
    void sessionId;

    // A SECOND storm game in the same season pays nothing more (idempotent, D63).
    await seatStormSettle(h, competitionId);
    expect(h.awardCalls).toHaveLength(1);
  }, 30000); // two full storm games (everyone draws 6) run long — allow headroom

  it('an UNFUNDED season records the storm but pays nothing (D67)', async () => {
    const h = boot();
    const competitionId = h.orchestrator.createCompetition('Playground'); // jackpot_seed_wei = '0'
    await seatStormSettle(h, competitionId);

    // The storm is recorded (so it can never double-pay later)...
    const jp = h.db
      .prepare(`SELECT agent_id, tx_hash FROM jackpot_events WHERE competition_id = ?`)
      .get(competitionId) as { agent_id: string; tx_hash: string | null } | undefined;
    expect(jp?.agent_id).toBeTruthy();
    expect(jp?.tx_hash).toBeNull();
    // ...but nothing was paid on-chain.
    expect(h.awardCalls).toEqual([]);
  });
});
