// Child supervisor and the local socket (ADR-0017, design §3, §12 step 3). The helper is a new session, so closing
// this process does not take the command with it. A later process reattaches by pid, or takes the exit file the
// helper wrote, or marks the job lost when the pid is gone and no exit was recorded. The command stays in a mode
// 0600 argv file on this node; the jobs table keeps the hash. The socket is mode 0600.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  err, ok,
  type FinishEvent, type FinishProblem, type Guard, type Job, type NotifyTarget, type Result, type StartProblem,
} from "@morndo/domain";
import { deniedBy, denyRoots, processAlive, resolvedRoots, type ProcessStart } from "@morndo/node-ops";
import { errno } from "@morndo/service-kit";
import { psStarts, readRecorded, sameProcess, START_RECORD_GRACE_MS, writeProcessFile, type Recorded } from "./job-identity.ts";
import { capStep, endedBeforeStop, monotonicUsec, UNIT_CAP_LOOK_MS, type CapSight } from "./job-cap.ts";
import { MAX_TIMER_MS, UNIT_STOP_WAIT_MS, UNIT_STUCK_STOP_MS } from "./job-limits.ts";
import { askHub, JobGrants } from "./job-grant.ts";
import { killJobUnit, managerEnv, probeUserManager, resetJobUnit, runMs, showUnit, spawnFailed, startJobUnit, stopJobUnit, type ProbeResult, type UnitLook, type UnitState } from "./job-systemd.ts";
import { guardOf, readProc, type MachineSample } from "./job-guard.ts";
import { JobStore, type NoticeHandoff } from "./job-store.ts";
import type { JobGuardPolicy } from "../config.ts";

// Omitted (null or undefined): the class timeout, in milliseconds. 0: no limit, even when the class has one.
function startTimeout(asked: number | null | undefined, classSec: number | undefined): number | null {
  if (asked === 0) return null;
  if (asked !== undefined && asked !== null) return asked;
  if (classSec === undefined) return null;
  const ms = classSec * 1000;
  return ms > MAX_TIMER_MS ? MAX_TIMER_MS : ms;
}

const helperFile = fileURLToPath(new URL("./job-helper.ts", import.meta.url));
const KEPT = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR"] as const;

export type SuperviseProblem = StartProblem | FinishProblem | "disk" | "denied" | "bad_command" | "missing" | "unavailable" | "signalled";

export type JobStart = {
  id: string;
  lane: string;
  name: string;
  jobClass: string;
  notify: NotifyTarget;
  command: readonly string[];
  cwd: string;
  timeoutMs?: number | null;
};

type Spec = {
  command: string[];
  cwd: string;
  logPath: string;
  exitPath: string;
  childPath: string;
  timeoutMs: number | null;
  logBytes: number;
  env: Record<string, string>;
};

type ExitRecord = {
  outcome: "exited" | "timed_out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  error?: "did_not_start" | null;
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// CLD_EXITED=1, CLD_KILLED=2, CLD_DUMPED=3 (the wait status systemd stores in ExecMainCode).
// A signal's conventional status is 128 plus the signal number. SIGTERM is 143, SIGKILL is 137.
// Result=oom-kill, core-dump, or signal is a signal only when ExecMainCode says the process was
// killed or dumped. Code 1 is a normal exit, and ExecMainStatus is that exit code.
function exitOf(view: UnitState, durationMs: number): FinishEvent | null {
  if (view.result === "timeout") return { outcome: "timed_out", exitCode: null, durationMs };
  const signaled = view.execCode === 2 || view.execCode === 3;
  if (signaled) {
    const signal = view.execStatus;
    const exitCode = Number.isInteger(signal) && signal > 0 && signal < 128 ? 128 + signal : null;
    return { outcome: "exited", exitCode, durationMs };
  }
  if (spawnFailed(view)) {
    return { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" };
  }
  if (view.execCode === 1 && Number.isInteger(view.execStatus) && view.execStatus >= 0 && view.execStatus <= 255) {
    return { outcome: "exited", exitCode: view.execStatus, durationMs };
  }
  if (view.result === "failed" || view.result === "exit-code" || view.result === "watchdog"
    || view.result === "resources" || view.result === "start-limit-hit") {
    return { outcome: "exited", exitCode: null, durationMs };
  }
  return null;
}

async function until(f: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  let delay = 20;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return true;
    await wait(delay);
    delay = Math.min(delay * 2, 500);
  }
  return f();
}

function keptEnv(src: NodeJS.ProcessEnv, id: string, lane: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of KEPT) {
    const value = src[key];
    if (value !== undefined) env[key] = value;
  }
  env.MORNDO_JOB_ID = id;
  env.MORNDO_LANE = lane;
  return env;
}

type ListedJob = {
  id: string;
  name: string;
  class: string;
  state: string;
  position: number | null;
  reason: string | null;
  lane: string;
  notify: NotifyTarget;
  outcome: string | null;
  exit: number | null;
  durationSec: number | null;
  notice: string;
};

function commandOk(command: readonly string[]): command is string[] {
  return command.length > 0 && command.every(part => typeof part === "string" && part.length > 0 && !part.includes("\0"));
}

function eventOf(job: Job): FinishEvent | null {
  if (job.outcome === null || job.durationMs === null) return null;
  if (job.outcome === "lost") return { outcome: "lost", at: (job.startedAt ?? 0) + job.durationMs };
  if (job.outcome === "exited") return { outcome: "exited", exitCode: job.exitCode, durationMs: job.durationMs, error: job.error };
  return { outcome: job.outcome, exitCode: job.exitCode, durationMs: job.durationMs };
}

function recordEvent(record: ExitRecord): FinishEvent | null {
  if (record.outcome !== "exited" && record.outcome !== "timed_out" && record.outcome !== "cancelled") return null;
  if (record.outcome === "exited" && record.error === "did_not_start") {
    return { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" };
  }
  if (!Number.isInteger(record.durationMs) || record.durationMs < 0) return null;
  if (record.exitCode !== null && (!Number.isInteger(record.exitCode) || record.exitCode < 0 || record.exitCode > 255)) return null;
  if (record.outcome === "exited") return { outcome: "exited", exitCode: record.exitCode, durationMs: record.durationMs };
  return { outcome: record.outcome, exitCode: record.exitCode, durationMs: record.durationMs };
}

// A failed probe prints one line and stays on the child supervisor. A successful probe is the systemd path.
export async function openJobSupervisor(store: JobStore, opts: {
  home: string;
  stateDir: string;
  socketPath: string;
  limits?: Readonly<Record<string, number>>;
  timeouts?: Readonly<Record<string, number>>;
  enabled?: boolean;
  guard?: JobGuardPolicy;
  readMachine?: () => MachineSample;
  env?: NodeJS.ProcessEnv;
  node?: string;
  grants?: JobGrants;
  hubBase?: string;
  stuckStopMs?: number;
  log?: { error: (message: string, error?: unknown) => void };
}, choice: {
  probe?: () => ProbeResult | Promise<ProbeResult>;
  slice?: string;
  say?: (line: string) => void;
  toolEnv?: NodeJS.ProcessEnv;
} = {}): Promise<JobSupervisor> {
  const result = await (choice.probe ?? (() => probeUserManager(choice.toolEnv)))();
  if (!result.ok) {
    (choice.say ?? (line => process.stdout.write(line)))(`systemd skipped: ${result.reason}\n`);
    return new JobSupervisor(store, opts);
  }
  if (!choice.slice) throw new Error("systemd jobs need a throwaway slice");
  return new JobSupervisor(store, {
    ...opts,
    systemd: choice.toolEnv ? { slice: choice.slice, toolEnv: choice.toolEnv } : { slice: choice.slice },
  });
}

export class JobSupervisor {
  #store: JobStore;
  #home: string;
  #stateDir: string;
  #socketPath: string;
  #limits: Readonly<Record<string, number>>;
  #timeouts: Readonly<Record<string, number>>;
  #enabled: boolean;
  #guard: JobGuardPolicy | undefined;
  #readMachine: () => MachineSample;
  #env: NodeJS.ProcessEnv;
  #node: string;
  #slice: string | null;
  #grants: JobGrants | null;
  #hubBase: string | null;
  #log: { error: (message: string, error?: unknown) => void } | null;
  #toolEnv: NodeJS.ProcessEnv | undefined;
  #managerEnv: Promise<string[] | null> | null = null;
  #server: Server | null = null;
  #tails = new Map<string, Promise<void>>();
  // Design §5: the grace of each capped systemd job, running beside the sweep (see #watchCap).
  #capWatches = new Map<string, Promise<void>>();
  // Each open job's first sighting of its log at the cap, kept across watches: the grace runs once from it (design §5).
  #capSights = new Map<string, CapSight>();
  // Jobs a cancel signalled but could not confirm: how such a unit ends is the cancel's result, not the command's.
  #signalledCancels = new Set<string>();
  // Each unit the sweep found stopping: when it first did (monotonic ms), and whether the bound's SIGKILL went out.
  #stoppingSights = new Map<string, { since: number; killed: boolean }>();
  #stuckStopMs: number;
  // A closed supervisor's watches stop acting, also when they already wait for the job's lock: the agent that replaces
  // it owns the jobs. close() does not wait for them; each one sees this at its next step and returns.
  #closed = false;

  constructor(store: JobStore, opts: {
    home: string;
    stateDir: string;
    socketPath: string;
    limits?: Readonly<Record<string, number>>;
    timeouts?: Readonly<Record<string, number>>;
    enabled?: boolean;
    guard?: JobGuardPolicy;
    readMachine?: () => MachineSample;
    env?: NodeJS.ProcessEnv;
    node?: string;
    systemd?: { slice: string; toolEnv?: NodeJS.ProcessEnv };
    grants?: JobGrants;
    hubBase?: string;
    stuckStopMs?: number;
    log?: { error: (message: string, error?: unknown) => void };
  }) {
    this.#store = store;
    this.#home = opts.home;
    this.#stateDir = opts.stateDir;
    this.#socketPath = opts.socketPath;
    this.#limits = opts.limits ?? { default: 2 };
    this.#timeouts = opts.timeouts ?? {};
    this.#enabled = opts.enabled ?? true;
    this.#guard = opts.guard;
    this.#readMachine = opts.readMachine ?? (() => readProc("/proc/loadavg", "/proc/meminfo", {
      load1: this.#guard?.load1 !== undefined,
      mem: this.#guard?.memAvailableMiB !== undefined,
    }));
    this.#env = opts.env ?? process.env;
    this.#node = opts.node ?? process.execPath;
    this.#slice = opts.systemd?.slice ?? null;
    this.#log = opts.log ?? null;
    this.#grants = opts.grants ?? null;
    this.#hubBase = opts.hubBase ?? null;
    this.#toolEnv = opts.systemd?.toolEnv;
    this.#stuckStopMs = opts.stuckStopMs ?? UNIT_STUCK_STOP_MS;
  }

  listen(): Promise<void> {
    mkdirSync(dirname(this.#socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.#socketPath)) unlinkSync(this.#socketPath);
    const server = createServer(socket => {
      let buf = "";
      let closed = false;
      const end = (body: string) => {
        if (closed) return;
        closed = true;
        socket.end(body);
      };
      socket.on("error", () => { closed = true; socket.destroy(); });
      socket.on("data", chunk => {
        if (closed) return;
        buf += String(chunk);
        if (buf.length > 1_000_000) { closed = true; socket.destroy(); return; }
        const at = buf.indexOf("\n");
        if (at < 0) return;
        const line = buf.slice(0, at);
        buf = "";
        void this.#reply(line).then(body => { end(`${JSON.stringify(body)}\n`); }, () => { closed = true; socket.destroy(); });
      });
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#socketPath, () => {
        server.off("error", reject);
        chmodSync(this.#socketPath, 0o600);
        resolve();
      });
    });
  }

  // How many jobs this supervisor still holds cap or cancel state for. A job that has ended holds none, so the count is
  // bounded by the open jobs (the tests read it to show nothing outlives a job).
  trackedJobs(): number {
    return new Set([...this.#capSights.keys(), ...this.#signalledCancels, ...this.#stoppingSights.keys()]).size;
  }

  close(): void {
    this.#closed = true;
    this.#server?.close();
    this.#server = null;
    try { unlinkSync(this.#socketPath); } catch (e) { if (errno(e) !== "ENOENT") throw e; }
  }

  async start(body: JobStart): Promise<Result<Job, string>> {
    const prior = typeof body.id === "string" ? this.#store.get(body.id) : null;
    if (!this.#enabled && !prior) return err("disabled");
    if (!Array.isArray(body.command) || !commandOk(body.command)) return err("bad_command");
    if (typeof body.cwd !== "string" || body.cwd.length === 0) return err("bad_command");
    const timeoutMs = startTimeout(body.timeoutMs, this.#timeouts[body.jobClass]);
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS)) return err("bad_command");
    const cwd = this.#cwd(body.cwd);
    if (cwd === null) return err("denied");
    const decided = this.#store.accept({
      id: body.id, lane: body.lane, name: body.name, jobClass: body.jobClass, notify: body.notify,
      commandHash: createHash("sha256").update(body.command.join("\0")).digest("hex"),
      cwdHash: createHash("sha256").update(cwd).digest("hex"),
    });
    if (!decided.ok) return decided;
    if (!prior) this.#writeSpec(body, cwd, timeoutMs);
    await this.#promote(this.#starting());
    const job = this.#store.get(body.id);
    return job ? ok(job) : err("missing");
  }

  async cancel(id: string): Promise<Result<NoticeHandoff, SuperviseProblem>> {
    const result = await this.#exclusive(id, () => this.#cancelOne(id));
    await this.#promote(this.#starting());
    return result;
  }

  // What a new agent finds: a live helper, an exit file, or a starting/running row with no process (lost).
  // A job this sweep just admitted is launched. One left starting by a crash is not started again.
  async sweep(): Promise<void> {
    // This sweep's reading, or null when nothing was queued so there was nothing to read. A start that arrives
    // while this awaits takes its own reading; it never sees this one.
    const guard = this.#queued() ? this.#measure() : null;
    const pending = this.#starting();
    await this.#apply(guard);
    const starts = await psStarts(this.#fallbackPids());
    const jobs = this.#store.list().filter(job => job.state === "running" || job.state === "starting");
    const watches: Promise<void>[] = [];
    if (this.#slice) {
      await Promise.all(jobs.map(job => this.#exclusive(job.id, () => this.#sweepOne(job.id, pending, starts, watches))));
    } else {
      for (const job of jobs) await this.#exclusive(job.id, () => this.#sweepOne(job.id, pending, starts, watches));
    }
    await this.#promote(this.#starting(), guard);
    this.#reconcile();
    // Design §5: a capped unit's grace runs beside the sweep, so it holds up no other job and no cancel. The sweep
    // still ends with the decisions of the watches it started (an earlier sweep's watch is that sweep's), and starts
    // what they freed.
    if (watches.length > 0) {
      await Promise.all(watches);
      await this.#promote(this.#starting());
    }
  }

  async #exclusive<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.#tails.get(id);
    if (!prev) {
      const result = fn();
      if (!(result instanceof Promise)) return result;
      const settled = result.then(() => {}, () => {});
      this.#tails.set(id, settled);
      try { return await result; }
      finally { if (this.#tails.get(id) === settled) this.#tails.delete(id); }
    }
    const run = prev.then(() => fn());
    const settled = run.then(() => {}, () => {});
    this.#tails.set(id, settled);
    try { return await run; }
    finally { if (this.#tails.get(id) === settled) this.#tails.delete(id); }
  }

  #open(id: string): Job | null {
    const job = this.#store.get(id);
    if (!job || job.outcome !== null) return null;
    if (job.state !== "running" && job.state !== "starting") return null;
    return job;
  }

  async #cancelOne(id: string): Promise<Result<NoticeHandoff, SuperviseProblem>> {
    if (this.#slice) return this.#cancelUnit(id);
    const job = this.#store.get(id);
    if (!job) return err("missing");
    if (job.outcome !== null) return this.#replay(job);
    if (job.state === "queued") return this.#settle(id, { outcome: "cancelled", exitCode: null, durationMs: 0 });
    let found = this.#recorded(id, "pid");
    if (found?.recorded.kind === "none") {
      await this.#waitForRecord(id);
      const current = this.#store.get(id);
      if (!current) return err("missing");
      if (current.outcome !== null) return this.#replay(current);
      found = this.#recorded(id, "pid");
      if (!found || found.recorded.kind === "none") {
        try {
          const decided = await this.#settle(id, { outcome: "lost", at: Date.now() });
          return decided.ok ? ok(decided.value) : err("missing");
        } catch { return err("missing"); }
      }
    }
    const live = found ? await sameProcess(found.pid, found.recorded) : false;
    const current = this.#store.get(id);
    if (!current) return err("missing");
    if (current.outcome !== null) return this.#replay(current);
    let delivered = false;
    if (live && found) {
      try { process.kill(found.pid, "SIGTERM"); delivered = true; }
      catch { delivered = false; }
    }
    const handoff = await this.#awaitExit(id, found, delivered);
    if (handoff) return ok(handoff);
    return (await this.#ended(id)) ?? err(delivered ? "signalled" : "unavailable");
  }

  #fallbackPids(): number[] {
    const pids: number[] = [];
    for (const job of this.#store.list()) {
      if (job.state !== "running" && job.state !== "starting") continue;
      for (const kind of ["pid", "child"] as const) {
        const found = this.#recorded(job.id, kind);
        if (found?.recorded.kind === "start") pids.push(found.pid);
      }
    }
    return pids;
  }

  async #sweepOne(id: string, pending: Set<string>, starts: ReadonlyMap<number, ProcessStart | null>, watches: Promise<void>[] = []): Promise<void> {
    if (this.#slice) { await this.#sweepUnit(id, pending, watches); return; }
    if (!this.#open(id)) return;
    if (existsSync(join(this.#store.dir, `${id}.exit`))) { await this.#takeExit(id); return; }
    const found = this.#recorded(id, "pid");
    if (found?.recorded.kind === "none") {
      if (this.#recordPending(id)) return;
      if (!this.#open(id)) return;
      try { await this.#settle(id, { outcome: "lost", at: Date.now() }); } catch { /* next sweep retries */ }
      return;
    }
    const live = found ? await sameProcess(found.pid, found.recorded, starts) : false;
    const job = this.#open(id);
    if (!job) return;
    if (live && found) {
      if (job.state === "starting") this.#store.started(id);
      if (this.#store.watch(id) === "capped") this.#requestCap(id);
      return;
    }
    if (found || pending.has(id) || job.state === "running") {
      await this.#stopChild(id, starts);
      if (!this.#open(id)) return;
      try { await this.#settle(id, { outcome: "lost", at: Date.now() }); } catch { /* next sweep retries */ }
      return;
    }
    if (!this.#open(id)) return;
    await this.#launch(id);
  }

  // Jobs already `starting` keep their pids. A job this call moves to `starting` is launched.
  #starting(): Set<string> {
    return new Set(this.#store.list().filter(job => job.state === "starting").map(job => job.id));
  }

  #queued(): boolean {
    return this.#store.list().some(job => job.state === "queued");
  }

  // `guard` is the reading this caller already took. Null means take one now, and only if a job is queued.
  async #apply(guard: Guard | null): Promise<void> {
    if (!this.#enabled) {
      await this.#refuseQueued();
      return;
    }
    await this.#store.applySchedule(this.#limits, guard ?? this.#measure());
  }

  #measure(): Guard {
    const policy = this.#guard;
    if (!policy) return "off";
    if (!this.#queued()) return "off";
    return guardOf(policy, this.#readMachine);
  }

  // A restart with jobs off does not kill a command that is already running. A job that never started is refused,
  // once, so its notice is the one the fleet delivers.
  async #refuseQueued(): Promise<void> {
    for (const job of this.#store.list()) {
      if (job.state !== "queued") continue;
      try {
        const decided = await this.#settle(job.id, { outcome: "refused" });
        if (!decided.ok) continue;
      } catch (e) {
        this.#log?.error(`refusing queued job ${job.id} failed`, e);
        throw e;
      }
    }
  }

  // The launch is async. It has to take the same per-job lock as sweep and cancel, or a sweep can see
  // the unit still absent and settle the job lost while systemd-run is in flight.
  async #promote(already: Set<string>, guard: Guard | null = null): Promise<void> {
    await this.#apply(guard);
    const launched: string[] = [];
    await Promise.all(this.#store.list()
      .filter(job => job.state === "starting" && !already.has(job.id))
      .map(job => this.#exclusive(job.id, () => this.#launch(job.id)).then(() => { launched.push(job.id); })));
    // A launch that failed settled its job did_not_start and freed the slot it took: pass again while a job is
    // still queued (each pass starts at least one job, so this ends).
    if (launched.some(id => this.#store.get(id)?.outcome != null) && this.#queued()) {
      await this.#promote(new Set([...already, ...launched]), guard);
    }
  }

  async #reply(line: string): Promise<
    | { ok: true; job: Job | { id: string; state: string; text: string } }
    | { ok: true; jobs: ListedJob[] }
    | { ok: true; text: string }
    | { ok: false; error: string }
  > {
    let msg: { op?: string; id?: string; lane?: string; state?: string; lines?: number; token?: string };
    try { msg = JSON.parse(line) as { op?: string; id?: string; lane?: string; state?: string; lines?: number; token?: string }; } catch { return { ok: false, error: "bad_command" }; }
    if (msg.op === "start") {
      const body = msg as JobStart & { token?: string };
      if (this.#grants) {
        if (typeof body.token !== "string" || body.token.length === 0 || typeof body.lane !== "string" || typeof body.id !== "string" || typeof body.cwd !== "string" || !body.notify || typeof body.jobClass !== "string") {
          return { ok: false, error: "hub" };
        }
        if (!this.#hubBase) return { ok: false, error: "no_hub" };
        const known = this.#grants.laneOf(body.token);
        const asked = known ?? body.lane;
        const verdict = await askHub(this.#hubBase, body.token, {
          lane: asked, id: body.id, jobClass: body.jobClass, notify: body.notify,
          cwdHash: createHash("sha256").update(body.cwd).digest("hex"),
        });
        if (verdict.kind === "denied" && verdict.code === "not_yours") return { ok: false, error: "not_yours" };
        const lane = verdict.kind === "allowed" ? verdict.lane : asked;
        const admitted = this.#grants.admit(lane, body.token, verdict);
        if (admitted !== "ok") return { ok: false, error: admitted === "no_cache" ? "no_cache" : "hub" };
        body.lane = lane;
      }
      const decided = await this.start(body);
      return decided.ok ? { ok: true, job: decided.value } : { ok: false, error: decided.error };
    }
    if (msg.op === "list" || msg.op === "show" || msg.op === "logs") return this.#read(msg);
    if (msg.op === "cancel" && typeof msg.id === "string") {
      const lane = this.#actor(msg);
      if (typeof lane !== "string") return lane;
      const owned = this.#store.get(msg.id);
      if (!owned) return { ok: false, error: "missing" };
      if (owned.lane !== lane) return { ok: false, error: "not_yours" };
      const decided = await this.cancel(msg.id);
      return decided.ok ? { ok: true, job: decided.value.job } : { ok: false, error: decided.error };
    }
    return { ok: false, error: "bad_command" };
  }

  #listed(job: Job): ListedJob {
    return {
      id: job.id, name: job.name, class: job.jobClass, state: job.state,
      position: job.position, reason: job.reason, lane: job.lane, notify: job.notify,
      outcome: job.outcome, exit: job.exitCode,
      durationSec: job.durationMs === null ? null : Math.round(job.durationMs / 100) / 10,
      notice: job.notice,
    };
  }

  // The lane is the one cached with the token. The name on the message is not a credential.
  #actor(msg: { lane?: string; token?: string }): string | { ok: false; error: string } {
    if (!this.#grants) return typeof msg.lane === "string" ? msg.lane : { ok: false, error: "bad_command" };
    if (typeof msg.token !== "string" || msg.token.length === 0) return { ok: false, error: "hub" };
    const lane = this.#grants.laneOf(msg.token);
    return lane ?? { ok: false, error: "not_yours" };
  }

  #read(msg: { op?: string; id?: string; lane?: string; state?: string; lines?: number; token?: string }): { ok: true; jobs: ListedJob[] } | { ok: true; job: { id: string; state: string; text: string } } | { ok: true; text: string } | { ok: false; error: string } {
    const lane = this.#actor(msg);
    if (typeof lane !== "string") return lane;
    if (msg.op === "list") {
      const jobs = this.#store.list().filter(job => job.lane === lane && (msg.state === undefined || job.state === msg.state));
      return { ok: true, jobs: jobs.map(job => this.#listed(job)) };
    }
    if (typeof msg.id !== "string") return { ok: false, error: "bad_command" };
    const job = this.#store.get(msg.id);
    if (!job) return { ok: false, error: "missing" };
    if (job.lane !== lane) return { ok: false, error: "not_yours" };
    if (msg.op === "logs") {
      const lines = msg.lines === undefined ? 40 : msg.lines;
      if (!Number.isInteger(lines) || lines < 1) return { ok: false, error: "bad_command" };
      const text = this.#store.log(msg.id, lines);
      return text === null ? { ok: false, error: "missing" } : { ok: true, text };
    }
    const text = this.#store.preview(msg.id);
    return text === null ? { ok: false, error: "missing" } : { ok: true, job: { id: job.id, state: job.state, text } };
  }

  #cwd(cwd: string): string | null {
    let real: string;
    try { real = realpathSync.native(cwd); } catch { return null; }
    if (!statSync(real).isDirectory()) return null;
    if (deniedBy(real, resolvedRoots(denyRoots(this.#home, this.#stateDir)))) return null;
    return real;
  }

  #writeSpec(body: JobStart, cwd: string, timeoutMs: number | null): void {
    const spec: Spec = {
      command: [...body.command], cwd,
      logPath: join(this.#store.dir, `${body.id}.log`),
      exitPath: join(this.#store.dir, `${body.id}.exit`),
      childPath: join(this.#store.dir, `${body.id}.child`),
      timeoutMs,
      logBytes: this.#store.logBytes,
      env: keptEnv(this.#env, body.id, body.lane),
    };
    const path = join(this.#store.dir, `${body.id}.argv`);
    writeFileSync(path, JSON.stringify(spec), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  async #sweepUnit(id: string, pending: Set<string>, watches: Promise<void>[] = []): Promise<void> {
    if (!this.#open(id)) return;
    const seenUsec = monotonicUsec();
    const look = await showUnit(id, this.#toolEnv);
    const job = this.#open(id);
    if (!job) return;
    if (look.kind === "unknown") return;
    if (look.kind === "absent") {
      if (pending.has(id) || job.state === "running") {
        try { await this.#settle(id, this.#unitEnd(id, job, null)); } catch { /* next sweep retries */ }
        return;
      }
      await this.#launchUnit(id);
      return;
    }
    const view = look.view;
    if (view.active !== "deactivating") this.#stoppingSights.delete(id);
    if (view.active === "activating" || (view.active === "active" && view.sub === "running")) {
      if (job.state === "starting") this.#store.started(id);
      if (this.#overCap(id)) {
        const watch = this.#watchCap(id, view, seenUsec);
        if (watch) watches.push(watch);
      }
      return;
    }
    if (view.active === "deactivating") { await this.#stoppingUnit(id, job); return; }
    await this.#settleUnit(id, view);
  }

  // A unit that is stopping has not told its result yet; the next sweep reads how it ended. systemd bounds a stop
  // itself (TimeoutStopSec=10 on every job unit), but a stop that never ends must not hold the job open for ever:
  // once the unit has been seen stopping for `stuckStopMs` it gets a SIGKILL, and after twice that the job ends as
  // the signalled cancel or lost, the unit being one no one can confirm over.
  async #stoppingUnit(id: string, job: Job): Promise<void> {
    const now = performance.now();
    const sight = this.#stoppingSights.get(id);
    if (!sight) { this.#stoppingSights.set(id, { since: now, killed: false }); return; }
    const age = now - sight.since;
    if (age < this.#stuckStopMs) return;
    if (age < 2 * this.#stuckStopMs) {
      if (sight.killed) return;
      sight.killed = true;
      try { await killJobUnit(id, "SIGKILL", this.#toolEnv); }
      catch (e) { this.#log?.error(`the SIGKILL for job ${id}, stuck stopping, failed; the next sweep gives up on it`, e); }
      return;
    }
    if (job.state === "starting") {
      const started = this.#store.started(id);
      if (!started.ok) return;
    }
    try { await this.#settle(id, this.#unitEnd(id, job, null)); } catch { return; }
    try { await stopJobUnit(id, this.#toolEnv); } catch { /* the end is already recorded */ }
    await resetJobUnit(id, this.#toolEnv);
  }

  // How a unit that is over ended. A cancel that signalled it owns that end (the unit's exit code is the signal's,
  // not the command's); a unit no one can read is lost. With a view the unit's own result decides, and may be nothing.
  #unitEnd(id: string, job: Job, view: UnitState): FinishEvent | null;
  #unitEnd(id: string, job: Job, view: null): FinishEvent;
  #unitEnd(id: string, job: Job, view: UnitState | null): FinishEvent | null {
    if (this.#signalled(id)) {
      const durationMs = view !== null ? runMs(view, job.startedAt)
        : job.startedAt === null ? 0 : Math.max(0, Date.now() - job.startedAt);
      return { outcome: "cancelled", exitCode: null, durationMs };
    }
    if (view === null) return { outcome: "lost", at: Date.now() };
    return exitOf(view, runMs(view, job.startedAt));
  }

  // A unit that is no longer running: its own result, read from systemd.
  async #settleUnit(id: string, view: UnitState): Promise<void> {
    const job = this.#open(id);
    if (!job) return;
    const event = this.#unitEnd(id, job, view);
    if (!event) return;
    if (job.state === "starting") {
      const started = this.#store.started(id);
      if (!started.ok) return;
    }
    try {
      const decided = await this.#settle(id, event);
      if (!decided.ok) return;
    } catch { return; }
    try { await stopJobUnit(id, this.#toolEnv); } catch { /* the exit is already recorded */ }
    await resetJobUnit(id, this.#toolEnv);
  }

  // Design §5: on systemd the supervisor owns the cap. The sweep that sees it starts one watch per job, which runs the
  // grace beside the sweep on the monotonic clock, looking every UNIT_CAP_LOOK_MS, and takes the job's lock only to
  // settle or stop. The .cap file notes the sighting, so a later sweep, or a restarted agent, still knows the log is
  // at the cap. `seenUsec`: when the look began that showed the unit running.
  #watchCap(id: string, view: UnitState, seenUsec: bigint): Promise<void> | null {
    if (this.#capWatches.has(id)) return null;
    this.#requestCap(id);
    const watch = this.#capUnit(id, view, seenUsec)
      .catch((e: unknown) => { this.#log?.error(`the cap watch for job ${id} failed; the next sweep looks again`, e); })
      .finally(() => { this.#capWatches.delete(id); this.#forget(id); });
    this.#capWatches.set(id, watch);
    return watch;
  }

  // Every settle drops what the supervisor keeps for the job once it is no longer open. The .cap and .cancel
  // files stay on disk for prune, like the log. Async: the store's terminal row is synced off the event loop
  // (job-store.ts), so a settle returns only once the outcome is durable.
  async #settle(id: string, event: FinishEvent): Promise<Result<NoticeHandoff, FinishProblem | "missing">> {
    let decided: Result<NoticeHandoff, FinishProblem | "missing">;
    try {
      decided = await this.#store.settle(id, event);
    } catch (e) {
      this.#forget(id);
      throw e;
    }
    // A settle that ended the job needs no read of the store to know it is over.
    this.#forget(id, decided.ok);
    return decided;
  }

  // What is kept per job goes once the job has ended, so it is bounded by the open jobs. `ended`: the caller knows the
  // job is over. Otherwise the store says; when it cannot be read nothing is dropped, and the next sweep's
  // reconcile judges the entry again.
  #forget(id: string, ended = false): void {
    if (!ended) {
      let open: boolean;
      try { open = this.#open(id) !== null; } catch { return; }
      if (open) return;
    }
    this.#capSights.delete(id);
    this.#signalledCancels.delete(id);
    this.#stoppingSights.delete(id);
  }

  // Every job the supervisor still holds state for is looked at again, so an entry whose forget could not read the
  // store does not outlive the job.
  #reconcile(): void {
    for (const id of new Set([...this.#capSights.keys(), ...this.#signalledCancels, ...this.#stoppingSights.keys()])) this.#forget(id);
  }

  // Each look checks the log and the unit's main process; only when that process is gone does it ask systemd how the
  // unit ended.
  async #capUnit(id: string, view: UnitState, seenUsec: bigint): Promise<void> {
    let sight = this.#capSights.get(id) ?? null;
    let seen = seenUsec;
    for (;;) {
      // A failed stat is not a size of 0. Skip this look: no sighting, and no stop.
      const size = this.#logSize(id);
      if (size !== null) {
        const step = capStep(sight, size, this.#store.logBytes, performance.now(), true);
        if (step.kind !== "grace") break;
        sight = step.sight;
        this.#capSights.set(id, sight);
      }
      await wait(UNIT_CAP_LOOK_MS);
      if (this.#closed || !this.#open(id)) return;
      if (view.mainPid > 0 && processAlive(view.mainPid)) continue;
      const lookedAt = monotonicUsec();
      const look = await showUnit(id, this.#toolEnv);
      if (this.#closed || look.kind === "absent") return;
      if (look.kind === "found" && !this.#unfinished(look.view)) {
        const ended = look.view;
        await this.#exclusive(id, () => (this.#closed ? undefined : this.#settleUnit(id, ended)));
        return;
      }
      if (look.kind === "found") seen = lookedAt;
    }
    await this.#exclusive(id, () => (this.#closed ? undefined : this.#stopForCap(id, seen)));
  }

  #logSize(id: string): number | null {
    try { return statSync(join(this.#store.dir, `${id}.log`)).size; } catch { return null; }
  }

  async #cancelUnit(id: string): Promise<Result<NoticeHandoff, SuperviseProblem>> {
    const job = this.#store.get(id);
    if (!job) return err("missing");
    if (job.outcome !== null) return this.#replay(job);
    if (job.state === "queued") return this.#settle(id, { outcome: "cancelled", exitCode: null, durationMs: 0 });
    const look = await showUnit(id, this.#toolEnv);
    if (look.kind === "unknown") return err("unavailable");
    const view = look.kind === "found" ? look.view : null;
    // A unit that is still stopping owes its end to this cancel too, so deactivating counts as not over.
    const live = view !== null && this.#unfinished(view);
    // A unit systemd is stopping for its RuntimeMaxSec timed out before this cancel: the cancel ends it, and the
    // timeout stays its end.
    const timedOut = view !== null && view.active === "deactivating" && view.result === "timeout";
    if (live) {
      // The mark goes first, before any signal or wait: an agent that restarts while this cancel waits, or a settle
      // that throws after the signals, still finds a cancel in flight. A cancel that sent no signal takes it back.
      const marked = !timedOut && !this.#signalled(id);
      if (!timedOut) this.#markCancel(id);
      const after = await this.#endLive(id);
      if (after === "unsignalled") {
        if (marked) this.#unmarkCancel(id);
        return err("unavailable");
      }
      if (after === "signalled") return err("signalled");
      const current = this.#store.get(id);
      if (!current) return err("missing");
      if (current.outcome !== null) return this.#replay(current);
      const durationMs = after.kind === "found" ? runMs(after.view, current.startedAt) : 0;
      const event: FinishEvent = timedOut ? { outcome: "timed_out", exitCode: null, durationMs } : { outcome: "cancelled", exitCode: null, durationMs };
      try {
        const decided = await this.#settle(id, event);
        if (!decided.ok) return (await this.#ended(id)) ?? err("signalled");
        try { await stopJobUnit(id, this.#toolEnv); } catch { /* the exit is already recorded */ }
        await resetJobUnit(id, this.#toolEnv);
        return ok(decided.value);
      } catch { return (await this.#ended(id)) ?? err("signalled"); }
    }
    if (!view) {
      try {
        const decided = await this.#settle(id, this.#unitEnd(id, job, null));
        return decided.ok ? ok(decided.value) : err("missing");
      } catch { return err("missing"); }
    }
    const event = this.#unitEnd(id, job, view);
    if (!event) return err("missing");
    if (job.state === "starting") {
      const started = this.#store.started(id);
      if (!started.ok) return err("missing");
    }
    try {
      const decided = await this.#settle(id, event);
      if (!decided.ok) return err("missing");
      try { await stopJobUnit(id, this.#toolEnv); } catch { /* the exit is already recorded */ }
      await resetJobUnit(id, this.#toolEnv);
      return ok(decided.value);
    } catch { return err("missing"); }
  }

  async #launch(id: string): Promise<void> {
    if (this.#slice) { await this.#launchUnit(id); return; }
    const pidPath = join(this.#store.dir, `${id}.pid`);
    if (existsSync(pidPath)) return;
    const specPath = join(this.#store.dir, `${id}.argv`);
    if (!existsSync(specPath)) return;
    const spawnedAt = Date.now();
    const helper: ChildProcess = spawn(this.#node, [helperFile], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: keptEnv(this.#env, id, ""),
    });
    let failed = false;
    const giveUp = () => {
      if (failed) return;
      failed = true;
      helper.stdin?.destroy();
      helper.unref();
      const job = this.#store.get(id);
      if (!job || job.state !== "starting") return;
      // The settle is awaited by no one (this runs from the helper's error events); its own failure is only the next
      // sweep's to retry.
      this.#settle(id, { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" })
        .catch(() => { /* the same event can be settled again */ });
    };
    helper.on("error", giveUp);
    helper.stdin?.on("error", giveUp);
    const spec = readFileSync(specPath, "utf8");
    helper.stdin?.end(spec);
    if (failed || helper.pid === undefined) { giveUp(); return; }
    writeFileSync(pidPath, String(helper.pid), { mode: 0o600 });
    chmodSync(pidPath, 0o600);
    writeProcessFile(`${pidPath}.at`, helper.pid, spawnedAt);
    helper.unref();
    this.#store.started(id);
  }

  async #launchUnit(id: string): Promise<void> {
    if (!this.#slice) return;
    const specPath = join(this.#store.dir, `${id}.argv`);
    if (!existsSync(specPath)) return;
    const existing = await showUnit(id, this.#toolEnv);
    if (existing.kind === "unknown") return;
    if (existing.kind === "found") {
      if (existing.view.active === "active" && existing.view.sub === "running") this.#store.started(id);
      return;
    }
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
    const unset = await this.#drops();
    if (unset === null) {
      const job = this.#store.get(id);
      if (!job || job.state !== "starting") return;
      try { await this.#settle(id, { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" }); } catch { /* retried */ }
      return;
    }
    try {
      writeFileSync(spec.logPath, "", { flag: "a", mode: 0o600 });
      chmodSync(spec.logPath, 0o600);
      await startJobUnit({
        id, slice: this.#slice, cwd: spec.cwd, command: spec.command, logPath: spec.logPath,
        env: spec.env, unset, timeoutMs: spec.timeoutMs,
      }, this.#toolEnv);
    } catch {
      try { await stopJobUnit(id, this.#toolEnv); } catch { /* a start that never created a unit has nothing to stop */ }
      await resetJobUnit(id, this.#toolEnv);
      const job = this.#store.get(id);
      if (!job || job.state !== "starting") return;
      try { await this.#settle(id, { outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" }); } catch { /* retried */ }
      return;
    }
    this.#store.started(id);
  }

  // One read for this supervisor. A failure is remembered: later starts refuse rather than inherit the manager environment.
  #drops(): Promise<string[] | null> {
    if (!this.#managerEnv) this.#managerEnv = managerEnv(this.#toolEnv).then(names => names, () => null);
    return this.#managerEnv;
  }

  #recordPending(id: string): boolean {
    try {
      const age = Date.now() - statSync(join(this.#store.dir, `${id}.pid`)).mtimeMs;
      return age < START_RECORD_GRACE_MS;
    } catch { return false; }
  }

  async #waitForRecord(id: string): Promise<void> {
    const path = join(this.#store.dir, `${id}.pid`);
    let age = START_RECORD_GRACE_MS;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { return; }
    if (age >= START_RECORD_GRACE_MS) return;
    await until(() => {
      const found = this.#recorded(id, "pid");
      if (!found || found.recorded.kind !== "none") return true;
      return !processAlive(found.pid);
    }, START_RECORD_GRACE_MS - age);
  }

  #recorded(id: string, kind: "pid" | "child"): { pid: number; recorded: Recorded } | null {
    const path = join(this.#store.dir, `${id}.${kind}`);
    if (!existsSync(path)) return null;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const atPath = `${path}.at`;
    const text = existsSync(atPath) ? readFileSync(atPath, "utf8") : null;
    return { pid, recorded: readRecorded(text) };
  }

  async #lost(id: string): Promise<NoticeHandoff | null> {
    try {
      const decided = await this.#settle(id, { outcome: "lost", at: Date.now() });
      return decided.ok ? decided.value : null;
    } catch { return null; }
  }

  async #takeExit(id: string): Promise<NoticeHandoff | null> {
    const path = join(this.#store.dir, `${id}.exit`);
    if (!existsSync(path)) return null;
    const job = this.#store.get(id);
    if (!job || job.outcome !== null) return null;
    let record: ExitRecord;
    try { record = JSON.parse(readFileSync(path, "utf8")) as ExitRecord; } catch { return this.#lost(id); }
    const event = recordEvent(record);
    if (!event) return this.#lost(id);
    const began = event.outcome === "exited" && event.error === "did_not_start";
    try {
      if (job.state === "starting" && !began) {
        const started = this.#store.started(id);
        if (!started.ok) return this.#lost(id);
      }
      const decided = await this.#settle(id, event);
      if (decided.ok) return decided.value;
    } catch { return null; }
    return this.#lost(id);
  }

  // The helper is gone and wrote nothing. Stop the command it recorded, then lost — unless this cancel's SIGTERM
  // was actually delivered, in which case the user did cancel it.
  async #awaitExit(id: string, found: { pid: number; recorded: Recorded } | null, delivered: boolean): Promise<NoticeHandoff | null> {
    const path = join(this.#store.dir, `${id}.exit`);
    const matched = found ? await sameProcess(found.pid, found.recorded) : false;
    const dead = () => !found || !matched || !processAlive(found.pid);
    await until(() => existsSync(path) || dead(), 5000);
    const taken = await this.#takeExit(id);
    if (taken) return taken;
    if (found !== null && dead() && !existsSync(path)) {
      await this.#stopChild(id);
      try {
        const decided = await (delivered
          ? this.#settle(id, { outcome: "cancelled", exitCode: null, durationMs: 0 })
          : this.#settle(id, { outcome: "lost", at: Date.now() }));
        return decided.ok ? decided.value : null;
      } catch { return null; }
    }
    return this.#takeExit(id);
  }

  #overCap(id: string): boolean {
    if (this.#store.watch(id) === "capped") return true;
    return existsSync(join(this.#store.dir, `${id}.cap`));
  }

  #live(view: UnitState): boolean {
    return view.active === "activating" || (view.active === "active" && view.sub === "running");
  }

  // A deactivating unit has not ended yet: its result is still owed, so a stop waits for it.
  #unfinished(view: UnitState): boolean {
    return this.#live(view) || view.active === "deactivating";
  }

  // The mark of a cancel that is signalling the unit (and may not confirm it): once in memory, once as an empty file
  // next to the log, so the next agent still knows (prune removes the file with the job).
  #markCancel(id: string): void {
    this.#signalledCancels.add(id);
    try { writeFileSync(join(this.#store.dir, `${id}.cancel`), "", { flag: "wx", mode: 0o600 }); }
    catch (e) {
      // EEXIST: already marked. Anything else leaves the mark in memory only, which an agent restart loses.
      if (errno(e) !== "EEXIST") this.#log?.error(`marking the cancel of job ${id} failed; an agent restart would lose it`, e);
    }
  }

  // A cancel that failed before it signalled anything leaves no mark: the unit ends on its own account.
  #unmarkCancel(id: string): void {
    this.#signalledCancels.delete(id);
    try { unlinkSync(join(this.#store.dir, `${id}.cancel`)); }
    catch (e) {
      if (errno(e) !== "ENOENT") this.#log?.error(`removing the cancel mark of job ${id} failed; its end would be recorded cancelled`, e);
    }
  }

  #signalled(id: string): boolean {
    return this.#signalledCancels.has(id) || existsSync(join(this.#store.dir, `${id}.cancel`));
  }

  // systemctl stop unloads a transient unit and forgets its timestamps. Kill leaves the unit loaded
  // so the run can be read, and a failed kill leaves the job open.
  async #endLive(id: string): Promise<UnitLook | "unsignalled" | "signalled"> {
    try { await killJobUnit(id, "SIGTERM", this.#toolEnv); }
    catch { return "unsignalled"; }
    let after = await showUnit(id, this.#toolEnv);
    if (after.kind === "unknown") return "signalled";
    // A unit systemd is already stopping (its timeout, a stop from outside) stays deactivating after the SIGTERM
    // until TimeoutStopSec, so it gets the SIGKILL too.
    if (after.kind === "found" && this.#unfinished(after.view)) {
      try { await killJobUnit(id, "SIGKILL", this.#toolEnv); }
      catch { return "signalled"; }
      after = await showUnit(id, this.#toolEnv);
      if (after.kind === "unknown") return "signalled";
    }
    // A unit can linger in deactivating after the signals: wait before the cancel is only "signalled".
    if (after.kind === "found" && this.#unfinished(after.view)) {
      let look: UnitLook = after;
      const over = await until(async () => {
        look = await showUnit(id, this.#toolEnv);
        return look.kind === "absent" || (look.kind === "found" && !this.#unfinished(look.view));
      }, UNIT_STOP_WAIT_MS);
      if (!over) return "signalled";
      after = look;
    }
    return after;
  }

  // Design §5: no code for a unit still running when the stop is sent. A main process that ended before it keeps its
  // own result: its exit code, or 128 plus the signal when someone else killed it.
  async #stopForCap(id: string, seenUsec: bigint): Promise<void> {
    if (!this.#open(id)) return;
    const sentUsec = monotonicUsec();
    const after = await this.#endLive(id);
    // The stop was in flight while this supervisor closed: the agent that replaces it owns the job now.
    if (this.#closed) return;
    if (after === "unsignalled" || after === "signalled" || after.kind !== "found") return;
    const job = this.#open(id);
    if (!job) return;
    if (job.state === "starting") {
      const started = this.#store.started(id);
      if (!started.ok) return;
    }
    const durationMs = runMs(after.view, job.startedAt);
    const own = endedBeforeStop(after.view.exitedUsec, sentUsec, seenUsec) ? exitOf(after.view, durationMs) : null;
    // The signalled cancel owns the end; otherwise the unit's own result from before the stop, or a plain exit.
    const cancelled = this.#signalled(id) ? this.#unitEnd(id, job, after.view) : null;
    const event = cancelled ?? own ?? { outcome: "exited" as const, exitCode: null, durationMs };
    try { await this.#settle(id, event); } catch { return; }
    try { await stopJobUnit(id, this.#toolEnv); } catch { /* the exit is already recorded */ }
    await resetJobUnit(id, this.#toolEnv);
  }

  #requestCap(id: string): void {
    const path = join(this.#store.dir, `${id}.cap`);
    try { writeFileSync(path, "", { flag: "wx", mode: 0o600 }); } catch { /* already requested */ }
  }

  async #stopChild(id: string, starts?: ReadonlyMap<number, ProcessStart | null>): Promise<void> {
    const child = this.#recorded(id, "child");
    if (!child || !(await sameProcess(child.pid, child.recorded, starts))) return;
    // SIGKILL leaves a zombie, and kill(pid, 0) still succeeds until it is reaped
    // (man 2 kill, read 2026-10-11). The helper waits for that; a sweep must too,
    // or it records the job lost while the command still answers.
    let group = true;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch {
      group = false;
      try { process.kill(child.pid, "SIGKILL"); } catch { return; }
    }
    const gone = (): boolean => {
      if (!group) return !processAlive(child.pid);
      try { process.kill(-child.pid, 0); return false; }
      catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    await until(gone, 1000);
  }

  // A settle that loses because the job already ended answers with that outcome, not an unknown signal.
  async #ended(id: string): Promise<Result<NoticeHandoff, SuperviseProblem> | null> {
    const stored = this.#store.get(id);
    if (!stored || stored.outcome === null) return null;
    return this.#replay(stored);
  }

  async #replay(job: Job): Promise<Result<NoticeHandoff, SuperviseProblem>> {
    const event = eventOf(job);
    if (!event) return err("missing");
    return this.#settle(job.id, event);
  }
}
