// systemd supervisor (ADR-0017, design §3, §12 step 4). The probe decides. A failed probe prints why and uses the
// child supervisor. These rows never leave a morndo-job unit on the live user manager.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobStore, type NoticeHandoff } from "../src/ops/job-store.ts";
import { namesFromEnvironmentExport, probeUserManager, showUnit, unitOf, unsetNameOrder, type ProbeResult } from "../src/ops/job-systemd.ts";
import { openJobRuntime } from "../src/ops/job-runtime.ts";
import { JobSupervisor, openJobSupervisor, type JobStart } from "../src/ops/job-supervisor.ts";
import { agentPaths } from "../src/paths.ts";
import { until, tempHome, wait } from "./helpers.ts";

const jobId = (): string => `j${randomBytes(4).toString("hex")}`;

function skipLine(result: ProbeResult): string | null {
  return result.ok ? null : `systemd skipped: ${result.reason}\n`;
}

const bus = await probeUserManager();
const skip = skipLine(bus);
if (skip) process.stdout.write(skip);

const showValue = (unit: string, prop: string): string =>
  execFileSync("systemctl", ["--user", "show", "-p", prop, "--value", unit], { encoding: "utf8", timeout: 10_000 }).trim();

// Stop and reset one unit this drill created. Never a glob: other lanes run real morndo-job units on this user manager.
function releaseUnit(unit: string): void {
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    if (showValue(unit, "LoadState") === "not-found") return;
    try { execFileSync("systemctl", ["--user", "reset-failed", unit], { timeout: 10_000, stdio: "ignore" }); } catch { /* not failed */ }
    try { execFileSync("systemctl", ["--user", "stop", unit], { timeout: 20_000, stdio: "ignore" }); } catch { /* already gone */ }
  }
}

const STAY = `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  fs.writeFileSync(process.argv[1], JSON.stringify({
    pid: process.pid, child: child.pid,
    leak: process.env.LEAK_SENTINEL || null, id: process.env.MORNDO_JOB_ID || null,
  }));
  setInterval(() => {}, 1e9);
`;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Fills a log at once, records when, and ends 0 from a SIGTERM trap after recording when the signal came.
const TRAP = `
  const fs = require("node:fs");
  fs.writeSync(1, Buffer.alloc(64, 97));
  fs.writeFileSync(process.argv[1], String(Date.now()));
  process.on("SIGTERM", () => { fs.appendFileSync(process.argv[1], " " + String(Date.now())); process.exit(0); });
  setInterval(() => {}, 1000);
`;

// A throwaway user scope (--scope) in its own slice (--slice=). --collect unloads it when the sleep ends.
// systemd-run(1), https://www.freedesktop.org/software/systemd/man/255/systemd-run.html (read 2026-10-10).
function openDrill(): { slice: string; close: () => void } {
  const name = `morndodrill${randomBytes(4).toString("hex")}`;
  const child: ChildProcess = spawn("systemd-run", [
    "--user", "--scope", "--collect", "--unit", name, "--slice", `${name}.slice`, "--", "sleep", "infinity",
  ], { stdio: "ignore" });
  const end = Date.now() + 5_000;
  let active = false;
  while (Date.now() < end) {
    const state = execFileSync("systemctl", ["--user", "show", "-p", "ActiveState", "--value", `${name}.scope`], { encoding: "utf8" }).trim();
    if (state === "active") { active = true; break; }
    execFileSync("sleep", ["0.05"]);
  }
  if (!active) throw new Error(`drill scope ${name} did not start`);
  return {
    slice: `${name}.slice`,
    close() {
      try { execFileSync("systemctl", ["--user", "stop", `${name}.scope`, `${name}.slice`], { timeout: 20_000, stdio: "ignore" }); } catch { /* already gone */ }
      try { execFileSync("systemctl", ["--user", "reset-failed", `${name}.scope`], { timeout: 10_000, stdio: "ignore" }); } catch { /* not failed */ }
      try { child.kill("SIGKILL"); } catch { /* scope process already exited */ }
    },
  };
}

const open: { adb: AgentDb; cleanup: () => void; dir: string; sup: JobSupervisor }[] = [];
const drills: { close: () => void }[] = [];
const owned: string[] = [];
afterEach(() => {
  if (bus.ok) {
    for (const unit of owned.splice(0)) {
      releaseUnit(unit);
      expect(showValue(unit, "LoadState")).toBe("not-found");
    }
    for (const drill of drills.splice(0)) drill.close();
  } else {
    owned.splice(0);
    drills.splice(0);
  }
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

const track = (id: string): string => {
  owned.push(unitOf(id));
  return id;
};

async function rig(say: (line: string) => void) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  const work = join(h.home, "work");
  mkdirSync(work, { recursive: true });
  const notices: NoticeHandoff[] = [];
  const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, onNotice: n => notices.push(n) });
  const paths = agentPaths(h.home);
  const sup = await openJobSupervisor(store, {
    home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
  }, {
    probe: () => ({ ok: false, reason: "no user bus" }),
    say,
  });
  open.push({ adb, cleanup: h.cleanup, dir, sup });
  const start = async (over: Partial<JobStart> & Pick<JobStart, "id" | "command">) => {
    const decided = await sup.start({
      lane: "builder", name: "pack", jobClass: "default", notify: { kind: "lane", name: "builder" }, cwd: work, ...over,
    });
    if (!decided.ok) throw new Error(`refused: ${decided.error}`);
    return decided.value;
  };
  return { sup, dir, start, notices };
}

function fakeTools(home: string, systemctl: string, systemdRun = "#!/bin/sh\nexit 0\n"): NodeJS.ProcessEnv {
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), systemctl, { mode: 0o755 });
  writeFileSync(join(bin, "systemd-run"), systemdRun, { mode: 0o755 });
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "systemd-run"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

describe("systemd probe", () => {
  it("refuses a user manager older than 251, where timestamps are not unix seconds", async () => {
    const h = tempHome();
    const log = join(h.home, "probe.log");
    try {
      const env = fakeTools(h.home, `#!/bin/sh
printf '%s\\n' "$@" >> '${log}'
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'systemd 249 (249.11-0ubuntu3.12)'
  exit 0
fi
exit 0
`, `#!/bin/sh\nprintf '%s\\n' systemd-run >> '${log}'\nexit 0\n`);
      const result = await probeUserManager(env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("251");
      expect(readFileSync(log, "utf8")).not.toContain("systemd-run");
    } finally { h.cleanup(); }
  });

  it("accepts systemd 251, which is when --timestamp=unix arrived", async () => {
    const h = tempHome();
    const log = join(h.home, "probe.log");
    try {
      const env = fakeTools(h.home, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'systemd 251 (251.4-1)'
  exit 0
fi
exit 0
`, `#!/bin/sh\nprintf '%s\\n' systemd-run >> '${log}'\nexit 0\n`);
      expect(await probeUserManager(env)).toEqual({ ok: true });
      expect(readFileSync(log, "utf8")).toContain("systemd-run");
    } finally { h.cleanup(); }
  });

  it("gives the probe and the supervisor the same tool environment", async () => {
    const h = tempHome();
    const log = join(h.home, "tool.log");
    const env = fakeTools(h.home, `#!/bin/sh
printf '%s\\n' "$@" >> '${log}'
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'systemd 255 (255.4)'
  exit 0
fi
if [ "$2" = "show" ]; then
  printf '%s\\n' LoadState=not-found
  exit 0
fi
if [ "$2" = "show-environment" ]; then
  printf '%s\\n' PATH=/usr/bin
  exit 0
fi
exit 0
`, `#!/bin/sh\nprintf '%s\\n' systemd-run >> '${log}'\nexit 0\n`);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const sup = await openJobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
    }, { slice: "morndofake.slice", toolEnv: env, say: () => {} });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const id = track(jobId());
    const started = await sup.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
    });
    if (!started.ok) throw new Error(started.error);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("--version");
    expect(text).toContain("show");
  });

  it("prints why the probe failed and runs the job as a child, with no unit left", async () => {
    const lines: string[] = [];
    const { dir, start } = await rig(line => lines.push(line));
    const id = track(jobId());
    expect((await start({ id, command: [process.execPath, "-e", "process.exit(0)"] })).state).toBe("running");
    expect(lines).toEqual(["systemd skipped: no user bus\n"]);
    expect(await until(() => existsSync(join(dir, `${id}.pid`)))).toBe(true);
    const pid = Number(readFileSync(join(dir, `${id}.pid`), "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid) || existsSync(join(dir, `${id}.exit`))).toBe(true);
    if (bus.ok) expect(showValue(unitOf(id), "LoadState")).toBe("not-found");
  });

  it("prints why the drills are skipped when the user manager cannot be probed", () => {
    expect(skipLine({ ok: false, reason: "no user bus" })).toBe("systemd skipped: no user bus\n");
    expect(skipLine({ ok: true })).toBeNull();
  });
});

describe.skipIf(!bus.ok)("systemd unit ownership", () => {
  it("stops the unit this drill created and leaves another morndo-job unit loaded", () => {
    const drill = openDrill();
    drills.push(drill);
    const mine = track(jobId());
    const otherId = `keep${randomBytes(4).toString("hex")}`;
    const other = unitOf(otherId);
    execFileSync("systemd-run", [
      "--user", `--unit=${unitOf(mine).replace(/\.service$/, "")}`, `--slice=${drill.slice}`, "--remain-after-exit",
      "--property=Type=exec", "--", "sleep", "infinity",
    ], { stdio: "ignore" });
    try {
      execFileSync("systemd-run", [
        "--user", `--unit=${unitOf(otherId).replace(/\.service$/, "")}`, `--slice=${drill.slice}`, "--remain-after-exit",
        "--property=Type=exec", "--", "sleep", "infinity",
      ], { stdio: "ignore" });
      expect(showValue(unitOf(mine), "ActiveState")).toBe("active");
      expect(showValue(other, "ActiveState")).toBe("active");
      releaseUnit(unitOf(mine));
      expect(showValue(unitOf(mine), "LoadState")).toBe("not-found");
      expect(showValue(other, "ActiveState")).toBe("active");
      expect(showValue(other, "MainPID") !== "0").toBe(true);
    } finally {
      releaseUnit(other);
    }
  });
});

describe.skipIf(!bus.ok)("systemd control group", () => {
  it("keeps the job in its own unit after the supervisor closes, and stopping that unit kills the group", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const drill = openDrill();
    drills.push(drill);
    const opts = {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      env: { ...process.env, LEAK_SENTINEL: "should-not-appear" },
    };
    const sup = await openJobSupervisor(store, opts, { slice: drill.slice });
    const slot = { adb, cleanup: h.cleanup, dir, sup };
    open.push(slot);
    const id = track(jobId());
    const marker = join(h.home, "group.json");
    process.env.LEAK_SENTINEL = "should-not-appear";
    let started: Awaited<ReturnType<JobSupervisor["start"]>>;
    try {
      started = await sup.start({
        id, lane: "builder", name: "pack", jobClass: "default",
        notify: { kind: "lane", name: "builder" }, cwd: work,
        command: [process.execPath, "-e", STAY, marker],
      });
    } finally { delete process.env.LEAK_SENTINEL; }
    if (!started.ok) throw new Error(`refused: ${started.error}`);
    expect(started.value.state).toBe("running");
    expect(await until(() => existsSync(marker))).toBe(true);
    const mark = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; child: number; leak: string | null; id: string | null };
    expect(mark.leak).toBe(null);
    expect(mark.id).toBe(id);
    const main = showValue(unitOf(id), "MainPID");
    expect(main).toBe(String(mark.pid));
    const jobCgroup = readFileSync(`/proc/${mark.pid}/cgroup`, "utf8");
    const childCgroup = readFileSync(`/proc/${mark.child}/cgroup`, "utf8");
    const ours = readFileSync(`/proc/${process.pid}/cgroup`, "utf8");
    expect(jobCgroup).toContain(unitOf(id));
    expect(childCgroup).toContain(unitOf(id));
    expect(jobCgroup).not.toBe(ours);
    sup.close();
    expect(alive(mark.pid)).toBe(true);
    expect(alive(mark.child)).toBe(true);
    slot.sup = await openJobSupervisor(store, opts, { slice: drill.slice, probe: () => ({ ok: true }) });
    await slot.sup.sweep();
    expect(store.get(id)?.state).toBe("running");
    expect(showValue(unitOf(id), "MainPID")).toBe(main);
    execFileSync("systemctl", ["--user", "stop", unitOf(id)], { timeout: 20_000 });
    expect(await until(() => !alive(mark.pid) && !alive(mark.child))).toBe(true);
  });
});

describe.skipIf(!bus.ok)("systemd RemainAfterExit", () => {
  it("reads the exit the unit kept while the supervisor was closed, once, then unloads it", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const notices: NoticeHandoff[] = [];
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, onNotice: n => notices.push(n) });
    const paths = agentPaths(h.home);
    const drill = openDrill();
    drills.push(drill);
    const opts = { home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock };
    const sup = await openJobSupervisor(store, opts, { slice: drill.slice });
    const slot = { adb, cleanup: h.cleanup, dir, sup };
    open.push(slot);
    const id = track(jobId());
    const marker = join(h.home, "ran");
    const started = await sup.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x'); process.exit(7)", marker],
    });
    if (!started.ok) throw new Error(`refused: ${started.error}`);
    sup.close();
    const show = () => execFileSync("systemctl", ["--user", "show", "-p", "LoadState", "-p", "RemainAfterExit", "-p", "ExecMainCode", "-p", "ExecMainStatus", "-p", "Result", unitOf(id)], { encoding: "utf8" });
    expect(await until(() => show().includes("ExecMainStatus=7"))).toBe(true);
    const shown = show();
    expect(shown).toContain("LoadState=loaded");
    expect(shown).toContain("RemainAfterExit=yes");
    expect(shown).toContain("ExecMainCode=1");
    expect(shown).toContain("ExecMainStatus=7");
    slot.sup = await openJobSupervisor(store, opts, { slice: drill.slice, probe: () => ({ ok: true }) });
    await slot.sup.sweep();
    const job = store.get(id);
    expect(job?.outcome).toBe("exited");
    expect(job?.exitCode).toBe(7);
    expect(notices).toHaveLength(1);
    expect(readFileSync(marker, "utf8")).toBe("x");
    expect(showValue(unitOf(id), "LoadState")).toBe("not-found");
    await slot.sup.sweep();
    expect(notices).toHaveLength(1);
    expect(readFileSync(marker, "utf8")).toBe("x");
  });
});

async function systemdRig(caps?: { logBytes?: number; budget?: number }) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  const work = join(h.home, "work");
  mkdirSync(work, { recursive: true });
  const notices: NoticeHandoff[] = [];
  const store = new JobStore(adb.db, dir, () => Date.now(), {
    home: h.home, onNotice: n => notices.push(n),
    ...(caps?.logBytes !== undefined ? { logBytes: caps.logBytes } : {}),
    ...(caps?.budget !== undefined ? { budget: caps.budget } : {}),
  });
  const paths = agentPaths(h.home);
  const drill = openDrill();
  drills.push(drill);
  const opts = { home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock };
  const sup = await openJobSupervisor(store, opts, { slice: drill.slice });
  const slot = { adb, cleanup: h.cleanup, dir, sup };
  open.push(slot);
  const start = async (command: readonly string[]) => {
    const id = track(jobId());
    const decided = await sup.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command,
    });
    if (!decided.ok) throw new Error(`refused: ${decided.error}`);
    return id;
  };
  return { store, notices, start, sup, home: h.home, opts, drill, dir, slot };
}

function failingSystemctl(home: string): NodeJS.ProcessEnv {
  const bin = join(home, "failbin");
  mkdirSync(bin);
  const log = join(home, "systemctl.log");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "systemctl"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

const KEPT_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR", "MORNDO_JOB_ID", "MORNDO_LANE"];

describe("systemd environment", () => {
  it("lists a prefix before the longer name systemd would replace", () => {
    expect(unsetNameOrder(["JAVA_HOME_8_X64", "JAVA_HOME_11_X64", "JAVA_HOME"])).toEqual([
      "JAVA_HOME", "JAVA_HOME_8_X64", "JAVA_HOME_11_X64",
    ]);
  });

  it("takes JDK paths from the service environment export", () => {
    expect(namesFromEnvironmentExport([
      "# comment",
      "JAVA_HOME_8_X64=/usr/lib/jvm/temurin-8-jdk-amd64",
      "not a line",
      "BAD-NAME=1",
      "",
    ].join("\n"))).toEqual(["JAVA_HOME_8_X64"]);
  });

  it("refuses to start when the user manager environment cannot be read, and does not try again", async () => {
    const h = tempHome();
    const log = join(h.home, "env.log");
    const env = fakeTools(h.home, `#!/bin/sh
printf '%s\\n' "$@" >> '${log}'
if [ "$2" = "show-environment" ]; then exit 1; fi
if [ "$2" = "show" ]; then
  printf '%s\\n' LoadState=not-found
  exit 0
fi
exit 0
`, `#!/bin/sh\nprintf '%s\\n' systemd-run >> '${log}'\nexit 0\n`);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: env },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const start = (id: string) => sup.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
    });
    const first = track(jobId());
    const second = track(jobId());
    if (!(await start(first)).ok) throw new Error("refused");
    if (!(await start(second)).ok) throw new Error("refused");
    expect(store.get(first)).toMatchObject({ outcome: "exited", error: "did_not_start" });
    expect(store.get(second)).toMatchObject({ outcome: "exited", error: "did_not_start" });
    const text = readFileSync(log, "utf8");
    expect(text).not.toContain("systemd-run");
    expect(text.split("\n").filter(line => line.includes("show-environment"))).toHaveLength(1);
  });

  it("unsets a name the process holds when the manager listing omitted it, and execs the job command", async () => {
    const h = tempHome();
    const log = join(h.home, "run.log");
    const env = fakeTools(h.home, `#!/bin/sh
if [ "$2" = "show-environment" ]; then printf 'PATH=/usr/bin\\n'; exit 0; fi
if [ "$2" = "show" ]; then printf '%s\\n' LoadState=not-found; exit 0; fi
exit 0
`, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexit 0\n`);
    env.MORNDO_LATE_INJECT = "from-the-process";
    env.JAVA_HOME_8_X64 = "jdk8";
    env.JAVA_HOME = "jdk";
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: env },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const decided = await sup.start({
      id: track(jobId()), lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
    });
    if (!decided.ok) throw new Error(decided.error);
    const lines = readFileSync(log, "utf8").split("\n");
    expect(lines).toContain("--property=Type=exec");
    expect(lines).toContain("--property=UnsetEnvironment=MORNDO_LATE_INJECT");
    const prefix = lines.indexOf("--property=UnsetEnvironment=JAVA_HOME");
    const longer = lines.indexOf("--property=UnsetEnvironment=JAVA_HOME_8_X64");
    expect(prefix).toBeGreaterThanOrEqual(0);
    expect(longer).toBeGreaterThan(prefix);
    let image = "";
    try { image = readFileSync("/etc/environment", "utf8"); } catch { /* the generator is the other source */ }
    for (const key of namesFromEnvironmentExport(image)) {
      if (KEPT_ENV.includes(key)) continue;
      expect(lines).toContain(`--property=UnsetEnvironment=${key}`);
    }
    expect(lines).not.toContain("/usr/bin/env");
    expect(lines).not.toContain("-i");
    const dash = lines.indexOf("--");
    expect(lines[dash + 1]).toBe("/bin/true");
  });
});

describe.skipIf(!bus.ok)("systemd environment", () => {
  it("starts the job with the kept names only", async () => {
    const { start, home } = await systemdRig();
    const marker = join(home, "env.json");
    const id = await start([
      process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
      marker,
    ]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const env = JSON.parse(readFileSync(marker, "utf8")) as Record<string, string>;
    expect(env.MORNDO_JOB_ID).toBe(id);
    expect(env.MORNDO_LANE).toBe("builder");
    expect(env.PATH).toBe(process.env.PATH);
    const manager = execFileSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
    for (const line of manager.split("\n")) {
      const key = line.slice(0, line.indexOf("="));
      if (key.length === 0 || KEPT_ENV.includes(key)) continue;
      expect(env[key], key).toBeUndefined();
    }
    expect(Object.keys(env).sort()).toEqual(KEPT_ENV.filter(key => env[key] !== undefined).sort());
  });

  it("reads the user manager environment once for every job on the supervisor", async () => {
    const h = tempHome();
    const count = join(h.home, "env-count");
    const bin = join(h.home, "count-bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh
if [ "$1" = "--user" ] && [ "$2" = "show-environment" ]; then printf 'x\\n' >> '${count}'; fi
exec /usr/bin/systemctl "$@"
`, { mode: 0o755 });
    chmodSync(join(bin, "systemctl"), 0o755);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const drill = openDrill();
    drills.push(drill);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: drill.slice, toolEnv: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const start = async () => {
      const id = track(jobId());
      const decided = await sup.start({
        id, lane: "builder", name: "pack", jobClass: "default",
        notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
      });
      if (!decided.ok) throw new Error(decided.error);
      return id;
    };
    const first = await start();
    const second = await start();
    expect(await until(async () => {
      await sup.sweep();
      return store.get(first)?.outcome === "exited" && store.get(second)?.outcome === "exited";
    }, 8000)).toBe(true);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe.skipIf(!bus.ok)("systemd show", () => {
  it("leaves a live job running when systemctl show fails", async () => {
    const { store, start, home, opts, drill } = await systemdRig();
    const marker = join(home, "stay.json");
    const id = await start([process.execPath, "-e", STAY, marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const mark = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    const blind = new JobSupervisor(store, { ...opts, systemd: { slice: drill.slice, toolEnv: failingSystemctl(home) } });
    await blind.sweep();
    expect(readFileSync(join(home, "systemctl.log"), "utf8")).toContain("show");
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    expect(alive(mark.pid)).toBe(true);
    expect(showValue(unitOf(id), "ActiveState")).toBe("active");
    const cancelled = await blind.cancel(id);
    expect(cancelled).toEqual({ ok: false, error: "unavailable" });
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    expect(alive(mark.pid)).toBe(true);
    blind.close();
  });

  it("leaves the job running when systemctl stop fails, for a cancel and for the log cap", async () => {
    const { store, start, home, opts, drill, dir } = await systemdRig({ logBytes: 8 });
    const marker = join(home, "stay.json");
    const id = await start([process.execPath, "-e", STAY, marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const mark = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    writeFileSync(join(dir, `${id}.log`), "12345678");
    const blind = new JobSupervisor(store, { ...opts, systemd: { slice: drill.slice, toolEnv: fakeTools(home, `#!/bin/sh
if [ "$2" = "show" ]; then
  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=${mark.pid} RemainAfterExit=yes ExecMainStartTimestampMonotonic=1000000 ExecMainExitTimestampMonotonic=0
  exit 0
fi
if [ "$2" = "stop" ] || [ "$2" = "kill" ]; then exit 1; fi
exit 0
`) } });
    await blind.sweep();
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    const cancelled = await blind.cancel(id);
    expect(cancelled).toEqual({ ok: false, error: "unavailable" });
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    expect(alive(mark.pid)).toBe(true);
    expect(showValue(unitOf(id), "ActiveState")).toBe("active");
    blind.close();
  });

  it("reports a signal that was sent when the unit then cannot be read", async () => {
    const { store, start, home, opts, drill } = await systemdRig();
    const marker = join(home, "stay.json");
    const id = await start([process.execPath, "-e", STAY, marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const mark = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    const killed = join(home, "killed");
    const blind = new JobSupervisor(store, { ...opts, systemd: { slice: drill.slice, toolEnv: fakeTools(home, `#!/bin/sh
if [ "$2" = "show" ]; then
  if [ -f '${killed}' ]; then exit 1; fi
  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=${mark.pid} RemainAfterExit=yes ExecMainStartTimestampMonotonic=1000000 ExecMainExitTimestampMonotonic=0
  exit 0
fi
if [ "$2" = "kill" ]; then touch '${killed}'; exit 0; fi
exit 0
`) } });
    const cancelled = await blind.cancel(id);
    expect(cancelled).toEqual({ ok: false, error: "signalled" });
    expect(existsSync(killed)).toBe(true);
    expect(alive(mark.pid)).toBe(true);
    blind.close();
  });

  it("marks the job lost when the unit is gone", async () => {
    const { store, start, sup, home } = await systemdRig();
    const marker = join(home, "stay.json");
    const id = await start([process.execPath, "-e", STAY, marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    execFileSync("systemctl", ["--user", "stop", unitOf(id)], { timeout: 20_000 });
    expect(await until(() => showValue(unitOf(id), "LoadState") === "not-found")).toBe(true);
    await sup.sweep();
    expect(store.get(id)).toMatchObject({ state: "lost", outcome: "lost" });
  });
});

const FILL = "require('node:fs').writeSync(1, 'KEEP'); const b = Buffer.alloc(64, 97); while (true) require('node:fs').writeSync(1, b);";

describe.skipIf(!bus.ok)("systemd log cap", () => {
  it("stops a job once its log reaches the per-job cap and keeps the bytes already written", async () => {
    const { store, start, sup, dir } = await systemdRig({ logBytes: 8 });
    const id = await start([process.execPath, "-e", FILL]);
    expect(await until(async () => { await sup.sweep(); return store.get(id)?.outcome === "exited"; }, 8000)).toBe(true);
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: null });
    expect(existsSync(join(dir, `${id}.cap`))).toBe(true);
    expect(readFileSync(join(dir, `${id}.log`)).subarray(0, 4).toString()).toBe("KEEP");
  });

  it("gives a full log the same grace as the helper backend, and a trapped SIGTERM still records no code", async () => {
    const { store, start, sup, home } = await systemdRig({ logBytes: 8 });
    const marker = join(home, "trap");
    const id = await start([process.execPath, "-e", TRAP, marker]);
    expect(await until(async () => { await sup.sweep(); return store.get(id)?.outcome === "exited"; }, 8000)).toBe(true);
    // The command ends 0 by its own trap, but the cap ended it: no code, whatever the handler did.
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: null });
    const times = readFileSync(marker, "utf8").split(" ").map(Number);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(240);    // the grace passed before the signal
  });

  it("keeps a command's own exit code when it ends within the grace", async () => {
    const { store, start, sup, dir } = await systemdRig({ logBytes: 8 });
    const id = await start([process.execPath, "-e", "require('node:fs').writeSync(1, Buffer.alloc(64, 97)); setTimeout(() => process.exit(1), 120)"]);
    expect(await until(async () => { await sup.sweep(); return store.get(id)?.outcome === "exited"; }, 8000)).toBe(true);
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: 1 });
    expect(existsSync(join(dir, `${id}.cap`))).toBe(false);       // its own end came first: the cap never enforced
  });

  it("marks a job truncated when the pool is full and leaves it running under its own cap", async () => {
    const { store, notices, start, sup, home, dir } = await systemdRig({ logBytes: 1_000_000, budget: 32 });
    const marker = join(home, "pid");
    const id = await start([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); const b = Buffer.alloc(64, 97); while (true) require('node:fs').writeSync(1, b);", marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    expect(await until(async () => {
      await sup.sweep();
      return existsSync(join(dir, `${id}.log`)) && readFileSync(join(dir, `${id}.log`)).length >= 32;
    }, 8000)).toBe(true);
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    expect(existsSync(join(dir, `${id}.cap`))).toBe(false);
    expect(alive(pid)).toBe(true);
    const cancelled = await sup.cancel(id);
    if (!cancelled.ok) throw new Error(cancelled.error);
    expect(notices.map(n => n.text).join("\n")).toContain("log truncated: pool full");
  });
});

function slowSystemctl(home: string): NodeJS.ProcessEnv {
  const bin = join(home, "slowbin");
  mkdirSync(bin);
  const log = join(home, "slow.log");
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh\ndate +%s%N >> '${log}'\nsleep 0.35\nif [ "$1" = "--user" ] && [ "$2" = "show" ]; then\n  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0\nfi\nexit 0\n`, { mode: 0o755 });
  chmodSync(join(bin, "systemctl"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

describe("systemd launch", () => {
  async function holding(overlap: "sweep" | "cancel") {
    const h = tempHome();
    const log = join(h.home, "hold.log");
    const ready = join(h.home, "ready");
    const env = fakeTools(h.home, `#!/bin/sh
printf 'show\\n' >> '${log}'
printf '%s\\n' LoadState=not-found
exit 0
`, `#!/bin/sh
printf 'run-begin\\n' >> '${log}'
touch '${ready}'
sleep 0.6
printf 'run-end\\n' >> '${log}'
exit 0
`);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: env },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const id = track(jobId());
    const launching = sup.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
    });
    expect(await until(() => existsSync(ready))).toBe(true);
    const other = overlap === "sweep" ? sup.sweep() : sup.cancel(id);
    await launching;
    await other;
    const text = readFileSync(log, "utf8");
    const begin = text.indexOf("run-begin");
    const end = text.indexOf("run-end");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(text.slice(begin, end)).not.toContain("show");
  }

  it("does not let a sweep look at the unit while the launch is still running", async () => {
    await holding("sweep");
  });

  it("does not let a cancel look at the unit while the launch is still running", async () => {
    await holding("cancel");
  });

  it("does not let the sweep timer look at the unit while the launch is still running", async () => {
    const h = tempHome();
    const log = join(h.home, "hold.log");
    const ready = join(h.home, "ready");
    const launched = join(h.home, "launched");
    const env = fakeTools(h.home, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'systemd 255 (255.4-1)'
  exit 0
fi
if [ "$2" = "show-environment" ]; then exit 0; fi
printf 'show\\n' >> '${log}'
if [ -f '${launched}' ]; then
  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0
else
  printf '%s\\n' LoadState=not-found
fi
exit 0
`, `#!/bin/sh
case " $* " in
  *" --collect "*) exit 0 ;;
esac
printf 'run-begin\\n' >> '${log}'
touch '${ready}'
sleep 0.6
touch '${launched}'
printf 'run-end\\n' >> '${log}'
exit 0
`);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    const work = join(h.home, "work");
    mkdirSync(work, { recursive: true });
    const paths = agentPaths(h.home);
    const runtime = await openJobRuntime({
      db: adb.db, home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      sweepMs: 40, toolEnv: env, say: () => {},
    });
    open.push({ adb, cleanup: () => { runtime.close(); h.cleanup(); }, dir, sup: runtime.supervisor });
    const id = track(jobId());
    const launching = runtime.supervisor.start({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work, command: ["/bin/true"],
    });
    expect(await until(() => existsSync(ready))).toBe(true);
    await launching;
    expect(await until(() => readFileSync(log, "utf8").includes("run-end"))).toBe(true);
    await wait(200);
    const text = readFileSync(log, "utf8");
    const begin = text.indexOf("run-begin");
    const end = text.indexOf("run-end");
    expect(text.slice(begin, end)).not.toContain("show");
    expect(runtime.store.get(id)?.outcome).toBeNull();
    expect(runtime.store.get(id)?.state).toBe("running");
  });
});

describe("systemd event loop", () => {
  it("returns from a show while systemctl is still running", async () => {
    const h = tempHome();
    const env = slowSystemctl(h.home);
    let ran = false;
    setTimeout(() => { ran = true; }, 20);
    const started = Date.now();
    const pending = showUnit(`missing${randomBytes(4).toString("hex")}`, env);
    expect(Date.now() - started).toBeLessThan(100);
    await wait(50);
    expect(ran).toBe(true);
    expect(await pending).toMatchObject({ kind: "found" });
    h.cleanup();
  });

  it.skipIf(!bus.ok)("shows two running jobs at the same time", async () => {
    const { store, start, home, opts, drill } = await systemdRig();
    const markerA = join(home, "a.json");
    const markerB = join(home, "b.json");
    const a = await start([process.execPath, "-e", STAY, markerA]);
    const b = await start([process.execPath, "-e", STAY, markerB]);
    expect(await until(() => existsSync(markerA) && existsSync(markerB))).toBe(true);
    const blind = new JobSupervisor(store, { ...opts, systemd: { slice: drill.slice, toolEnv: slowSystemctl(home) } });
    const began = Date.now();
    await blind.sweep();
    const elapsed = Date.now() - began;
    const stamps = readFileSync(join(home, "slow.log"), "utf8").trim().split("\n").map(Number);
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...stamps) - Math.min(...stamps)).toBeLessThan(200_000_000);
    expect(elapsed).toBeLessThan(600);
    expect(store.get(a)?.state).toBe("running");
    expect(store.get(b)?.state).toBe("running");
    blind.close();
  });
});

describe.skipIf(!bus.ok)("systemd start failure", () => {
  it("unloads the unit when systemd cannot enter the working directory", async () => {
    const { store, sup, home, dir } = await systemdRig();
    const id = track(jobId());
    const hash = "ab".repeat(16);
    const accepted = store.accept({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" },
      commandHash: hash, cwdHash: hash,
    });
    if (!accepted.ok) throw new Error(accepted.error);
    writeFileSync(join(dir, `${id}.argv`), JSON.stringify({
      command: ["/bin/true"], cwd: join(home, "gone"),
      logPath: join(dir, `${id}.log`), exitPath: join(dir, `${id}.exit`), childPath: join(dir, `${id}.child`),
      timeoutMs: null, logBytes: 8, env: { PATH: "/usr/bin", MORNDO_JOB_ID: id, MORNDO_LANE: "builder" },
    }));
    await sup.sweep();
    expect(store.get(id)).toMatchObject({ outcome: "exited", error: "did_not_start", exitCode: null });
    expect(showValue(unitOf(id), "LoadState")).toBe("not-found");
  });
});

function timedStop(home: string): NodeJS.ProcessEnv {
  const killed = join(home, "killed");
  return fakeTools(home, `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${killed}'; exit 0; fi
if [ "$2" != "show" ]; then exit 0; fi
if [ -f '${killed}' ]; then
  printf '%s\\n' LoadState=loaded ActiveState=inactive SubState=dead Result=signal ExecMainCode=2 ExecMainStatus=15 MainPID=0 RemainAfterExit=yes ExecMainStartTimestampMonotonic=5000000 ExecMainExitTimestampMonotonic=6500000 ExecMainStartTimestamp=@1000 ExecMainExitTimestamp=@1001.500000
else
  printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=5000000 ExecMainExitTimestampMonotonic=0 ExecMainStartTimestamp=@1000 ExecMainExitTimestamp=
fi
exit 0
`);
}

describe("systemd stop duration", () => {
  function planted(logBytes?: number) {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    mkdirSync(dir, { recursive: true });
    const store = new JobStore(adb.db, dir, () => 1_000, { home: h.home, ...(logBytes !== undefined ? { logBytes } : {}) });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: timedStop(h.home) },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const id = track(jobId());
    const hash = "ab".repeat(16);
    const accepted = store.accept({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, commandHash: hash, cwdHash: hash,
    });
    if (!accepted.ok) throw new Error(accepted.error);
    store.applySchedule({ default: 1 }, "off");
    const running = store.started(id);
    if (!running.ok) throw new Error(running.error);
    return { store, sup, id, dir };
  }

  it("times a cancel from the unit after the stop, not from the wall clock", async () => {
    const { store, sup, id } = planted();
    const decided = await sup.cancel(id);
    if (!decided.ok) throw new Error(decided.error);
    expect(store.get(id)).toMatchObject({ outcome: "cancelled", durationMs: 1500 });
  });

  it("times a cap stop from the unit after the stop, not from the wall clock", async () => {
    const { store, sup, id, dir } = planted(8);
    writeFileSync(join(dir, `${id}.log`), "12345678");
    // The first sweep only decides the cap; the stop comes on a later sweep, once the grace has passed.
    await sup.sweep();
    expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    expect(await until(async () => {
      await sup.sweep();
      return store.get(id)?.outcome === "exited";
    }, 8000)).toBe(true);
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: null, durationMs: 1500 });
  });
});

describe.skipIf(!bus.ok)("systemd duration", () => {
  it("uses the unit's own start and exit, not the time the agent was down", async () => {
    const { store, start, sup, opts, drill, slot } = await systemdRig();
    const id = await start([process.execPath, "-e", "setTimeout(() => process.exit(0), 1500)"]);
    const began = Date.now();
    sup.close();
    expect(await until(() => showValue(unitOf(id), "ExecMainCode") === "1", 8000)).toBe(true);
    await wait(3000);
    slot.sup = await openJobSupervisor(store, opts, { slice: drill.slice, probe: () => ({ ok: true }) });
    await slot.sup.sweep();
    const job = store.get(id);
    const elapsed = Date.now() - began;
    expect(job?.outcome).toBe("exited");
    expect(job?.exitCode).toBe(0);
    expect(job?.durationMs ?? 0).toBeGreaterThanOrEqual(1000);
    expect(job?.durationMs ?? 0).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThan((job?.durationMs ?? 0) + 2500);
  });
});

describe.skipIf(!bus.ok)("systemd cancel", () => {
  it("takes the exit a finished unit kept instead of reporting the job missing", async () => {
    const { store, start, sup, home } = await systemdRig();
    const marker = join(home, "ran");
    const id = await start([
      process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], 'x'); process.exit(7)",
      marker,
    ]);
    expect(await until(() => showValue(unitOf(id), "ExecMainStatus") === "7")).toBe(true);
    const decided = await sup.cancel(id);
    if (!decided.ok) throw new Error(decided.error);
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: 7 });
    expect(decided.value.job.outcome).toBe("exited");
    expect(readFileSync(marker, "utf8")).toBe("x");
  });
});

describe("systemd result versus exec status", () => {
  it.each([
    ["oom-kill", 1, 1, 1],
    ["core-dump", 1, 1, 1],
    ["signal", 1, 15, 15],
    ["oom-kill", 2, 9, 137],
  ] as const)("Result=%s with ExecMainCode=%s and status %s settles as exit %s", async (result, code, status, exitCode) => {
    const h = tempHome();
    const env = fakeTools(h.home, `#!/bin/sh
if [ "$2" = "show" ]; then
  cat <<'EOF'
LoadState=loaded
ActiveState=failed
SubState=failed
Result=${result}
ExecMainCode=${code}
ExecMainStatus=${status}
MainPID=0
RemainAfterExit=yes
ExecMainStartTimestampMonotonic=1000000
ExecMainExitTimestampMonotonic=2000000
ExecMainStartTimestamp=@1000
ExecMainExitTimestamp=@1001
EOF
  exit 0
fi
exit 0
`);
    const adb = openAgentDb(join(h.home, "agent.db"));
    const dir = join(h.home, "job-logs");
    mkdirSync(dir, { recursive: true });
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: env },
    });
    open.push({ adb, cleanup: h.cleanup, dir, sup });
    const id = track(jobId());
    const hash = "ab".repeat(16);
    const accepted = store.accept({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, commandHash: hash, cwdHash: hash,
    });
    if (!accepted.ok) throw new Error(accepted.error);
    store.applySchedule({ default: 1 }, "off");
    const running = store.started(id);
    if (!running.ok) throw new Error(running.error);
    await sup.sweep();
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode, error: null });
  });
});

describe.skipIf(!bus.ok)("systemd end states", () => {
  it.each([201, 255])("records exit %s from the process, not a spawn failure", async (code) => {
    const { store, start, sup } = await systemdRig();
    const id = await start([process.execPath, "-e", `process.exit(${code})`]);
    expect(await until(async () => { await sup.sweep(); return store.get(id)?.outcome === "exited"; }, 8000)).toBe(true);
    expect(store.get(id)).toMatchObject({ outcome: "exited", exitCode: code, error: null });
  });

  it.each([
    ["SIGKILL", "9", 137],
    ["SIGTERM", "15", 143],
  ] as const)("settles a job after the main process dies from %s", async (signal, status, exitCode) => {
    const { store, notices, start, sup, home } = await systemdRig();
    const marker = join(home, "stay.json");
    const id = await start([process.execPath, "-e", STAY, marker]);
    expect(await until(() => existsSync(marker))).toBe(true);
    const mark = JSON.parse(readFileSync(marker, "utf8")) as { pid: number };
    process.kill(mark.pid, signal);
    expect(await until(() => showValue(unitOf(id), "ExecMainStatus") === status)).toBe(true);
    await sup.sweep();
    expect(store.get(id)).toMatchObject({ state: "exited", outcome: "exited", exitCode });
    expect(notices).toHaveLength(1);
    expect(alive(mark.pid)).toBe(false);
  });
});
