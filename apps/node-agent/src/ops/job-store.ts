// Background jobs on this node (ADR-0017; design §3, §5). The row holds hashes, never the command. A terminal
// outcome is committed with synchronous=FULL (synced, the same rule as a done key's `started`) and only then is the
// notice handed to the caller. A commit that throws leaves the row as it was, so nothing is handed off and the next
// loop can retry. Logs are files beside the database: 8 MiB each, 256 MiB across jobs (the relay's disk budget is
// the model, and a separate pool). The store never rewrites a log: the supervisor appends, and a running job whose
// file reaches the cap is marked capped and stays running until the process ends. A start that cannot fit is `disk`
// and is not queued. A terminal row, its log, its exit file and the supervisor's pid, child and argv files are
// removed 7 days after the outcome was stored. Callers pass `now`.
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  acceptJob, boundNotice, err, finish, noticeCanMove, noticeText, ok, schedule,
  type FinishEvent, type FinishProblem, type Guard, type Job, type JobOutcome, type NoticeState, type QueueReason,
  type Result, type StartBody, type StartProblem,
} from "@morndo/domain";
import { redactText } from "@morndo/protocol";
import { errno } from "@morndo/service-kit";
import { log } from "../log.ts";
import { synced } from "./done-keys.ts";

export const JOB_LOG_BYTES = 8 * 1024 * 1024;
export const JOB_LOG_BUDGET = 256 * 1024 * 1024;
export const JOB_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type LogSignal = "capped" | "truncated";
export type AppendResult = { written: number; signal: LogSignal | null };

export type NoticeHandoff = { noticeId: string; text: string; job: Job };
export type JobStoreOptions = {
  home: string;
  logBytes?: number;
  budget?: number;
  onNotice?: (notice: NoticeHandoff) => void;
  // A state the fleet is allowed to see. The tail is the redacted notice, empty until the job is terminal.
  onJob?: (job: Job, tail: string) => void;
};

type Row = {
  id: string;
  lane: string;
  name: string;
  job_class: string;
  notify: string;
  command_hash: string;
  cwd_hash: string;
  accepted_at: number;
  state: Job["state"];
  position: number | null;
  reason: QueueReason | null;
  outcome: JobOutcome | null;
  exit_code: number | null;
  duration_ms: number | null;
  notice: NoticeState;
  notice_id: string | null;
  error: "did_not_start" | null;
  ended_at: number | null;
  started_at: number | null;
};

export class JobStore {
  readonly dir: string;
  #db: Database.Database;
  #now: () => number;
  #logBytes: number;
  #budget: number;
  #home: string;
  #onNotice: ((notice: NoticeHandoff) => void) | undefined;
  #onJob: ((job: Job, tail: string) => void) | undefined;
  #sent = new Map<string, string>();
  #noticeText = new Map<string, string>();
  #used = 0;
  #known = new Map<string, number>();
  #capped = new Set<string>();
  #truncated = new Set<string>();

  constructor(db: Database.Database, dir: string, now: () => number = Date.now, opts: JobStoreOptions) {
    if (!opts?.home || opts.home === "/") throw new TypeError("home is required");
    this.#db = db;
    this.dir = dir;
    this.#now = now;
    this.#logBytes = opts.logBytes ?? JOB_LOG_BYTES;
    this.#budget = opts.budget ?? JOB_LOG_BUDGET;
    this.#home = opts.home;
    this.#onNotice = opts.onNotice;
    this.#onJob = opts.onJob;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#scan();
  }

  get logBytes(): number { return this.#logBytes; }

  accept(body: StartBody): Result<Job, StartProblem | "disk" | "io"> {
    const existing = this.get(body.id);
    const decided = acceptJob(existing, body, existing?.acceptedAt ?? this.#now());
    if (!decided.ok) return decided;
    if (existing) return this.#withLog(decided.value);
    this.#scan();
    if (this.#used >= this.#budget) return err("disk");
    this.#insert(decided.value);
    const created = this.#withLog(decided.value);
    if (!created.ok) {
      try { this.#db.prepare("DELETE FROM jobs WHERE id = ?").run(decided.value.id); }
      catch { /* the original error stands; a failed cleanup must not replace it */ }
      return created;
    }
    this.#tell(created.value, "");
    return created;
  }

  get(id: string): Job | null {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#job(row) : null;
  }

  list(): Job[] {
    return (this.#db.prepare("SELECT * FROM jobs ORDER BY accepted_at, id").all() as Row[]).map(row => this.#job(row));
  }

  // How many of a lane's jobs are still open (queued, starting or running): the ones it started, and the ones whose
  // notice goes to it (what a fleet run counts, run.ts). Either may be what the lane waits on, so the relay asks none of
  // these lanes for a waker (W1, ADR-0032; status-ask.ts).
  openFor(lane: string): number {
    const rows = this.#db.prepare("SELECT lane, notify FROM jobs WHERE state IN ('queued', 'starting', 'running')").all() as Pick<Row, "lane" | "notify">[];
    return rows.filter(row => {
      const notify = JSON.parse(row.notify) as Job["notify"];
      return row.lane === lane || (notify.kind === "lane" && notify.name === lane);
    }).length;
  }

  // When a reconnect may send this job, and the time that observation was actually taken.
  // A terminal job outside the 7-day window is not sent: stamping it with now would undo the fleet's prune.
  replayAt(job: Job): number | null {
    if (job.outcome === null) return job.startedAt ?? job.acceptedAt;
    const row = this.#db.prepare("SELECT ended_at FROM jobs WHERE id = ?").get(job.id) as { ended_at: number | null } | undefined;
    const ended = row?.ended_at ?? null;
    if (ended === null || ended < this.#now() - JOB_KEEP_MS) return null;
    return ended;
  }

  // What `show` prints: the notice once the job is terminal, otherwise the state the row is in now.
  preview(id: string): string | null {
    const job = this.get(id);
    if (!job) return null;
    if (job.outcome !== null && job.durationMs !== null && job.noticeId !== null) return `${this.#handoff(job).text}\nnotice: ${job.notice}`;
    const queued = job.state === "queued" && job.position !== null ? ` #${job.position} ${job.reason ?? ""}` : "";
    return `${job.id} ${job.state}${queued}`;
  }

  // The text a fleet frame carries: the capped notice once the job is terminal, otherwise nothing. Never the raw log.
  eventTail(id: string): string {
    const cached = this.#noticeText.get(id);
    if (cached !== undefined) return cached;
    const row = this.#db.prepare("SELECT notice_text FROM jobs WHERE id = ?").get(id) as { notice_text: string | null } | undefined;
    if (typeof row?.notice_text === "string") {
      this.#noticeText.set(id, row.notice_text);
      return row.notice_text;
    }
    const job = this.get(id);
    if (!job || job.outcome === null) return "";
    try { return this.#handoff(job).text; } catch { return ""; }
  }

  // The last lines of the log, redacted. The command line is not in the file.
  log(id: string, lines: number): string | null {
    if (!this.get(id)) return null;
    const tail = this.#lines(id).slice(-Math.max(0, lines));
    return redactText(tail.join("\n"), this.#home);
  }

  // Writes the schedule the domain decided. `starting` has no start time; started() records running once a process
  // exists. A class the policy does not list becomes terminal `refused`.
  applySchedule(limits: Readonly<Record<string, number>>, guard: Guard): Job[] {
    const prior = new Map(this.list().map(job => [job.id, job]));
    const next = schedule([...prior.values()], limits, guard);
    const update = this.#db.prepare("UPDATE jobs SET state = ?, position = ?, reason = ?, started_at = ? WHERE id = ? AND state IN ('queued', 'starting', 'running')");
    this.#db.transaction(() => {
      for (const job of next.jobs) {
        const row = prior.get(job.id);
        if (!row || (row.state !== "queued" && row.state !== "starting" && row.state !== "running")) continue;
        if (job.state !== "queued" && job.state !== "starting" && job.state !== "running") continue;
        update.run(job.state, job.position, job.reason, job.startedAt, job.id);
      }
    }).immediate();
    for (const job of next.jobs) {
      const row = prior.get(job.id);
      if (!row || (row.state === job.state && row.position === job.position && row.reason === job.reason)) continue;
      const current = this.get(job.id);
      if (current) this.#tell(current, "");
    }
    for (const id of next.refused) this.settle(id, { outcome: "refused" });
    return next.jobs.map(job => this.get(job.id) ?? job);
  }

  // The supervisor calls this once the process exists. Until then the row stays `starting` and started_at stays null.
  started(id: string): Result<Job, "missing" | "not_starting"> {
    const job = this.get(id);
    if (!job) return err("missing");
    if (job.state === "running") return ok(job);
    if (job.state !== "starting") return err("not_starting");
    const changed = this.#db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ? AND state = 'starting'").run(this.#now(), id).changes;
    if (changed !== 1) return err("not_starting");
    const next = this.get(id);
    if (!next) return err("missing");
    this.#tell(next, "");
    return ok(next);
  }

  // Appends with O_APPEND|O_CREAT|O_WRONLY, so a missing log is created. Never reads the log back and never truncates
  // it. A running job reports `capped` the first time its file reaches the per-job cap, and `truncated` the first
  // time the pool refuses bytes. Either signal is once. The job stays running until its process ends.
  append(id: string, bytes: Uint8Array): AppendResult {
    const job = this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    if (job.outcome !== null) return { written: 0, signal: null };
    const path = this.#logFile(id);
    const size = this.#note(id, path);
    const room = Math.max(0, Math.min(this.#logBytes - size, this.#budget - this.#used, bytes.length));
    if (room > 0) {
      const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
      try { writeSync(fd, bytes.subarray(0, room)); }
      finally { closeSync(fd); }
      this.#used += room;
      this.#known.set(id, size + room);
    }
    return { written: room, signal: this.#limitSignal(job, size, room, bytes.length) };
  }

  // One stat of this job's log, no read of its bytes. The per-job cap is first: a full pool marks the job
  // truncated but does not hide a log that has reached its own cap. Each signal is only the first time.
  watch(id: string): "capped" | "truncated" | null {
    const job = this.get(id);
    if (!job || job.outcome !== null) return null;
    const size = this.#note(id, this.#logFile(id));
    if (size >= this.#logBytes) return this.#markCapped(job);
    if (this.#used >= this.#budget) return this.#markTruncated(job);
    return null;
  }

  // The terminal row first, synced. The notice is handed off only after that commit returns.
  settle(id: string, event: FinishEvent): Result<NoticeHandoff, FinishProblem | "missing"> {
    const job = this.get(id);
    if (!job) return err("missing");
    const decided = finish(job, event);
    if (!decided.ok) return decided;
    const next = decided.value;
    if (next !== job) {
      synced(this.#db, () => {
        this.#db.transaction(() => {
          const endedAt = event.outcome === "lost" ? Math.max(event.at, job.startedAt ?? event.at) : this.#now();
          const changed = this.#db.prepare(`UPDATE jobs SET state = ?, position = NULL, reason = NULL, outcome = ?, exit_code = ?,
            duration_ms = ?, notice = ?, notice_id = ?, error = ?, ended_at = ?
            WHERE id = ? AND state IN ('queued', 'starting', 'running')`)
            .run(next.state, next.outcome, next.exitCode, next.durationMs, next.notice, next.noticeId, next.error, endedAt, next.id).changes;
          if (changed !== 1) throw new Error(`terminal row for ${id} was not written`);
        }).immediate();
      });
    }
    const handoff = this.#handoff(next);
    this.#capped.delete(id);
    this.#truncated.delete(id);
    this.#onNotice?.(handoff);
    if (next !== job) this.#tell(this.get(id) ?? next, handoff.text);
    return ok(handoff);
  }

  // The delivery queue has the notice. Only the edges in noticeCanMove are taken.
  markNotice(id: string, notice: NoticeState): void {
    const job = this.get(id);
    if (!job || job.outcome === null || !noticeCanMove(job.notice, notice)) return;
    this.#db.prepare("UPDATE jobs SET notice = ? WHERE id = ? AND notice = ?").run(notice, id, job.notice);
    const next = this.get(id);
    const text = this.eventTail(id);
    if (next && text !== "") this.#tell(next, text);
  }

  prune(): number {
    const cutoff = this.#now() - JOB_KEEP_MS;
    const ids = this.#db.prepare("SELECT id FROM jobs WHERE ended_at IS NOT NULL AND ended_at < ?").all(cutoff) as { id: string }[];
    let n = 0;
    for (const { id } of ids) {
      if (this.#remove(`${id}.log`)) this.#release(id);
      for (const suffix of [".exit", ".pid", ".pid.at", ".child", ".child.at", ".argv", ".exit.tmp", ".cap"]) this.#remove(`${id}${suffix}`);
      this.#capped.delete(id);
      this.#truncated.delete(id);
      this.#sent.delete(id);
      this.#noticeText.delete(id);
      n += this.#db.prepare("DELETE FROM jobs WHERE id = ? AND ended_at IS NOT NULL AND ended_at < ?").run(id, cutoff).changes;
    }
    return n;
  }

  // One event per distinct view. A sweep that changes nothing does not send again.
  #tell(job: Job, tail?: string): void {
    if (!this.#onJob) return;
    let shown = tail ?? "";
    if (tail === undefined && job.outcome !== null && job.durationMs !== null && job.noticeId !== null) {
      try { shown = this.#handoff(job).text; } catch { shown = ""; }
    }
    const key = `${job.state}\0${job.position}\0${job.reason}\0${job.outcome}\0${job.notice}\0${job.exitCode}\0${job.durationMs}\0${shown}`;
    if (this.#sent.get(job.id) === key) return;
    this.#sent.set(job.id, key);
    try { this.#onJob(job, shown); }
    catch (e) { log.warn("a job event could not be sent", e); }
  }

  #insert(job: Job): void {
    this.#db.prepare(`INSERT INTO jobs (
      id, lane, name, job_class, notify, command_hash, cwd_hash, accepted_at,
      state, position, reason, outcome, exit_code, duration_ms, notice, notice_id, error, ended_at, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
      job.id, job.lane, job.name, job.jobClass, JSON.stringify(job.notify), job.commandHash, job.cwdHash, job.acceptedAt,
      job.state, job.position, job.reason, job.outcome, job.exitCode, job.durationMs, job.notice, job.noticeId, job.error,
      job.startedAt,
    );
  }

  #job(row: Row): Job {
    return {
      id: row.id, lane: row.lane, name: row.name, jobClass: row.job_class,
      notify: JSON.parse(row.notify) as Job["notify"],
      commandHash: row.command_hash, cwdHash: row.cwd_hash, acceptedAt: row.accepted_at,
      state: row.state, position: row.position, reason: row.reason, outcome: row.outcome,
      exitCode: row.exit_code, durationMs: row.duration_ms, notice: row.notice, noticeId: row.notice_id, error: row.error,
      startedAt: row.started_at, endedAt: row.ended_at,
    };
  }

  #handoff(job: Job): NoticeHandoff {
    if (job.outcome === null || job.durationMs === null || job.noticeId === null) throw new Error(`job ${job.id} is not terminal`);
    let text = noticeText({
      name: job.name, outcome: job.outcome, id: job.id, jobClass: job.jobClass,
      exitCode: job.exitCode, durationMs: job.durationMs, logPath: this.#logFile(job.id), home: this.#home,
      lines: this.#lines(job.id), error: job.error,
    }, redactText);
    if (this.#truncated.has(job.id)) text = boundNotice(text, "log truncated: pool full");
    else text = boundNotice(text);
    this.#noticeText.set(job.id, text);
    this.#db.prepare("UPDATE jobs SET notice_text = ? WHERE id = ?").run(text, job.id);
    return { noticeId: job.noticeId, text, job };
  }

  #lines(id: string): string[] {
    const path = this.#logFile(id);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  #logFile(id: string): string {
    return join(this.dir, `${id}.log`);
  }

  // A running job reports each limit once. The real exit is recorded later, when the process ends.
  #limitSignal(job: Job, size: number, room: number, asked: number): LogSignal | null {
    if (asked > 0 && size + room >= this.#logBytes) return this.#markCapped(job);
    if (asked > room) return this.#markTruncated(job);
    return null;
  }

  #markCapped(job: Job): "capped" | null {
    if (job.state !== "running" || job.outcome !== null || this.#capped.has(job.id)) return null;
    this.#capped.add(job.id);
    return "capped";
  }

  #markTruncated(job: Job): "truncated" | null {
    if (job.state !== "running" || job.outcome !== null || this.#truncated.has(job.id)) return null;
    this.#truncated.add(job.id);
    return "truncated";
  }

  #scan(): void {
    this.#used = 0;
    this.#known.clear();
    for (const name of this.#names()) {
      if (!name.endsWith(".log")) continue;
      const size = this.#fileSize(join(this.dir, name));
      this.#known.set(name.slice(0, -".log".length), size);
      this.#used += size;
    }
  }

  // Accounts for bytes another writer appended since the last look. One stat, no read of the log.
  #note(id: string, path: string): number {
    const size = this.#fileSize(path);
    const prev = this.#known.get(id) ?? 0;
    this.#used += size - prev;
    if (this.#used < 0) this.#used = 0;
    this.#known.set(id, size);
    return size;
  }

  #fileSize(path: string): number {
    try { return statSync(path).size; }
    catch (e) { if (errno(e) === "ENOENT") return 0; throw e; }
  }

  #names(): string[] {
    try { return readdirSync(this.dir); }
    catch (e) { if (errno(e) === "ENOENT") return []; throw e; }
  }

  // A row is never returned without its log. A retry creates the file, or returns the same failure.
  #withLog(job: Job): Result<Job, "disk" | "io"> {
    if (existsSync(this.#logFile(job.id))) return ok(job);
    try {
      this.#touch(job.id);
      return ok(job);
    } catch (e) {
      const code = errno(e) || "unknown";
      log.warn(`could not create a job log: ${code}`);
      return err(code === "ENOSPC" || code === "EDQUOT" ? "disk" : "io");
    }
  }

  #touch(id: string): void {
    const path = this.#logFile(id);
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }

  // True when the file is gone. A failure leaves the pool count where it was.
  #remove(name: string): boolean {
    try { unlinkSync(join(this.dir, name)); return true; }
    catch (e) { if (errno(e) === "ENOENT") return true; throw e; }
  }

  #release(id: string): void {
    const prev = this.#known.get(id) ?? 0;
    this.#used -= prev;
    if (this.#used < 0) this.#used = 0;
    this.#known.delete(id);
  }
}
