// The deliveries' mirror (fleet clients spec §4.6): the latest state of each delivery its node reported, in fleet.db's
// lane_deliveries (migration 15), never its text. Not synced (spec §6): a state lost to a power loss comes back with the
// node's next report (ev.delivery after every reconnect). `alerted` counts the delivery_waiting thresholds raised for it.
// The application decides what replaces what (application/deliveries.ts); this only reads and writes rows.
import type Database from "better-sqlite3";
import type { Delivery, DeliveryState } from "@morndo/protocol";

export type DeliveryRow = { id: string; node: string; delivery: Delivery; updatedAt: number; alerted: number };
type Row = { id: string; node: string; body: string; updated_at: number; alerted: number };
const rowOf = (r: Row): DeliveryRow => ({ id: r.id, node: r.node, delivery: JSON.parse(r.body) as Delivery, updatedAt: r.updated_at, alerted: r.alerted });

export class LaneDeliveriesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(id: string): DeliveryRow | null {
    const r = this.#db.prepare("SELECT id, node, body, updated_at, alerted FROM lane_deliveries WHERE id = ?").get(id) as Row | undefined;
    return r ? rowOf(r) : null;
  }

  // `alerted` stays as it is for a row already there.
  upsert(node: string, d: Delivery, at: number): void {
    this.#db.prepare(`INSERT INTO lane_deliveries (id, node, target, state, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET node = excluded.node, target = excluded.target, state = excluded.state, body = excluded.body,
        updated_at = excluded.updated_at`).run(d.id, node, JSON.stringify(d.target), d.state, JSON.stringify(d), at);
  }

  // The newest `limit` rows changed at or after `since`, of a lane (its name as the target) and a state when given,
  // oldest first.
  list(o: { since: number; lane?: string; state?: DeliveryState; limit: number }): DeliveryRow[] {
    const rows = this.#db.prepare(`SELECT id, node, body, updated_at, alerted FROM lane_deliveries
      WHERE updated_at >= ? AND (? IS NULL OR json_extract(target, '$.lane') = ?) AND (? IS NULL OR state = ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(o.since, o.lane ?? null, o.lane ?? null, o.state ?? null, o.state ?? null, o.limit) as Row[];
    return rows.reverse().map(rowOf);
  }

  // Every delivery still waiting (queued, typed or held) with a delivery_waiting threshold not yet raised.
  open(thresholds: number): DeliveryRow[] {
    return (this.#db.prepare(`SELECT id, node, body, updated_at, alerted FROM lane_deliveries
      WHERE state IN ('queued', 'typed', 'held') AND alerted < ? ORDER BY updated_at`).all(thresholds) as Row[]).map(rowOf);
  }

  setAlerted(id: string, alerted: number): void {
    this.#db.prepare("UPDATE lane_deliveries SET alerted = ? WHERE id = ?").run(alerted, id);
  }

  prune(before: number): number {
    return this.#db.prepare("DELETE FROM lane_deliveries WHERE updated_at < ?").run(before).changes;
  }
}
