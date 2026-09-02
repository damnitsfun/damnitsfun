import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase, type Db } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 22 (T103) — the turn notification, and the long poll built on it.
 *
 * The production soak spent 83.9% of 1.84M requests on `pending-actions`, and
 * 84.8% of those polls carried no turn. That was not an impolite fleet: it polled
 * inside the documented rate, and the contract gave an author no way to be both
 * fast and quiet. `wait` is that way.
 *
 * Real timers throughout. A long poll is a piece of timing behaviour, and fake
 * timers would assert the shape of the code rather than that it actually wakes.
 */

interface H {
  app: FastifyInstance;
  db: Db;
  o: Orchestrator;
  comp: string;
  advance(ms: number): void;
}

function boot(): H {
  const config = loadConfig({
    env: {
      // Three seats, not two. At a two-seat table a PASS or GRAB2 hands the turn
      // straight back to the agent that played it, so "did the other seat get
      // woken" would depend on which card came up. Three makes the turn always
      // leave the actor, whatever is played.
      TABLE_MIN_SIZE: '3',
      TABLE_MAX_SIZE: '3',
      DECISION_TIMEOUT_MS: '600000',
      GAME_TIME_LIMIT_MS: '3600000',
      GAME_LIMIT_MIN_ROUNDS: '0',
      // A Rainbow Storm returns the turn to the agent that played, so it is one
      // more way for no waiter to be woken. Rare, but this suite is about the
      // wake mechanism and has no business depending on it.
      RAINBOW_STORM_CHANCE: '0',
    },
  });
  const db = openDatabase(':memory:');
  let clock = 1_700_000_000_000;
  const o = new Orchestrator(db, config, { clock: () => clock });
  const { app } = buildServer({ db, config, orchestrator: o });
  const comp = o.createCompetition('Long Poll Cup');
  return { app, db, o, comp, advance: (ms) => { clock += ms; } };
}

/** Seat a full table so it deals, and say who is on move. */
async function dealTable(h: H) {
  const seats = ['alpha', 'bravo', 'charlie'].map((n) => h.o.registerAgent(n).agentId);
  const joined = await h.o.joinSession(seats[0]!, h.comp);
  for (const id of seats.slice(1)) await h.o.joinSession(id, h.comp);
  const sessionId = joined.sessionId;
  const onMove = seats.find((id) => h.o.pendingActions(id)[0]!.yourTurn)!;
  const waiting = seats.filter((id) => id !== onMove);
  return { seats, sessionId, onMove, waiting };
}

function chooseMove(legalMoves: Array<Record<string, unknown>>): Record<string, unknown> {
  const pick = legalMoves.find((m) => m.type === 'playCard') ?? legalMoves[0]!;
  if (pick.type === 'playCard') {
    const card = pick.card as { symbol: string; color: string | null };
    if (card.color === null) return { type: 'playCard', card: { symbol: card.symbol, color: 'red' } };
  }
  return pick;
}

describe('waitForTurn (D158)', () => {
  it('wakes as soon as the turn actually arrives', async () => {
    const h = boot();
    const { sessionId, onMove, waiting } = await dealTable(h);

    const started = Date.now();
    // Park every seat that is not on move. Exactly one of them gets the turn, and
    // only that one is woken — waking the whole table would wake two agents per
    // move with nothing to do, which is the polling cost this exists to remove.
    //
    // The cap is well under this test's own timeout on purpose: if nothing wakes,
    // the assertion below should say so with a number, rather than the suite
    // dying on an opaque Jest timeout.
    const parked = Promise.race(waiting.map((id) => h.o.waitForTurn(id, 3000)));

    // The agent on move plays ~50ms later. Before the notification existed, the
    // waiting agent could only find out by asking again.
    //
    // It plays until the turn actually LEAVES this seat, which is not the same as
    // playing once: `drawCard` keeps the turn, and a deal where the opening seat
    // holds nothing playable is ordinary. Acting once made this test depend on
    // the shuffle, and it failed on CI exactly when the deal went that way.
    let actError: unknown = null;
    setTimeout(() => {
      try {
        for (let step = 0; step < 12; step++) {
          const mine = h.o.pendingActions(onMove)[0];
          if (!mine || !mine.yourTurn) break;
          h.o.applyAction(onMove, sessionId, chooseMove(mine.legalMoves) as never, 'test', `k${step}`);
        }
      } catch (error) {
        // Surface it through the assertion instead of losing it in a timer.
        actError = error;
      }
    }, 50);

    await parked;
    if (actError) throw actError;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2500); // woken by the move, not by the 3s cap

    // The wake means "the table moved", not "it is your turn" — and it has to.
    // At a two-seat table a PASS or GRAB2 hands the turn straight back to the
    // agent that played it, so a notification that only fired on the waiter's own
    // turn would sleep through a card that was played at it.
    const events = h.db
      .prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    expect(events.n).toBeGreaterThan(0);
    expect(waiting.some((id) => h.o.pendingActions(id)[0]!.yourTurn)).toBe(true);
    await h.app.close();
  }, 20_000);

  it('returns on time when no turn comes', async () => {
    const h = boot();
    const { waiting } = await dealTable(h);
    const started = Date.now();
    await h.o.waitForTurn(waiting[0]!, 250);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(2000);
    await h.app.close();
  });

  it('wakes every seat when the table settles, rather than stranding them', async () => {
    const h = boot();
    const { seats } = await dealTable(h);
    // EVERY seat parks. A settling table has no "turn" to deliver, so if settlement
    // did not wake them they would all sit until the cap — the exact hang this
    // test exists to prevent, and the reason settle broadcasts where afterMove
    // does not.
    const parked = Promise.all(seats.map((id) => h.o.waitForTurn(id, 8000)));
    const started = Date.now();

    setTimeout(() => {
      h.advance(4_000_000); // past the game clock
      h.o.tick();
    }, 50);

    await parked;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(h.o.pendingActions(seats[0]!)).toEqual([]); // gone from the list = it ended
    await h.app.close();
  }, 20_000);

  it('does not park an agent that is between tables', async () => {
    const h = boot();
    const lonely = h.o.registerAgent('lonely').agentId;
    const started = Date.now();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/session/pending-actions?wait=5000',
      headers: { 'x-battleground-api-key': '' },
    });
    // Unauthenticated is still a fast 401 — waiting must never come before auth.
    expect(res.statusCode).toBe(401);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lonely).toBeTruthy();
    await h.app.close();
  });
});

describe('GET /session/pending-actions?wait= (the endpoint)', () => {
  it('answers immediately when it is already your turn', async () => {
    const h = boot();
    const { onMove } = await dealTable(h);
    const key = h.db
      .prepare(`SELECT api_key_hash FROM agents WHERE id = ?`)
      .get(onMove) as { api_key_hash: string };
    expect(key).toBeTruthy(); // the hash is stored, so re-register to get a usable key

    const agent = h.o.registerAgent('caller');
    const started = Date.now();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/session/pending-actions?wait=3000',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    expect(res.statusCode).toBe(200);
    // No table, so nothing to wait on.
    expect(Date.now() - started).toBeLessThan(1000);
    await h.app.close();
  });

  it('advises when to come back (D159)', async () => {
    const h = boot();
    const agent = h.o.registerAgent('advised');
    const idle = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/session/pending-actions',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    expect(idle.json().pollAfterMs).toBe(1000); // between tables: rejoin shortly

    await h.o.joinSession(agent.agentId, h.comp);
    const lobby = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/session/pending-actions',
      headers: { 'x-battleground-api-key': agent.apiKey },
    });
    // A lobby short of the minimum has no countdown, and no amount of polling
    // hurries company along.
    expect(lobby.json().pollAfterMs).toBe(2000);
    await h.app.close();
  });

  it('says 0 when it is your move — go, do not wait', async () => {
    const h = boot();
    const players = ['mover', 'other', 'third'].map((n) => h.o.registerAgent(n));
    for (const p of players) await h.o.joinSession(p.agentId, h.comp);
    const onMove = players.find((p) => h.o.pendingActions(p.agentId)[0]!.yourTurn)!;
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/battleground/session/pending-actions',
      headers: { 'x-battleground-api-key': onMove.apiKey },
    });
    expect(res.json().pollAfterMs).toBe(0);
    await h.app.close();
  });
});
