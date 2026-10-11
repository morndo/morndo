// The node that last reported a window of each sticky lane name (fleet clients spec §4.6), in fleet.db's sticky_lanes
// (migration 15). Not synced (spec §6): after a power loss the next inventory writes it again.
import type Database from "better-sqlite3";

export type StickyRow = { name: string; node: string; at: number };

export class StickyLanesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(name: string): StickyRow | null {
    return (this.#db.prepare("SELECT name, node, at FROM sticky_lanes WHERE name = ?").get(name) as StickyRow | undefined) ?? null;
  }

  set(name: string, node: string, at: number): void {
    this.#db.prepare(`INSERT INTO sticky_lanes (name, node, at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET node = excluded.node, at = excluded.at`).run(name, node, at);
  }
}
