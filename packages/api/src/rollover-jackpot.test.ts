import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { planRollover } from './rollover-jackpot';
import type { ChainResult, TournamentChain } from './tournament-chain';

/**
 * Two things, both about the database agreeing with the contract.
 *
 * 1. `rollover-jackpot` carries an unpaid jackpot off a settled season. The
 *    contract wrapper existed; nothing called it.
 * 2. Every chain write now refuses to be recorded when the chain did not make
 *    it. The client never throws — a revert comes back as `{ ok: false }` — and
 *    the orchestrator used to update the database regardless. The case that
 *    matters most is settlement: a season marked `settled` over a pool the
 *    contract still held, which `settle-season` would then refuse to retry.
 */

/** A chain that succeeds until told to fail. */
function switchableChain(): TournamentChain & { failing: boolean } {
  const chain = {
    enabled: true,
    contractAddress: '0xTOURNEY',
    failing: false,
  } as TournamentChain & { failing: boolean };
  const result = async (): Promise<ChainResult> =>
    chain.failing ? { ok: false, error: 'execution reverted' } : { ok: true, txHash: `0x${'b'.repeat(64)}` };
  Object.assign(chain, {
    openCompetition: result,
    verifyEntry: async () => ({ ok: false, error: 'not used' }),
    seedPool: result,
    seedJackpot: result,
    closeEntries: result,
    settleCompetition: result,
    awardJackpot: result,
    rolloverJackpot: result,
  });
  return chain;
}

function boot() {
  const config = loadConfig({ env: { MIN_RANKED_SESSIONS: '0' } });
  const db = openDatabase(':memory:');
  const chain = switchableChain();
  const o = new Orchestrator(db, config, { tournamentChain: chain });
  const tournament = (name: string): string => {
    const id = o.createCompetition(name);
    db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(id);
    return id;
  };
  const row = (id: string) =>
    db.prepare(`SELECT status, jackpot_seed_wei, pool_wei FROM competitions WHERE id = ?`).get(id) as {
      status: string;
      jackpot_seed_wei: string;
      pool_wei: string;
    };
  return { db, o, chain, tournament, row };
}

const settle = (db: Db, id: string, jackpotWei: string): void => {
  db.prepare(`UPDATE competitions SET status = 'settled', jackpot_seed_wei = ? WHERE id = ?`).run(jackpotWei, id);
};

describe('rollover-jackpot', () => {
  it('carries a settled season\'s jackpot into an open one, on both sides', async () => {
    const h = boot();
    const s1 = h.tournament('Tournament S1');
    const s2 = h.tournament('Tournament S2');
    settle(h.db, s1, '100000000000000000');

    expect(planRollover(h.db, s1, s2).refusals).toEqual([]);
    await h.o.rolloverJackpot(s1, s2);

    expect(h.row(s1).jackpot_seed_wei).toBe('0');
    expect(h.row(s2).jackpot_seed_wei).toBe('100000000000000000');
  });

  it('leaves both seasons untouched when the contract refuses', async () => {
    const h = boot();
    const s1 = h.tournament('Tournament S1');
    const s2 = h.tournament('Tournament S2');
    settle(h.db, s1, '100000000000000000');
    h.chain.failing = true;

    await expect(h.o.rolloverJackpot(s1, s2)).rejects.toThrow(/rolloverJackpot failed on chain/);
    // The old code zeroed S1 and credited S2 here, reporting a move that never happened.
    expect(h.row(s1).jackpot_seed_wei).toBe('100000000000000000');
    expect(h.row(s2).jackpot_seed_wei).toBe('0');
  });

  it('refuses before sending: an unsettled source, a playground target, an empty jackpot', () => {
    const h = boot();
    const live = h.tournament('Tournament S1');
    const playground = h.o.createCompetition('Playground S1');
    const settledEmpty = h.tournament('Tournament S0');
    settle(h.db, settledEmpty, '0');

    expect(planRollover(h.db, live, h.tournament('S2')).refusals.join(' ')).toMatch(/settle it first/);
    settle(h.db, live, '5');
    expect(planRollover(h.db, live, playground).refusals.join(' ')).toMatch(/not a tournament/);
    expect(planRollover(h.db, settledEmpty, h.tournament('S3')).refusals.join(' ')).toMatch(/no jackpot/);
    expect(planRollover(h.db, live, live).refusals.join(' ')).toMatch(/same season/);
  });
});

describe('a chain write the chain did not make is not recorded', () => {
  it('settlement: a reverted settle leaves the season active, so it can be retried', async () => {
    const h = boot();
    const s1 = h.tournament('Tournament S1');
    h.db.prepare(`UPDATE competitions SET pool_wei = '500000000000000000' WHERE id = ?`).run(s1);
    h.chain.failing = true;

    await expect(h.o.settleTournament(s1)).rejects.toThrow(/failed on chain/);
    expect(h.row(s1).status).toBe('active');
    expect(h.row(s1).pool_wei).toBe('500000000000000000');
  });

  it('seeding: a failed seed does not add money the contract never received', async () => {
    const h = boot();
    const s1 = h.tournament('Tournament S1');
    h.chain.failing = true;

    await expect(h.o.seedTournament(s1, '400000000000000000', '0')).rejects.toThrow(/seedPool failed on chain/);
    expect(h.row(s1).pool_wei).toBe('0');
  });
});
