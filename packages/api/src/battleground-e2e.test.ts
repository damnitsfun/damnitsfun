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
 * number → tournament (coins) — plus the rename being grep-clean. This ties
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

  it('a played game feeds coins standings (ranked by coins) and game numbers; tournament ranks by coins', async () => {
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

    // Playground standings — ranked by coins, 4 agents. Buy-ins are pooled back
    // into the winnings, so the four balances still total 4000 (coins conserved).
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
    expect(standings.reduce((s, r) => s + r.coins, 0)).toBe(4 * 1000);

    // The finished game carries a stable game number.
    const sessions = (
      await app.inject({ method: 'GET', url: '/api/battleground/spectate/sessions' })
    ).json().sessions as Array<{ gameNumber: number | null }>;
    expect(sessions[0]!.gameNumber).toBe(1);

    // The tournament now ranks by COINS (openskill removed): the board is
    // coins-sorted and the on-chain prize pays the top of it.
    const lb = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/competition/leaderboard?competitionId=${competitionId}`,
        headers: { 'x-battleground-api-key': agents[0]!.apiKey },
      })
    ).json().leaderboard as Array<{ coins: number }>;
    expect(lb.length).toBeGreaterThan(0);
    expect(typeof lb[0]!.coins).toBe('number');
    for (let i = 1; i < lb.length; i++) expect(lb[i - 1]!.coins).toBeGreaterThanOrEqual(lb[i]!.coins);
  });

  it('playground and tournament are different game types: kinds, coins on both, economics (T44/T46)', async () => {
    const { app, orchestrator } = boot();
    const classic = orchestrator.createCompetition('Open Playground');
    const tourn = orchestrator.createTournament('Season 1', '0');
    await orchestrator.seedTournament(tourn, '2500000000000000000', '500000000000000000');

    const agents: Agent[] = [];
    for (const n of ['P1', 'P2', 'P3', 'P4']) agents.push(orchestrator.registerAgent(n));

    // Both game types move coins now (the tournament follows the playground).
    await playOneGame(orchestrator, classic, agents);
    for (const a of agents) await orchestrator.enterCompetition(a.agentId, tourn);
    await playOneGame(orchestrator, tourn, agents);

    // Public competitions expose both kinds + the tournament's economics.
    const comps = (await app.inject({ method: 'GET', url: '/api/battleground/competitions' })).json()
      .competitions as Array<Record<string, unknown>>;
    const classicC = comps.find((c) => c.id === classic)!;
    const tournC = comps.find((c) => c.id === tourn)!;
    expect(classicC.kind).toBe('classic');
    expect(tournC.kind).toBe('tournament');
    expect(tournC.poolWei).toBe('2500000000000000000');
    expect(tournC.jackpotWei).toBe('500000000000000000');
    expect(tournC.entriesCount).toBe(4);
    // No secrets leaked in the public payload.
    expect(Object.keys(tournC)).not.toContain('operatorPrivateKey');

    // Sessions carry their competition kind, so the web can split the feed.
    const sessions = (await app.inject({ method: 'GET', url: '/api/battleground/spectate/sessions' }))
      .json().sessions as Array<{ competitionKind: string; competitionId: string }>;
    expect(sessions.some((s) => s.competitionKind === 'classic')).toBe(true);
    expect(sessions.some((s) => s.competitionKind === 'tournament')).toBe(true);

    // Coins are conserved across BOTH games (zero-sum among the same 4 agents who
    // started at 1000 each): the total is still 4000 no matter how many tables ran.
    const standings = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/playground/standings?competitionId=${classic}`,
      })
    ).json().standings as Array<{ coins: number }>;
    expect(standings).toHaveLength(4);
    expect(standings.reduce((s, r) => s + r.coins, 0)).toBe(4 * 1000);

    // The tournament now ALSO ranks by coins: its leaderboard lists the 4 entrants
    // coins-sorted (the on-chain prize pays the top of it).
    const lb = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/competition/leaderboard?competitionId=${tourn}`,
        headers: { 'x-battleground-api-key': agents[0]!.apiKey },
      })
    ).json().leaderboard as Array<{ coins: number }>;
    expect(lb).toHaveLength(4);
    for (let i = 1; i < lb.length; i++) expect(lb[i - 1]!.coins).toBeGreaterThanOrEqual(lb[i]!.coins);

    // /playground/standings stays the PLAYGROUND board (classic only), so it never
    // lists a tournament competition even though tournaments now move coins.
    const tournStandings = (
      await app.inject({
        method: 'GET',
        url: `/api/battleground/playground/standings?competitionId=${tourn}`,
      })
    ).json().standings as unknown[];
    expect(tournStandings).toHaveLength(0);
  });

  it('the two web files are grep-clean of our product "arena" (arena.dev.fun excepted)', () => {
    for (const file of ['home.html', 'index.html']) {
      const hits = productArenaHits(readFileSync(join(WEB, file), 'utf8'));
      expect(hits).toEqual([]);
    }
  });
});
