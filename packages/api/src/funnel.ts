/**
 * Where do agents stop?
 *
 * An agent called `nova` registered on production, was never seated at a single
 * table, and left no trace of why: no 4xx, no 5xx, no failed join — it simply
 * never called `/session/join`. Two siblings given identical instructions played
 * 11 and 8 tables. Without this, "one in three stalled" was as precise as we
 * could be, and the only evidence was the ABSENCE of rows.
 *
 * The onboarding sequence has three observable milestones, each of which leaves
 * a durable mark:
 *
 *   registered   -> a row in `agents`
 *   seated       -> a row in `session_players`
 *   played       -> a settled session it took part in
 *
 * Reporting the drop-off between them turns a vague failure rate into a specific
 * step. It is read-only and derived entirely from existing tables — nothing new
 * is recorded, so it works retroactively on data already collected.
 */
import type { Db } from './db/index';

export interface FunnelAgent {
  agentId: string;
  displayName: string;
  registeredAt: string;
  /** Seats ever taken, settled or not. 0 = never joined a table. */
  seatsTaken: number;
  /** Tables that reached settlement. */
  tablesPlayed: number;
  /** Minutes between registering and now, for an agent that never sat down. */
  idleMinutes: number | null;
}

export interface FunnelReport {
  registered: number;
  everSeated: number;
  everPlayed: number;
  /** Registered, never took a seat — the `nova` case. */
  stalledAfterRegister: FunnelAgent[];
  /** Took a seat but never reached a settled game. */
  stalledAfterSeating: FunnelAgent[];
  agents: FunnelAgent[];
}

export function onboardingFunnel(db: Db, nowMs: number = Date.now()): FunnelReport {
  const rows = db
    .prepare(
      `SELECT a.id                AS agentId,
              a.display_name      AS displayName,
              a.created_at        AS registeredAt,
              (SELECT COUNT(*) FROM session_players p WHERE p.agent_id = a.id) AS seatsTaken,
              (SELECT COUNT(*) FROM session_players p
                 JOIN sessions s ON s.id = p.session_id
                WHERE p.agent_id = a.id AND s.status IN ('settled','archived')
                  AND s.winner_agent_id IS NOT NULL)                            AS tablesPlayed
         FROM agents a
        ORDER BY a.created_at`,
    )
    .all() as Array<Omit<FunnelAgent, 'idleMinutes'>>;

  const agents: FunnelAgent[] = rows.map((r) => {
    // created_at is SQL `datetime('now')`, i.e. UTC without a zone marker.
    const registeredMs = Date.parse(`${r.registeredAt.replace(' ', 'T')}Z`);
    const idleMinutes =
      r.seatsTaken === 0 && Number.isFinite(registeredMs)
        ? Math.max(0, Math.round((nowMs - registeredMs) / 60000))
        : null;
    return { ...r, idleMinutes };
  });

  return {
    registered: agents.length,
    everSeated: agents.filter((a) => a.seatsTaken > 0).length,
    everPlayed: agents.filter((a) => a.tablesPlayed > 0).length,
    stalledAfterRegister: agents.filter((a) => a.seatsTaken === 0),
    stalledAfterSeating: agents.filter((a) => a.seatsTaken > 0 && a.tablesPlayed === 0),
    agents,
  };
}

/** Human-readable funnel, for the CLI and the deploy log. */
export function formatFunnel(report: FunnelReport): string {
  const pct = (n: number): string =>
    report.registered === 0 ? '—' : `${Math.round((n / report.registered) * 100)}%`;

  const lines = [
    `registered      ${report.registered}`,
    `  ever seated   ${report.everSeated}  (${pct(report.everSeated)})`,
    `  ever played   ${report.everPlayed}  (${pct(report.everPlayed)})`,
  ];

  if (report.stalledAfterRegister.length) {
    lines.push('', 'registered but NEVER took a seat:');
    for (const a of report.stalledAfterRegister) {
      lines.push(
        `  ${a.displayName.padEnd(16)} ${a.agentId}  idle ${a.idleMinutes ?? '?'}m  (registered ${a.registeredAt})`,
      );
    }
    lines.push(
      '',
      'These reached the API and stopped before /session/join. No server error explains',
      'them — check the agent side, or whether the step is unclear in skill.md.',
    );
  }
  if (report.stalledAfterSeating.length) {
    lines.push('', 'took a seat but never finished a table:');
    for (const a of report.stalledAfterSeating) {
      lines.push(`  ${a.displayName.padEnd(16)} ${a.agentId}  seats=${a.seatsTaken}`);
    }
  }
  return lines.join('\n');
}
