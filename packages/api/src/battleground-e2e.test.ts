import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';
import { buildServer } from './server';

/**
 * Sub-spec 12 (T43): the whole "battleground" walkthrough as one path —
 * homepage → app → alias/301/config → a played game → coins standings + game
 * number → tournament (openskill) — plus the rename being grep-clean. This ties
 * the individual task DoDs together into the demo the spec's Part E describes.
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

/** Play one full table to settlement, choosing a colour for wilds. */
async function playOneGame(orchestrator: Orchestrator, competitionId: string, agents: Agent[]): Promise<void> {
  let sessionId = '';
  for (const a of agents) sessionId = (await orchestrator.joinSession(a.agentId, competitionId)).sessionId;
  for (let step = 0; step < 6000; step++) {
    for (const a of agents) {
      const mine = orchestrator.pendingActions(a.agentId).find((s) => s.sessionId === sessionId);
      if (!mine || !mine.yourTurn) continue;
      let move = mine.legalMoves.find((m) => m.type === 'playCard') ?? mine.legalMoves[0];
      if (!move) continue;
      if (move.type === 'playCard' && move.card && move.card.color == null) {
        move = { type: 'playCard', card: { symbol: move.card.symbol, color: 'red' } };
      }
      await orchestrator.applyAction(a.agentId, sessionId, move, 'e2e', `${sessionId}-${a.agentId}-${step}`);
    }
    const live = agents.some((a) =>
      orchestrator.pendingActions(a.agentId).some((s) => s.sessionId === sessionId),
    );
    if (!live) return;
  }
}

const WEB = join(__dirname, '..', '..', 'web', 'public');
/** "arena" as OUR product term — excludes the external design-reference arena.dev.fun. */
function productArenaHits(text: string): string[] {
  return text
    .replace(/arena\.dev\.fun/g, '')
    .split('\n')
    .filter((line) => /arena/i.test(line));
}

describe('battleground end-to-end walkthrough (T43)', () => {
  it('homepage is the front door: renamed, one-paste, no login, new-tab entry', async () => {
    const { app } = boot();
    const html = (await app.inject({ method: 'GET', url: '/' })).body;
    expect(html).toContain('enter the battleground');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('one paste and your agent registers itself');
    // No login / Local Dev control on the homepage (D47).
    expect(html).not.toContain('sign in with Google');
    expect(html).not.toContain('Local Dev');
    expect(html).not.toContain('id="auth-slot"');
    // Decision clock is config-driven, not a hard-coded literal.
    expect(html).toContain('id="clock-val"');
    expect(html).not.toContain('>30s<');
  });

  it('the app lives at /battleground with the [battleground ▾] menu; /arena 301s', async () => {
    const { app } = boot();
    const appHtml = (await app.inject({ method: 'GET', url: '/battleground' })).body;
    expect(appHtml).toContain('id="mode-btn"');
    expect(appHtml).toContain('battleground ▾');
    expect(appHtml).toContain('data-mode="playground"');
    expect(appHtml).toContain('data-mode="tournament"');

    const legacy = await app.inject({ method: 'GET', url: '/arena' });
    expect(legacy.statusCode).toBe(301);
    expect(legacy.headers['location']).toBe('/battleground');
  });

  it('skill.md and config advertise the battleground contract; /api/arena still aliases', async () => {
    const { app } = boot();
    const skill = (await app.inject({ method: 'GET', url: '/skill.md' })).body;
    expect(skill).toContain('/api/battleground');
    expect(skill).toContain('x-battleground-api-key');
    expect(skill).not.toContain('/api/arena');
    expect(skill).not.toContain('x-arena-api-key');

    const cfg = await app.inject({ method: 'GET', url: '/api/battleground/config' });
    expect(cfg.json()).toEqual({
      tableSize: 4,
      startingHand: 7,
      decisionTimeoutMs: 3000,
      gameTimeLimitMs: 3600000,
    });
    const alias = await app.inject({ method: 'GET', url: '/api/arena/config' });
    expect(alias.statusCode).toBe(200);
    expect(alias.headers['deprecation']).toBe('true');
  });

  it('a played game feeds coins standings (ranked by coins) and game numbers; tournament stays openskill', async () => {
    const { app, orchestrator } = boot();
    const competitionId = orchestrator.createCompetition('E2E Cup');
    const agents: Agent[] = [];
    for (const n of ['E1', 'E2', 'E3', 'E4']) agents.push(orchestrator.registerAgent(n));

    // Everyone starts at 1000 (the coin economy default).
    for (const a of agents) {
      const me = (
        await app.inject({
          method: 'GET',
          url: '/api/battleground/agent/me',
          headers: { 'x-battleground-api-key': a.apiKey },
        })
      ).json();
      expect(me.coins).toBe(1000);
    }

    await playOneGame(orchestrator, competitionId, agents);

    // Playground standings — ranked by coins, 4 agents, zero-sum minus 4 buy-ins.
    const standings = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/playground/standings?competitionId=${competitionId}`,
      })
    ).json().standings as Array<{ coins: number }>;
    expect(standings).toHaveLength(4);
    for (let i = 1; i < standings.length; i++) {
      expect(standings[i - 1]!.coins).toBeGreaterThanOrEqual(standings[i]!.coins);
    }
    expect(standings.reduce((s, r) => s + r.coins, 0)).toBe(4 * 1000 - 4 * 10);

    // The finished game carries a stable game number.
    const sessions = (
      await app.inject({ method: 'GET', url: '/api/battleground/spectate/sessions' })
    ).json().sessions as Array<{ gameNumber: number | null }>;
    expect(sessions[0]!.gameNumber).toBe(1);

    // The tournament ranking is openskill (μ − 3σ), unchanged by the coin economy.
    const lb = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/competition/leaderboard?competitionId=${competitionId}`,
        headers: { 'x-battleground-api-key': agents[0]!.apiKey },
      })
    ).json().leaderboard as Array<{ conservativeRating: number }>;
    expect(lb.length).toBeGreaterThan(0);
    expect(typeof lb[0]!.conservativeRating).toBe('number');
  });

  it('the two web files are grep-clean of our product "arena" (arena.dev.fun excepted)', () => {
    for (const file of ['home.html', 'index.html']) {
      const hits = productArenaHits(readFileSync(join(WEB, file), 'utf8'));
      expect(hits).toEqual([]);
    }
  });
});
