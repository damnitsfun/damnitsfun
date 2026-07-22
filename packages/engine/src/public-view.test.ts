import { GameSession } from './adapter';
import { InMemorySessionEventStore } from './events';

/**
 * `GameSession.getPublicView` (sub-spec 10 T32) — the partial-information
 * projection an agent may observe: the public board + every seat's hand *count*
 * + the caller's OWN hand. It must never expose another seat's card faces or the
 * seed. This is what `pending-actions` forwards once the live spectator tail is
 * gone (T30).
 */

const SEATS = ['A', 'B', 'C', 'D'];

function makeSession(): GameSession {
  return new GameSession(SEATS, {
    seedReveal: 'view-seed',
    sessionId: 'sess_view',
    store: new InMemorySessionEventStore(),
  });
}

describe('getPublicView', () => {
  it('exposes the board and every seat count, but only the caller their own hand', () => {
    const session = makeSession();
    const view = session.getPublicView('A');

    // Public board.
    expect(view.discardTop).toHaveProperty('symbol');
    expect(view.direction).toMatch(/^(cw|ccw)$/);
    expect(view.currentAgentId).toBe(session.currentAgentId);
    expect(view.yourTurn).toBe(session.currentAgentId === 'A');

    // Every seat: identity + count only, no faces.
    expect(view.seats).toHaveLength(4);
    for (const seat of view.seats) {
      expect(Object.keys(seat).sort()).toEqual(['agentId', 'handCount']);
      expect(seat.handCount).toBe(7);
    }

    // The caller's own hand is revealed; it matches the caller's seat count.
    expect(view.yourHand).toHaveLength(7);
    expect(view.seats.find((s) => s.agentId === 'A')!.handCount).toBe(view.yourHand.length);
  });

  it("never contains another seat's faces, and never the seed", () => {
    const session = makeSession();

    // Each agent's own view reveals a different own-hand; no view carries another's.
    const viewA = session.getPublicView('A');
    const viewB = session.getPublicView('B');

    // A's serialized seats (where B, C, D appear) contain no card faces at all.
    expect(JSON.stringify(viewA.seats)).not.toContain('symbol');
    // The only faces in A's view are its own hand + the board — B's private hand
    // is only ever in B's own view.
    expect(viewB.yourHand).toHaveLength(7);
    // Nothing in the view type carries the seed.
    expect(JSON.stringify(viewA)).not.toContain('view-seed');
  });

  it('surfaces only inherently-public recent events (no dealt hands, no draw faces)', () => {
    const session = makeSession();
    // Opening state: recentEvents excludes SESSION_STARTED (it carries dealt hands).
    expect(session.getPublicView('A').recentEvents.every((e) => e.type !== 'SESSION_STARTED')).toBe(
      true,
    );

    // Play one legal card; it should surface as a public CARD_PLAYED, faces and all
    // (a played card is public), but a subsequent draw's faces never appear.
    const actor = session.currentAgentId!;
    const legal = session.getLegalMoves(actor);
    const play = legal.find((m) => m.type === 'playCard');
    if (play) {
      const move =
        play.type === 'playCard' && play.card.color === null
          ? ({ type: 'playCard', card: { symbol: play.card.symbol, color: 'red' } } as const)
          : play;
      session.applyMove(actor, move, { reasoning: 'test' });
      const recent = session.getPublicView(actor).recentEvents;
      expect(recent.some((e) => e.type === 'CARD_PLAYED')).toBe(true);
      expect(recent.every((e) => e.type !== 'CARD_DRAWN')).toBe(true);
    }
  });
});
