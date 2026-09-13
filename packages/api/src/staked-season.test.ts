import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { ApiError, Orchestrator } from './orchestrator';
import type { VaultChain } from './vault-chain';

/**
 * Sub-spec 24 — the refundable season, through the orchestrator with a fake
 * VaultChain so deposits and resolution are deterministic.
 *
 * The point of these is the boundary between the two models: a staked season must
 * take a deposit into the vault rather than a fee into the pool, must refund
 * everyone regardless of whether they played, and must leave every fee-model path
 * behaving exactly as it did (D191).
 */

interface ResolveCall {
  seasonId: string;
  winners: string[];
  amounts: bigint[];
  resultRoot: string;
}

interface FakeVault extends VaultChain {
  resolveCalls: ResolveCall[];
  openCalls: Array<{ seasonId: string; depositWei: string; closeAt: number; resolveBy: number }>;
  verifyOk: boolean;
}

function fakeVaultChain(): FakeVault {
  const resolveCalls: ResolveCall[] = [];
  const openCalls: FakeVault['openCalls'] = [];
  const v: FakeVault = {
    enabled: true,
    contractAddress: '0xVAULT',
    resolveCalls,
    openCalls,
    verifyOk: true,
    async openSeason(seasonId, depositWei, closeAt, resolveBy) {
      openCalls.push({ seasonId, depositWei, closeAt, resolveBy });
      return { ok: true, txHash: '0xopen' };
    },
    async verifyDeposit(_seasonId, txHash, expectedWei) {
      if (!v.verifyOk) return { ok: false, error: 'not a deposit for this season' };
      // A distinct "wallet" per txHash, so each depositor is its own address.
      const payer = `0x${txHash.replace(/[^a-f0-9]/gi, '0').padEnd(40, '0').slice(0, 40)}`;
      return { ok: true, payer, amountWei: expectedWei };
    },
    async seedPot() {
      return { ok: true, txHash: '0xseed' };
    },
    async closeRegistration() {
      return { ok: true, txHash: '0xclose' };
    },
    async resolve(seasonId, winners, amounts, resultRoot) {
      resolveCalls.push({ seasonId, winners, amounts, resultRoot });
      return { ok: true, txHash: '0xresolve' };
    },
    async exitStale() {
      return { ok: true, txHash: '0xexit' };
    },
    async readSeason() {
      return null;
    },
    async readOwed() {
      return null;
    },
  };
  return v;
}

const NOW = 1_700_000_000_000;
const CLOSE_AT = Math.floor(NOW / 1000) + 3600;
const RESOLVE_BY = Math.floor(NOW / 1000) + 7200;

interface Harness {
  db: Db;
  orchestrator: Orchestrator;
  vault: FakeVault;
}

function boot(overrides: Record<string, string> = {}): Harness {
  const config = loadConfig({
    env: { MIN_RANKED_SESSIONS: '1', VAULT_CONTRACT_ADDRESS: '0xVAULT', ...overrides },
  });
  const db = openDatabase(':memory:');
  const vault = fakeVaultChain();
  const orchestrator = new Orchestrator(db, config, { clock: () => NOW, vaultChain: vault });
  return { db, orchestrator, vault };
}

/** Claim an agent and give it a payout address — the prize-eligibility gate. */
function claim(db: Db, agentId: string, payoutAddress: string): void {
  const ownerId = `owner_${agentId}`;
  db.prepare(`INSERT OR IGNORE INTO owners (id, x_user_id, x_handle) VALUES (?, ?, ?)`).run(
    ownerId,
    `x-${agentId}`,
    `@${agentId}`,
  );
  db.prepare(
    `UPDATE agents SET owner_id = ?, claimed_at = datetime('now'), payout_address = ? WHERE id = ?`,
  ).run(ownerId, payoutAddress, agentId);
}

describe('the refundable season (sub-spec 24)', () => {
  it('writes both deadlines on chain when the season is created', () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);

    expect(h.vault.openCalls).toHaveLength(1);
    expect(h.vault.openCalls[0]).toMatchObject({
      seasonId: id,
      depositWei: '1000',
      closeAt: CLOSE_AT,
      resolveBy: RESOLVE_BY,
    });
  });

  it('refuses deadlines that are out of order', () => {
    const h = boot();
    expect(() => h.orchestrator.createStakedSeason('bad', '1000', RESOLVE_BY, CLOSE_AT)).toThrow(
      ApiError,
    );
  });

  /**
   * The staked season's entry fee is '0'. Without the entry_model branch that
   * reads as a free season and seats the agent without taking anything.
   */
  it('asks for a deposit instead of seating for free', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    const { agentId } = h.orchestrator.registerAgent('depositor');

    await expect(h.orchestrator.enterCompetition(agentId, id)).rejects.toMatchObject({
      statusCode: 402,
      code: 'DEPOSIT_REQUIRED',
    });
    expect(h.orchestrator.isEntered(agentId, id)).toBe(false);
  });

  it('the 402 names the vault, the amount, and says the deposit comes back', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    const { agentId } = h.orchestrator.registerAgent('depositor');

    const err = await h.orchestrator.enterCompetition(agentId, id).catch((e) => e as ApiError);
    const details = (err as ApiError).details as { paymentRequired: Record<string, unknown> };
    expect(details.paymentRequired).toMatchObject({
      contractAddress: '0xVAULT',
      amountWei: '1000',
      refundable: true,
      method: 'deposit(bytes32)',
    });
    expect(details.paymentRequired.resolveBy).toBeTruthy();
  });

  it('refuses a deposit it cannot verify on chain', async () => {
    const h = boot();
    h.vault.verifyOk = false;
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    const { agentId } = h.orchestrator.registerAgent('liar');

    await expect(h.orchestrator.enterCompetition(agentId, id, '0xdeadbeef')).rejects.toMatchObject({
      statusCode: 402,
      code: 'DEPOSIT_NOT_VERIFIED',
    });
    expect(h.orchestrator.isEntered(agentId, id)).toBe(false);
  });

  /** The deposit is the player's money. It must never swell the prize pool. */
  it('a deposit does not become prize money', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    const { agentId } = h.orchestrator.registerAgent('depositor');

    await h.orchestrator.enterCompetition(agentId, id, '0xaaa1');
    const pool = (
      h.db.prepare(`SELECT pool_wei FROM competitions WHERE id = ?`).get(id) as { pool_wei: string }
    ).pool_wei;
    expect(pool).toBe('0');
  });

  it('the prize pot is sponsor money and does show up in the pool', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    await h.orchestrator.seedStakedPot(id, '5000');
    const pool = (
      h.db.prepare(`SELECT pool_wei FROM competitions WHERE id = ?`).get(id) as { pool_wei: string }
    ).pool_wei;
    expect(pool).toBe('5000');
  });

  /**
   * The headline promise, at the orchestrator boundary: eligibility gates prizes
   * only. An agent that deposits and never plays is still refunded in full.
   */
  it('refunds every depositor, including one that played nothing', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    await h.orchestrator.seedStakedPot(id, '5000');

    const a = h.orchestrator.registerAgent('player');
    const idle = h.orchestrator.registerAgent('idle');
    await h.orchestrator.enterCompetition(a.agentId, id, '0xaaa1');
    await h.orchestrator.enterCompetition(idle.agentId, id, '0xbbb2');
    claim(h.db, a.agentId, '0xPAYOUTA');
    claim(h.db, idle.agentId, '0xPAYOUTB');

    const out = await h.orchestrator.resolveStakedSeason(id);

    expect(out.refunds).toHaveLength(2);
    for (const r of out.refunds) expect(r.amountWei).toBe('1000');
    expect(out.refunds.map((r) => r.agentId).sort()).toEqual(
      [a.agentId, idle.agentId].sort(),
    );

    const rows = h.db
      .prepare(`SELECT agent_id, refund_wei FROM competition_entries WHERE competition_id = ?`)
      .all(id) as Array<{ agent_id: string; refund_wei: string }>;
    expect(rows.every((r) => r.refund_wei === '1000')).toBe(true);
  });

  /** Nobody played, so nobody is prize-eligible — and everyone is still refunded. */
  it('pays no prize into an empty eligible field but still returns the deposits', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    await h.orchestrator.seedStakedPot(id, '5000');
    const a = h.orchestrator.registerAgent('unclaimed');
    await h.orchestrator.enterCompetition(a.agentId, id, '0xaaa1');

    const out = await h.orchestrator.resolveStakedSeason(id);
    expect(out.winners).toHaveLength(0);
    expect(h.vault.resolveCalls[0]?.winners).toEqual([]);
    expect(out.refunds).toHaveLength(1);
    expect(out.refunds[0]?.amountWei).toBe('1000');
  });

  it('marks the season settled and records the resolve tx', async () => {
    const h = boot();
    const id = h.orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    await h.orchestrator.resolveStakedSeason(id);

    const row = h.db
      .prepare(`SELECT status, resolved_tx_hash FROM competitions WHERE id = ?`)
      .get(id) as { status: string; resolved_tx_hash: string };
    expect(row.status).toBe('settled');
    expect(row.resolved_tx_hash).toBe('0xresolve');
  });

  it('refuses staked operations on a fee season, and vice versa', async () => {
    const h = boot();
    const fee = h.orchestrator.createTournament('fee season', '1000');
    await expect(h.orchestrator.resolveStakedSeason(fee)).rejects.toMatchObject({
      code: 'NOT_A_STAKED_SEASON',
    });
    await expect(h.orchestrator.seedStakedPot(fee, '1')).rejects.toMatchObject({
      code: 'NOT_A_STAKED_SEASON',
    });
  });

  /** D191: every pre-existing row, and every season made the old way, reads 'fee'. */
  it('leaves the fee model exactly as it was', () => {
    const h = boot();
    const fee = h.orchestrator.createTournament('fee season', '1000');
    const row = h.db
      .prepare(`SELECT entry_model, deposit_wei, vault_address FROM competitions WHERE id = ?`)
      .get(fee) as { entry_model: string; deposit_wei: string | null; vault_address: string | null };
    expect(row).toEqual({ entry_model: 'fee', deposit_wei: null, vault_address: null });
  });

  /** DoD 9: a box with no vault still runs the season and still refunds. */
  it('records and refunds with no vault configured', async () => {
    const config = loadConfig({ env: { MIN_RANKED_SESSIONS: '1' } });
    const db = openDatabase(':memory:');
    const orchestrator = new Orchestrator(db, config, { clock: () => NOW });

    const id = orchestrator.createStakedSeason('S1', '1000', CLOSE_AT, RESOLVE_BY);
    const a = orchestrator.registerAgent('depositor');
    // With no vault there is nothing to verify against, so the deposit is refused
    // rather than silently trusted — but the season itself still resolves.
    await expect(orchestrator.enterCompetition(a.agentId, id, '0xaaa1')).rejects.toMatchObject({
      code: 'DEPOSIT_NOT_VERIFIED',
    });

    const out = await orchestrator.resolveStakedSeason(id);
    expect(out.txHash).toBeNull();
    expect(
      (db.prepare(`SELECT status FROM competitions WHERE id = ?`).get(id) as { status: string })
        .status,
    ).toBe('settled');
  });
});
