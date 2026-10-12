// Child supervisor (ADR-0017, design §3, §11, §12 step 3). No systemd: a detached helper, an exit file, and the
// local socket. These rows are the ones that do not need a user manager.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { noticeIdOf, type Job } from "@morndo/domain";
import { processIdentity, resetProcessStartCache } from "@morndo/node-ops";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobStore, type NoticeHandoff } from "../src/ops/job-store.ts";
import { psStarts, START_RECORD_GRACE_MS, writeProcessFile } from "../src/ops/job-identity.ts";
import { JobGrants } from "../src/ops/job-grant.ts";
import { JobSupervisor, type JobStart } from "../src/ops/job-supervisor.ts";
import { agentPaths } from "../src/paths.ts";
import { until } from "./helpers.ts";
import { tempHome } from "./helpers.ts";

const HOLD = `process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)`;
const GROUP = `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const out = process.argv[1];
  const run = process.argv[2];
  fs.appendFileSync(run, "x");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(HOLD)}], { stdio: "ignore" });
  fs.writeFileSync(out, process.pid + " " + child.pid);
  setInterval(() => {}, 1000);
`;
const ORPHAN = `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const child = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGHUP",()=>{}); process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1e9)`)}], { stdio: "ignore" });
  fs.writeFileSync(process.argv[1], String(child.pid));
  process.exit(0);
`;
const EXIT_LATER = `
  const fs = require("node:fs");
  setTimeout(() => { fs.appendFileSync(process.argv[1], "x"); process.exit(Number(process.argv[2])); }, Number(process.argv[3]));
`;

const inspectorFor = (pid: number): boolean => {
  const out = execFileSync("ss", ["-H", "-ltnp"], { encoding: "utf8" });
  return out.split("\n").some(line => line.includes(":9229") && line.includes(`pid=${pid},`));
};

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function sessionId(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(rest[3]);
}

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};

const open: { adb: AgentDb; cleanup: () => void; dir: string; sup: JobSupervisor }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.sup.close();
    if (existsSync(o.dir)) {
      for (const name of readdirSync(o.dir)) {
        if (!name.endsWith(".pid") && !name.endsWith(".child")) continue;
        const pid = Number(readFileSync(join(o.dir, name), "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try { process.kill(-pid, "SIGKILL"); } catch { /* not a group */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    o.adb.close();
    o.cleanup();
  }
});

const TOKEN = "mat_secret-token";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function grantHub(): Promise<{ url: string; seen: { authorization: string; body: string }[]; answer: { status: number; body: unknown } | "down"; close: () => Promise<void> }> {
  const seen: { authorization: string; body: string }[] = [];
  const state: { answer: { status: number; body: unknown } | "down" } = { answer: { status: 200, body: {} } };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      seen.push({ authorization: String(req.headers.authorization ?? ""), body: Buffer.concat(chunks).toString("utf8") });
      if (state.answer === "down") { res.destroy(); return; }
      res.writeHead(state.answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.answer.body));
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("hub");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        seen,
        get answer() { return state.answer; },
        set answer(value) { state.answer = value; },
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function rig(limits?: Record<string, number>, env?: NodeJS.ProcessEnv, logBytes?: number, node?: string, hubBase?: string, budget?: number) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  const work = join(h.home, "work");
  mkdirSync(work, { recursive: true });
  const notices: NoticeHandoff[] = [];
  const store = new JobStore(adb.db, dir, () => Date.now(), {
    home: h.home, onNotice: n => notices.push(n),
    ...(logBytes !== undefined ? { logBytes } : {}),
    ...(budget !== undefined ? { budget } : {}),
  });
  const paths = agentPaths(h.home);
  const sup = new JobSupervisor(store, {
    home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
    grants: new JobGrants(adb.db, () => Date.now()),
    ...(hubBase ? { hubBase } : {}),
    ...(limits ? { limits } : {}),
    ...(env ? { env } : {}),
    ...(node ? { node } : {}),
  });
  const slot = { adb, cleanup: h.cleanup, dir, sup };
  open.push(slot);
  const start = async (over: Partial<JobStart> & Pick<JobStart, "id" | "command">): Promise<Job> => value(await sup.start({
    lane: "builder", name: "pack", jobClass: "default", notify: { kind: "lane", name: "builder" }, cwd: work, ...over,
  }));
  return { sup, store, dir, work, home: h.home, notices, paths, adb, start, slot };
}

function replace(slot: { sup: JobSupervisor }, store: JobStore, home: string, paths: ReturnType<typeof agentPaths>) {
  slot.sup.close();
  slot.sup = new JobSupervisor(store, { home, stateDir: paths.stateDir, socketPath: paths.jobSock });
  return slot.sup;
}

function ask(sock: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buf = "";
    socket.on("error", reject);
    socket.on("data", chunk => {
      buf += String(chunk);
      const i = buf.indexOf("\n");
      if (i < 0) return;
      socket.end();
      resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
    });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

describe("child supervisor", () => {
  it("accepts a start on the local socket without the caller's environment or the command in the row", async () => {
    const hub = await grantHub();
    hub.answer = { status: 200, body: { ok: true, lane: "builder", hash: TOKEN_HASH } };
    const { sup, store, work, paths, adb } = rig(undefined, { ...process.env, LEAK_SENTINEL: "should-not-appear" }, undefined, undefined, hub.url);
    await sup.listen();
    expect(statSync(paths.jobSock).mode & 0o777).toBe(0o600);
    const envFile = join(work, "env");
    const script = `require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ id: process.env.MORNDO_JOB_ID ?? null, lane: process.env.MORNDO_LANE ?? null, leak: process.env.LEAK_SENTINEL ?? null }))`;
    const reply = await ask(paths.jobSock, {
      op: "start", id: "job-socket", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, timeoutMs: null,
      command: [process.execPath, "-e", script, envFile, "ARGV-SENTINEL"],
      token: TOKEN,
    });
    expect(reply.ok).toBe(true);
    expect(JSON.stringify(reply)).not.toContain("ARGV-SENTINEL");
    expect(await until(async () => { await sup.sweep(); return store.get("job-socket")?.outcome === "exited"; })).toBe(true);
    expect(existsSync(envFile)).toBe(true);
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({ id: "job-socket", lane: "builder", leak: null });
    const row = JSON.stringify(adb.db.prepare("SELECT * FROM jobs WHERE id = ?").get("job-socket"));
    expect(row).not.toContain("ARGV-SENTINEL");
    expect(row).toContain("job-socket");
    const denied = await sup.start({
      id: "job-denied", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: paths.stateDir, command: [process.execPath, "-e", "process.exit(0)"],
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toBe("denied");
    expect(store.get("job-denied")).toBeNull();
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache").get()).toEqual({ lane: "builder", hash: TOKEN_HASH });
    expect(JSON.stringify(adb.db.prepare("SELECT * FROM jobs").all())).not.toContain(TOKEN);
    expect(hub.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(hub.seen[0]?.body).not.toContain(TOKEN);
    const lied = await ask(paths.jobSock, {
      op: "start", id: "job-lied", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      grant: { kind: "live", hash: "cd".repeat(32) },
      hub: "http://127.0.0.1:1",
    });
    expect(lied).toEqual({ ok: false, error: "hub" });
    expect(store.get("job-lied")).toBeNull();
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache").all()).toEqual([{ lane: "builder", hash: TOKEN_HASH }]);
    hub.answer = { status: 200, body: { ok: true, lane: "builder", hash: "cd".repeat(32) } };
    const mismatch = await ask(paths.jobSock, {
      op: "start", id: "job-mismatch", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: TOKEN,
    });
    expect(mismatch).toEqual({ ok: false, error: "hub" });
    expect(store.get("job-mismatch")).toBeNull();
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache").all()).toEqual([{ lane: "builder", hash: TOKEN_HASH }]);
    hub.answer = "down";
    const cached = await ask(paths.jobSock, {
      op: "start", id: "job-cached", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: TOKEN,
    });
    expect(cached.ok).toBe(true);
    const other = await ask(paths.jobSock, {
      op: "start", id: "job-other", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: "mat_other-token",
    });
    expect(other).toEqual({ ok: false, error: "no_cache" });
    expect(store.get("job-other")).toBeNull();
    hub.answer = { status: 401, body: { error: "revoked" } };
    const revoked = await ask(paths.jobSock, {
      op: "start", id: "job-revoked", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: TOKEN,
    });
    expect(revoked).toEqual({ ok: false, error: "hub" });
    expect(store.get("job-revoked")).toBeNull();
    expect(adb.db.prepare("SELECT COUNT(*) AS n FROM token_cache").get()).toEqual({ n: 0 });
    await hub.close();
  });

  it("acts for the lane cached with the token, and a not_yours answer leaves every hash", async () => {
    const hub = await grantHub();
    const other = "mat_other-token";
    const otherHash = createHash("sha256").update(other).digest("hex");
    hub.answer = { status: 200, body: { ok: true, lane: "builder", hash: TOKEN_HASH } };
    const { sup, store, work, paths, adb } = rig(undefined, undefined, undefined, undefined, hub.url);
    await sup.listen();
    const started = await ask(paths.jobSock, {
      op: "start", id: "job-lane", lane: "reviewer", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "console.log('lane-log')"],
      token: TOKEN,
    });
    expect(started.ok).toBe(true);
    expect(store.get("job-lane")?.lane).toBe("builder");
    expect(await until(async () => { await sup.sweep(); return store.get("job-lane")?.outcome === "exited"; })).toBe(true);
    expect(await ask(paths.jobSock, { op: "list", lane: "reviewer", token: TOKEN })).toMatchObject({ ok: true, jobs: [{ id: "job-lane" }] });
    expect(await ask(paths.jobSock, { op: "show", id: "job-lane", lane: "nope", token: TOKEN })).toMatchObject({ ok: true });
    expect(await ask(paths.jobSock, { op: "logs", id: "job-lane", lane: "nope", token: TOKEN })).toEqual({ ok: true, text: "lane-log" });
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("reviewer", otherHash, Date.now());
    hub.answer = { status: 403, body: { error: "not_yours" } };
    const mismatch = await ask(paths.jobSock, {
      op: "start", id: "job-miss", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "reviewer" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: other,
    });
    expect(mismatch).toEqual({ ok: false, error: "not_yours" });
    expect(store.get("job-miss")).toBeNull();
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache ORDER BY lane").all()).toEqual([
      { lane: "builder", hash: TOKEN_HASH },
      { lane: "reviewer", hash: otherHash },
    ]);
    expect(await ask(paths.jobSock, { op: "cancel", id: "job-lane", lane: "builder", token: other })).toEqual({ ok: false, error: "not_yours" });
    expect(store.get("job-lane")?.outcome).toBe("exited");
    const own = await ask(paths.jobSock, { op: "cancel", id: "job-lane", lane: "reviewer", token: TOKEN });
    expect(own.ok).toBe(true);
    await hub.close();
  });

  it("refuses a start when this node has no hub address, and does not use the cache", async () => {
    const { sup, store, work, paths, adb } = rig();
    await sup.listen();
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("builder", TOKEN_HASH, Date.now());
    const reply = await ask(paths.jobSock, {
      op: "start", id: "job-nohub", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: TOKEN,
    });
    expect(reply).toEqual({ ok: false, error: "no_hub" });
    expect(store.get("job-nohub")).toBeNull();
    expect(adb.db.prepare("SELECT lane, hash FROM token_cache").all()).toEqual([{ lane: "builder", hash: TOKEN_HASH }]);
  });

  it("lists, shows and prints the log of this lane's job", async () => {
    const { sup, store, work, paths, adb } = rig();
    await sup.listen();
    await sup.start({
      id: "job-see", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "console.log('hello-log')"],
    });
    expect(await until(async () => { await sup.sweep(); return store.get("job-see")?.outcome === "exited"; })).toBe(true);
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("builder", TOKEN_HASH, Date.now());
    const list = await ask(paths.jobSock, { op: "list", lane: "builder", token: TOKEN });
    expect(list).toMatchObject({ ok: true, jobs: [{ id: "job-see", state: "exited" }] });
    const waiting = await ask(paths.jobSock, { op: "list", lane: "builder", state: "running", token: TOKEN });
    expect(waiting).toEqual({ ok: true, jobs: [] });
    const show = await ask(paths.jobSock, { op: "show", id: "job-see", lane: "builder", token: TOKEN });
    expect(show.ok).toBe(true);
    expect(JSON.stringify(show)).toContain("pack exited");
    expect(JSON.stringify(show)).toContain("hello-log");
    const logs = await ask(paths.jobSock, { op: "logs", id: "job-see", lane: "builder", lines: 10, token: TOKEN });
    expect(logs).toEqual({ ok: true, text: "hello-log" });
    expect(await ask(paths.jobSock, { op: "list", lane: "reviewer", token: TOKEN })).toMatchObject({ ok: true, jobs: [{ id: "job-see" }] });
    const other = "mat_reviewer-token";
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("reviewer", createHash("sha256").update(other).digest("hex"), Date.now());
    expect(await ask(paths.jobSock, { op: "show", id: "job-see", lane: "builder", token: other })).toEqual({ ok: false, error: "not_yours" });
    expect(await ask(paths.jobSock, { op: "logs", id: "job-see", lane: "builder", token: other })).toEqual({ ok: false, error: "not_yours" });
    expect(adb.db.prepare("SELECT lane FROM token_cache ORDER BY lane").all()).toEqual([{ lane: "builder" }, { lane: "reviewer" }]);
    expect(JSON.stringify(list)).not.toContain("console.log");
  });

  it("reattaches after the supervisor closes and reports the real exit once", async () => {
    const { sup, store, dir, work, home, notices, paths, start, slot } = rig();
    const marker = join(work, "ran");
    const command = [process.execPath, "-e", EXIT_LATER, marker, "4", "2000"] as const;
    const job = await start({ id: "job-reattach", command });
    expect(job.state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-reattach.pid")) && existsSync(join(dir, "job-reattach.child")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-reattach.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "job-reattach.child"), "utf8"));
    expect(alive(helper)).toBe(true);
    expect(alive(child)).toBe(true);
    expect(sessionId(helper)).toBe(helper);
    expect(sessionId(helper)).not.toBe(sessionId(process.pid));
    expect(sessionId(child)).toBe(child);
    const again = await sup.start({
      id: "job-reattach", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command,
    });
    expect(value(again).state).toBe("running");
    expect(readFileSync(join(dir, "job-reattach.pid"), "utf8")).toBe(String(helper));
    const conflict = await sup.start({
      id: "job-reattach", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: [process.execPath, "-e", "process.exit(9)"],
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toBe("id_conflict");
    sup.close();
    expect(alive(helper)).toBe(true);
    expect(alive(child)).toBe(true);
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-reattach")?.state).toBe("running");
    expect(alive(child)).toBe(true);
    expect(await until(() => existsSync(join(dir, "job-reattach.exit")))).toBe(true);
    await next.sweep();
    expect(store.get("job-reattach")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 4 });
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-reattach")]);
    await next.sweep();
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-reattach")]);
    expect(store.list().map(j => j.id)).toContain("job-reattach");
  });

  it("reads the exit file after the command finished while the supervisor was closed and does not start it again", async () => {
    const { sup, store, dir, work, home, notices, paths, start, slot } = rig();
    const marker = join(work, "ran");
    expect((await start({ id: "job-exit", command: [process.execPath, "-e", EXIT_LATER, marker, "5", "200"] })).state).toBe("running");
    sup.close();
    expect(await until(() => existsSync(join(dir, "job-exit.exit")))).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("x");
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-exit")).toMatchObject({ outcome: "exited", exitCode: 5 });
    expect(notices.map(n => n.text).some(t => t.includes("exited") && t.includes("exit: 5"))).toBe(true);
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-exit")]);
    await next.sweep();
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-exit")]);
  });

  it("marks a vanished process lost and keeps the row", async () => {
    const { sup, store, dir, work, home, notices, paths, start, slot } = rig();
    const group = join(work, "group");
    const run = join(work, "ran");
    expect((await start({ id: "job-lost", command: [process.execPath, "-e", GROUP, group, run] })).state).toBe("running");
    expect(await until(() => existsSync(group))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-lost.pid"), "utf8"));
    const [parent, grand] = readFileSync(group, "utf8").split(" ").map(Number);
    sup.close();
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(-Number(parent), "SIGKILL"); } catch { try { process.kill(Number(parent), "SIGKILL"); } catch { /* gone */ } }
    try { process.kill(Number(grand), "SIGKILL"); } catch { /* gone */ }
    expect(await until(() => !alive(helper) && !alive(Number(parent)) && !alive(Number(grand)))).toBe(true);
    expect(existsSync(join(dir, "job-lost.exit"))).toBe(false);
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-lost")).toMatchObject({ state: "lost", outcome: "lost" });
    expect(store.list().map(j => j.id)).toContain("job-lost");
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-lost")]);
    expect(notices[0]?.text).toContain("lost");
    expect(readFileSync(run, "utf8")).toBe("x");
  });

  it("a timeout kills the process group and the notice says timed_out", async () => {
    const { sup, store, dir, work, home, notices, paths, start, slot } = rig();
    const group = join(work, "group");
    const run = join(work, "ran");
    expect((await start({
      id: "job-timeout", timeoutMs: 400,
      command: [process.execPath, "-e", GROUP, group, run],
    })).state).toBe("running");
    expect(await until(() => existsSync(group))).toBe(true);
    const [parent, grand] = readFileSync(group, "utf8").split(" ").map(Number);
    sup.close();
    expect(await until(() => existsSync(join(dir, "job-timeout.exit")) && !alive(Number(parent)) && !alive(Number(grand)), 8000)).toBe(true);
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-timeout")).toMatchObject({ outcome: "timed_out" });
    expect(notices[0]?.text).toContain("timed_out");
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-timeout")]);
    expect(readFileSync(run, "utf8")).toBe("x");
    await next.sweep();
    expect(notices.map(n => n.noticeId)).toEqual([noticeIdOf("job-timeout")]);
  });

  it("cancel of a queued job never runs it, and cancel of a running job stops the group once", async () => {
    const queued = rig({ default: 0 });
    const run = join(queued.work, "ran");
    expect((await queued.start({ id: "job-queued", command: [process.execPath, "-e", GROUP, join(queued.work, "group"), run] })).state).toBe("queued");
    expect(existsSync(join(queued.dir, "job-queued.pid"))).toBe(false);
    const first = value(await queued.sup.cancel("job-queued"));
    expect(first.job).toMatchObject({ outcome: "cancelled", exitCode: null, durationMs: 0 });
    expect(first.noticeId).toBe(noticeIdOf("job-queued"));
    expect(first.text).toContain("cancelled");
    expect(existsSync(run)).toBe(false);
    expect(queued.store.list().map(j => j.id)).toContain("job-queued");
    const second = value(await queued.sup.cancel("job-queued"));
    expect(second.noticeId).toBe(first.noticeId);
    expect(existsSync(run)).toBe(false);
    expect(new Set(queued.notices.map(n => n.noticeId))).toEqual(new Set([noticeIdOf("job-queued")]));

    const running = rig();
    const group = join(running.work, "group");
    const ran = join(running.work, "ran");
    expect((await running.start({ id: "job-cancel", command: [process.execPath, "-e", GROUP, group, ran] })).state).toBe("running");
    expect(await until(() => existsSync(group))).toBe(true);
    const [parent, grand] = readFileSync(group, "utf8").split(" ").map(Number);
    const stopped = value(await running.sup.cancel("job-cancel"));
    expect(stopped.job.outcome).toBe("cancelled");
    expect(stopped.noticeId).toBe(noticeIdOf("job-cancel"));
    expect(alive(Number(parent))).toBe(false);
    expect(alive(Number(grand))).toBe(false);
    expect(readFileSync(ran, "utf8")).toBe("x");
    const repeated = value(await running.sup.cancel("job-cancel"));
    expect(repeated.noticeId).toBe(stopped.noticeId);
    expect(readFileSync(ran, "utf8")).toBe("x");
    expect(new Set(running.notices.map(n => n.noticeId))).toEqual(new Set([noticeIdOf("job-cancel")]));
  });

  it("refuses to cancel another lane's job", async () => {
    const { sup, store, work, paths, adb } = rig();
    await sup.listen();
    expect((await sup.start({
      id: "job-own", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: [process.execPath, "-e", HOLD],
    })).ok).toBe(true);
    expect(store.get("job-own")?.state).toBe("running");
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("builder", TOKEN_HASH, Date.now());
    const other = "mat_reviewer-token";
    adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("reviewer", createHash("sha256").update(other).digest("hex"), Date.now());
    expect(await ask(paths.jobSock, { op: "cancel", id: "job-own", lane: "builder", token: other })).toEqual({ ok: false, error: "not_yours" });
    expect(store.get("job-own")?.state).toBe("running");
    expect(store.get("job-own")?.outcome).toBeNull();
    expect(adb.db.prepare("SELECT COUNT(*) AS n FROM token_cache").get()).toEqual({ n: 2 });
    const own = await ask(paths.jobSock, { op: "cancel", id: "job-own", lane: "reviewer", token: TOKEN });
    expect(own.ok).toBe(true);
    expect(store.get("job-own")?.outcome).toBe("cancelled");
  });

  it("launches the job a free slot promotes, including when another job ends", async () => {
    const { store, dir, start, sup } = rig({ default: 1 });
    const hold = [process.execPath, "-e", HOLD] as const;
    expect((await start({ id: "job-a", command: hold })).state).toBe("running");
    expect((await start({ id: "job-b", command: hold })).state).toBe("queued");
    expect(existsSync(join(dir, "job-b.pid"))).toBe(false);
    expect(await until(() => existsSync(join(dir, "job-a.child")))).toBe(true);
    expect(value(await sup.cancel("job-a")).job.outcome).toBe("cancelled");
    expect(await until(() => store.get("job-b")?.state === "running" && existsSync(join(dir, "job-b.pid")))).toBe(true);
    expect((await start({ id: "job-c", command: hold })).state).toBe("queued");
    expect(store.get("job-b")?.state).toBe("running");
  });

  it("stays up when a client drops, and a helper that cannot spawn is did_not_start", async () => {
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => { errors.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      const running = rig();
      await running.sup.listen();
      expect((await running.start({ id: "job-hold", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
      expect(await until(() => existsSync(join(running.dir, "job-hold.child")))).toBe(true);
      const socket = connect(running.paths.jobSock);
      running.adb.db.prepare("INSERT INTO token_cache (lane, hash, checked_at) VALUES (?, ?, ?)").run("builder", TOKEN_HASH, Date.now());
      const line = JSON.stringify({ op: "cancel", id: "job-hold", lane: "reviewer", token: TOKEN });
      socket.write(`${line}\n`);
      await until(() => false, 50);
      socket.write(`${line}\n`);
      socket.destroy();
      expect(await until(() => running.store.get("job-hold")?.outcome !== null, 8000)).toBe(true);
      await until(() => false, 100);
      const again = await ask(running.paths.jobSock, { op: "cancel", id: "job-hold", lane: "builder", token: TOKEN });
      expect(again.ok).toBe(true);
      expect(errors).toEqual([]);

      const missed = rig(undefined, undefined, undefined, "/no/such/morndo-node");
      await missed.start({ id: "job-spawn", command: [process.execPath, "-e", "process.exit(0)"] });
      expect(await until(async () => { await missed.sup.sweep(); return missed.store.get("job-spawn")?.error === "did_not_start"; })).toBe(true);
      expect(missed.store.get("job-spawn")).toMatchObject({ outcome: "exited", error: "did_not_start", exitCode: null, durationMs: 0 });
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("a sweep waits for a cancel of the same job instead of settling it twice", async () => {
    const { dir, start, sup, store, notices } = rig();
    expect((await start({ id: "job-once", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-once.child")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-once.pid"), "utf8"));
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
    expect(await until(() => !alive(helper))).toBe(true);
    const settled = sup.cancel("job-once");
    const swept = sup.sweep();
    const result = await settled;
    await swept;
    expect(result.ok).toBe(true);
    expect(store.get("job-once")).toMatchObject({ outcome: "lost" });
    expect(notices.filter(n => n.noticeId === noticeIdOf("job-once"))).toHaveLength(1);
  });

  it("a cancel whose signal is refused because the helper is gone is lost", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-esrch", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-esrch.child")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-esrch.pid"), "utf8"));
    const orig = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === helper && signal === "SIGTERM") {
        try { orig(pid, "SIGKILL"); } catch { /* already gone */ }
        const error = new Error("esrch") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return orig(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      expect(value(await sup.cancel("job-esrch")).job).toMatchObject({ outcome: "lost" });
      expect(store.get("job-esrch")).toMatchObject({ outcome: "lost" });
    } finally {
      process.kill = orig;
      try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("a cancel that finds the helper already dead is lost and the child group is gone", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-early", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-early.child")))).toBe(true);
    expect(await until(() => existsSync(join(dir, "job-early.child.at")))).toBe(true);
    expect(await until(() => existsSync(join(dir, "job-early.pid.at")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-early.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "job-early.child"), "utf8"));
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
    expect(await until(() => !alive(helper))).toBe(true);
    expect(existsSync(join(dir, "job-early.exit"))).toBe(false);
    expect(value(await sup.cancel("job-early")).job).toMatchObject({ outcome: "lost" });
    expect(store.get("job-early")).toMatchObject({ outcome: "lost" });
    expect(await until(() => !alive(child))).toBe(true);
  });

  it("a sweep that finds the helper already dead kills the child group and records lost", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-dead", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-dead.child.at")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-dead.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "job-dead.child"), "utf8"));
    try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
    expect(await until(() => !alive(helper))).toBe(true);
    await sup.sweep();
    expect(store.get("job-dead")).toMatchObject({ outcome: "lost" });
    expect(alive(child)).toBe(false);

    expect((await start({ id: "job-stray", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-stray.child.at")))).toBe(true);
    const strayHelper = Number(readFileSync(join(dir, "job-stray.pid"), "utf8"));
    const stray = Number(readFileSync(join(dir, "job-stray.child"), "utf8"));
    writeFileSync(join(dir, "job-stray.child.at"), "1");
    try { process.kill(strayHelper, "SIGKILL"); } catch { /* already gone */ }
    expect(await until(() => !alive(strayHelper))).toBe(true);
    await sup.sweep();
    expect(store.get("job-stray")).toMatchObject({ outcome: "lost" });
    expect(alive(stray)).toBe(true);
    try { process.kill(stray, "SIGKILL"); } catch { /* already gone */ }
  });

  it("rejects a timeout Node would fire at once, and the helper does not either", async () => {
    const { sup, store, dir, work } = rig();
    const decided = await sup.start({
      id: "job-long", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      timeoutMs: 2_147_483_648,
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    expect(decided).toEqual({ ok: false, error: "bad_command" });
    expect(store.get("job-long")).toBeNull();

    const exitPath = join(dir, "crafted.exit");
    const childPath = join(dir, "crafted.child");
    const helper = spawn(process.execPath, [fileURLToPath(new URL("../src/ops/job-helper.ts", import.meta.url))], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    writeFileSync(join(dir, "crafted.pid"), String(helper.pid));
    helper.stdin?.end(JSON.stringify({
      command: [process.execPath, "-e", HOLD], cwd: work,
      logPath: join(dir, "crafted.log"), exitPath, childPath,
      timeoutMs: 2_147_483_648, logBytes: 8_000_000, env: { PATH: process.env.PATH ?? "" },
    }));
    expect(await until(() => existsSync(childPath), 8000)).toBe(true);
    await until(() => false, 300);
    expect(existsSync(exitPath)).toBe(false);
  });

  it("records the exit only once the process group is gone", async () => {
    const { dir, work, start, sup, store } = rig();
    const marker = join(work, "grand");
    expect((await start({ id: "job-group", command: [process.execPath, "-e", ORPHAN, marker] })).state).toBe("running");
    expect(await until(() => existsSync(marker), 8000)).toBe(true);
    const grand = Number(readFileSync(marker, "utf8"));
    try {
      expect(alive(grand)).toBe(true);
      await until(() => false, 200);
      expect(existsSync(join(dir, "job-group.exit"))).toBe(false);
    } finally {
      try { process.kill(grand, "SIGKILL"); } catch { /* already gone */ }
    }
    expect(await until(() => existsSync(join(dir, "job-group.exit")), 8000)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "job-group.exit"), "utf8"))).toMatchObject({ outcome: "exited", exitCode: 0 });
    await sup.sweep();
    expect(store.get("job-group")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 0 });
  });

  it("does not trust a pid whose start time is not the one recorded at spawn", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-reuse", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-reuse.pid")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-reuse.pid"), "utf8"));
    expect(JSON.parse(readFileSync(join(dir, "job-reuse.pid.at"), "utf8"))).toEqual(processIdentity(helper));
    const childPath = join(dir, "job-reuse.child");
    expect(await until(() => existsSync(childPath))).toBe(true);
    const child = Number(readFileSync(childPath, "utf8"));
    try {
      writeFileSync(join(dir, "job-reuse.pid"), String(process.pid));
      writeFileSync(join(dir, "job-reuse.pid.at"), "1");
      await sup.sweep();
      expect(store.get("job-reuse")).toMatchObject({ outcome: "lost" });
      expect(alive(process.pid)).toBe(true);
    } finally {
      writeFileSync(join(dir, "job-reuse.pid"), String(helper));
      try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
      try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("reads every fallback start time from one ps call", async () => {
    const calls: number[][] = [];
    const starts = await psStarts([10, 11, 10], async pids => {
      calls.push([...pids]);
      return "10 Thu Jan  1 00:00:01 1970\n11 Thu Jan  1 00:00:02 1970\n";
    });
    expect(calls).toEqual([[10, 11]]);
    expect(starts.get(10)).toBe(Date.parse("Thu Jan  1 00:00:01 1970"));
    expect(starts.get(11)).toBe(Date.parse("Thu Jan  1 00:00:02 1970"));
  });

  it("records a start identity only inside the spawn window, before it returns", async () => {
    const { dir } = rig();
    const child = spawn(process.execPath, ["-e", HOLD], { detached: true, stdio: "ignore" });
    const spawnedAt = Date.now();
    expect(child.pid).toBeGreaterThan(0);
    const born = join(dir, "born.at");
    const late = join(dir, "late.at");
    try {
      writeProcessFile(born, child.pid!, spawnedAt);
      expect(existsSync(born)).toBe(true);
      writeProcessFile(late, child.pid!, spawnedAt + 60_000);
      expect(existsSync(late)).toBe(false);
      await until(() => false, 50);
      expect(existsSync(late)).toBe(false);
    } finally {
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  // /proc/stat prints the boot time in whole seconds, here 990 ms short of the boot clock's own. A process that started
  // 50 ms before the spawn stamp is inside the window all the same. The tick rate and ps are given, not the host's.
  it("records a start inside the spawn window when btime is most of a second short", () => {
    const { dir } = rig();
    const bootS = 1_791_300_000;
    const bootMs = bootS * 1000 + 990;
    const ticks = 100_000;
    const startedMs = bootMs + ticks * 10;
    const nowMs = startedMs + 200;
    const proc: Record<string, string> = {
      "/proc/4242/stat": `4242 (job) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks}`,
      "/proc/stat": `cpu 1\nbtime ${bootS}\n`,
      "/proc/uptime": `${((nowMs - bootMs) / 1000).toFixed(2)} 1.00\n`,
      "/proc/sys/kernel/random/boot_id": "0f6c1b52-7a3e-4c55-9d1e-2b8f4a6c9e10\n",
    };
    const io = { read: (path: string) => proc[path] ?? null, now: () => nowMs, hz: 100, ps: () => null };
    resetProcessStartCache();
    try {
      writeProcessFile(join(dir, "born.at"), 4242, startedMs + 50, io);
      expect(existsSync(join(dir, "born.at"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "born.at"), "utf8"))).toEqual({ ticks, bootId: "0f6c1b52-7a3e-4c55-9d1e-2b8f4a6c9e10" });
      writeProcessFile(join(dir, "late.at"), 4242, startedMs + 60_000, io);
      writeProcessFile(join(dir, "early.at"), 4242, startedMs - 60_000, io);
      expect(existsSync(join(dir, "late.at"))).toBe(false);
      expect(existsSync(join(dir, "early.at"))).toBe(false);
    } finally {
      resetProcessStartCache();
    }
  });

  it("does not signal a pid with no start record, and records lost after the grace", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-old", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-old.child")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-old.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "job-old.child"), "utf8"));
    unlinkSync(join(dir, "job-old.pid.at"));
    const pidPath = join(dir, "job-old.pid");
    utimesSync(pidPath, new Date(), new Date());
    await sup.sweep();
    expect(store.get("job-old")).toMatchObject({ state: "running", outcome: null });
    expect(alive(helper)).toBe(true);
    const past = new Date(Date.now() - START_RECORD_GRACE_MS - 1_000);
    utimesSync(pidPath, past, past);
    await sup.sweep();
    expect(store.get("job-old")).toMatchObject({ state: "lost", outcome: "lost" });
    expect(alive(helper)).toBe(true);
    expect(alive(child)).toBe(true);
  });

  it("does not signal a pid it cannot prove, and records lost after the grace", async () => {
    const { dir, start, sup, store } = rig();
    expect((await start({ id: "job-eperm", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    expect(await until(() => existsSync(join(dir, "job-eperm.child")))).toBe(true);
    const helper = Number(readFileSync(join(dir, "job-eperm.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "job-eperm.child"), "utf8"));
    const pidPath = join(dir, "job-eperm.pid");
    const orig = process.kill.bind(process);
    const sent: number[] = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 1 && signal !== 0 && signal !== undefined) sent.push(pid);
      return orig(pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    try {
      unlinkSync(join(dir, "job-eperm.pid.at"));
      writeFileSync(pidPath, "1");
      const past = new Date(Date.now() - START_RECORD_GRACE_MS - 1_000);
      utimesSync(pidPath, past, past);
      await sup.sweep();
      expect(store.get("job-eperm")).toMatchObject({ state: "lost", outcome: "lost" });
      expect(sent).toEqual([]);
      expect(alive(helper)).toBe(true);
      expect(alive(child)).toBe(true);
    } finally {
      process.kill = orig;
      writeFileSync(pidPath, String(helper));
      try { process.kill(helper, "SIGKILL"); } catch { /* already gone */ }
      try { process.kill(child, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("settles an exit file left while the job was still starting", async () => {
    const body = {
      lane: "builder", name: "pack", jobClass: "default", notify: { kind: "lane" as const, name: "builder" },
      commandHash: "0123456789abcdef", cwdHash: "0123456789abcdef",
    };
    const { store, dir, sup } = rig();
    expect(value(store.accept({ id: "job-start", ...body })).state).toBe("queued");
    store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-start")?.state).toBe("starting");
    writeFileSync(join(dir, "job-start.exit"), JSON.stringify({ outcome: "exited", exitCode: 3, durationMs: 40 }));
    await sup.sweep();
    expect(store.get("job-start")).toMatchObject({ state: "exited", outcome: "exited", exitCode: 3, durationMs: 40 });

    expect(value(store.accept({ id: "job-junk", ...body })).state).toBe("queued");
    store.applySchedule({ default: 1 }, "off");
    expect(store.get("job-junk")?.state).toBe("starting");
    writeFileSync(join(dir, "job-junk.exit"), "{");
    await sup.sweep();
    expect(store.get("job-junk")).toMatchObject({ outcome: "lost" });
    expect(store.get("job-junk")?.state).not.toBe("starting");
  });

  it("leaves a job running when the pool is full and the job is under its own cap", async () => {
    const { store, start, sup, dir, notices } = rig(undefined, undefined, 1_000_000, undefined, undefined, 32);
    const marker = join(dir, "pid");
    await start({
      id: "job-pool",
      command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); const b = Buffer.alloc(64, 97); while (true) require('node:fs').writeSync(1, b);", marker],
    });
    expect(await until(() => existsSync(marker))).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    expect(await until(async () => {
      await sup.sweep();
      return existsSync(join(dir, "job-pool.log")) && readFileSync(join(dir, "job-pool.log")).length >= 32;
    }, 8000)).toBe(true);
    expect(store.get("job-pool")).toMatchObject({ state: "running", outcome: null });
    expect(existsSync(join(dir, "job-pool.cap"))).toBe(false);
    expect(alive(pid)).toBe(true);
    const cancelled = await sup.cancel("job-pool");
    expect(cancelled.ok).toBe(true);
    expect(notices.map(n => n.text).join("\n")).toContain("log truncated: pool full");
  });

  it("a cap found by a sweep is the helper's own capped result", async () => {
    const { dir, start, sup, store } = rig(undefined, undefined, 8);
    expect((await start({ id: "job-sweep-cap", command: [process.execPath, "-e", HOLD] })).state).toBe("running");
    const pidPath = join(dir, "job-sweep-cap.pid");
    expect(await until(() => existsSync(pidPath))).toBe(true);
    const helper = Number(readFileSync(pidPath, "utf8"));
    writeFileSync(join(dir, "job-sweep-cap.log"), "0123456789abcdef");
    let opened = false;
    expect(await until(async () => {
      if (inspectorFor(helper)) opened = true;
      await sup.sweep();
      return existsSync(join(dir, "job-sweep-cap.exit"));
    }, 8000)).toBe(true);
    expect(existsSync(join(dir, "job-sweep-cap.cap"))).toBe(true);
    expect(opened).toBe(false);
    await sup.sweep();
    expect(store.get("job-sweep-cap")).toMatchObject({ state: "exited", outcome: "exited", exitCode: null });
  });

  it("a cancel during start-up wins over a cap requested earlier", async () => {
    const { dir, work } = rig();
    const exitPath = join(dir, "job-race.exit");
    const childPath = join(dir, "job-race.child");
    writeFileSync(join(dir, "job-race.cap"), "");
    const helper = spawn(process.execPath, [fileURLToPath(new URL("../src/ops/job-helper.ts", import.meta.url))], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let ready = false;
    helper.stdout?.on("data", () => { ready = true; });
    expect(await until(() => helper.pid !== undefined && ready)).toBe(true);
    writeFileSync(join(dir, "job-race.pid"), String(helper.pid));
    try { process.kill(helper.pid!, "SIGTERM"); } catch { /* already gone */ }
    await until(() => false, 30);
    helper.stdin?.end(JSON.stringify({
      command: [process.execPath, "-e", HOLD], cwd: work,
      logPath: join(dir, "job-race.log"), exitPath, childPath,
      timeoutMs: null, logBytes: 8, env: { PATH: process.env.PATH ?? "" },
    }));
    expect(await until(() => existsSync(exitPath), 8000)).toBe(true);
    expect(JSON.parse(readFileSync(exitPath, "utf8"))).toMatchObject({ outcome: "cancelled" });
    expect(existsSync(childPath)).toBe(false);
  });

  it("keeps the exit code when the command filled its log and then exited", async () => {
    const { sup, store, dir, home, paths, start, slot } = rig(undefined, undefined, 8);
    const script = `require("node:fs").writeSync(1, Buffer.alloc(64, 97)); process.exit(1);`;
    expect((await start({ id: "job-cap-exit", command: [process.execPath, "-e", script] })).state).toBe("running");
    sup.close();
    expect(await until(() => existsSync(join(dir, "job-cap-exit.exit")), 8000)).toBe(true);
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-cap-exit")).toMatchObject({ outcome: "exited", exitCode: 1 });
  });

  it("stops a command that fills its log, and leaves the bytes already written", async () => {
    const { sup, store, dir, home, paths, start, slot } = rig(undefined, undefined, 8);
    const script = `require("node:fs").writeSync(1, "KEEP"); const b = Buffer.alloc(64, 97); while (true) require("node:fs").writeSync(1, b);`;
    expect((await start({ id: "job-cap", command: [process.execPath, "-e", script] })).state).toBe("running");
    sup.close();
    const childPath = join(dir, "job-cap.child");
    expect(await until(() => existsSync(join(dir, "job-cap.exit")) && existsSync(childPath) && !alive(Number(readFileSync(childPath, "utf8"))), 8000)).toBe(true);
    expect(readFileSync(join(dir, "job-cap.log")).subarray(0, 4).toString()).toBe("KEEP");
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-cap")).toMatchObject({ state: "exited", outcome: "exited" });
    expect(store.list().map(j => j.id)).toContain("job-cap");
  });
});

describe("a cancel that finds the job already ended", () => {
  it("replays the stored outcome instead of signalled", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const killed = join(h.home, "killed");
    const bin = join(h.home, "fake-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
if [ "$2" = "show" ]; then
  if [ -f '${killed}' ]; then
    printf '%s\\n' LoadState=loaded ActiveState=inactive SubState=dead Result=success ExecMainCode=1 ExecMainStatus=0 MainPID=1 RemainAfterExit=no ExecMainStartTimestampMonotonic=1000000 ExecMainExitTimestampMonotonic=2000000
    exit 0
  fi
  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1000000 ExecMainExitTimestampMonotonic=0
  exit 0
fi
if [ "$2" = "kill" ]; then touch '${killed}'; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(join(bin, "systemctl"), 0o755);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "test", toolEnv: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const id = "job-ended";
    value(store.accept({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, commandHash: "a".repeat(64), cwdHash: "b".repeat(64),
    }));
    store.applySchedule({ default: 1 }, "off");
    value(store.started(id));
    const inner = store.settle.bind(store);
    store.settle = (jobId, event) => {
      if (event.outcome === "cancelled") {
        inner(jobId, { outcome: "exited", exitCode: 0, durationMs: 40 });
        return inner(jobId, event);
      }
      return inner(jobId, event);
    };
    const decided = await sup.cancel(id);
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.value.job.outcome).toBe("exited");
    expect(store.get(id)?.outcome).toBe("exited");
  });
});

// Design §5, "When a log reaches its cap": the helper owns the decision. Sweeps run the whole time, as they do in the
// agent, so a .cap note from the supervisor is part of every case.
describe("the log cap rule on the helper backend", () => {
  const FILLED = `require("node:fs").writeSync(1, Buffer.alloc(64, 97));`;
  const ended = async (sup: JobSupervisor, store: JobStore, id: string) =>
    until(async () => { await sup.sweep(); return store.get(id)?.outcome != null; }, 10_000);

  it("keeps the code of a command that ends within the grace", async () => {
    const { sup, store, start } = rig(undefined, undefined, 8);
    const script = `${FILLED} setTimeout(() => process.exit(1), 150);`;
    expect((await start({ id: "job-cap-grace", command: [process.execPath, "-e", script] })).state).toBe("running");
    expect(await ended(sup, store, "job-cap-grace")).toBe(true);
    expect(store.get("job-cap-grace")).toMatchObject({ outcome: "exited", exitCode: 1 });
  });

  it("records no code for a command still running when the cap stops it, even when its SIGTERM handler exits 0", async () => {
    const { sup, store, start } = rig(undefined, undefined, 8);
    const script = `process.on("SIGTERM", () => process.exit(0)); ${FILLED} setInterval(() => {}, 1000);`;
    expect((await start({ id: "job-cap-trap", command: [process.execPath, "-e", script] })).state).toBe("running");
    expect(await ended(sup, store, "job-cap-trap")).toBe(true);
    expect(store.get("job-cap-trap")).toMatchObject({ outcome: "exited", exitCode: null });
  });

  it("records no code for a writer that keeps going past the cap and exits 0 on SIGTERM", async () => {
    const { sup, store, start } = rig(undefined, undefined, 8);
    const script = `process.on("SIGTERM", () => process.exit(0)); const b = Buffer.alloc(64, 97); setInterval(() => require("node:fs").writeSync(1, b), 5);`;
    expect((await start({ id: "job-cap-writer", command: [process.execPath, "-e", script] })).state).toBe("running");
    expect(await ended(sup, store, "job-cap-writer")).toBe(true);
    expect(store.get("job-cap-writer")).toMatchObject({ outcome: "exited", exitCode: null });
  });

  it("keeps the code when the command ended but a process it left behind holds the group, and stops that process", async () => {
    const { sup, store, start, home } = rig(undefined, undefined, 8);
    const marker = join(home, "left.pid");
    const script = `const left = require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" });
      require("node:fs").writeFileSync(process.argv[1], String(left.pid)); ${FILLED} process.exit(3);`;
    expect((await start({ id: "job-cap-left", command: [process.execPath, "-e", script, marker] })).state).toBe("running");
    expect(await ended(sup, store, "job-cap-left")).toBe(true);
    expect(store.get("job-cap-left")).toMatchObject({ outcome: "exited", exitCode: 3 });
    const left = Number(readFileSync(marker, "utf8"));
    expect(await until(() => !alive(left), 5000)).toBe(true);
  });

  it("keeps the code across a restart: a .cap on disk does not override what the helper wrote", async () => {
    const { sup, store, dir, home, paths, start, slot } = rig(undefined, undefined, 8);
    const script = `${FILLED} setTimeout(() => process.exit(2), 400);`;
    expect((await start({ id: "job-cap-restart", command: [process.execPath, "-e", script] })).state).toBe("running");
    expect(await until(async () => { await sup.sweep(); return existsSync(join(dir, "job-cap-restart.cap")); }, 8000)).toBe(true);
    sup.close();
    expect(await until(() => existsSync(join(dir, "job-cap-restart.exit")), 8000)).toBe(true);
    const next = replace(slot, store, home, paths);
    await next.sweep();
    expect(store.get("job-cap-restart")).toMatchObject({ outcome: "exited", exitCode: 2 });
  });
});
