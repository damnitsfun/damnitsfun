import { loadConfig, ConfigError } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';

/**
 * Sub-spec 18 (T66) — 3–6 seats, fill-or-countdown, and the lobby reaper.
 *
 * The run behind this spec stalled on a table that split three-and-one and never
 * dealt: nothing in the system looked at a lobby again after the join that made
 * it. These tests pin the three rules that replace that — deal at capacity, deal
 * on the clock, reap what will never fill — and the invariant underneath them,
 * that the clock starts at the MINIMUM so it can never fire on an illegal table.
 */

const COUNTDOWN = 15_000;
const ABANDON = 60_000;

interface Harness {
  db: Db;
  orchestrator: Orchestrator;
  competitionId: string;
  advance(ms: number): void;
  now(): number;
  seatedCount(sessionId: string): number;
  statusOf(sessionId: string): string;
}

function boot(env: Record<string, string> = {}): Harness {
  const config = loadConfig({
    env: {
      TABLE_MIN_SIZE: '3',
      TABLE_MAX_SIZE: '6',
      LOBBY_COUNTDOWN_MS: String(COUNTDOWN),
      LOBBY_ABANDON_MS: String(ABANDON),
      DECISION_TIMEOUT_MS: '999999999', // never auto-play; these tests only seat
      ...env,
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const orchestrator = new Orchestrator(db, config, { clock: () => clock });
  const competitionId = orchestrator.createCompetition('Seating Playground');
  return {
    db,
    orchestrator,
    competitionId,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
    seatedCount: (sessionId) =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM session_players WHERE session_id = ?`)
          .get(sessionId) as { n: number }
      ).n,
    statusOf: (sessionId) =>
      (db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string })
        .status,
  };
}

/** Seat `n` fresh agents, returning the join results in order. */
async function seat(h: Harness, n: number, prefix = 'a'): Promise<
  Array<{ agentId: string; sessionId: string; status: string; startsInMs?: number | null }>
> {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { agentId } = h.orchestrator.registerAgent(`${prefix}-${i}`);
    const joined = await h.orchestrator.joinSession(agentId, h.competitionId);
    out.push({ agentId, ...joined });
  }
  return out;
}

describe('seating (sub-spec 18 T66)', () => {
  it('does not start a clock before the minimum is seated', async () => {
    const h = boot();
    const joins = await seat(h, 2);

    expect(joins.every((j) => j.status === 'lobby')).toBe(true);
    // No countdown yet — an agent must be able to tell "no clock" from "12s left".
    expect(joins[0]!.startsInMs).toBeNull();
    expect(joins[1]!.startsInMs).toBeNull();
    expect(h.statusOf(joins[0]!.sessionId)).toBe('lobby');
  });

  it('starts the countdown on the minimum-th seat and reports it', async () => {
    const h = boot();
    const joins = await seat(h, 3);

    expect(joins[2]!.startsInMs).toBe(COUNTDOWN);
    expect(h.statusOf(joins[0]!.sessionId)).toBe('lobby'); // not dealt yet
  });

  it('deals a three-handed table when the countdown expires', async () => {
    const h = boot();
    const joins = await seat(h, 3);
    const sessionId = joins[0]!.sessionId;

    h.advance(COUNTDOWN - 1);
    h.orchestrator.tick();
    expect(h.statusOf(sessionId)).toBe('lobby');

    h.advance(2);
    h.orchestrator.tick();
    expect(h.statusOf(sessionId)).toBe('in_progress');
    // The row must record what it DEALT at, not the lobby's capacity of 6.
    const row = h.db.prepare(`SELECT table_size FROM sessions WHERE id = ?`).get(sessionId) as {
      table_size: number;
    };
    expect(row.table_size).toBe(3);
  });

  it('deals immediately at capacity without waiting for the clock', async () => {
    const h = boot();
    const joins = await seat(h, 6);

    expect(joins[5]!.status).toBe('seated');
    expect(h.statusOf(joins[0]!.sessionId)).toBe('in_progress');
    // Dealt on the sixth seat, with the countdown still nowhere near expiry.
    const row = h.db.prepare(`SELECT table_size, lobby_deadline_at FROM sessions WHERE id = ?`)
      .get(joins[0]!.sessionId) as { table_size: number; lobby_deadline_at: number | null };
    expect(row.table_size).toBe(6);
    expect(row.lobby_deadline_at).toBeNull();
  });

  it('does not extend the deadline when later seats arrive (D105)', async () => {
    const h = boot();
    await seat(h, 3);
    const sessionId = (
      h.db.prepare(`SELECT id, lobby_deadline_at FROM sessions LIMIT 1`).get() as { id: string }
    ).id;
    const first = (
      h.db.prepare(`SELECT lobby_deadline_at AS d FROM sessions WHERE id = ?`).get(sessionId) as {
        d: number;
      }
    ).d;

    h.advance(5_000);
    await seat(h, 1, 'late'); // a 4th agent joins mid-countdown

    const after = (
      h.db.prepare(`SELECT lobby_deadline_at AS d FROM sessions WHERE id = ?`).get(sessionId) as {
        d: number;
      }
    ).d;
    expect(after).toBe(first); // unchanged — a trickle cannot hold the table open
  });

  it('reaps a lobby that never reaches the minimum, refunding every buy-in', async () => {
    const h = boot();
    const joins = await seat(h, 2);
    const sessionId = joins[0]!.sessionId;
    const entry = 10;

    const before = joins.map((j) => h.orchestrator.getAgent(j.agentId).coins);
    // Each already paid the seat buy-in on join.
    expect(before[0]).toBe(1000 - entry);

    h.advance(ABANDON + 1);
    h.orchestrator.tick();

    expect(h.statusOf(sessionId)).toBe('archived');
    expect(h.seatedCount(sessionId)).toBe(0);
    for (const j of joins) {
      expect(h.orchestrator.getAgent(j.agentId).coins).toBe(1000); // made whole
    }
  });

  it('never reaps a lobby that reached the minimum', async () => {
    const h = boot();
    const joins = await seat(h, 3);
    h.advance(ABANDON + 1);
    h.orchestrator.tick();
    // It deals rather than being reaped — the countdown expired long ago.
    expect(h.statusOf(joins[0]!.sessionId)).toBe('in_progress');
  });

  it('tells a waiting agent how long is left via pending-actions (D107)', async () => {
    const h = boot();
    const joins = await seat(h, 3);

    h.advance(4_000);
    const pending = h.orchestrator.pendingActions(joins[0]!.agentId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe('lobby');
    expect(pending[0]!.startsInMs).toBe(COUNTDOWN - 4_000);
    expect(pending[0]!.seatsFilled).toBe(3);
    expect(pending[0]!.seatsNeeded).toBe(3);
  });

  it('always returns startsInMs on join, even when the table deals immediately', async () => {
    // Reported by an agent following the documented contract: skill.md promises the
    // key is always present with a null, but the full-table path omitted it, so
    // `body.startsInMs` read `undefined` to any client that trusted the doc.
    const h = boot({ TABLE_MIN_SIZE: '2', TABLE_MAX_SIZE: '2' });
    const joins = await seat(h, 2);

    expect(joins[1]!.status).toBe('seated');           // dealt on the spot
    expect('startsInMs' in joins[1]!).toBe(true);      // key present...
    expect(joins[1]!.startsInMs).toBeNull();           // ...and explicitly null
    // The lobby path was already correct; assert both so they cannot drift apart.
    expect('startsInMs' in joins[0]!).toBe(true);
  });

  it('rejects a seat range the engine could not deal', () => {
    expect(() => loadConfig({ env: { TABLE_MIN_SIZE: '1' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { TABLE_MAX_SIZE: '11' } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { TABLE_MIN_SIZE: '5', TABLE_MAX_SIZE: '4' } })).toThrow(
      ConfigError,
    );
  });

  it('keeps a legacy TABLE_SIZE deployment on exactly that many seats', async () => {
    const h = boot({ TABLE_MIN_SIZE: '', TABLE_MAX_SIZE: '', TABLE_SIZE: '4' });
    // With neither bound set, TABLE_SIZE pins both: 3 seats must NOT deal.
    const joins = await seat(h, 3);
    h.advance(COUNTDOWN + 1);
    h.orchestrator.tick();
    expect(h.statusOf(joins[0]!.sessionId)).toBe('lobby');

    await seat(h, 1, 'fourth');
    expect(h.statusOf(joins[0]!.sessionId)).toBe('in_progress');
  });
});
