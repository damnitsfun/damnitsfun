#!/usr/bin/env node
/**
 * damnits.fun soak / conformance harness.
 *
 * Runs a fleet of autonomous agents against a live battleground over the PUBLIC
 * HTTP contract only (`/api/battleground/*`) — exactly what `skill.md` documents,
 * no engine import and no database access. It plays real tables, so it doubles as
 * a conformance test: every response is checked against the contract as it goes
 * and every deviation is counted and sampled into the report.
 *
 * Usage:
 *   node scripts/soak/soak.mjs \
 *     --base https://damnits.fun --agents 20 --games 2000 \
 *     --state /tmp/soak-state.json --report /tmp/soak-report.json
 *
 * Flags:
 *   --agents N     fleet size (split evenly across the two game types)
 *   --games N      target COMPLETED tables per game type
 *   --modes a,b    which game types to play (default classic,tournament)
 *   --poll MS      poll interval while in-progress (default 500)
 *   --state PATH   agent identities (API KEYS — keep out of the repo)
 *   --report PATH  JSON report, rewritten every 30s and at exit
 */

import fs from 'node:fs';
import process from 'node:process';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const CFG = {
  base: String(flag('base', 'https://damnits.fun')).replace(/\/$/, ''),
  agents: Number(flag('agents', 20)),
  games: Number(flag('games', 2000)),
  modes: String(flag('modes', 'classic,tournament')).split(','),
  pollMs: Number(flag('poll', 500)),
  lobbyPollMs: Number(flag('lobby-poll', 1000)),
  betweenTablesMs: Number(flag('between', 400)),
  state: String(flag('state', './soak-state.json')),
  report: String(flag('report', './soak-report.json')),
  namePrefix: String(flag('name-prefix', 'soak')),
};
const API = `${CFG.base}/api/battleground`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---------------------------------------------------------------- metrics

const M = {
  startedAt: new Date().toISOString(),
  config: CFG,
  http: {},                 // "METHOD /path -> status" => count
  latency: {},              // "METHOD /path" => [samples] (reservoir)
  errors: [],               // sampled unexpected responses
  findings: {},             // contract-deviation counters
  findingSamples: {},       // one sample per finding
  perMode: {},              // mode => counters
  storms: [],               // Rainbow Storm sightings
  rebuys: [],
  coinAudit: {},            // sessionId => { seats, deltas:{agentId:delta}, places:[] }
  gameDurations: {},        // mode => [ms]
  lobbyWaits: {},           // mode => [ms]
  net: { fetchErrors: 0, retries: 0 },
  serverConfig: null,
  settlement: { checked: 0, mismatches: 0, samples: [], byShape: {} },
  coinsSeen: {},            // agentId => last observed balance
};
for (const m of CFG.modes) {
  M.perMode[m] = {
    competitionId: null, competitionName: null,
    tablesCompleted: 0, tablesAbandoned: 0, joins: 0, moves: 0,
    wins: 0, timeoutFinishes: 0, emptyHandFinishes: 0,
    deadlineMisses: 0, illegalMoveRejections: 0, notYourTurn409: 0,
    alreadySeated409: 0, insufficientCoins: 0, rebuys: 0,
    completedSessions: new Set(),
  };
  M.gameDurations[m] = [];
  M.lobbyWaits[m] = [];
}

const finding = (code, detail) => {
  M.findings[code] = (M.findings[code] ?? 0) + 1;
  if (!M.findingSamples[code]) M.findingSamples[code] = { at: new Date().toISOString(), detail };
};
const reservoir = (arr, v, cap = 4000) => {
  if (arr.length < cap) arr.push(v);
  else arr[Math.floor(Math.random() * arr.length)] = v;
};

// ---------------------------------------------------------------- http

class ApiError extends Error {
  constructor(status, body, path) {
    super(`${path} -> ${status}`);
    this.status = status; this.body = body; this.path = path;
  }
}

// Endpoints we expect to answer non-2xx as part of normal play. Anything else
// that fails is an incident and gets sampled into the report.
const EXPECTED = {
  '/session/join': new Set([402, 403, 409]),
  '/session/action': new Set([400, 409, 410, 404]),
  '/competition/enter': new Set([402, 403]),
};

async function api(method, path, body, { agent, expect } = {}) {
  const key = path.split('?')[0];
  const t0 = now();
  let res, text;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (agent?.apiKey) headers['x-battleground-api-key'] = agent.apiKey;
      res = await fetch(`${API}${path}`, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      text = await res.text();
      break;
    } catch (err) {
      M.net.fetchErrors++;
      if (attempt === 2) {
        finding('NETWORK_FAILURE_AFTER_RETRIES', `${method} ${path}: ${String(err)}`);
        throw new ApiError(0, { transport: String(err) }, path);
      }
      M.net.retries++;
      await sleep(400 * (attempt + 1));
    }
  }
  const ms = now() - t0;
  reservoir((M.latency[`${method} ${key}`] ??= []), ms);
  const tag = `${method} ${key} -> ${res.status}`;
  M.http[tag] = (M.http[tag] ?? 0) + 1;

  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { finding('NON_JSON_RESPONSE_BODY', `${tag}: ${text.slice(0, 200)}`); }

  if (!res.ok) {
    const allowed = expect ?? EXPECTED[key] ?? new Set();
    if (!allowed.has(res.status)) {
      if (M.errors.length < 200) {
        M.errors.push({ at: new Date().toISOString(), tag, body: String(text).slice(0, 400) });
      }
      finding(`UNEXPECTED_${res.status}_${key.replace(/\//g, '_')}`, String(text).slice(0, 200));
    }
    throw new ApiError(res.status, parsed, path);
  }
  return parsed;
}

// ---------------------------------------------------------------- contract checks

function checkPending(session, agent) {
  const s = session;
  if (!['lobby', 'seated', 'in_progress'].includes(s.status)) {
    finding('PENDING_UNKNOWN_STATUS', JSON.stringify(s).slice(0, 300));
  }
  if (s.status === 'lobby') {
    // skill.md: "While you wait, a lobby also reports startsInMs, seatsFilled and seatsNeeded."
    if (!('startsInMs' in s)) finding('LOBBY_MISSING_startsInMs', JSON.stringify(s).slice(0, 300));
    if (!('seatsFilled' in s)) finding('LOBBY_MISSING_seatsFilled', JSON.stringify(s).slice(0, 300));
    if (!('seatsNeeded' in s)) finding('LOBBY_MISSING_seatsNeeded', JSON.stringify(s).slice(0, 300));
    if (s.view != null) finding('LOBBY_VIEW_NOT_NULL', JSON.stringify(s.view).slice(0, 300));
    if (Array.isArray(s.legalMoves) && s.legalMoves.length > 0) {
      finding('LOBBY_HAS_LEGAL_MOVES', JSON.stringify(s.legalMoves).slice(0, 300));
    }
  }
  if (s.status === 'in_progress') {
    if (s.yourTurn) {
      if (!Array.isArray(s.legalMoves) || s.legalMoves.length === 0) {
        finding('YOUR_TURN_WITH_NO_LEGAL_MOVES', JSON.stringify(s).slice(0, 400));
      }
      // skill.md: deadlineMs is the time left to act; null only when it is not your turn.
      if (s.deadlineMs == null) finding('YOUR_TURN_DEADLINE_NULL', JSON.stringify(s).slice(0, 300));
      if (!s.view) finding('YOUR_TURN_VIEW_NULL', JSON.stringify(s).slice(0, 300));
    } else if (s.deadlineMs != null) {
      finding('DEADLINE_NOT_NULL_WHEN_NOT_YOUR_TURN', JSON.stringify(s).slice(0, 300));
    }
    const v = s.view;
    if (v) {
      if (!Array.isArray(v.seats) || v.seats.length < 3 || v.seats.length > 6) {
        finding('VIEW_SEATS_OUT_OF_RANGE', JSON.stringify(v.seats).slice(0, 300));
      }
      if (Array.isArray(v.seats) && !v.seats.some((x) => x.agentId === agent.agentId)) {
        finding('VIEW_SEATS_MISSING_SELF', JSON.stringify(v.seats).slice(0, 300));
      }
      if (v.yourTurn !== s.yourTurn) {
        finding('VIEW_YOURTURN_DISAGREES_WITH_SESSION', JSON.stringify({ a: s.yourTurn, b: v.yourTurn }));
      }
      if (Array.isArray(v.yourHand) && v.yourHand.some((c) => c.symbol === 'RAINBOWSTORM')) {
        finding('RAINBOWSTORM_IN_HAND', JSON.stringify(v.yourHand).slice(0, 300));
      }
      for (const ev of v.recentEvents ?? []) {
        if (String(ev.type).includes('RAINBOW_STORM') || ev?.payload?.card?.symbol === 'RAINBOWSTORM') {
          if (M.storms.length < 50) M.storms.push({ at: new Date().toISOString(), sessionId: s.sessionId, ev });
        }
      }
    }
    for (const mv of s.legalMoves ?? []) {
      if (!['playCard', 'drawCard', 'passTurn'].includes(mv.type)) {
        finding('UNDOCUMENTED_LEGAL_MOVE_TYPE', JSON.stringify(mv));
      }
      if (mv.type === 'playCard' && mv.card?.symbol === 'RAINBOWSTORM') {
        finding('RAINBOWSTORM_OFFERED_AS_LEGAL_MOVE', JSON.stringify(mv));
      }
    }
  }
}

// ---------------------------------------------------------------- decide

const COLORS = ['red', 'blue', 'green', 'yellow'];
const WILDS = new Set(['RAINBOW', 'MEGARAINBOW']);

/** skill.md's documented baseline heuristic, played straight. */
function decide(legalMoves, view) {
  const plays = legalMoves.filter((m) => m.type === 'playCard');
  if (plays.length === 0) {
    return legalMoves.find((m) => m.type === 'drawCard')
      ?? legalMoves.find((m) => m.type === 'passTurn')
      ?? legalMoves[0];
  }
  const hand = view?.yourHand ?? [];
  const colorCount = Object.fromEntries(COLORS.map((c) => [c, hand.filter((x) => x.color === c).length]));
  const threat = (view?.seats ?? []).some((s) => s.agentId !== view?.selfId && s.handCount <= 2);

  const score = (m) => {
    const sym = m.card.symbol;
    let s = 0;
    if (WILDS.has(sym)) s -= 40;                      // keep the escape hatch
    if (/^[0-9]$/.test(sym)) s += 20;                 // plain numbers first
    if (threat && ['GRAB2', 'PASS', 'MEGARAINBOW'].includes(sym)) s += 45;
    if (m.card.color) s += colorCount[m.card.color] ?? 0;
    return s;
  };
  const best = plays.reduce((a, b) => (score(b) > score(a) ? b : a));
  if (best.card.color == null) {
    const pick = COLORS.reduce((a, b) => ((colorCount[b] ?? 0) > (colorCount[a] ?? 0) ? b : a));
    return { type: 'playCard', card: { symbol: best.card.symbol, color: pick } };
  }
  return best;
}

// ---------------------------------------------------------------- agents

function loadState() {
  try { return JSON.parse(fs.readFileSync(CFG.state, 'utf8')); } catch { return { agents: [] }; }
}
function saveState(state) { fs.writeFileSync(CFG.state, JSON.stringify(state, null, 2)); }

async function ensureFleet() {
  const state = loadState();
  const wanted = CFG.agents;
  while (state.agents.length < wanted) {
    const i = state.agents.length;
    const mode = CFG.modes[i % CFG.modes.length];
    // The name is permanent (skill.md "Your name") and must be unique per agent —
    // it must NOT encode the game type, because the same fleet plays both.
    const displayName = `${CFG.namePrefix}-${String(i + 1).padStart(2, '0')}`;
    const out = await api('POST', '/register', { displayName });
    if (!out?.apiKey || !out?.agentId) finding('REGISTER_MISSING_FIELDS', JSON.stringify(out).slice(0, 200));
    state.agents.push({ agentId: out.agentId, apiKey: out.apiKey, displayName, mode });
    saveState(state);
    process.stdout.write(`registered ${displayName} ${out.agentId}\n`);
    await sleep(120);
  }
  // Mode assignment can change between runs; re-derive it deterministically.
  state.agents.forEach((a, i) => { a.mode = CFG.modes[i % CFG.modes.length]; });
  saveState(state);
  return state.agents.slice(0, wanted);
}

let STOPPING = false;
const modeDone = (mode) => M.perMode[mode].completedSessions.size >= CFG.games;

async function recordResult(agent, sessionId, mode) {
  let results;
  try {
    results = await api('GET', `/session/results?sessionId=${encodeURIComponent(sessionId)}`, undefined, { agent });
  } catch { return null; }
  const r = (results?.results ?? [])[0];
  if (!r) { finding('RESULTS_MISSING_FOR_FINISHED_TABLE', sessionId); return null; }

  if (r.place == null || r.coinDelta == null) finding('RESULT_NULL_PLACE_OR_COINDELTA', JSON.stringify(r).slice(0, 300));
  if (r.place != null && (r.place < 1 || r.place > r.placedOf)) finding('RESULT_PLACE_OUT_OF_RANGE', JSON.stringify(r).slice(0, 300));
  if (r.placedOf != null && r.seats != null && r.placedOf !== r.seats) finding('RESULT_PLACEDOF_NE_SEATS', JSON.stringify(r).slice(0, 300));
  if (r.won && r.place !== 1) finding('RESULT_WON_BUT_NOT_FIRST', JSON.stringify(r).slice(0, 300));
  if (!r.won && r.place === 1) finding('RESULT_FIRST_BUT_NOT_WON', JSON.stringify(r).slice(0, 300));
  if (r.competitionId && M.perMode[mode].competitionId && r.competitionId !== M.perMode[mode].competitionId) {
    finding('RESULT_COMPETITION_MISMATCH', JSON.stringify(r).slice(0, 300));
  }
  if (!['empty_hand', 'timeout'].includes(r.reason)) finding('RESULT_UNKNOWN_REASON', JSON.stringify(r).slice(0, 300));
  if (r.won && r.winnerAgentId !== agent.agentId) finding('RESULT_WON_BUT_WINNER_IS_SOMEONE_ELSE', JSON.stringify(r).slice(0, 300));
  if (!r.won && r.winnerAgentId === agent.agentId) finding('RESULT_WINNER_IS_ME_BUT_NOT_WON', JSON.stringify(r).slice(0, 300));
  if (r.won && r.finalHandValue !== 0 && r.reason === 'empty_hand') {
    finding('EMPTY_HAND_WINNER_WITH_NONZERO_HAND_VALUE', JSON.stringify(r).slice(0, 300));
  }
  // Placement settlement is a fixed step around the midpoint, so a table's payouts
  // are fully determined by (place, placedOf). Check every row against that.
  const step = M.serverConfig?.coinPlaceStep;
  if (step != null && r.place != null && r.placedOf != null && r.coinDelta != null) {
    const expected = Math.round(step * ((r.placedOf + 1) / 2 - r.place));
    M.settlement.checked++;
    if (expected !== r.coinDelta) {
      M.settlement.mismatches++;
      finding('COIN_DELTA_OFF_PLACEMENT_CURVE', JSON.stringify({ ...r, expected }).slice(0, 400));
      if (M.settlement.samples.length < 10) M.settlement.samples.push({ ...r, expected });
    }
    (M.settlement.byShape[`${r.placedOf}seats/place${r.place}`] ??= new Set()).add(r.coinDelta);
  }

  const audit = (M.coinAudit[sessionId] ??= { seats: r.placedOf ?? r.seats ?? null, mode, deltas: {}, places: {}, rows: {} });
  audit.deltas[agent.agentId] = r.coinDelta;
  audit.places[agent.agentId] = r.place;
  audit.rows[agent.agentId] = { place: r.place, coinDelta: r.coinDelta, finalHandValue: r.finalHandValue, won: r.won };

  const pm = M.perMode[mode];
  if (r.won) pm.wins++;
  if (r.reason === 'timeout') pm.timeoutFinishes++;
  if (r.reason === 'empty_hand') pm.emptyHandFinishes++;
  return r;
}

async function playOneTable(agent) {
  const mode = agent.mode;
  const pm = M.perMode[mode];

  // skill.md: re-read list-active before EVERY table (seasons roll over).
  const list = await api('GET', '/competition/list-active', undefined, { agent });
  const comp = (list?.competitions ?? []).find((c) => c.kind === mode && c.entryFeeWei === '0');
  if (!comp) { finding('NO_FREE_COMPETITION_FOR_MODE', mode); await sleep(5000); return; }
  if (pm.competitionId && pm.competitionId !== comp.id) finding('SEASON_ROLLED_OVER_MID_RUN', `${pm.competitionId} -> ${comp.id}`);
  pm.competitionId = comp.id; pm.competitionName = comp.name;

  if (mode === 'tournament' && !agent.entered?.[comp.id]) {
    try {
      await api('POST', '/competition/enter', { competitionId: comp.id }, { agent });
      (agent.entered ??= {})[comp.id] = true;
    } catch (e) {
      if (e.status === 402) { finding('TOURNAMENT_BUYIN_REQUIRED_ON_FREE_COMP', JSON.stringify(e.body).slice(0, 200)); STOPPING = true; return; }
      if (e.status === 403) { finding('TOURNAMENT_CLAIM_REQUIRED', JSON.stringify(e.body).slice(0, 200)); STOPPING = true; return; }
      throw e;
    }
  }

  // ---- join
  let sessionId = null;
  const joinedAt = now();
  try {
    const j = await api('POST', '/session/join', { competitionId: comp.id }, { agent });
    pm.joins++;
    sessionId = j.sessionId;
    if (!['lobby', 'seated'].includes(j.status)) finding('JOIN_UNKNOWN_STATUS', JSON.stringify(j).slice(0, 300));
    if (!('startsInMs' in j)) finding('JOIN_MISSING_startsInMs', JSON.stringify(j).slice(0, 300));
    if (j.rebuy) {
      pm.rebuys++;
      if (M.rebuys.length < 100) M.rebuys.push({ agent: agent.displayName, mode, ...j.rebuy, at: new Date().toISOString() });
    }
  } catch (e) {
    if (e.status === 409) {
      pm.alreadySeated409++;
      const pending = await api('GET', '/session/pending-actions', undefined, { agent });
      const mine = (pending?.sessions ?? [])[0];
      if (!mine) { finding('409_ALREADY_SEATED_BUT_NO_PENDING_SESSION', agent.agentId); await sleep(2000); return; }
      sessionId = mine.sessionId;
    } else if (e.status === 402) {
      const err = e.body?.error;
      if (err === 'INSUFFICIENT_COINS') { pm.insufficientCoins++; agent.broke = true; return; }
      finding('UNEXPECTED_402_ON_FREE_JOIN', JSON.stringify(e.body).slice(0, 200));
      await sleep(3000); return;
    } else if (e.status === 403) {
      finding('JOIN_403_ON_UNGATED_COMPETITION', JSON.stringify(e.body).slice(0, 200));
      STOPPING = true; return;
    } else { throw e; }
  }

  // ---- poll & act
  let step = 0, moves = 0, dealtAt = null, sawInProgress = false;
  let lastProgress = now();
  const IDLE_LIMIT = 11 * 60 * 1000; // > gameTimeLimitMs (540s) so we never abandon a live table

  for (;;) {
    if (now() - lastProgress > IDLE_LIMIT) {
      finding('TABLE_WENT_QUIET_PAST_TIME_LIMIT', `${sessionId} idle ${((now() - lastProgress) / 1000) | 0}s`);
      pm.tablesAbandoned++;
      return;
    }
    let pending;
    try { pending = await api('GET', '/session/pending-actions', undefined, { agent }); }
    catch { await sleep(CFG.pollMs); continue; }

    const sessions = pending?.sessions ?? [];
    if (sessions.length > 1) finding('AGENT_SEATED_AT_MULTIPLE_TABLES', JSON.stringify(sessions.map((s) => s.sessionId)));
    const mine = sessions.find((s) => s.sessionId === sessionId);

    if (!mine) {
      // Table left the pending list -> it ended (or the lobby was reaped).
      if (!sawInProgress) {
        pm.tablesAbandoned++;
        finding('LOBBY_REAPED_BEFORE_DEALING', `${sessionId} after ${((now() - joinedAt) / 1000).toFixed(1)}s`);
        return;
      }
      const r = await recordResult(agent, sessionId, mode);
      pm.tablesCompleted++;
      pm.completedSessions.add(sessionId);
      pm.moves += moves;
      if (dealtAt) reservoir(M.gameDurations[mode], now() - dealtAt);
      return r;
    }

    checkPending(mine, agent);

    if (mine.status !== 'in_progress') {
      lastProgress = now();
      await sleep(CFG.lobbyPollMs);
      continue;
    }
    if (!sawInProgress) {
      sawInProgress = true;
      dealtAt = now();
      reservoir(M.lobbyWaits[mode], dealtAt - joinedAt);
    }
    if (!mine.yourTurn) { await sleep(CFG.pollMs); continue; }

    const move = decide(mine.legalMoves, mine.view ? { ...mine.view, selfId: agent.agentId } : null);
    if (!move) { finding('DECIDE_PRODUCED_NO_MOVE', JSON.stringify(mine.legalMoves)); await sleep(CFG.pollMs); continue; }
    try {
      await api('POST', '/session/action', {
        sessionId, move,
        reasoning: 'soak: playing the documented baseline heuristic from skill.md',
        idempotencyKey: `${agent.agentId}-${sessionId}-${step++}`,
      }, { agent });
      moves++; lastProgress = now();
    } catch (e) {
      if (e.status === 400) {
        pm.illegalMoveRejections++;
        finding('LEGAL_MOVE_REJECTED_AS_ILLEGAL', JSON.stringify({ move, body: e.body }).slice(0, 400));
      } else if (e.status === 409) {
        pm.notYourTurn409++;
        // Most often: our deadline expired and the arena auto-played for us.
        if (mine.deadlineMs != null && mine.deadlineMs < 2000) pm.deadlineMisses++;
      } else if (e.status === 410 || e.status === 404) {
        // Table ended under us; the next poll settles it.
      } else { throw e; }
      await sleep(CFG.pollMs);
    }
  }
}

async function runAgent(agent) {
  while (!STOPPING && !agent.broke) {
    // When this agent's game type hits its target, move it onto one that has not —
    // otherwise the fleet halves itself just as the slower mode needs it most.
    if (modeDone(agent.mode)) {
      const next = CFG.modes.find((m) => !modeDone(m));
      if (!next) break;
      if (next !== agent.mode) {
        process.stdout.write(`${agent.displayName}: ${agent.mode} target met -> switching to ${next}\n`);
        agent.mode = next;
      }
    }
    try { await playOneTable(agent); }
    catch (e) {
      finding('AGENT_LOOP_EXCEPTION', `${agent.displayName}: ${e.status ?? ''} ${String(e.message)}`);
      if (M.errors.length < 200) M.errors.push({ at: new Date().toISOString(), tag: 'loop', body: String(e.stack ?? e).slice(0, 400) });
      await sleep(2000);
    }
    await sleep(CFG.betweenTablesMs + Math.random() * 400);
  }
}

// ---------------------------------------------------------------- report

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function auditCoins() {
  // Placement settlement pools the buy-ins and pays them straight back out, so
  // across a table where WE hold every seat the coin deltas must sum to zero.
  const out = {
    checked: 0, fullTables: 0, nonZeroSum: 0, samples: [], duplicatePlaces: 0, worstAbsSum: 0,
    // Ties share a `place` but are paid by RANK, and the rank tie-break in
    // packages/api/src/coins.ts is lexicographic on agentId. If that is what
    // production does, the agent with the smaller id wins every tie it is in.
    ties: { tiedGroups: 0, groupsWithUnequalPay: 0, lowerIdPaidMore: 0, higherIdPaidMore: 0, samples: [] },
  };
  for (const [sid, a] of Object.entries(M.coinAudit)) {
    out.checked++;
    const seen = Object.keys(a.deltas).length;
    if (a.seats == null || seen !== a.seats) continue;
    out.fullTables++;
    const sum = Object.values(a.deltas).reduce((x, y) => x + (y ?? 0), 0);
    if (sum !== 0) {
      out.nonZeroSum++;
      out.worstAbsSum = Math.max(out.worstAbsSum, Math.abs(sum));
      if (out.samples.length < 10) out.samples.push({ sessionId: sid, sum, deltas: a.deltas, places: a.places });
    }
    const places = Object.values(a.places).filter((p) => p != null);
    if (new Set(places).size !== places.length) {
      out.duplicatePlaces++;
      const byPlace = {};
      for (const [id, row] of Object.entries(a.rows)) (byPlace[row.place] ??= []).push({ id, ...row });
      for (const group of Object.values(byPlace)) {
        if (group.length < 2) continue;
        out.ties.tiedGroups++;
        const deltas = new Set(group.map((g) => g.coinDelta));
        if (deltas.size > 1) {
          out.ties.groupsWithUnequalPay++;
          const sorted = [...group].sort((x, y) => (x.id < y.id ? -1 : 1));
          const best = [...group].sort((x, y) => y.coinDelta - x.coinDelta)[0];
          if (best.id === sorted[0].id) out.ties.lowerIdPaidMore++;
          else out.ties.higherIdPaidMore++;
          if (out.ties.samples.length < 20) out.ties.samples.push({ sessionId: sid, seats: a.seats, group });
        }
      }
    }
  }
  return out;
}

function buildReport() {
  const perMode = {};
  for (const m of CFG.modes) {
    const pm = M.perMode[m];
    perMode[m] = {
      ...pm,
      completedSessions: undefined,
      distinctTables: pm.completedSessions.size,
      gameDurationMs: { p50: pct(M.gameDurations[m], 50), p90: pct(M.gameDurations[m], 90), p99: pct(M.gameDurations[m], 99), max: Math.max(0, ...M.gameDurations[m]) },
      lobbyWaitMs: { p50: pct(M.lobbyWaits[m], 50), p90: pct(M.lobbyWaits[m], 90), max: Math.max(0, ...M.lobbyWaits[m]) },
    };
  }
  const latency = {};
  for (const [k, v] of Object.entries(M.latency)) {
    latency[k] = { n: v.length, p50: pct(v, 50), p90: pct(v, 90), p99: pct(v, 99), max: Math.max(...v) };
  }
  return {
    startedAt: M.startedAt, at: new Date().toISOString(),
    elapsedSec: Math.round((now() - START) / 1000),
    config: CFG, perMode, latency, http: M.http, net: M.net,
    findings: M.findings, findingSamples: M.findingSamples,
    serverConfig: M.serverConfig,
    settlement: {
      ...M.settlement,
      byShape: Object.fromEntries(Object.entries(M.settlement.byShape).map(([k, v]) => [k, [...v]])),
    },
    coinAudit: auditCoins(),
    coinsSeen: M.coinsSeen,
    storms: M.storms, rebuys: M.rebuys.slice(0, 20),
    errorSamples: M.errors.slice(0, 40),
    finalSnapshot: M.finalSnapshot ?? null,
  };
}

const START = now();
function writeReport() {
  const rep = buildReport();
  fs.writeFileSync(CFG.report, JSON.stringify(rep, null, 2));
  const line = CFG.modes.map((m) => `${m}=${rep.perMode[m].distinctTables}/${CFG.games}`).join(' ');
  process.stdout.write(`[${rep.elapsedSec}s] ${line} findings=${Object.keys(M.findings).length} httpErr=${M.errors.length}\n`);
  return rep;
}

// ---------------------------------------------------------------- main

// The settlement curve is published — read it so every result row can be checked
// against the closed form rather than against a number hard-coded here.
try {
  M.serverConfig = await api('GET', '/config', undefined, { agent: { apiKey: null }, expect: new Set([401, 403, 404]) });
} catch { /* /config needs auth on some deployments; filled in below from a fleet key */ }

const fleet = await ensureFleet();
if (!M.serverConfig) {
  try { M.serverConfig = await api('GET', '/config', undefined, { agent: fleet[0], expect: new Set([404]) }); }
  catch { finding('CONFIG_ENDPOINT_UNREADABLE', 'GET /config failed with and without a key'); }
}
process.stdout.write(`server config: ${JSON.stringify(M.serverConfig)}\n`);
process.stdout.write(`fleet of ${fleet.length} ready; target ${CFG.games} tables per mode (${CFG.modes.join(', ')})\n`);

const ticker = setInterval(writeReport, 30_000);
const stop = () => { STOPPING = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await Promise.all(fleet.map((a, i) => sleep(i * 150).then(() => runAgent(a))));

clearInterval(ticker);

// Closing snapshot: what the standings and our balances actually look like.
M.finalSnapshot = { agents: [], leaderboards: {} };
for (const a of fleet) {
  try {
    const me = await api('GET', '/agent/me', undefined, { agent: a });
    M.coinsSeen[a.agentId] = me.coins;
    M.finalSnapshot.agents.push({ displayName: a.displayName, mode: a.mode, agentId: a.agentId, coins: me.coins, profileUrl: me.profileUrl });
  } catch { /* snapshot is advisory */ }
}
for (const m of CFG.modes) {
  const cid = M.perMode[m].competitionId;
  if (!cid) continue;
  try {
    const lb = await api('GET', `/competition/leaderboard?competitionId=${encodeURIComponent(cid)}`, undefined, { agent: fleet[0] });
    const rows = lb?.leaderboard ?? [];
    if (!Array.isArray(rows)) finding('LEADERBOARD_NOT_AN_ARRAY', JSON.stringify(lb).slice(0, 200));
    for (const row of rows) {
      if (row.netCoins == null || row.coins == null) finding('LEADERBOARD_ROW_MISSING_COIN_FIELDS', JSON.stringify(row).slice(0, 200));
      else if (row.netCoins !== row.coins - (row.rebuysUsed ?? 0) * 1000) {
        finding('LEADERBOARD_NETCOINS_FORMULA_MISMATCH', JSON.stringify(row).slice(0, 200));
      }
    }
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i - 1].netCoins ?? 0) < (rows[i].netCoins ?? 0)) { finding('LEADERBOARD_NOT_SORTED_BY_NETCOINS', JSON.stringify(rows.slice(i - 1, i + 1)).slice(0, 300)); break; }
    }
    M.finalSnapshot.leaderboards[m] = { competitionId: cid, size: rows.length, top: rows.slice(0, 15) };
  } catch { /* snapshot is advisory */ }
}

const final = writeReport();
process.stdout.write(`\nDONE in ${final.elapsedSec}s — report at ${CFG.report}\n`);
