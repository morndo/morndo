// The Rollouts in fleet.db (migration 16). Every write is synced (db.ts `synced`): a halt must outlive the machine
// (RL12), so a fleet that restarts answers the same Rollout it held — GET /v1/rollout after a restart is the halt
// that stopped every node's updates. The rows hold the wire's fields (RolloutWire) beside resumed_at (the last
// resume, for the audit's story: the wire doesn't carry it) and updated_at (the last write).
import { randomBytes } from "node:crypto";
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

// How long an issued attempt id is kept (review of #107, round 4): a rollback is reported within minutes of its apply,
// and a node that comes back after a month gets a fresh offer.
export const ATTEMPT_RETENTION_MS = 30 * 86_400_000;

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

  // The attempt id the fleet issues a machine for a Version it offers it: the unspent one it already holds, else a new
  // random one (16 bytes, base64url). So rows stay bounded by the offers, never by what a node reports.
  issue(machine: string, version: string, now: number = this.#now()): string {
    const held = this.#db.prepare("SELECT attempt FROM rollout_attempts WHERE machine = ? AND version = ? AND used_at IS NULL ORDER BY issued_at DESC LIMIT 1")
      .get(machine, version) as { attempt: string } | undefined;
    if (held) return held.attempt;
    const attempt = randomBytes(16).toString("base64url");
    synced(this.#db, () => this.#db.prepare("INSERT INTO rollout_attempts (attempt, machine, version, issued_at) VALUES (?, ?, ?, ?)").run(attempt, machine, version, now));
    this.prune(now);
    return attempt;
  }
  // An id the control plane's own updater announced with its `applying` record (it has no other way to be given one).
  register(machine: string, version: string, attempt: string, now: number = this.#now()): void {
    synced(this.#db, () => this.#db.prepare("INSERT OR IGNORE INTO rollout_attempts (attempt, machine, version, issued_at) VALUES (?, ?, ?, ?)").run(attempt, machine, version, now));
  }
  lookup(attempt: string): { machine: string; version: string; issuedAt: number; usedAt: number | null } | null {
    const r = this.#db.prepare("SELECT machine, version, issued_at, used_at FROM rollout_attempts WHERE attempt = ?").get(attempt) as
      { machine: string; version: string; issued_at: number; used_at: number | null } | undefined;
    return r ? { machine: r.machine, version: r.version, issuedAt: r.issued_at, usedAt: r.used_at } : null;
  }
  // Spends an id; false when it was spent already.
  used(attempt: string, now: number = this.#now()): boolean {
    return synced(this.#db, () => this.#db.prepare("UPDATE rollout_attempts SET used_at = ? WHERE attempt = ? AND used_at IS NULL").run(now, attempt).changes === 1);
  }
  // Ids older than ATTEMPT_RETENTION_MS go: spent ones by when they were spent, unspent ones by when they were issued,
  // except the newest offer of each machine and Version (still what that machine may report under).
  prune(now: number = this.#now()): void {
    const cutoff = now - ATTEMPT_RETENTION_MS;
    this.#db.prepare(`DELETE FROM rollout_attempts WHERE (used_at IS NOT NULL AND used_at < ?)
      OR (used_at IS NULL AND issued_at < ? AND issued_at < (SELECT MAX(r.issued_at) FROM rollout_attempts r
        WHERE r.machine = rollout_attempts.machine AND r.version = rollout_attempts.version))`).run(cutoff, cutoff);
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
