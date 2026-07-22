import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Agent partial-information view on `pending-actions` (sub-spec 10 T32).
 *
 * Removing the public live-spectator tail (T30) meant an agent could no longer
 * glean the public board from the website, so `pending-actions` now carries a
 * `view`: the caller's OWN hand plus every seat's hand *count* and the public
 * board — never an opponent's card faces. This is what an agent needs to choose
 * a move without any live table ever being public.
 */

interface Agent {
  agentId: string;
  apiKey: string;
}

function boot(): { app: FastifyInstance; orchestrator: Orchestrator } {
  const config = loadConfig({
    env: { DECISION_TIMEOUT_MS: '3000', GAME_TIME_LIMIT_MS: '3600000', TABLE_SIZE: '4' },
  });
  const db = openDatabase(':memory:');
  const orchestrator = new Orchestrator(db, config);
  const { app } = buildServer({ db, config, orchestrator });
  return { app, orchestrator };
}

async function register(app: FastifyInstance, name: string): Promise<Agent> {
  const body = (
    await app.inject({ method: 'POST', url: '/api/arena/register', payload: { displayName: name } })
  ).json();
  return { agentId: body.agentId, apiKey: body.apiKey };
}

async function viewFor(app: FastifyInstance, agent: Agent, sessionId: string): Promise<any> {
  const sessions = (
    await app.inject({
      method: 'GET',
      url: '/api/arena/session/pending-actions',
      headers: { 'x-arena-api-key': agent.apiKey },
    })
  ).json().sessions as Array<{ sessionId: string; view: any; legalMoves: any[]; yourTurn: boolean }>;
  return sessions.find((s) => s.sessionId === sessionId);
}

describe('pending-actions partial-information view', () => {
  it("gives each agent its own hand plus opponents' counts, never their faces", async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('View Cup');
    const agents = [
      await register(app, 'A'),
      await register(app, 'B'),
      await register(app, 'C'),
      await register(app, 'D'),
    ];
    let sessionId = '';
    for (const agent of agents) {
      sessionId = (
        await app.inject({
          method: 'POST',
          url: '/api/arena/session/join',
          headers: { 'x-arena-api-key': agent.apiKey },
          payload: { competitionId },
        })
      ).json().sessionId;
    }

    const a = await viewFor(app, agents[0]!, sessionId);
    const b = await viewFor(app, agents[1]!, sessionId);

    // The board is observable.
    expect(a.view).toBeTruthy();
    expect(a.view.discardTop).toHaveProperty('symbol');
    expect(a.view.direction).toMatch(/^(cw|ccw)$/);
    expect(a.view.seats).toHaveLength(4);

    // Every seat shows a COUNT only — no card array, no faces, for anyone.
    for (const seat of a.view.seats) {
      expect(seat).toEqual({ agentId: expect.any(String), handCount: 7 });
    }
    expect(JSON.stringify(a.view.seats)).not.toContain('symbol');

    // The caller sees its OWN hand (7 dealt cards), matching its own seat count.
    expect(a.view.yourHand).toHaveLength(7);
    const aSeat = a.view.seats.find((s: any) => s.agentId === agents[0]!.agentId);
    expect(aSeat.handCount).toBe(a.view.yourHand.length);

    // Agent A's response carries NOTHING of agent B's hand: the only faces in A's
    // view are its own hand + the shared board. B's private hand is only in B's
    // own view, and A's `seats` (where B appears) has no faces at all.
    const bOwnHand = JSON.stringify(b.view.yourHand);
    expect(b.view.yourHand).toHaveLength(7);
    const aSeatForB = a.view.seats.find((s: any) => s.agentId === agents[1]!.agentId);
    expect(aSeatForB).toEqual({ agentId: agents[1]!.agentId, handCount: 7 });
    expect(Object.keys(aSeatForB)).not.toContain('hand');
    // Sanity: B's own view really is a distinct, populated hand.
    expect(bOwnHand).toContain('symbol');

    // yourTurn agrees with currentAgentId.
    expect(a.view.yourTurn).toBe(a.view.currentAgentId === agents[0]!.agentId);
  });

  it('is null for a seated-but-not-yet-dealt table', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('Lobby Cup');
    // Only two agents join a 4-seat table → seated/lobby, not yet dealt.
    const a = await register(app, 'Solo1');
    const b = await register(app, 'Solo2');
    let sessionId = '';
    for (const agent of [a, b]) {
      sessionId = (
        await app.inject({
          method: 'POST',
          url: '/api/arena/session/join',
          headers: { 'x-arena-api-key': agent.apiKey },
          payload: { competitionId },
        })
      ).json().sessionId;
    }
    const view = await viewFor(app, a, sessionId);
    expect(view.view).toBeNull();
    expect(view.legalMoves).toEqual([]);
  });
});
