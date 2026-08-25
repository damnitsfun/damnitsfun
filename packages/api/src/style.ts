/**
 * Sub-spec 19 (T74) — an agent's playing style, derived from its own moves.
 *
 * The reference profile (`arena.dev.fun`) names a style — "LOOSE & MEASURED" —
 * and then shows the numbers it came from, with a toggle for the raw jargon
 * underneath. That structure is the thing worth copying: the page **interprets**,
 * and the interpretation can always be checked against the evidence printed
 * directly beneath it (D118).
 *
 * Two rules follow from that, and both are load-bearing:
 *
 *  1. **The name is computed, never stored.** A stored archetype is a second
 *     source of truth that drifts from the log the moment either changes.
 *  2. **The metrics are this game's, not poker's** (D119). VPIP and PFR describe a
 *     game we do not run. Ours come from the card vocabulary agents actually play.
 *
 * Below {@link MIN_TABLES_FOR_STYLE} tables this returns `null` rather than a
 * confident label drawn from four hands — an archetype needs a sample, and
 * inventing a character for a new agent is worse than saying nothing.
 */
import type { Db } from './db/index';

/** An archetype needs a sample. Below this, the page says so instead. */
export const MIN_TABLES_FOR_STYLE = 20;

/**
 * ...and the sample has to be of DECISIONS, not just tables.
 *
 * Found by running the read model against a real server rather than only unit
 * tests: an agent that timed out of 25 tables satisfies the table minimum while
 * having played no cards at all, and every rate is then 0 — which the archetype
 * dutifully read as "sheds quickly, spends few punishers". That is a confident
 * character drawn from an empty log. Rates need a denominator before they mean
 * anything, so both gates must pass.
 */
export const MIN_CARDS_FOR_STYLE = 50;

export interface StyleMetrics {
  /** Cards played that punish the next seat, per 100 cards played. */
  aggression: number;
  /** Colour-changing cards played, per 100 cards played. */
  colourControl: number;
  /** Draws taken per 100 turns — high means waiting for a fit. */
  patience: number;
  /** Tables won as a percentage of tables played. */
  winRate: number;
  /** Mean finish scaled 0 (always first) → 1 (always last). */
  placeScore: number;
  /** Rainbow Storms triggered. A house-rule EVENT, never a card — see below. */
  storms: number;
  /** Median seconds between being given the turn and acting. */
  decisionSeconds: number | null;
  cardsPlayed: number;
  tables: number;
}

export interface AgentStyle {
  name: string;
  blurb: string;
  metrics: StyleMetrics;
  /** The plain-English rows the UI shows above the raw grid (D118). */
  rows: Array<{ label: string; detail: string; percent: number }>;
}

/**
 * `RAINBOWSTORM` is deliberately absent from the card mix.
 *
 * It is a house-rule event that can fire on any play, not a card an agent can
 * hold (`vocabulary.ts`). Counting it as a played symbol is exactly the mistake
 * that once produced a confident "zero storms all day" report while production
 * had fired two and paid a jackpot on-chain. It belongs in `storms`, never in the
 * mix.
 */
const PUNISHING = ['GRAB2', 'MEGARAINBOW'];
const COLOUR_CHOOSING = ['RAINBOW', 'MEGARAINBOW'];

export function agentStyle(db: Db, agentId: string, competitionId?: string): AgentStyle | null {
  const scope = competitionId ? `AND s.competition_id = @competitionId` : '';
  const args = { agentId, competitionId: competitionId ?? null };

  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT s.id) AS tables,
              COUNT(DISTINCT CASE WHEN s.winner_agent_id = p.agent_id THEN s.id END) AS won,
              AVG(CASE WHEN s.table_size > 1
                       THEN (p.place - 1.0) / (s.table_size - 1) END) AS placeScore
         FROM session_players p
         JOIN sessions s ON s.id = p.session_id AND s.status = 'settled'
        WHERE p.agent_id = @agentId ${scope}`,
    )
    .get(args) as { tables: number; won: number; placeScore: number | null };

  if (totals.tables < MIN_TABLES_FOR_STYLE) return null;

  const played = db
    .prepare(
      `SELECT json_extract(e.payload_json, '$.card.symbol') AS symbol, COUNT(*) AS n
         FROM session_events e
         JOIN sessions s ON s.id = e.session_id AND s.status = 'settled'
        WHERE e.event_type = 'CARD_PLAYED'
          AND json_extract(e.payload_json, '$.agentId') = @agentId ${scope}
        GROUP BY symbol`,
    )
    .all(args) as Array<{ symbol: string; n: number }>;

  const cardsPlayed = played.reduce((t, r) => t + r.n, 0);
  const countOf = (symbols: string[]): number =>
    played.filter((r) => symbols.includes(r.symbol)).reduce((t, r) => t + r.n, 0);

  const draws = db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_events e
         JOIN sessions s ON s.id = e.session_id AND s.status = 'settled'
        WHERE e.event_type = 'CARD_DRAWN'
          AND json_extract(e.payload_json, '$.cause') = 'draw'
          AND json_extract(e.payload_json, '$.agentId') = @agentId ${scope}`,
    )
    .get(args) as { n: number };

  const storms = db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_events e
         JOIN sessions s ON s.id = e.session_id AND s.status = 'settled'
        WHERE e.event_type = 'RAINBOW_STORM'
          AND json_extract(e.payload_json, '$.agentId') = @agentId ${scope}`,
    )
    .get(args) as { n: number };

  const per100 = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 100));
  // A turn is one decision: a card played, or a draw taken.
  const turns = cardsPlayed + draws.n;

  const metrics: StyleMetrics = {
    aggression: per100(countOf(PUNISHING), cardsPlayed),
    colourControl: per100(countOf(COLOUR_CHOOSING), cardsPlayed),
    patience: per100(draws.n, turns),
    winRate: per100(totals.won, totals.tables),
    placeScore: totals.placeScore ?? 0.5,
    storms: storms.n,
    decisionSeconds: null, // reserved: needs per-turn timing, not yet derived
    cardsPlayed,
    tables: totals.tables,
  };

  // Both gates: enough tables to be a record, and enough cards for a rate.
  if (cardsPlayed < MIN_CARDS_FOR_STYLE) return null;

  return { ...archetype(metrics), metrics, rows: describe(metrics) };
}

/**
 * Name the style from the numbers beneath it.
 *
 * Two axes, each split at a threshold picked from the real distribution rather
 * than invented: production agents play punishing cards on roughly 20 of every
 * 100 cards and draw on roughly 26 of every 100 turns, so those are the middles.
 * The name is a reading of the numbers, and the numbers are always shown.
 */
export function archetype(m: StyleMetrics): { name: string; blurb: string } {
  const pushy = m.aggression >= 20;
  const patient = m.patience >= 26;
  if (pushy && patient) {
    return { name: 'PATIENT & BRUTAL', blurb: 'waits for a fit, then punishes' };
  }
  if (pushy && !patient) {
    return { name: 'RELENTLESS', blurb: 'plays whatever it can, and it hurts' };
  }
  if (!pushy && patient) {
    return { name: 'QUIET & MEASURED', blurb: 'holds its shape, rarely picks a fight' };
  }
  return { name: 'FAST & PLAIN', blurb: 'sheds quickly, spends few punishers' };
}

/** The three plain-English rows shown above the raw grid (D118). */
function describe(m: StyleMetrics): AgentStyle['rows'] {
  return [
    {
      label: 'aggression',
      detail: `GRAB2/MEGARAINBOW on ${m.aggression} of every 100 cards`,
      percent: m.aggression,
    },
    {
      label: 'colour control',
      detail: `RAINBOW on ${m.colourControl} of every 100 cards`,
      percent: m.colourControl,
    },
    {
      label: 'patience',
      detail: `draws on ${m.patience} of every 100 turns`,
      percent: m.patience,
    },
  ];
}
