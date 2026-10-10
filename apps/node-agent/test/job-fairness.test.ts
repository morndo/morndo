// Queue fairness on the real supervisor (design §5, §11, §12 step 8). Limits come from the node policy.
// A full class stays queued; another class still starts; the next job starts only when a slot frees.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { err, type Job } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { jobLimits, jobTimeouts, parsePolicy, type JobGuardPolicy } from "../src/config.ts";
import { MAX_TIMER_MS } from "../src/ops/job-limits.ts";
import { guardOf, readProc, type MachineSample } from "../src/ops/job-guard.ts";
import { JobGrants } from "../src/ops/job-grant.ts";
import { JobStore, type NoticeHandoff } from "../src/ops/job-store.ts";
import { JobSupervisor, type JobStart } from "../src/ops/job-supervisor.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome, until } from "./helpers.ts";

const HOLD = `process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)`;

const open: { adb: AgentDb; cleanup: () => void; dir: string; sup: JobSupervisor }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.sup.close();
    if (existsSync(o.dir)) {
      for (const name of readdirSync(o.dir)) {
        if (!name.endsWith(".pid") && !name.endsWith(".child")) continue;
        const pid = Number(readFileSync(join(o.dir, name), "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
    o.adb.close();
    o.cleanup();
  }
});

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function rig(policy: Record<string, unknown>, readMachine?: () => MachineSample, timeouts?: Record<string, number>) {
  const parsed = parsePolicy(policy, "policy.json");
  const guard: JobGuardPolicy | undefined = parsed.jobs.guard;
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  const work = join(h.home, "work");
  mkdirSync(work, { recursive: true });
  const notices: NoticeHandoff[] = [];
  const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, onNotice: n => notices.push(n) });
  const paths = agentPaths(h.home);
  const sup = new JobSupervisor(store, {
    home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
    grants: new JobGrants(adb.db, () => Date.now()),
    limits: jobLimits(parsed.jobs),
    timeouts: timeouts ?? jobTimeouts(parsed.jobs),
    enabled: parsed.jobs.enabled,
    ...(guard ? { guard } : {}),
    ...(readMachine ? { readMachine } : {}),
  });
  const slot = { adb, cleanup: h.cleanup, dir, sup };
  open.push(slot);
  const start = async (over: Partial<JobStart> & Pick<JobStart, "id"> & { jobClass?: string }): Promise<Job> => value(await sup.start({
    lane: "builder", name: "pack", jobClass: over.jobClass ?? "default", notify: { kind: "lane", name: "builder" },
    cwd: work, command: [process.execPath, "-e", HOLD], ...over,
  }));
  const replace = (enabled: boolean, log?: { error: (message: string, error?: unknown) => void }) => {
    slot.sup.close();
    const next = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      grants: new JobGrants(adb.db, () => Date.now()),
      limits: jobLimits(parsed.jobs),
      timeouts: timeouts ?? jobTimeouts(parsed.jobs),
      enabled,
      ...(guard ? { guard } : {}),
      ...(readMachine ? { readMachine } : {}),
      ...(log ? { log } : {}),
    });
    slot.sup = next;
    return next;
  };
  return { sup, store, dir, work, start, notices, replace };
}

describe("queue positions", () => {
  it("numbers a class in the order the jobs were accepted", async () => {
    const { start, store, sup } = rig({ jobs: { classes: { default: { limit: 1 } } } });
    expect((await start({ id: "runner" })).state).toBe("running");
    expect(await start({ id: "m-second" })).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(await start({ id: "a-first" })).toMatchObject({ state: "queued", position: 2, reason: "class" });
    expect(store.get("m-second")).toMatchObject({ position: 1 });
    expect((await sup.cancel("runner")).ok).toBe(true);
    expect(await until(() => store.get("m-second")?.state === "running")).toBe(true);
    expect(store.get("a-first")).toMatchObject({ state: "queued", position: 1, reason: "class" });
  });
});

describe("guard", () => {
  it("delays a start while the machine is over the line and does not kill a running job", async () => {
    let sample: MachineSample = { load1: 0, memAvailableMiB: 10_000 };
    const { start, store, dir, sup } = rig(
      { jobs: { classes: { default: { limit: 3 } }, guard: { load1: 4, memAvailableMiB: 512 } } },
      () => sample,
    );
    expect((await start({ id: "live" })).state).toBe("running");
    const pid = Number(readFileSync(join(dir, "live.pid"), "utf8"));
    sample = { load1: 9, memAvailableMiB: 10_000 };
    await sup.sweep();
    expect(store.get("live")).toMatchObject({ state: "running" });
    expect(alive(pid)).toBe(true);
    expect(await start({ id: "wait" })).toMatchObject({ state: "queued", reason: "load", position: 1 });
    expect(existsSync(join(dir, "wait.pid"))).toBe(false);
    sample = { load1: 0, memAvailableMiB: 64 };
    expect(await start({ id: "low-mem" })).toMatchObject({ state: "queued", reason: "memory" });
    sample = { load1: 0, memAvailableMiB: 10_000 };
    await sup.sweep();
    expect(await until(() => store.get("wait")?.state === "running" && store.get("low-mem")?.state === "running")).toBe(true);
    expect(alive(pid)).toBe(true);
  });

  it("does not hold a job for a line the policy does not set", async () => {
    const { start } = rig(
      { jobs: { classes: { default: { limit: 1 } }, guard: { load1: 4 } } },
      () => ({ load1: 0.2 }),
    );
    expect((await start({ id: "load-only" })).state).toBe("running");
  });

  it("reads the 1-minute load and MemAvailable", () => {
    const h = tempHome();
    open.push({ adb: { close() {} } as AgentDb, cleanup: h.cleanup, dir: h.home, sup: { close() {} } as JobSupervisor });
    const load = join(h.home, "loadavg");
    const mem = join(h.home, "meminfo");
    writeFileSync(load, "1.50 0.40 0.20 2/100 9\n");
    writeFileSync(mem, "MemTotal: 2048000 kB\nMemAvailable: 524288 kB\n");
    expect(readProc(load, mem)).toEqual({ load1: 1.5, memAvailableMiB: 512 });
    writeFileSync(mem, "MemTotal: 2048000 kB\n");
    expect(() => readProc(load, mem)).toThrow(/proc unreadable/);
    expect(readProc(load, mem, { load1: true, mem: false })).toEqual({ load1: 1.5 });
  });

  it("stays queued when a configured guard cannot be read", async () => {
    const { start, dir } = rig(
      { jobs: { classes: { default: { limit: 2 } }, guard: { load1: 4 } } },
      () => { throw new Error("proc"); },
    );
    expect(await start({ id: "unread" })).toMatchObject({ state: "queued", reason: "guard_unknown", position: 1 });
    expect(existsSync(join(dir, "unread.pid"))).toBe(false);
  });
});

describe("guard off by default", () => {
  it("reads a guard object that names no line; config is what turns that into off", () => {
    let reads = 0;
    expect(guardOf({}, () => { reads += 1; return { load1: 1, memAvailableMiB: 1 }; })).toBe("off");
    expect(reads).toBe(1);
  });

  it("starts a job and never reads the machine when the guard is empty", async () => {
    let reads = 0;
    const { start, sup } = rig({ jobs: { classes: { default: { limit: 2 } }, guard: {} } }, () => {
      reads += 1;
      throw new Error("proc");
    });
    expect((await start({ id: "empty-guard" })).state).toBe("running");
    await sup.sweep();
    expect(reads).toBe(0);
  });

  it("a start during a sweep does not reuse that sweep's off reading", async () => {
    let reads = 0;
    const { start, sup, store } = rig(
      { jobs: { classes: { default: { limit: 2 } }, guard: { load1: 4 } } },
      () => { reads += 1; return { load1: 12, memAvailableMiB: 10_000 }; },
    );
    const sweeping = sup.sweep();
    expect(await start({ id: "late" })).toMatchObject({ state: "queued", reason: "load" });
    expect(reads).toBeGreaterThan(0);
    await sweeping;
    expect(store.get("late")).toMatchObject({ state: "queued", reason: "load" });
  });

  it("overlapping sweeps each keep the reading they took", async () => {
    let reads = 0;
    const { start, sup, store } = rig(
      { jobs: { classes: { default: { limit: 2 } }, guard: { load1: 4 } } },
      () => { reads += 1; return { load1: 12, memAvailableMiB: 10_000 }; },
    );
    expect((await start({ id: "held" })).state).toBe("queued");
    reads = 0;
    await Promise.all([sup.sweep(), sup.sweep()]);
    expect(reads).toBe(2);
    expect(store.get("held")).toMatchObject({ state: "queued", reason: "load" });
  });

  it("reads the machine once per sweep, and not when nothing is queued", async () => {
    let reads = 0;
    const { start, sup, store } = rig(
      { jobs: { classes: { default: { limit: 1 } }, guard: { load1: 8 } } },
      () => { reads += 1; return { load1: 0, memAvailableMiB: 10_000 }; },
    );
    expect((await start({ id: "runner" })).state).toBe("running");
    expect(reads).toBe(1);
    reads = 0;
    await sup.sweep();
    expect(reads).toBe(0);
    expect((await start({ id: "held" })).state).toBe("queued");
    reads = 0;
    await sup.sweep();
    expect(reads).toBe(1);
    expect(store.get("runner")?.state).toBe("running");
    expect(store.get("held")?.reason).toBe("class");
  });

  it("starts a job and never reads the machine when the policy has no guard", async () => {
    let reads = 0;
    const { start, sup } = rig({ jobs: { classes: { default: { limit: 2 } } } }, () => {
      reads += 1;
      return { load1: 100, memAvailableMiB: 0 };
    });
    expect((await start({ id: "free" })).state).toBe("running");
    await sup.sweep();
    expect(reads).toBe(0);
  });
});

describe("class timeout", () => {
  it("times a job out at the class timeoutSec when the start omits one", async () => {
    const { start, store, dir, sup } = rig({ jobs: { classes: { default: { limit: 2, timeoutSec: 1 } } } });
    expect((await start({ id: "slow" })).state).toBe("running");
    const spec = JSON.parse(readFileSync(join(dir, "slow.argv"), "utf8")) as { timeoutMs: number | null };
    expect(spec.timeoutMs).toBe(1000);
    expect(await until(() => existsSync(join(dir, "slow.exit")))).toBe(true);
    await sup.sweep();
    expect(store.get("slow")?.outcome).toBe("timed_out");
  });

  it("arms the longest timer the runtime allows when the class timeout is longer", async () => {
    const { start, dir } = rig({ jobs: { classes: { default: { limit: 1 } } } }, undefined, { default: 2_500_000 });
    expect((await start({ id: "long" })).state).toBe("running");
    const spec = JSON.parse(readFileSync(join(dir, "long.argv"), "utf8")) as { timeoutMs: number | null };
    expect(spec.timeoutMs).toBe(MAX_TIMER_MS);
  });

  it("keeps a start that asks for no limit from using the class timeout", async () => {
    const { start, dir } = rig({ jobs: { classes: { default: { limit: 2, timeoutSec: 1 } } } });
    expect((await start({ id: "open", timeoutMs: 0 })).state).toBe("running");
    const spec = JSON.parse(readFileSync(join(dir, "open.argv"), "utf8")) as { timeoutMs: number | null };
    expect(spec.timeoutMs).toBeNull();
  });
});

describe("class limits", () => {
  it("holds the third job of a full class and still starts another class", async () => {
    const { start, store, dir, sup } = rig({
      jobs: { enabled: true, classes: { default: { limit: 2 }, review: { limit: 1 } } },
    });
    expect((await start({ id: "def-a" })).state).toBe("running");
    expect((await start({ id: "def-b" })).state).toBe("running");
    const held = await start({ id: "def-c" });
    expect(held).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(existsSync(join(dir, "def-c.pid"))).toBe(false);
    expect((await start({ id: "rev-a", jobClass: "review" })).state).toBe("running");
    expect(store.get("def-c")).toMatchObject({ state: "queued", position: 1, reason: "class" });
    const unknown = await start({ id: "batch-a", jobClass: "batch" });
    expect(unknown.outcome).toBe("refused");
    expect(existsSync(join(dir, "batch-a.pid"))).toBe(false);
    expect((await sup.cancel("def-a")).ok).toBe(true);
    expect(await until(() => store.get("def-c")?.state === "running")).toBe(true);
    expect(store.get("def-b")?.state).toBe("running");
    expect(store.get("rev-a")?.state).toBe("running");
  });

  it("ignores a refusal the store already settled, and logs a write that fails", async () => {
    const { start, store, replace } = rig({ jobs: { classes: { default: { limit: 1 } } } });
    expect((await start({ id: "runner" })).state).toBe("running");
    expect((await start({ id: "waiting" })).state).toBe("queued");
    const lines: string[] = [];
    store.settle = () => err("already_terminal");
    const quiet = replace(false, { error: (message) => lines.push(message) });
    await quiet.sweep();
    expect(lines).toEqual([]);
    store.settle = () => { throw new Error("disk full"); };
    await expect(quiet.sweep()).rejects.toThrow(/disk full/);
    expect(lines.join("\n")).toMatch(/waiting/);
  });

  it("refuses a queued job once jobs are turned off, and leaves a running one", async () => {
    const { start, store, notices, replace } = rig({ jobs: { classes: { default: { limit: 1 } } } });
    expect((await start({ id: "runner" })).state).toBe("running");
    expect((await start({ id: "waiting" })).state).toBe("queued");
    const off = replace(false);
    await off.sweep();
    expect(store.get("waiting")).toMatchObject({ state: "refused", outcome: "refused" });
    expect(notices.filter(n => n.job.id === "waiting")).toHaveLength(1);
    expect(store.get("runner")?.state).toBe("running");
    await off.sweep();
    expect(notices.filter(n => n.job.id === "waiting")).toHaveLength(1);
  });

  it("returns an accepted job when a later start finds jobs turned off", async () => {
    const { start, store, work, replace } = rig({ jobs: { classes: { default: { limit: 1 } } } });
    const body = {
      id: "keep", lane: "builder" as const, name: "pack", jobClass: "default",
      notify: { kind: "lane" as const, name: "builder" }, cwd: work,
      command: [process.execPath, "-e", HOLD],
    };
    expect((await start(body)).state).toBe("running");
    const off = replace(false);
    const again = await off.start(body);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toMatchObject({ id: "keep", state: "running" });
    const clash = await off.start({ ...body, command: [process.execPath, "-e", "process.exit(0)"] });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toBe("id_conflict");
    const fresh = await off.start({ ...body, id: "new" });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.error).toBe("disabled");
    expect(store.get("new")).toBeNull();
  });

  it("says disabled before it checks the command, when jobs are off", async () => {
    const { sup, store } = rig({ jobs: { enabled: false, classes: { default: { limit: 1 } } } });
    const started = await sup.start({
      id: "nope", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: "/nope", command: [],
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toBe("disabled");
    expect(store.get("nope")).toBeNull();
  });

  it("refuses a start when jobs are disabled and runs nothing", async () => {
    const { sup, store, work } = rig({ jobs: { enabled: false, classes: { default: { limit: 2 } } } });
    const started = await sup.start({
      id: "def-off", lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", HOLD],
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.error).toBe("disabled");
    expect(store.get("def-off")).toBeNull();
  });
});
