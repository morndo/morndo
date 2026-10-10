// The lanes table: one row per lane name, its owning node and worker, and whether its name is in conflict (spec 4,
// 6). The lane registry (application/lane-registry.ts) decides; this only reads and writes rows.
import type Database from "better-sqlite3";

export type LaneRow = { name: string; node: string; workerId: string | null; registeredAt: number; conflict: boolean };
type Row = { name: string; node: string; worker_id: string | null; registered_at: number; conflict: number };
const laneFrom = (r: Row): LaneRow => ({ name: r.name, node: r.node, workerId: r.worker_id, registeredAt: r.registered_at, conflict: r.conflict === 1 });

export class LanesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(name: string): LaneRow | null {
    const r = this.#db.prepare("SELECT * FROM lanes WHERE name = ?").get(name) as Row | undefined;
    return r ? laneFrom(r) : null;
  }

  all(): LaneRow[] {
    return (this.#db.prepare("SELECT * FROM lanes ORDER BY name").all() as Row[]).map(laneFrom);
  }

  namesOf(node: string): string[] {
    return (this.#db.prepare("SELECT name FROM lanes WHERE node = ?").all(node) as { name: string }[]).map(r => r.name);
  }

  upsert(l: LaneRow): void {
    this.#db.prepare(`INSERT INTO lanes (name, node, worker_id, registered_at, conflict) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET node = excluded.node, worker_id = excluded.worker_id, registered_at = excluded.registered_at, conflict = excluded.conflict`)
      .run(l.name, l.node, l.workerId, l.registeredAt, l.conflict ? 1 : 0);
  }

  delete(name: string): void { this.#db.prepare("DELETE FROM lanes WHERE name = ?").run(name); }

  // Removes the lanes of every node not in `nodes` (revoked or unknown), e.g. a revocation made while stopped.
  keepOnly(nodes: string[]): number {
    const keep = new Set(nodes);
    let removed = 0;
    for (const l of this.all()) if (!keep.has(l.node)) { this.delete(l.name); removed++; }
    return removed;
  }
}
