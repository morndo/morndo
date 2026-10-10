// The fleet's copy of a job (ADR-0017, ADR-0014). One row per (node, id): two nodes may both run `--id build`.
// A later observation replaces that pair; an older one does not. The columns are the view a client may see:
// no command, no working directory, no environment.

// The id of a notice routed to another node. It names the node that ran the job, so two nodes do not share a claim.
export const fleetNoticeId = (node: string, id: string) => `node:job:${node}:${id}:done`;

// Same window as the node's JOB_KEEP_MS. The fleet does not import the node.
export const JOB_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Open jobs, plus this many newest terminal rows, are what a new events client is sent.
export const JOB_SNAPSHOT_MAX = 100;
import type Database from "better-sqlite3";
import { noticeCanMove, noticeCanReach } from "@morndo/domain";
import { JobViewSchema, type JobView, type JobsQuery } from "@morndo/protocol";

type Row = {
  id: string; node: string; lane: string; name: string; class: string; state: string;
  outcome: string | null; exit_code: number | null; duration_sec: number | null; notify: string;
  task: string | null; notice: string; at: number; ended: number | null; tail: string; position: number | null;
  reason: string | null; error: string | null;
};

// `at` is when this observation was taken. The newest one is stored even when nothing else changed.
const same = (a: JobView, b: JobView): boolean =>
  (Object.keys(a) as (keyof JobView)[]).every(k => k === "at" || JSON.stringify(a[k]) === JSON.stringify(b[k]));

const fromRow = (r: Row): JobView => JobViewSchema.parse({
  id: r.id, node: r.node, lane: r.lane, name: r.name, class: r.class, state: r.state,
  outcome: r.outcome, exit: r.exit_code, durationSec: r.duration_sec, notify: JSON.parse(r.notify) as unknown,
  task: r.task, notice: r.notice, at: r.at, ended: r.ended, tail: r.tail, position: r.position, reason: r.reason, error: r.error,
});

export class JobsStore {
  #db: Database.Database;
  #write: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#write = db.prepare(`INSERT INTO jobs (
      id, node, lane, name, class, state, outcome, exit_code, duration_sec, notify, task, notice, at, ended, tail, position, reason, error
    ) VALUES (
      @id, @node, @lane, @name, @class, @state, @outcome, @exit_code, @duration_sec, @notify, @task, @notice, @at, @ended, @tail, @position, @reason, @error
    ) ON CONFLICT(node, id) DO UPDATE SET
      lane = excluded.lane, name = excluded.name, class = excluded.class, state = excluded.state,
      outcome = excluded.outcome, exit_code = excluded.exit_code, duration_sec = excluded.duration_sec, notify = excluded.notify,
      task = excluded.task, notice = excluded.notice, at = excluded.at, ended = excluded.ended, tail = excluded.tail, position = excluded.position,
      reason = excluded.reason, error = excluded.error
    WHERE excluded.at >= jobs.at`);
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  // True when the stored view changed. A replay of the same view does not emit, but a newer `at` is kept
  // so a delayed older frame cannot pass the rewind check. An older `at` changes nothing.
  upsert(view: JobView): boolean {
    const prev = this.get(view.node, view.id);
    // A later observation must not walk a notice backwards. A newer one may skip a step the fleet never saw.
    const forward = !prev || prev.notice === view.notice || noticeCanMove(prev.notice, view.notice) || (view.at > prev.at && noticeCanReach(prev.notice, view.notice));
    const kept = prev && !forward ? { ...view, notice: prev.notice } : view;
    if (prev && prev.at > kept.at) return false;
    if (prev && same(prev, kept)) {
      if (kept.at > prev.at) this.#db.prepare("UPDATE jobs SET at = ? WHERE node = ? AND id = ? AND at < ?").run(kept.at, view.node, view.id, kept.at);
      return false;
    }
    this.#write.run({
      id: kept.id, node: kept.node, lane: kept.lane, name: kept.name, class: kept.class, state: kept.state,
      outcome: kept.outcome, exit_code: kept.exit, duration_sec: kept.durationSec, notify: JSON.stringify(kept.notify),
      task: kept.task, notice: kept.notice, at: kept.at, ended: kept.ended, tail: kept.tail, position: kept.position, reason: kept.reason,
      error: kept.error,
    });
    const next = this.get(view.node, view.id);
    return next !== null && (prev === null || !same(next, prev));
  }

  // True the first time this notice id is claimed. A replay finds the row and sends nothing again.
  claim(noticeId: string, node: string, jobId: string, destNode: string): boolean {
    const result = this.#db.prepare(
      "INSERT INTO job_routes (notice_id, node, job_id, dest_node) VALUES (?, ?, ?, ?) ON CONFLICT(notice_id) DO NOTHING",
    ).run(noticeId, node, jobId, destNode);
    return result.changes === 1;
  }

  release(noticeId: string): void {
    this.#db.prepare("DELETE FROM job_routes WHERE notice_id = ?").run(noticeId);
  }

  byId(id: string): JobView[] {
    return (this.#db.prepare("SELECT * FROM jobs WHERE id = ?").all(id) as Row[]).map(fromRow);
  }

  // True the first time this (node, id) is a failure. A replay finds the row and returns false.
  claimFailure(node: string, id: string): boolean {
    return this.#db.prepare("INSERT OR IGNORE INTO job_alerts (node, id) VALUES (?, ?)").run(node, id).changes === 1;
  }

  // When this fleet started raising job_failed. Missing means "now", so an old row is not a backfill.
  alertSince(): number {
    const row = this.#db.prepare("SELECT at FROM job_alert_since LIMIT 1").get() as { at: number } | undefined;
    return row?.at ?? Date.now();
  }

  // The notice the node itself has. Null until it reports one, or a push to it is acknowledged.
  nodeNotice(node: string, id: string): string | null {
    const row = this.#db.prepare("SELECT node_notice FROM jobs WHERE node = ? AND id = ?").get(node, id) as { node_notice: string | null } | undefined;
    return row?.node_notice ?? null;
  }

  holdNotice(node: string, id: string, notice: string): void {
    this.#db.prepare("UPDATE jobs SET node_notice = ? WHERE node = ? AND id = ?").run(notice, node, id);
  }

  // The hub's board result. Only a legal move is written. The caller emits and alerts.
  setNotice(node: string, id: string, notice: "commented" | "given_up"): JobView | null {
    const prev = this.get(node, id);
    if (!prev) return null;
    if (prev.notice !== notice && noticeCanMove(prev.notice, notice)) {
      this.#db.prepare("UPDATE jobs SET notice = ? WHERE node = ? AND id = ?").run(notice, node, id);
    }
    return this.get(node, id);
  }

  // True the first time this (node, id) is given up. A replay finds the row and returns false.
  claimUnnoticed(node: string, id: string): boolean {
    return this.#db.prepare("INSERT OR IGNORE INTO job_unnoticed (node, id) VALUES (?, ?)").run(node, id).changes === 1;
  }

  get(node: string, id: string): JobView | null {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE node = ? AND id = ?").get(node, id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  // Where this notice was aimed when the job finished. Null until then; "" means it stays on this node or had no lane.
  noticeDest(node: string, id: string): string | null {
    const row = this.#db.prepare("SELECT notice_dest FROM jobs WHERE node = ? AND id = ?").get(node, id) as { notice_dest: string | null } | undefined;
    return row?.notice_dest ?? null;
  }

  // True the first time. A later finish does not move a notice that was already decided.
  decide(node: string, id: string, dest: string): boolean {
    return this.#db.prepare("UPDATE jobs SET notice_dest = ? WHERE node = ? AND id = ? AND notice_dest IS NULL").run(dest, node, id).changes === 1;
  }

  // Terminal lane notices whose finish-time destination is another node, and that are not claimed right now.
  pendingNotices(): JobView[] {
    const rows = this.#db.prepare(`SELECT jobs.* FROM jobs
      WHERE outcome IS NOT NULL
        AND json_extract(notify, '$.kind') = 'lane'
        AND notice_dest IS NOT NULL AND notice_dest != '' AND notice_dest != node
        AND NOT EXISTS (
          SELECT 1 FROM job_routes r WHERE r.node = jobs.node AND r.job_id = jobs.id
        )`).all() as Row[];
    return rows.map(fromRow);
  }

  // Terminal rows older than 7 days, and the routes that pointed at them. A job still running stays.
  prune(now: number): number {
    const cutoff = now - JOB_KEEP_MS;
    const gone = this.#db.prepare("SELECT node, id FROM jobs WHERE outcome IS NOT NULL AND at < ?").all(cutoff) as { node: string; id: string }[];
    const dropRoute = this.#db.prepare("DELETE FROM job_routes WHERE node = ? AND job_id = ?");
    const dropAlert = this.#db.prepare("DELETE FROM job_alerts WHERE node = ? AND id = ?");
    const dropUnnoticed = this.#db.prepare("DELETE FROM job_unnoticed WHERE node = ? AND id = ?");
    const dropJob = this.#db.prepare("DELETE FROM jobs WHERE node = ? AND id = ? AND outcome IS NOT NULL AND at < ?");
    let n = 0;
    for (const row of gone) {
      dropRoute.run(row.node, row.id);
      dropAlert.run(row.node, row.id);
      dropUnnoticed.run(row.node, row.id);
      n += dropJob.run(row.node, row.id, cutoff).changes;
    }
    return n;
  }

  // What a subscriber is caught up with: every open job, then the newest terminal window, oldest of that window first.
  snapshot(): JobView[] {
    const open = (this.#db.prepare("SELECT * FROM jobs WHERE outcome IS NULL ORDER BY at, id").all() as Row[]).map(fromRow);
    const recent = (this.#db.prepare(
      "SELECT * FROM jobs WHERE outcome IS NOT NULL ORDER BY at DESC, id DESC LIMIT ?",
    ).all(JOB_SNAPSHOT_MAX) as Row[]).map(fromRow);
    recent.reverse();
    return [...open, ...recent];
  }

  list(q: JobsQuery): JobView[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.node !== undefined) { where.push("node = ?"); args.push(q.node); }
    if (q.lane !== undefined) { where.push("lane = ?"); args.push(q.lane); }
    if (q.state !== undefined) { where.push("state = ?"); args.push(q.state); }
    const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at, id`;
    return (this.#db.prepare(sql).all(...args) as Row[]).map(fromRow);
  }
}
