// Lane events (fleet clients spec §7) in fleet.db's lane_events (migration 15): written in the intake's synced commit
// with the hooks they come from (insert), read by GET /v1/lane-events (since) and by the manager's batches (waiting).
// to_manager: 0 waiting for the manager, 1 in a delivery its node stored (delivery_id names it), NULL not for the
// manager. The marks are not synced (spec §6): one a power loss takes back sends those events once more.
import type Database from "better-sqlite3";
import type { LaneEvent, LaneEventName } from "@morndo/protocol";

export type LaneEventDraft = Omit<LaneEvent, "seq">;
type Row = {
  seq: number; node: string; window: string | null; lane: string | null; session_id: string | null; event: LaneEventName; at: number; body: string;
};
// The fields of each event beyond the columns, as the body column keeps them. A `finished`'s pending `tasks` and `wakes`
// (ADR-0032, R6) are kept with it, so GET /v1/lane-events and the lane watch's rebuild read them back as they were.
const BODY_FIELDS = ["status", "firstLine", "bg", "crons", "question", "error", "waitingOn", "until", "reason", "since", "stalls", "tasks", "wakes"] as const;
const eventOf = (r: Row): LaneEvent => ({
  v: 1, t: "lane", seq: r.seq, event: r.event, node: r.node, window: r.window, lane: r.lane,
  ...(r.session_id === null ? {} : { sessionId: r.session_id }), at: r.at, ...(JSON.parse(r.body) as Partial<LaneEvent>),
});
const COLUMNS = "seq, node, window, lane, session_id, event, at, body";

export class LaneEventsStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  insert(d: LaneEventDraft, toManager: 0 | null): LaneEvent {
    const body = Object.fromEntries(BODY_FIELDS.filter(k => d[k] !== undefined).map(k => [k, d[k]]));
    const r = this.#db.prepare("INSERT INTO lane_events (node, window, lane, session_id, event, at, body, to_manager) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.node, d.window, d.lane, d.sessionId ?? null, d.event, d.at, JSON.stringify(body), toManager);
    return { ...d, seq: Number(r.lastInsertRowid) };
  }

  // Events after `seq`, oldest first, at most `limit`.
  since(seq: number, limit: number): LaneEvent[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM lane_events WHERE seq > ? ORDER BY seq LIMIT ?`).all(seq, limit) as Row[]).map(eventOf);
  }

  // A session's latest lane event, by name; null when it has none (lane_events_by_session: "x=?" lets SQLite use a partial
  // index on "x IS NOT NULL", https://www.sqlite.org/partialindex.html, read 2026-10-08).
  lastOf(sessionId: string): LaneEventName | null {
    const r = this.#db.prepare("SELECT event FROM lane_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as { event: LaneEventName } | undefined;
    return r?.event ?? null;
  }

  // What the lane watch rebuilds from, after the time `after`, oldest first: the turn ends and stale events, and the
  // session state changes and failed turn ends that may follow a turn end (activity, as they were live).
  turnsSince(after: number): LaneEvent[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM lane_events WHERE at > ? AND event IN ('finished', 'stale', 'needs_input', 'answered', 'stop_failure') ORDER BY seq`)
      .all(after) as Row[]).map(eventOf);
  }

  // Events waiting for the manager, oldest first, at most `limit`.
  waiting(limit: number): LaneEvent[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM lane_events WHERE to_manager = 0 ORDER BY seq LIMIT ?`).all(limit) as Row[]).map(eventOf);
  }

  markSent(seqs: number[], deliveryId: string): void {
    this.#db.prepare("UPDATE lane_events SET to_manager = 1, delivery_id = ? WHERE seq IN (SELECT value FROM json_each(?)) AND to_manager = 0")
      .run(deliveryId, JSON.stringify(seqs));
  }

  // The events of a delivery that was given up wait for the manager again; returns how many.
  requeue(deliveryId: string): number {
    return this.#db.prepare("UPDATE lane_events SET to_manager = 0, delivery_id = NULL WHERE delivery_id = ? AND to_manager = 1").run(deliveryId).changes;
  }

  // The deliveries that carry events marked sent.
  sentIn(): string[] {
    return (this.#db.prepare("SELECT DISTINCT delivery_id FROM lane_events WHERE to_manager = 1 AND delivery_id IS NOT NULL").all() as { delivery_id: string }[])
      .map(r => r.delivery_id);
  }

  prune(before: number): number {
    return this.#db.prepare("DELETE FROM lane_events WHERE at < ?").run(before).changes;
  }
}
