import type { SessionEventRecord, SessionEventStore } from 'engine';
import type { Db } from './index';

/**
 * SQLite implementation of the engine's persistence port (spec 03 / T7).
 *
 * The engine owns the event shape and writes through this interface; the API
 * layer only supplies storage. `session_events` rows map 1:1 onto
 * {@link SessionEventRecord}, so this is a plain INSERT/SELECT — no translation,
 * and no second place where events could be regenerated differently (§4).
 */
export class SqliteSessionEventStore implements SessionEventStore {
  private readonly insert;
  private readonly selectAll;

  constructor(db: Db) {
    this.insert = db.prepare(
      `INSERT INTO session_events (session_id, seq, event_type, payload_json, reasoning, created_at)
       VALUES (@sessionId, @seq, @eventType, @payloadJson, @reasoning, @createdAt)`,
    );
    this.selectAll = db.prepare(
      `SELECT session_id AS sessionId, seq, event_type AS eventType, payload_json AS payloadJson,
              reasoning, created_at AS createdAt
         FROM session_events
        WHERE session_id = ?
        ORDER BY seq`,
    );
  }

  append(record: SessionEventRecord): void {
    this.insert.run({
      sessionId: record.sessionId,
      seq: record.seq,
      eventType: record.eventType,
      payloadJson: record.payloadJson,
      reasoning: record.reasoning,
      createdAt: record.createdAt,
    });
  }

  readAll(sessionId: string): SessionEventRecord[] {
    return this.selectAll.all(sessionId) as SessionEventRecord[];
  }
}
