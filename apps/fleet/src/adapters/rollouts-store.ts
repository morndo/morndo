// The Rollouts in fleet.db (migration 16). Every write is synced (db.ts `synced`): a halt must outlive the machine
// (RL12), so a fleet that restarts answers the same Rollout it held — GET /v1/rollout after a restart is the halt
// that stopped every node's updates. The rows hold the wire's fields (RolloutWire) beside resumed_at (the last
// resume, for the audit's story: the wire doesn't carry it) and updated_at (the last write).
import type Database from "better-sqlite3";
import type { RolloutWire } from "@morndo/protocol";
import { synced } from "./db.ts";

type Row = {
  version: string; control_plane_committed_at: number | null; soak_minutes: number; halted: number;
  halted_by: string | null; halt_reason: string | null; halted_at: number | null; resumed_at: number | null;
  updated_at: number;
};
const fromRow = (r: Row): RolloutWire => ({
  version: r.version, controlPlaneCommittedAt: r.control_plane_committed_at, soakMinutes: r.soak_minutes,
  halted: r.halted === 1, haltedBy: r.halted_by, haltReason: r.halt_reason, haltedAt: r.halted_at,
});

export class RolloutsStore {
  #db: Database.Database;
  #now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  get(version: string): RolloutWire | null {
    const r = this.#db.prepare("SELECT * FROM rollouts WHERE version = ?").get(version) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  list(): RolloutWire[] {
    return (this.#db.prepare("SELECT * FROM rollouts").all() as Row[]).map(fromRow);
  }

  // An update.apply the fleet forwarded to a node (an offer, review of #107). Synced like the halts.
  asked(node: string, version: string): void {
    const now = this.#now();
    synced(this.#db, () => this.#db.prepare("INSERT INTO update_asks (node, version, at) VALUES (?, ?, ?) ON CONFLICT(node, version) DO UPDATE SET at = excluded.at").run(node, version, now));
  }
  // The Versions the fleet asked this node to apply.
  askedOf(node: string): string[] {
    return (this.#db.prepare("SELECT version FROM update_asks WHERE node = ?").all(node) as { version: string }[]).map(r => r.version);
  }
  // Marks one rollback report acted on; false when it was already (each counts once, by its attempt).
  firstReport(machine: string, attempt: string): boolean {
    const now = this.#now();
    return synced(this.#db, () => this.#db.prepare("INSERT OR IGNORE INTO rollback_reports (machine, attempt, at) VALUES (?, ?, ?)").run(machine, attempt, now).changes === 1);
  }

  // Writes the Rollout of one Version whole. A write that clears a halt records when the fleet resumed it (the row's
  // own write time, `updated_at`: one clock, one value).
  put(r: RolloutWire): RolloutWire {
    const now = this.#now();
    return synced(this.#db, () => this.#db.transaction((): RolloutWire => {
      this.#db.prepare(`INSERT INTO rollouts (version, control_plane_committed_at, soak_minutes, halted, halted_by, halt_reason, halted_at, resumed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version) DO UPDATE SET control_plane_committed_at = excluded.control_plane_committed_at, soak_minutes = excluded.soak_minutes,
          halted = excluded.halted, halted_by = excluded.halted_by, halt_reason = excluded.halt_reason, halted_at = excluded.halted_at,
          resumed_at = CASE WHEN rollouts.halted = 1 AND excluded.halted = 0 THEN excluded.updated_at ELSE rollouts.resumed_at END,
          updated_at = excluded.updated_at`)
        .run(r.version, r.controlPlaneCommittedAt, r.soakMinutes, r.halted ? 1 : 0, r.haltedBy, r.haltReason, r.haltedAt, null, now);
      return r;
    }))();
  }
}
