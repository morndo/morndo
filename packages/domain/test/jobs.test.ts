// Background jobs (ADR-0017, design docs/design/background-jobs): pure states, one notice, queue order,
// redaction and the 24-hour token-hash cache. No processes, files or clocks of our own.
import { describe, expect, it } from "vitest";
import { redactText } from "@morndo/protocol";
import {
  COMMENT_MAX, ENDED_SKEW_MS, NOTICE_MAX, TOKEN_CACHE_MS, acceptJob, boundNotice, clampEnded, finish, fleetRecord, jobCounts, jobFailed, noticeCanMove, noticeCanReach, noticeIdOf, noticeText, parseTaskKey, redactJobOutput, schedule, taskEffect, taskNotice, tokenAllows,
  type Job, type StartBody,
} from "../src/index.ts";

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
const taskKey = (s: string) => {
  const key = parseTaskKey(s);
  if (!key) throw new Error(`not a task key: ${s}`);
  return key;
};
const queued = (over: Partial<StartBody> = {}, at = AT) => value(acceptJob(null, body(over), at));
const running = (over: Partial<StartBody> = {}, at = AT): Job => ({ ...queued(over, at), state: "running" });

describe("notice transitions", () => {
  it("confirms an uncertain notice and does not walk back from delivered", () => {
    expect(noticeCanMove("pending", "given_up")).toBe(true);
    expect(noticeCanMove("pending", "commented")).toBe(true);
    expect(noticeCanMove("uncertain", "delivered")).toBe(true);
    expect(noticeCanMove("held", "typed")).toBe(true);
    expect(noticeCanMove("delivered", "uncertain")).toBe(false);
    expect(noticeCanMove("delivered", "given_up")).toBe(false);
    expect(noticeCanMove("typed", "queued")).toBe(false);
    expect(noticeCanMove("delivered", "held")).toBe(false);
    expect(noticeCanMove("pending", "delivered")).toBe(false);
    expect(noticeCanReach("pending", "delivered")).toBe(true);
    expect(noticeCanReach("uncertain", "commented")).toBe(true);
    expect(noticeCanReach("delivered", "uncertain")).toBe(false);
    expect(noticeCanReach("typed", "queued")).toBe(false);
  });
});

describe("idempotent start", () => {
  it("the same id and body returns the job already stored, finished or not", () => {
    const first = queued();
    expect(value(acceptJob(first, body(), AT + 5))).toBe(first);
    const done = value(finish(running(), { outcome: "exited", exitCode: 0, durationMs: 1500 }));
    expect(value(acceptJob(done, body(), AT + 9))).toEqual(done);
  });
  it("the same id with another command is a conflict and the stored job stays", () => {
    const first = queued();
    expect(acceptJob(first, body({ commandHash: OTHER }), AT)).toEqual({ ok: false, error: "id_conflict" });
    expect(first.state).toBe("queued");
    expect(acceptJob(null, body({ commandHash: "echo hello" }), AT)).toEqual({ ok: false, error: "bad_hash" });
  });
  it("the same id from another lane is a conflict and does not return that job", () => {
    const first = queued({ lane: "builder" });
    expect(acceptJob(first, body({ lane: "other" }), AT)).toEqual({ ok: false, error: "id_conflict" });
    expect(first.lane).toBe("builder");
    expect(value(acceptJob(first, body({ lane: "builder" }), AT))).toBe(first);
  });
});

describe("terminal once", () => {
  it("an exit is recorded once, and a second outcome does not replace it", () => {
    const job = running();
    const done = value(finish(job, { outcome: "exited", exitCode: 0, durationMs: 1500 }));
    expect(done).toMatchObject({ state: "exited", outcome: "exited", exitCode: 0, durationMs: 1500, notice: "pending", noticeId: "node:job:job-1:done" });
    expect(value(finish(done, { outcome: "exited", exitCode: 0, durationMs: 1500 }))).toBe(done);
    expect(finish(done, { outcome: "lost", at: AT })).toEqual({ ok: false, error: "already_terminal" });
    expect(done.state).toBe("exited");
  });
  it("cancel from the queue never runs, and a second cancel is the same notice", () => {
    const job = queued();
    const done = value(finish(job, { outcome: "cancelled", exitCode: null, durationMs: 0 }));
    expect(done).toMatchObject({ state: "cancelled", exitCode: null, durationMs: 0, noticeId: noticeIdOf("job-1") });
    expect(value(finish(done, { outcome: "cancelled", exitCode: null, durationMs: 0 }))).toBe(done);
    expect(job.state).toBe("queued");
  });
  it("a running job with no exit is lost and still has a notice; a queued job is not lost", () => {
    const live = running();
    const lost = value(finish(live, { outcome: "lost", at: AT }));
    expect(lost).toMatchObject({ state: "lost", exitCode: null, notice: "pending", noticeId: "node:job:job-1:done" });
    expect(finish(queued(), { outcome: "lost", at: AT })).toEqual({ ok: false, error: "not_running" });
    expect(acceptJob(lost, body({ commandHash: OTHER }), AT)).toEqual({ ok: false, error: "id_conflict" });
  });
  it("a lost job keeps the time since it started, and a queued cancel has no exit code", () => {
    const live = { ...running(), startedAt: AT };
    const lost = value(finish(live, { outcome: "lost", at: AT + 3 * 3_600_000 }));
    expect(lost.durationMs).toBe(3 * 3_600_000);
    expect(lost.exitCode).toBeNull();
    const cancelled = value(finish(queued(), { outcome: "cancelled", exitCode: 137, durationMs: 99_999 }));
    expect(cancelled).toMatchObject({ state: "cancelled", exitCode: null, durationMs: 0 });
    expect(value(finish(cancelled, { outcome: "cancelled", exitCode: 137, durationMs: 99_999 }))).toBe(cancelled);
    const stopped = value(finish(running(), { outcome: "cancelled", exitCode: 137, durationMs: 50 }));
    expect(stopped).toMatchObject({ exitCode: 137, durationMs: 50 });
    const started = value(finish({ ...running(), startedAt: AT }, { outcome: "cancelled", exitCode: null, durationMs: 0 }));
    expect(finish(started, { outcome: "cancelled", exitCode: 143, durationMs: 5000 })).toEqual({ ok: false, error: "already_terminal" });
    expect(started).toMatchObject({ exitCode: null, durationMs: 0 });
  });
  it("a lost job rejects a clock that is not a whole number, and never stores NaN", () => {
    const live = { ...running(), startedAt: AT };
    expect(finish(live, { outcome: "lost", at: Number.NaN })).toEqual({ ok: false, error: "bad_exit" });
    expect(finish(live, { outcome: "lost", at: 1.5 })).toEqual({ ok: false, error: "bad_exit" });
    expect(finish(live, { outcome: "lost", at: Number.POSITIVE_INFINITY })).toEqual({ ok: false, error: "bad_exit" });
    expect(finish({ ...live, startedAt: Number.NaN }, { outcome: "lost", at: AT + 1000 })).toEqual({ ok: false, error: "bad_exit" });
    expect(live.durationMs).toBeNull();
    expect(value(finish(live, { outcome: "lost", at: AT + 4000 })).durationMs).toBe(4000);
  });
  it("a start that never created a process is exited from starting, with no start time", () => {
    const job = { ...queued(), state: "starting" as const };
    const done = value(finish(job, { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" }));
    expect(done).toMatchObject({ state: "exited", error: "did_not_start", exitCode: null, durationMs: 0, startedAt: null, notice: "pending" });
    expect(finish(queued(), { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" })).toEqual({ ok: false, error: "not_running" });
  });
  it("repeats a did_not_start exit from starting as the same job", () => {
    const job = { ...queued(), state: "starting" as const };
    const event = { outcome: "exited" as const, exitCode: 127, durationMs: 5, error: "did_not_start" as const };
    const done = value(finish(job, event));
    expect(done).toMatchObject({ state: "exited", error: "did_not_start", exitCode: null, durationMs: 0, startedAt: null });
    expect(value(finish(done, event))).toBe(done);
  });
});

describe("queue order", () => {
  it("limit 2 holds the third at position 1, admits it when a slot frees, and does not block another class", () => {
    const jobs = [running({ id: "a" }), running({ id: "b" }, AT + 1), queued({ id: "c" }, AT + 2), queued({ id: "d", jobClass: "pack" }, AT + 3)];
    const held = schedule(jobs, { default: 2, pack: 1 }, "off").jobs;
    expect(held.find(j => j.id === "c")).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(held.find(j => j.id === "d")).toMatchObject({ state: "starting", position: null, reason: null, startedAt: null });
    const after = schedule(held.map(j => j.id === "a" ? value(finish(j, { outcome: "exited", exitCode: 0, durationMs: 10 })) : j), { default: 2, pack: 1 }, "off").jobs;
    expect(after.find(j => j.id === "c")).toMatchObject({ state: "starting", position: null, startedAt: null });
    expect(after.find(j => j.id === "a")).toMatchObject({ state: "exited" });
  });
  it("a guard delays a start and never stops a job that is already running", () => {
    const jobs = [running({ id: "a" }), queued({ id: "b" }, AT + 1)];
    const loaded = schedule(jobs, { default: 2 }, "load").jobs;
    expect(loaded.find(j => j.id === "a")).toMatchObject({ state: "running" });
    expect(loaded.find(j => j.id === "b")).toMatchObject({ state: "queued", position: 1, reason: "load" });
    expect(schedule([queued({ id: "b" })], { default: 2 }, "off").jobs.find(j => j.id === "b")).toMatchObject({ state: "starting", startedAt: null });
    expect(schedule([queued({ id: "b" })], { default: 2 }, "memory").jobs.find(j => j.id === "b")).toMatchObject({ state: "queued", reason: "memory" });
    expect(schedule([queued({ id: "b" })], { default: 2 }, "unknown").jobs.find(j => j.id === "b")).toMatchObject({ state: "queued", reason: "guard_unknown" });
  });
  it("an unknown class is refused, including a name that only exists on the prototype", () => {
    const jobs = [queued({ id: "c", jobClass: "constructor" }), queued({ id: "d" }, AT + 1)];
    const result = schedule(jobs, { default: 1 }, "off");
    expect(result.refused).toEqual(["c"]);
    const refusedJob = result.jobs.find(j => j.id === "c");
    expect(refusedJob).toMatchObject({
      state: "refused", outcome: "refused", exitCode: null, durationMs: 0, notice: "pending", noticeId: noticeIdOf("c"),
    });
    expect(result.jobs.find(j => j.id === "d")).toMatchObject({ state: "starting", startedAt: null });
    expect(jobs[0]?.state).toBe("queued");
    if (!refusedJob) throw new Error("missing");
    expect(value(finish(refusedJob, { outcome: "refused" }))).toBe(refusedJob);
  });
});

describe("notice", () => {
  it("a short success is the fixed text, and a task effect is a comment with no status change", () => {
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 1500,
      logPath: "/home/someone/pack.log", home: "/home/someone", lines: ["all good"], error: null,
    }, (s) => s);
    expect(text).toBe("[morndo-job] pack exited\nid: job-1\nclass: default\nexit: 0\nduration: 1.5\nlog: /home/someone/pack.log\n---\nall good");
    const task = value(acceptJob(null, body({ notify: { kind: "task", key: taskKey("T-12") } }), AT));
    expect(taskEffect(task, "hello")).toEqual({ task: "T-12", text: "hello", status: null });
    expect(taskNotice({ outcome: "exited", notify: task.notify, tail: "shipped" })).toEqual({ task: "T-12", text: "shipped", status: null });
    expect(taskNotice({ outcome: null, notify: task.notify, tail: "shipped" })).toBeNull();
    expect(taskNotice({ outcome: "exited", notify: { kind: "lane", name: "builder" }, tail: "shipped" })).toBeNull();
    expect(taskEffect(queued(), "hello")).toBeNull();
    const lines = ["DROP-TAIL-TOP", ...Array.from({ length: 38 }, () => "m".repeat(200)), "KEEP-TAIL-END"];
    const wide = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/", lines, error: null,
    }, (s) => s);
    const comment = taskEffect(task, wide + "\x1b[31m");
    expect(wide.length).toBeGreaterThan(COMMENT_MAX);
    expect(comment?.text.length).toBeLessThanOrEqual(COMMENT_MAX);
    expect(comment?.text).toContain("KEEP-TAIL-END");
    expect(comment?.text).toContain("[morndo-job]");
    expect(comment?.text).not.toContain("DROP-TAIL-TOP");
    expect(comment?.text).not.toContain("\x1b");
    expect(comment?.status).toBeNull();
  });
  it("redacts the shared secrets and the job patterns, and keeps the notice inside the delivery cap", () => {
    const home = "/home/someone";
    const secret = "super-secret-token";
    const assignment = "super-token-value";
    const pem = "PEM-SENTINEL";
    const lines = [
      "DROP-ME " + "x".repeat(180),
      `Authorization: Bearer ${secret}`,
      `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`,
      `${home}/work`,
      "key AKIAIOSFODNN7EXAMPLE",
      `token=${assignment}`,
      "all good",
    ];
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 1, durationMs: 0,
      logPath: `${home}/pack.log`, home, lines, error: null,
    }, redactText);
    expect(text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(text).toContain("all good");
    expect(text).toContain("~/pack.log");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(assignment);
    expect(text).not.toContain(pem);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain(home);
    const long = noticeText({
      name: "pack", outcome: "timed_out", id: "job-1", jobClass: "default", exitCode: 137, durationMs: 5000,
      logPath: "~/pack.log", home: "/", lines: ["DROP-ME", ...Array.from({ length: 50 }, () => `y${"x".repeat(199)}`), `KEEP-ME${"z".repeat(193)}`],
      error: null,
    }, (s) => s);
    expect(long.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(long).toContain("KEEP-ME");
    expect(long).toContain("[truncated]");
    expect(long).not.toContain("DROP-ME");
    expect(long).toContain("exit: 137");
  });
  it("caps a long line before scanning it, so a 60 KB line stays cheap", () => {
    const marker = "ENDMARKER";
    const started = performance.now();
    const text = redactJobOutput(`{"password":"hunter2"}` + "a".repeat(60_000) + marker);
    expect(performance.now() - started).toBeLessThan(100);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(marker);
    expect(text.length).toBeLessThan(8_000);
  });
  it("redacts a quoted JSON secret, and leaves an ordinary word and a slash path", () => {
    const token = "abc123token";
    const password = "hunter2pass";
    const client = "client-secret-value";
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/",
      lines: [
        `{"access_token":"${token}","password": "${password}","client_secret":"${client}"}`,
        "Tests passed: 42, failed: 0",
        "author: Jane",
        "monkey=see",
        "keyboard: layout",
        "src/routes/api/users",
        "packages/domain/src/jobs",
      ],
      error: null,
    }, (s) => s);
    expect(text).toContain("access_token");
    expect(text).toContain("password");
    expect(text).toContain("client_secret");
    expect(text).not.toContain(token);
    expect(text).not.toContain(password);
    expect(text).not.toContain(client);
    expect(text).toContain("Tests passed: 42, failed: 0");
    expect(text).toContain("author: Jane");
    expect(text).toContain("monkey=see");
    expect(text).toContain("keyboard: layout");
    expect(text).toContain("src/routes/api/users");
    expect(text).toContain("packages/domain/src/jobs");
  });
  it("redacts NAME=value and NAME: value when the name contains a secret word, quotes included", () => {
    const access = "wJalrXUtnFEMI";
    const bare = "abc123value";
    const quoted = "quoted-pass-value";
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/",
      lines: [`AWS_SECRET_ACCESS_KEY=${access}`, `KEY=${bare}`, `password: "${quoted}"`, "token='quoted-token'"],
      error: null,
    }, (s) => s);
    expect(text).toContain("AWS_SECRET_ACCESS_KEY=[redacted]");
    expect(text).toContain("KEY=[redacted]");
    expect(text).toContain("password: [redacted]");
    expect(text).toContain("token=[redacted]");
    expect(text).toContain("exit: 0");
    expect(text).not.toContain(access);
    expect(text).not.toContain(bare);
    expect(text).not.toContain(quoted);
    expect(text).not.toContain("quoted-token");
  });
  it("redacts a private key before the tail is cut, including a lone armor line and a key body", () => {
    const limb = "Ab+/";
    const body = limb.repeat(16);
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/",
      lines: ["-----BEGIN PRIVATE KEY-----", ...Array.from({ length: 50 }, () => body), "-----END PRIVATE KEY-----", "visible-tail"],
      error: null,
    }, redactText);
    expect(text).toContain("visible-tail");
    expect(text).not.toContain(limb);
    expect(text).not.toContain("BEGIN PRIVATE");
    expect(text).not.toContain("END PRIVATE");
    const lone = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/", lines: ["-----BEGIN RSA PRIVATE KEY-----", "still-here"], error: null,
    }, (s) => s);
    expect(lone).toContain("still-here");
    expect(lone).not.toContain("BEGIN RSA");
    const orphan = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/", lines: [body, "still-here"], error: null,
    }, (s) => s);
    expect(orphan).toContain("still-here");
    expect(orphan).not.toContain(limb);
  });
  it("strips control characters and ANSI from every notice, and keeps a newline and a tab", () => {
    const text = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/",
      lines: ["ok\x1b[31mred\x1b[0m", "a\rb", "bell\x07", "col\tum"],
      error: null,
    }, (s) => s);
    expect(text).toContain("okred");
    expect(text).toContain("ab");
    expect(text).toContain("bell");
    expect(text).toContain("col\tum");
    expect(text).toContain("\n");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\x07");
    const osc = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/",
      lines: ["link\x1b]8;;https://secret.example\x1b\\after", "c1\u009b31mred\u009b0m", "raw\u0080\u009f"],
      error: null,
    }, (s) => s);
    expect(osc).toContain("linkafter");
    expect(osc).toContain("c1red");
    expect(osc).toContain("raw");
    expect(osc).not.toContain("https://secret.example");
    expect(osc).not.toContain("\x1b");
    expect(osc).not.toContain("\u0080");
    expect(osc).not.toContain("\u009b");
    expect(osc).not.toContain("\u009f");
  });
  it("redacts a home path and a tailnet name before the line is cut, and fits again after redaction grows", () => {
    const home = "/home/someone";
    const host = "box.tail1234.ts.net";
    const homeLine = "n".repeat(190) + `${home}/work`;
    const hostLine = "h".repeat(190) + host;
    const hidden = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home, lines: [homeLine, hostLine], error: null,
    }, redactText);
    expect(hidden).toContain("~/work");
    expect(hidden).toContain("[tailnet-host]");
    expect(hidden).not.toContain(home);
    expect(hidden).not.toContain("/home/som");
    expect(hidden).not.toContain("box.tail");
    const row = "a@b ".repeat(49);
    const grown = noticeText({
      name: "pack", outcome: "exited", id: "job-1", jobClass: "default", exitCode: 0, durationMs: 0,
      logPath: "/tmp/pack.log", home: "/", lines: [...Array.from({ length: 39 }, () => row), "KEEP-END"], error: null,
    }, redactText);
    expect(grown.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(grown).toContain("KEEP-END");
    expect(grown).toContain("[truncated]");
    expect(grown).toContain("[email]");
    expect(grown).not.toContain("a@b");
  });
  it("redacts the finished notice once", () => {
    let calls = 0;
    const text = noticeText({
      name: "pack", outcome: "timed_out", id: "job-1", jobClass: "default", exitCode: 137, durationMs: 5000,
      logPath: "~/pack.log", home: "/",
      lines: ["DROP-ME", ...Array.from({ length: 50 }, () => `y${"x".repeat(199)}`), `KEEP-ME${"z".repeat(193)}`],
      error: null,
    }, (s) => { calls += 1; return s; });
    expect(text).toContain("KEEP-ME");
    expect(calls).toBe(1);
  });
});

describe("a notice that has to fit the frame", () => {
  it("keeps a suffix inside NOTICE_MAX and strips controls", () => {
    const raw = `${"\x1b[31m"}${"x".repeat(NOTICE_MAX)}\n---\nline`;
    const text = boundNotice(raw, "log truncated: pool full");
    expect(text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(text).toContain("log truncated: pool full");
    expect(text).toContain("---");
    expect(text).toContain("line");
    expect(text).not.toContain("\x1b");
  });
  it("drops the oldest lines and keeps the footer and the newest line", () => {
    const text = boundNotice(`OLDEST\n${"y".repeat(NOTICE_MAX)}\n---\nNEWEST-LINE`, "log truncated: pool full");
    expect(text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(text).toContain("---");
    expect(text).toContain("log truncated: pool full");
    expect(text).toContain("NEWEST-LINE");
    expect(text).not.toContain("OLDEST");
    const plain = boundNotice(`${"a".repeat(40)}\n---\n${"b".repeat(NOTICE_MAX)}\nKEEP`);
    expect(plain.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(plain.endsWith("KEEP")).toBe(true);
    expect(plain).toContain("---");
  });
});

describe("fleet record", () => {
  it("carries the tail and not the command or the working directory", () => {
    const done = value(finish(running(), { outcome: "exited", exitCode: 0, durationMs: 1000 }));
    const view = fleetRecord(done, { node: "box", at: AT + 1000, tail: "all good" });
    expect(view).toMatchObject({ v: 1, t: "job", id: "job-1", node: "box", class: "default", state: "exited", exit: 0, durationSec: 1, tail: "all good", task: null });
    const flat = JSON.stringify(view);
    expect(flat).not.toContain("secret-command");
    expect(flat).not.toContain("secret-cwd");
    expect(flat).toContain("all good");
  });
  it("carries the queue place, the reason and a did_not_start error", () => {
    const waiting = schedule([queued()], { default: 1 }, "load").jobs[0];
    if (!waiting) throw new Error("missing");
    expect(fleetRecord(waiting, { node: "box", at: AT, tail: "" })).toMatchObject({ position: 1, reason: "load", error: null, state: "queued" });
    const failed = value(finish(running(), { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" }));
    expect(fleetRecord(failed, { node: "box", at: AT, tail: "" })).toMatchObject({ error: "did_not_start", exit: null, position: null, reason: null });
  });
});

describe("a task notice", () => {
  const job = { outcome: "refused" as const, notify: { kind: "task" as const, key: taskKey("T-5") }, tail: "" };
  it("does not comment when the notice has no text", () => {
    expect(taskNotice(job)).toBeNull();
    expect(taskNotice({ ...job, tail: "   " })).toBeNull();
    expect(taskNotice({ ...job, outcome: "exited", tail: "shipped" })).toEqual({ task: "T-5", text: "shipped", status: null });
  });
});

describe("what the hub counts, and what raises job_failed", () => {
  const row = (over: { node?: string; state?: Job["state"]; outcome?: Job["outcome"]; exit?: number | null; at?: number; ended?: number | null }) => ({
    node: "pc", state: "exited" as const, outcome: "exited" as const, exit: 0 as number | null, at: AT, ended: AT as number | null, ...over,
  });
  it("counts running, queued, and failures of the last day, per node", () => {
    expect(jobFailed(row({ exit: 0 }))).toBe(false);
    expect(jobFailed(row({ outcome: "cancelled", exit: null }))).toBe(false);
    expect(jobFailed(row({ outcome: "refused", exit: null }))).toBe(false);
    expect(jobFailed(row({ exit: 1 }))).toBe(true);
    expect(jobFailed(row({ outcome: "timed_out", exit: null }))).toBe(true);
    expect(jobFailed(row({ outcome: "lost", exit: null }))).toBe(true);
    const day = 24 * 60 * 60 * 1000;
    expect(jobCounts([
      row({ state: "running", outcome: null, exit: null }),
      row({ state: "queued", outcome: null, exit: null }),
      row({ exit: 1 }),
      row({ exit: 1, at: AT, ended: AT - day - 1 }),
      row({ exit: 1, ended: AT + 5_000 }),
      row({ exit: 1, ended: AT + 30 * day }),
      row({ exit: 1, ended: null }),
      row({ node: "mac", outcome: "timed_out", exit: null }),
      row({ node: "mac", outcome: "cancelled", state: "cancelled", exit: null }),
    ], AT + 1000)).toEqual([
      { node: "mac", running: 0, queued: 0, failed: 1 },
      { node: "pc", running: 1, queued: 1, failed: 2 },
    ]);
    expect(clampEnded(AT + 30 * day, AT)).toBe(AT);
    expect(clampEnded(AT + ENDED_SKEW_MS, AT)).toBe(AT + ENDED_SKEW_MS);
    expect(clampEnded(null, AT)).toBeNull();
  });
});

describe("token cache", () => {
  const hash = "c".repeat(64);
  const fresh = { lane: "builder", hash, checkedAt: AT };
  it("a live refusal wins, and an offline cache allows only the same lane and hash for 24 hours", () => {
    expect(tokenAllows({ reachable: true, allowed: false })).toBe(false);
    expect(tokenAllows({ reachable: true, allowed: true })).toBe(true);
    expect(tokenAllows({ reachable: false, lane: "builder", hash, cache: fresh, now: AT + TOKEN_CACHE_MS })).toBe(true);
    expect(tokenAllows({ reachable: false, lane: "builder", hash, cache: fresh, now: AT + TOKEN_CACHE_MS + 1 })).toBe(false);
    expect(tokenAllows({ reachable: false, lane: "other", hash, cache: fresh, now: AT + 1 })).toBe(false);
    expect(tokenAllows({ reachable: false, lane: "builder", hash: OTHER, cache: fresh, now: AT + 1 })).toBe(false);
    expect(tokenAllows({ reachable: false, lane: "builder", hash, cache: null, now: AT })).toBe(false);
  });
});
