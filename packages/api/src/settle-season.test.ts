import { loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { previewSettlement } from './settle-season';

/**
 * Sub-spec 22 — the operator tool that pays the prize.
 *
 * `settleTournament` had existed since sub-spec 08 with no caller outside an
 * in-process demo against a disabled chain, so the money path had never been
 * runnable against a live deployment. These pin the two things the tool has to
 * get right before it is trusted with a pool: it must show the operator exactly
 * who is being skipped and why, and it must refuse to pay a funded pool into an
 * empty field.
 */

interface H {
  db: Db;
  o: Orchestrator;
  config: Config;
  comp: string;
  advance(ms: number): void;
}

function boot(env: Record<string, string> = {}): H {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3',
      TABLE_MAX_SIZE: '3',
      GAME_LIMIT_MIN_ROUNDS: '0',
      GAME_TIME_LIMIT_MS: '1',
      MIN_RANKED_SESSIONS: '2',
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  const comp = o.createCompetition('Championship');
  db.prepare(`UPDATE competitions SET kind = 'tournament' WHERE id = ?`).run(comp);
  return { db, o, config, comp, advance: (ms) => { clock += ms; } };
}

async function playTables(h: H, ids: string[], count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    for (const id of ids) await h.o.joinSession(id, h.comp);
    h.advance(60_000);
    h.o.tick();
  }
}

async function seatThree(h: H, names: string[], tables = 3): Promise<string[]> {
  const ids = names.map((n) => h.o.registerAgent(n).agentId);
  for (const id of ids) await h.o.enterCompetition(id, h.comp);
  await playTables(h, ids, tables);
  return ids;
}

const fund = (h: H, wei: string): void => {
  h.db.prepare(`UPDATE competitions SET pool_wei = ? WHERE id = ?`).run(wei, h.comp);
};

describe('previewSettlement', () => {
  it('says exactly why each agent cannot be paid', async () => {
    const h = boot();
    const [claimedNoAddress, unclaimed, fullyEligible] = await seatThree(h, ['no-address', 'unclaimed', 'ready']);

    h.o.devClaimAgent(claimedNoAddress!, 'x_1', 'one');
    h.o.devClaimAgent(fullyEligible!, 'x_3', 'three');
    h.o.setPayoutAddress(fullyEligible!, `0x${'a'.repeat(40)}`);

    const p = previewSettlement(h.db, h.o, h.config, h.comp);
    const why = Object.fromEntries(p.skipped.map((s) => [s.displayName, s.reasons]));

    expect(p.ranked.map((r) => r.displayName)).toEqual(['ready']);
    expect(why['no-address']).toEqual(['no payout address set']);
    expect(why['unclaimed']).toEqual(
      expect.arrayContaining(['not claimed by an X-verified owner', 'no payout address set']),
    );
    expect(why.ready).toBeUndefined();
  });

  it('counts a short record as a reason, with the number', async () => {
    const h = boot({ MIN_RANKED_SESSIONS: '10' });
    const ids = await seatThree(h, ['keen', 'other', 'third'], 3);
    h.o.devClaimAgent(ids[0]!, 'x_1', 'one');
    h.o.setPayoutAddress(ids[0]!, `0x${'b'.repeat(40)}`);

    const p = previewSettlement(h.db, h.o, h.config, h.comp);
    expect(p.ranked).toHaveLength(0);
    const keen = p.skipped.find((s) => s.displayName === 'keen')!;
    expect(keen.reasons).toEqual(['only 3 settled games (needs 10)']);
  });

  it('splits the pool across the eligible field, best first', async () => {
    const h = boot();
    const ids = await seatThree(h, ['alpha', 'bravo', 'charlie']);
    ids.forEach((id, i) => {
      h.o.devClaimAgent(id, `x_${i}`, `owner${i}`);
      h.o.setPayoutAddress(id, `0x${String(i).repeat(40)}`);
    });
    fund(h, '1000000000000000000'); // 1 tBNB

    const p = previewSettlement(h.db, h.o, h.config, h.comp);
    expect(p.ranked).toHaveLength(3);
    // Top third of a 3-agent field, capped at the curve length: one seat paid.
    expect(p.amounts).toHaveLength(1);
    expect(p.amounts.reduce((a, b) => a + b, 0n)).toBe(1000000000000000000n);
    // The paid seat is the one leading the board, not an arbitrary one.
    expect(p.ranked[0]!.netCoins).toBeGreaterThanOrEqual(p.ranked[1]!.netCoins);
  });

  it('reports an empty field when a funded pool has nobody to pay', async () => {
    const h = boot();
    await seatThree(h, ['nobody-claimed', 'also-not', 'nor-this']);
    fund(h, '5000000000000000');

    const p = previewSettlement(h.db, h.o, h.config, h.comp);
    // The state production was actually in: agents playing, a pool, and not one
    // of them able to receive it. The CLI turns this into a hard refusal.
    expect(p.ranked).toHaveLength(0);
    expect(p.amounts).toEqual([]);
    expect(p.poolWei).toBeGreaterThan(0n);
    expect(p.skipped).toHaveLength(3);
    for (const s of p.skipped) expect(s.reasons).toContain('not claimed by an X-verified owner');
  });

  it('refuses a competition that is not a tournament, and an unknown id', () => {
    const h = boot();
    const classic = h.o.createCompetition('Playground');
    expect(() => previewSettlement(h.db, h.o, h.config, classic)).toThrow(/not a tournament/);
    expect(() => previewSettlement(h.db, h.o, h.config, 'comp_nope')).toThrow(/No such competition/);
  });

  it('flags a season that has already been settled', async () => {
    const h = boot();
    await seatThree(h, ['a', 'b', 'c']);
    h.db.prepare(`UPDATE competitions SET status = 'settled' WHERE id = ?`).run(h.comp);
    expect(previewSettlement(h.db, h.o, h.config, h.comp).alreadySettled).toBe(true);
  });
});
