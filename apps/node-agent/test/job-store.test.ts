// The node store for background jobs (ADR-0017, design §3, §5, §12 step 2). The terminal row is committed and its
// WAL synced before any notice is handed off; logs stay on this node, capped, and leave with the row after 7 days.
import { chmodSync, closeSync, constants, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTICE_MAX, noticeIdOf, type FinishEvent, type Job, type StartBody } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import type { WalSync } from "../src/db/wal-sync.ts";
import { jobTick } from "../src/ops/job-runtime.ts";
import { JOB_KEEP_MS, JOB_LOG_BUDGET, JOB_LOG_BYTES, JobStore, type NoticeHandoff } from "../src/ops/job-store.ts";
import { tempHome } from "./helpers.ts";

const AT = 1_700_000_000_000;
const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const body = (over: Partial<StartBody> = {}): StartBody => ({
  id: "job-1", lane: "builder", name: "pack", jobClass: "default",
  notify: { kind: "lane", name: "builder" }, commandHash: HASH, cwdHash: HASH, ...over,
});
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
const EXIT = { outcome: "exited", exitCode: 0, durationMs: 1500 } satisfies FinishEvent;

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function storeOn(now: () => number = () => AT, opts: { logBytes?: number; budget?: number; walSync?: WalSync; onNotice?: (n: NoticeHandoff) => void; onJob?: (job: Job, tail: string) => void } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  open.push({ adb, cleanup: h.cleanup });
  const store = new JobStore(adb.db, dir, now, { home: h.home, ...opts });
  return { store, adb, dir, home: h.home };
}

describe("jobs table", () => {
  it("stores the hashes and reloads the same job, and keeps no command column", () => {
    const { store, adb } = storeOn();
    const job = value(store.accept(body()));
    expect(job).toMatchObject({ id: "job-1", state: "queued", notice: "none", commandHash: HASH, cwdHash: HASH });
    expect(store.get("job-1")).toEqual(job);
    expect(value(store.accept(body()))).toEqual(job);
    expect(store.accept(body({ commandHash: OTHER }))).toEqual({ ok: false, error: "id_conflict" });
    expect(store.get("job-1")?.commandHash).toBe(HASH);
    const cols = (adb.db.pragma("table_info(jobs)") as { name: string }[]).map(c => c.name);
    expect(cols).toEqual([
      "id", "lane", "name", "job_class", "notify", "command_hash", "cwd_hash", "accepted_at",
      "state", "position", "reason", "outcome", "exit_code", "duration_ms", "notice", "notice_id", "error", "ended_at", "started_at", "notice_text",
    ]);
    expect(statSync(join(store.dir, "job-1.log")).mode & 0o777).toBe(0o600);
  });

  it("leaves a promoted job starting until the process exists, and only then records running", async () => {
    const { store } = storeOn();
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-1")).toMatchObject({ state: "starting", startedAt: null });
    expect(store.get("job-2")).toMatchObject({ state: "queued", position: 1, reason: "class" });
    await store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-2")).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(value(store.started("job-1"))).toMatchObject({ state: "running", startedAt: AT });
    expect(store.get("job-1")?.startedAt).toBe(AT);
    value(await store.settle("job-1", EXIT));
    await store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-2")).toMatchObject({ state: "starting", startedAt: null });
    const lost = value(await store.settle("job-2", { outcome: "lost", at: AT + 5_000 }));
    expect(lost.job).toMatchObject({ state: "lost", outcome: "lost", durationMs: 0, exitCode: null });
    expect(lost.text).toContain("lost");
  });

  it("rejects a running job that has no start time", async () => {
    const { store, adb } = storeOn();
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    expect(() => adb.db.exec("UPDATE jobs SET started_at = NULL WHERE id = 'job-1'")).toThrow(/CHECK/);
    expect(store.get("job-1")).toMatchObject({ state: "running", startedAt: AT });
  });

  it("writes a class the policy does not list as terminal refused, and notices it", async () => {
    const handed: NoticeHandoff[] = [];
    const { store } = storeOn(() => AT, { onNotice: n => { handed.push(n); } });
    value(store.accept(body({ id: "job-x", jobClass: "gpu" })));
    await store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-x")).toMatchObject({ state: "refused", outcome: "refused", exitCode: null, durationMs: 0, noticeId: noticeIdOf("job-x") });
    expect(store.list().map(j => j.id)).toContain("job-x");
    expect(handed.map(n => n.noticeId)).toEqual([noticeIdOf("job-x")]);
    expect(handed[0]?.text).toContain("refused");
    await store.applySchedule({ default: 1 }, "off");
    expect(handed.map(n => n.noticeId)).toEqual([noticeIdOf("job-x")]);
  });

  it("records a start that never created a process, from starting, with no start time", async () => {
    const { store } = storeOn();
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    const h = value(await store.settle("job-1", { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" }));
    expect(h.job).toMatchObject({ state: "exited", error: "did_not_start", exitCode: null, durationMs: 0, startedAt: null });
    expect(h.text).toContain("did_not_start");
  });
});

describe("a lane's open jobs (W1, the relay's waker ask)", () => {
  it("counts the queued, starting and running jobs a lane started or that notify it, and no others", async () => {
    const { store } = storeOn();
    expect(store.openFor("builder")).toBe(0);
    value(store.accept(body({ id: "own", notify: { kind: "fleet" } })));                       // started by builder
    value(store.accept(body({ id: "to-builder", lane: "alpha", notify: { kind: "lane", name: "builder" } })));
    value(store.accept(body({ id: "alpha-only", lane: "alpha", notify: { kind: "lane", name: "alpha" } })));
    expect(store.openFor("builder")).toBe(2);
    expect(store.openFor("alpha")).toBe(2);
    expect(store.openFor("beta")).toBe(0);
    await store.applySchedule({ default: 3 }, "off");
    expect(store.get("own")?.state).toBe("starting");
    expect(store.openFor("builder")).toBe(2);
    value(store.started("own"));
    expect(store.openFor("builder")).toBe(2);                                                    // running
    value(await store.settle("own", EXIT));
    expect(store.openFor("builder")).toBe(1);                                                    // a terminal job is no waker
    value(await store.settle("to-builder", { outcome: "lost", at: AT + 5_000 }));
    expect(store.openFor("builder")).toBe(0);
    expect(store.openFor("alpha")).toBe(1);
  });
});

describe("home", () => {
  it("requires a home directory and does not assume the filesystem root", () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    const dir = join(h.home, "job-logs");
    expect(() => new JobStore(adb.db, dir, () => AT, {} as { home: string })).toThrow(/home/);
    expect(() => new JobStore(adb.db, dir, () => AT, { home: "/" })).toThrow(/home/);
  });
});

describe("accept failures", () => {
  it("reports an io error for a permission failure, logs the system code, and a cleanup failure does not replace it", () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const { store, dir } = storeOn();
      chmodSync(dir, 0o500);
      try {
        expect(store.accept(body({ id: "job-e" }))).toEqual({ ok: false, error: "io" });
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(store.get("job-e")).toBeNull();
      const blocked = storeOn();
      blocked.adb.db.exec("CREATE TRIGGER jobs_keep BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'no delete'); END");
      chmodSync(blocked.dir, 0o500);
      try {
        expect(blocked.store.accept(body({ id: "job-e" }))).toEqual({ ok: false, error: "io" });
        expect(blocked.store.accept(body({ id: "job-e" }))).toEqual({ ok: false, error: "io" });
        expect(existsSync(join(blocked.dir, "job-e.log"))).toBe(false);
      } finally {
        chmodSync(blocked.dir, 0o700);
      }
      expect(blocked.store.get("job-e")?.id).toBe("job-e");
      expect(value(blocked.store.accept(body({ id: "job-e" }))).id).toBe("job-e");
      expect(existsSync(join(blocked.dir, "job-e.log"))).toBe(true);
      const logged = lines.join("");
      expect(logged).toContain("EACCES");
      expect(logged).not.toContain("error: \"EACCES\"");
    } finally {
      process.stderr.write = write as typeof process.stderr.write;
    }
  });
});

describe("log file", () => {
  it("creates a missing log when it appends", () => {
    const { store } = storeOn();
    value(store.accept(body()));
    const path = join(store.dir, "job-1.log");
    unlinkSync(path);
    expect(store.append("job-1", Buffer.from("hello"))).toEqual({ written: 5, signal: null });
    expect(readFileSync(path).toString()).toBe("hello");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("log caps", () => {
  it("reports a cap only when a running job has reached it", async () => {
    const { store } = storeOn(() => AT, { logBytes: 8 });
    value(store.accept(body()));
    writeFileSync(join(store.dir, "job-1.log"), "12345678");
    expect(store.watch("job-1")).toBeNull();
    expect(store.get("job-1")).toMatchObject({ state: "queued", outcome: null });
    await store.applySchedule({ default: 1 }, "off");
    expect(store.watch("job-1")).toBeNull();
    expect(store.get("job-1")).toMatchObject({ state: "starting", outcome: null });
    value(store.started("job-1"));
    writeFileSync(join(store.dir, "job-1.log"), "1234");
    expect(store.watch("job-1")).toBeNull();
    writeFileSync(join(store.dir, "job-1.log"), "12345678");
    expect(store.watch("job-1")).toBe("capped");
    expect(store.watch("job-1")).toBeNull();
    expect(store.append("job-1", Buffer.from("MORE"))).toEqual({ written: 0, signal: null });
    expect(store.get("job-1")).toMatchObject({ state: "running", outcome: null });
  });
  it("reports the per-job cap before a full pool, and a shorter log as truncated", async () => {
    const { store, dir } = storeOn(() => AT, { logBytes: 8, budget: 8 });
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 2 }, "off");
    value(store.started("job-1"));
    value(store.started("job-2"));
    writeFileSync(join(dir, "job-1.log"), "12345678");
    writeFileSync(join(dir, "job-2.log"), "1234");
    expect(store.watch("job-1")).toBe("capped");
    expect(store.watch("job-2")).toBe("truncated");
  });

  it("says once when the pool drops output from a running job", async () => {
    const { store } = storeOn(() => AT, { logBytes: 100, budget: 8 });
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 2 }, "off");
    value(store.started("job-1"));
    value(store.started("job-2"));
    expect(store.append("job-1", Buffer.from("aaaaaaaa"))).toEqual({ written: 8, signal: null });
    expect(store.append("job-2", Buffer.from("bbbb"))).toEqual({ written: 0, signal: "truncated" });
    expect(store.append("job-2", Buffer.from("cccc"))).toEqual({ written: 0, signal: null });
    expect(store.watch("job-2")).toBeNull();
    expect(store.get("job-2")).toMatchObject({ state: "running", outcome: null });
    expect(value(await store.settle("job-2", EXIT)).text).toContain("log truncated: pool full");
    expect(value(await store.settle("job-1", EXIT)).text).not.toContain("log truncated");
  });

  it("sends the capped notice, with the pool note, and not the raw log", async () => {
    const { store, dir } = storeOn(() => AT, { logBytes: 20_000, budget: 12 });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    writeFileSync(join(dir, "job-1.log"), `\x1b[31m${"x".repeat(9000)}`);
    expect(store.append("job-1", Buffer.from("more")).signal).toBe("truncated");
    const text = value(await store.settle("job-1", EXIT)).text;
    expect(text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(text).toContain("log truncated: pool full");
    expect(text).not.toContain("\x1b");
    store.markNotice("job-1", "typed");
    expect(store.eventTail("job-1")).toBe(text);
    expect(store.eventTail("job-1").length).toBeLessThanOrEqual(NOTICE_MAX);
  });

  it("appends without rewriting, and a capped job stays running until the process ends", async () => {
    expect(JOB_LOG_BYTES).toBe(8 * 1024 * 1024);
    const { store } = storeOn(() => AT, { logBytes: 8 });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    const path = join(store.dir, "job-1.log");
    const fd = openSync(path, constants.O_APPEND | constants.O_WRONLY);
    writeSync(fd, Buffer.from("KEEP"));
    expect(store.append("job-1", Buffer.from("MOREDATA"))).toEqual({ written: 4, signal: "capped" });
    expect(readFileSync(path).toString()).toBe("KEEPMORE");
    expect(store.get("job-1")).toMatchObject({ state: "running", outcome: null });
    writeSync(fd, Buffer.from("Z"));
    closeSync(fd);
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("KEEP");
    expect(store.append("job-1", Buffer.from("NOPE"))).toEqual({ written: 0, signal: null });
    expect(readFileSync(path).subarray(0, 4).toString()).toBe("KEEP");
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-2")).toMatchObject({ state: "queued" });
    expect(value(await store.settle("job-1", EXIT)).job).toMatchObject({ state: "exited", exitCode: 0, durationMs: 1500 });
  });

  it("refuses a start that cannot fit in the 256 MiB pool, and does not queue it", () => {
    expect(JOB_LOG_BUDGET).toBe(256 * 1024 * 1024);
    const { store } = storeOn(() => AT, { logBytes: 4, budget: 8 });
    value(store.accept(body()));
    expect(store.append("job-1", Buffer.from("aaaa"))).toEqual({ written: 4, signal: null });
    value(store.accept(body({ id: "job-2" })));
    expect(store.append("job-2", Buffer.from("bbbb"))).toEqual({ written: 4, signal: null });
    expect(store.accept(body({ id: "job-3" }))).toEqual({ ok: false, error: "disk" });
    expect(store.get("job-3")).toBeNull();
    expect(existsSync(join(store.dir, "job-3.log"))).toBe(false);
    expect(value(store.accept(body())).id).toBe("job-1");
    expect(store.append("job-1", Buffer.from("MORE"))).toEqual({ written: 0, signal: null });
    expect(readFileSync(join(store.dir, "job-1.log")).toString()).toBe("aaaa");
  });

  it("does not erase a log when the pool has no room left", () => {
    const { store } = storeOn(() => AT, { logBytes: 100, budget: 8 });
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    expect(store.append("job-1", Buffer.from("keep"))).toEqual({ written: 4, signal: null });
    expect(store.append("job-2", Buffer.from("xxxxxxxx"))).toEqual({ written: 4, signal: null });
    expect(readFileSync(join(store.dir, "job-1.log")).toString()).toBe("keep");
    expect(store.append("job-1", Buffer.from("MORE"))).toEqual({ written: 0, signal: null });
    expect(readFileSync(join(store.dir, "job-1.log")).toString()).toBe("keep");
    expect(store.get("job-1")?.state).toBe("queued");
  });
});

describe("durable terminal transition", () => {
  it("a failed commit does not hand off a notice, and the job stays running", async () => {
    const handed: NoticeHandoff[] = [];
    const { store, adb, home } = storeOn(() => AT, { onNotice: n => { handed.push(n); } });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    store.append("job-1", Buffer.from("token=super-secret-value\n"));
    adb.db.exec("CREATE TRIGGER jobs_disk BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(store.settle("job-1", EXIT)).rejects.toThrow(/disk full/);
    expect(handed).toEqual([]);
    expect(store.get("job-1")).toMatchObject({ state: "running", notice: "none", noticeId: null });
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);
    adb.db.exec("DROP TRIGGER jobs_disk");
    const h = value(await store.settle("job-1", EXIT));
    expect(handed).toEqual([h]);
    expect(h.noticeId).toBe(noticeIdOf("job-1"));
    expect(h.text).toContain("token=[redacted]");
    expect(h.text).not.toContain("super-secret-value");
    expect(h.text).toContain("~/job-logs/job-1.log");
    expect(h.text).not.toContain(home);
    expect(readFileSync(join(store.dir, "job-1.log")).toString()).toContain("super-secret-value");
    expect(store.get("job-1")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 0, notice: "pending", noticeId: h.noticeId });
    const again = value(await store.settle("job-1", EXIT));
    expect(again.noticeId).toBe(h.noticeId);
    expect(handed.map(n => n.noticeId)).toEqual([h.noticeId, h.noticeId]);
    expect(adb.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    expect(await store.settle("job-1", { outcome: "lost", at: AT })).toEqual({ ok: false, error: "already_terminal" });
    expect(handed).toHaveLength(2);
    expect(store.get("job-1")?.state).toBe("exited");
  });

  it("a sync that fails after the commit takes the row back to open: no handoff, and the next settle retries", async () => {
    const handed: NoticeHandoff[] = [];
    let failing = false;
    const { store } = storeOn(() => AT, {
      walSync: async () => { if (failing) throw new Error("the disk went away"); },
      onNotice: n => { handed.push(n); },
    });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    failing = true;
    await expect(store.settle("job-1", EXIT)).rejects.toThrow(/the disk went away/);
    expect(handed).toEqual([]);
    expect(store.get("job-1")).toMatchObject({ state: "running", outcome: null, exitCode: null, durationMs: null, notice: "none", noticeId: null, endedAt: null });
    failing = false;
    const h = value(await store.settle("job-1", EXIT));
    expect(handed).toEqual([h]);
    expect(store.get("job-1")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 0 });
  });

  it("a repeat settle behind one whose sync failed settles anew: one notice, and only for a row that is on the disk (T-532)", async () => {
    const handed: NoticeHandoff[] = [];
    let fail = () => {};
    let syncs = 0;
    const { store } = storeOn(() => AT, {
      // The first sync fails once it is let go; every later one lands.
      walSync: () => (syncs++ === 0 ? new Promise<void>((_resolve, reject) => { fail = () => { reject(new Error("the disk went away")); }; }) : Promise.resolve()),
      onNotice: n => { handed.push(n); },
    });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    syncs = 0;
    const first = store.settle("job-1", EXIT);                       // commits the terminal row, waits on its sync
    const repeat = store.settle("job-1", EXIT);                      // the same end, while the first waits
    fail();
    await expect(first).rejects.toThrow(/the disk went away/);       // its row went back to open
    const h = value(await repeat);                                   // it waited for the first, then settled itself
    expect(handed).toEqual([h]);                                     // one notice, after a sync that landed
    expect(store.get("job-1")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 0 });
  });

  it("sends a job's events only once their commit is synced (T-532)", async () => {
    const seen: string[] = [];
    let release = () => {};
    let held = true;
    const { store } = storeOn(() => AT, {
      walSync: () => (held ? new Promise<void>(resolve => { release = () => { held = false; resolve(); }; }) : Promise.resolve()),
      onJob: job => { seen.push(job.state); },
    });
    value(store.accept(body()));
    await Promise.resolve();
    expect(seen).toEqual([]);                                        // queued, but not yet on the disk: not sent
    release();
    await vi.waitFor(() => { expect(seen).toEqual(["queued"]); });
  });

  it("commits the terminal row at NORMAL, syncs the WAL, and only then hands off the notice", async () => {
    const order: string[] = [];
    const { store, adb } = storeOn(() => AT, {
      walSync: async () => { order.push("sync"); },
      onNotice: () => { order.push("notice"); },
    });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    value(await store.settle("job-1", { outcome: "lost", at: AT + 4_000 }));
    expect(order).toEqual(["sync", "notice"]);
    expect(store.get("job-1")).toMatchObject({ state: "lost", exitCode: null, durationMs: 4_000, notice: "pending" });
    expect(adb.db.prepare("SELECT ended_at FROM jobs WHERE id = 'job-1'").get()).toEqual({ ended_at: AT + 4_000 });
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);   // the connection was never switched off NORMAL
  });

  it("stores a lost job's end and its duration from the moment it was found", async () => {
    let now = AT;
    const { store, adb } = storeOn(() => now);
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    now = AT + 30_000;
    value(await store.settle("job-1", { outcome: "lost", at: AT + 4_000 }));
    expect(store.get("job-1")).toMatchObject({ state: "lost", durationMs: 4_000 });
    expect(adb.db.prepare("SELECT ended_at FROM jobs WHERE id = 'job-1'").get()).toEqual({ ended_at: AT + 4_000 });
  });

  it("rejects a lost clock that is not a whole number, and never stores an end before the start", async () => {
    const { store, adb } = storeOn();
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    for (const at of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(await store.settle("job-1", { outcome: "lost", at })).toEqual({ ok: false, error: "bad_exit" });
    }
    expect(store.get("job-1")).toMatchObject({ state: "running" });
    expect(adb.db.prepare("SELECT ended_at FROM jobs WHERE id = 'job-1'").get()).toEqual({ ended_at: null });
    value(await store.settle("job-1", { outcome: "lost", at: AT - 1_000 }));
    expect(store.get("job-1")).toMatchObject({ state: "lost", durationMs: 0 });
    expect(adb.db.prepare("SELECT ended_at, started_at FROM jobs WHERE id = 'job-1'").get()).toEqual({ ended_at: AT, started_at: AT });
  });

  it("a queued job can be cancelled, and cannot be lost, with no notice on the refusal", async () => {
    const handed: NoticeHandoff[] = [];
    const { store } = storeOn(() => AT, { onNotice: n => { handed.push(n); } });
    value(store.accept(body()));
    expect(await store.settle("job-1", { outcome: "lost", at: AT })).toEqual({ ok: false, error: "not_running" });
    expect(handed).toEqual([]);
    expect(store.get("job-1")?.state).toBe("queued");
    const h = value(await store.settle("job-1", { outcome: "cancelled", exitCode: null, durationMs: 0 }));
    expect(h.noticeId).toBe(noticeIdOf("job-1"));
    expect(h.text).toContain("cancelled");
    expect(handed).toEqual([h]);
  });
});

describe("prune", () => {
  it("removes a terminal job, its log and its exit file after 7 days, and keeps a queued job", async () => {
    expect(JOB_KEEP_MS).toBe(7 * 24 * 60 * 60 * 1000);
    let now = AT;
    const handed: NoticeHandoff[] = [];
    const { store, dir } = storeOn(() => now, { onNotice: n => { handed.push(n); } });
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    value(await store.settle("job-1", EXIT));
    writeFileSync(join(dir, "job-1.exit"), "0\n", { mode: 0o600 });
    chmodSync(join(dir, "job-1.exit"), 0o600);
    now = AT + JOB_KEEP_MS;
    expect(store.prune()).toBe(0);
    expect(store.get("job-1")?.state).toBe("exited");
    expect(existsSync(join(dir, "job-1.log"))).toBe(true);
    now = AT + JOB_KEEP_MS + 1;
    expect(store.prune()).toBe(1);
    expect(store.get("job-1")).toBeNull();
    expect(existsSync(join(dir, "job-1.log"))).toBe(false);
    expect(existsSync(join(dir, "job-1.exit"))).toBe(false);
    expect(store.get("job-2")).toMatchObject({ state: "queued" });
    expect(existsSync(join(dir, "job-2.log"))).toBe(true);
    expect(handed.map(n => n.noticeId)).toEqual([noticeIdOf("job-1")]);
  });

  it("forgets a pruned job's sent notice, and a notice change does not read the log again", async () => {
    let now = AT;
    const published: string[] = [];
    const { store, dir } = storeOn(() => now, { onJob: (_job, tail) => { published.push(tail); } });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    writeFileSync(join(dir, "job-1.log"), "line from the log\n");
    const text = value(await store.settle("job-1", EXIT)).text;
    expect(text).toContain("line from the log");
    unlinkSync(join(dir, "job-1.log"));
    const before = published.length;
    store.markNotice("job-1", "typed");
    expect(published.slice(before)).toEqual([text]);
    expect(store.eventTail("job-1")).toBe(text);
    now = AT + JOB_KEEP_MS + 1;
    expect(store.prune()).toBe(1);
    expect(store.eventTail("job-1")).toBe("");
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    writeFileSync(join(dir, "job-1.log"), "line from the log\n");
    const again = published.length;
    value(await store.settle("job-1", EXIT));
    expect(published.length).toBe(again + 1);
  });

  it("keeps the notice text in the store, so a restart does not publish an empty tail", async () => {
    const { store, dir, adb, home } = storeOn();
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    writeFileSync(join(dir, "job-1.log"), "kept line\n");
    const text = value(await store.settle("job-1", EXIT)).text;
    expect(text).toContain("kept line");
    unlinkSync(join(dir, "job-1.log"));
    const published: string[] = [];
    const reopened = new JobStore(adb.db, dir, () => AT, { home, onJob: (_job, tail) => { published.push(tail); } });
    reopened.markNotice("job-1", "typed");
    expect(published).toEqual([text]);
    expect(reopened.eventTail("job-1")).toBe(text);
  });

  it("prunes on the sweep tick, and a reconnect would send only jobs inside 7 days at their own time", async () => {
    let now = AT;
    const { store } = storeOn(() => now);
    value(store.accept(body()));
    value(store.accept(body({ id: "job-old" })));
    await store.applySchedule({ default: 2 }, "off");
    value(store.started("job-1"));
    value(store.started("job-old"));
    const fresh = value(await store.settle("job-1", EXIT));
    now = AT + JOB_KEEP_MS + 1;
    value(await store.settle("job-old", EXIT));
    value(store.accept(body({ id: "job-open" })));
    now = AT + JOB_KEEP_MS + 2;
    expect(store.replayAt(fresh.job)).toBeNull();
    const old = store.get("job-old");
    const open = store.get("job-open");
    if (!old || !open) throw new Error("missing");
    expect(store.replayAt(old)).toBe(AT + JOB_KEEP_MS + 1);
    expect(store.replayAt(open)).toBe(open.acceptedAt);
    let swept = 0;
    now = AT + JOB_KEEP_MS + JOB_KEEP_MS + 2;
    jobTick(store, () => { swept += 1; });
    expect(swept).toBe(1);
    expect(store.get("job-1")).toBeNull();
    expect(store.get("job-old")).toBeNull();
    expect(store.get("job-open")).toMatchObject({ state: "queued" });
  });
  it("returns the pruned log's bytes to the pool, so a new job can write", async () => {
    let now = AT;
    const { store } = storeOn(() => now, { logBytes: 8, budget: 8 });
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    expect(store.append("job-1", Buffer.from("aaaaaaaa"))).toEqual({ written: 8, signal: "capped" });
    expect(store.accept(body({ id: "job-full" }))).toEqual({ ok: false, error: "disk" });
    value(await store.settle("job-1", EXIT));
    now = AT + JOB_KEEP_MS + 1;
    expect(store.prune()).toBe(1);
    value(store.accept(body({ id: "job-2" })));
    expect(store.append("job-2", Buffer.from("bbbbbbbb"))).toEqual({ written: 8, signal: null });
  });
  it("measures the jobs directory, so a log removed outside the store frees the pool", () => {
    const { store } = storeOn(() => AT, { logBytes: 8, budget: 8 });
    value(store.accept(body()));
    expect(store.append("job-1", Buffer.from("aaaaaaaa"))).toEqual({ written: 8, signal: null });
    expect(store.accept(body({ id: "job-full" }))).toEqual({ ok: false, error: "disk" });
    unlinkSync(join(store.dir, "job-1.log"));
    expect(value(store.accept(body({ id: "job-2" }))).id).toBe("job-2");
    expect(store.append("job-2", Buffer.from("bbbbbbbb"))).toEqual({ written: 8, signal: null });
  });
  it("measures the jobs directory, so bytes written outside the store fill the pool", () => {
    const { store } = storeOn(() => AT, { logBytes: 8, budget: 8 });
    value(store.accept(body()));
    expect(store.append("job-1", Buffer.from("aaaa"))).toEqual({ written: 4, signal: null });
    writeFileSync(join(store.dir, "job-1.log"), "12345678");
    expect(store.accept(body({ id: "job-2" }))).toEqual({ ok: false, error: "disk" });
  });
  it("keeps the pool reserved when a log cannot be removed", async () => {
    let now = AT;
    const { store, dir } = storeOn(() => now, { logBytes: 8, budget: 8 });
    value(store.accept(body()));
    value(store.accept(body({ id: "job-2" })));
    await store.applySchedule({ default: 2 }, "off");
    value(store.started("job-1"));
    value(store.started("job-2"));
    expect(store.append("job-1", Buffer.from("aaaaaaaa"))).toEqual({ written: 8, signal: "capped" });
    value(await store.settle("job-1", EXIT));
    now = AT + JOB_KEEP_MS + 1;
    chmodSync(dir, 0o500);
    try { expect(() => store.prune()).toThrow(/EACCES/); }
    finally { chmodSync(dir, 0o700); }
    expect(existsSync(join(dir, "job-1.log"))).toBe(true);
    expect(store.append("job-2", Buffer.from("bbbbbbbb"))).toEqual({ written: 0, signal: "truncated" });
  });

  it("shows the notice the hub reported, and given_up follows pending", async () => {
    const { store } = storeOn();
    value(store.accept(body()));
    await store.applySchedule({ default: 1 }, "off");
    value(store.started("job-1"));
    value(await store.settle("job-1", EXIT));
    expect(store.preview("job-1")).toContain("notice: pending");
    store.markNotice("job-1", "given_up");
    expect(store.get("job-1")?.notice).toBe("given_up");
    expect(store.preview("job-1")).toContain("notice: given_up");
    store.markNotice("job-1", "pending");
    expect(store.get("job-1")?.notice).toBe("given_up");
  });
});
