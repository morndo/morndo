// A cancel that signalled a unit but could not confirm it (T-86, review range a8150bc..d28c388). However the unit
// ends afterwards, by a second cancel, a sweep, the cap watch or after an agent restart, the job's outcome is
// "cancelled", not an exit code, "lost" or "exited". A fake systemctl answers each case, so no real unit is touched.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { JobSupervisor } from "../src/ops/job-supervisor.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome, until } from "./helpers.ts";

const running = "printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0";
const deactivating = "printf '%s\\n' LoadState=loaded ActiveState=deactivating SubState=stop-sigterm Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0";
const ended = (code: number, status: number) => `printf '%s\\n' LoadState=loaded ActiveState=inactive SubState=dead Result=exit-code ExecMainCode=${code} ExecMainStatus=${status} MainPID=0 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=9000000000000000`;
const absent = "printf '%s\\n' LoadState=not-found";
const SIGTERMED = ended(2, 15);

type Rig = { store: JobStore; sup: JobSupervisor; home: string; dir: string };
const rigs: { adb: AgentDb | null; cleanup: () => void; sup: JobSupervisor }[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) { r.sup.close(); r.adb?.close(); r.cleanup(); }
});

function tools(root: string, systemctl: string, systemdRun = "#!/bin/sh\nexit 0\n"): NodeJS.ProcessEnv {
  const bin = join(root, "fake-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, text] of [["systemctl", systemctl], ["systemd-run", systemdRun]] as const) {
    writeFileSync(join(bin, name), text, { mode: 0o755 });
    chmodSync(join(bin, name), 0o755);
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

// `script(home)` is the fake `systemctl --user <verb> ...` ($2 is the verb); its marker files live in `home`.
function rig(script: (home: string) => string, over: { logBytes?: number; limits?: Record<string, number>; systemdRun?: (home: string) => string; log?: { error: (message: string, error?: unknown) => void } } = {}): Rig {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  mkdirSync(dir, { recursive: true });
  const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, ...(over.logBytes ? { logBytes: over.logBytes } : {}) });
  const paths = agentPaths(h.home);
  const sup = new JobSupervisor(store, {
    home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
    ...(over.limits ? { limits: over.limits } : {}),
    systemd: { slice: "morndofake.slice", toolEnv: tools(h.home, script(h.home), over.systemdRun?.(h.home)) },
    log: over.log ?? { error: () => {} },
  });
  rigs.push({ adb, cleanup: h.cleanup, sup });
  return { store, sup, home: h.home, dir };
}

// A second supervisor on the same store and files, as after an agent restart, with a systemctl of its own.
function restarted(r: Rig, script: (home: string) => string): JobSupervisor {
  const paths = agentPaths(r.home);
  const root = join(r.home, "second");
  mkdirSync(root);
  const sup = new JobSupervisor(r.store, {
    home: r.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
    systemd: { slice: "morndofake.slice", toolEnv: tools(root, script(r.home)) },
  });
  rigs.push({ adb: null, cleanup() {}, sup });
  return sup;
}

const hash = "ab".repeat(16);
function accept(store: JobStore, id: string): void {
  const accepted = store.accept({ id, lane: "builder", name: "pack", jobClass: "default", notify: { kind: "lane", name: "builder" }, commandHash: hash, cwdHash: hash });
  if (!accepted.ok) throw new Error(accepted.error);
}
// A job that is running.
function plant(store: JobStore, id: string): void {
  accept(store, id);
  store.applySchedule({ default: 5 }, "off");
  const started = store.started(id);
  if (!started.ok) throw new Error(started.error);
}

// The unit shows running until it is killed. The first looks after the kill fail (the signal went out, the unit cannot
// be read); once `allowed` exists a look answers `after(home)`.
const killedThenUnreadable = (after: (home: string) => string) => (home: string) => `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${join(home, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then
  if [ ! -f '${join(home, "killed")}' ]; then ${running}; exit 0; fi
  if [ ! -f '${join(home, "allowed")}' ]; then exit 1; fi
  ${after(home)}
fi
exit 0
`;
const allow = (home: string) => writeFileSync(join(home, "allowed"), "");

describe("a signalled cancel ends cancelled on every path", () => {
  it("a second cancel that finds the unit ended records cancelled, not the signal's exit code", async () => {
    const { store, sup, home } = rig(killedThenUnreadable(() => SIGTERMED));
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    allow(home);
    expect((await sup.cancel("j1")).ok).toBe(true);
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
    expect(sup.trackedJobs()).toBe(0);
  });

  it("a second cancel that finds the unit gone records cancelled, not lost", async () => {
    const { store, sup, home } = rig(killedThenUnreadable(() => absent));
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    allow(home);
    expect((await sup.cancel("j1")).ok).toBe(true);
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
    expect(sup.trackedJobs()).toBe(0);
  });

  it("a sweep that finds the unit gone records cancelled, not lost", async () => {
    const { store, sup, home } = rig(killedThenUnreadable(() => absent));
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    allow(home);
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
    expect(sup.trackedJobs()).toBe(0);
  });

  it("a sweep leaves a unit that is still deactivating open, and ends it cancelled once it is over", async () => {
    const { store, sup, home } = rig(killedThenUnreadable(h => `if [ -f '${join(h, "over")}' ]; then ${SIGTERMED}; else ${deactivating}; fi`));
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    allow(home);
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ state: "running", outcome: null });
    writeFileSync(join(home, "over"), "");
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
  });

  it("a cancel whose unit is still deactivating after the signals is signalled, not settled yet", async () => {
    const { store, sup } = rig(home => `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${join(home, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then if [ -f '${join(home, "killed")}' ]; then ${deactivating}; else ${running}; fi; fi
exit 0
`);
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    expect(store.get("j1")).toMatchObject({ state: "running", outcome: null });
  });

  it("a signalled cancel survives an agent restart: the next agent ends the job cancelled", async () => {
    const first = rig(killedThenUnreadable(() => SIGTERMED));
    plant(first.store, "j1");
    expect(await first.sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    expect(existsSync(join(first.dir, "j1.cancel"))).toBe(true);
    first.sup.close();
    const next = restarted(first, () => `#!/bin/sh\nif [ "$2" = "show" ]; then ${SIGTERMED}; fi\nexit 0\n`);
    await next.sweep();
    expect(first.store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
  });

  it("the cap watch of a restarted agent ends a job whose cancel was signalled as cancelled", async () => {
    const { store, sup, dir } = rig(home => `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${join(home, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then if [ -f '${join(home, "killed")}' ]; then ${SIGTERMED}; else ${running}; fi; fi
exit 0
`, { logBytes: 8 });
    plant(store, "j1");
    writeFileSync(join(dir, "j1.log"), "0123456789abcdef");
    // What the agent that sent the signal left behind (the marker a signalled cancel writes next to the log).
    writeFileSync(join(dir, "j1.cancel"), "", { mode: 0o600 });
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
  });
});

describe("what a job holds while it is open is gone when it ends", () => {
  it("a capped job that a later sweep finds ended on its own leaves nothing behind", async () => {
    const { store, sup, dir, home } = rig(h => `#!/bin/sh
if [ "$2" = "kill" ]; then exit 1; fi
if [ "$2" = "show" ]; then if [ -f '${join(h, "over")}' ]; then ${ended(1, 0)}; else ${running}; fi; fi
exit 0
`, { logBytes: 8 });
    plant(store, "j1");
    writeFileSync(join(dir, "j1.log"), "0123456789abcdef");
    // The watch's stop is refused, so it ends undecided and keeps its sighting for the next watch.
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ state: "running", outcome: null });
    expect(sup.trackedJobs()).toBe(1);
    writeFileSync(join(home, "over"), "");
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ outcome: "exited", exitCode: 0 });
    expect(sup.trackedJobs()).toBe(0);
  });
});

describe("a closed supervisor stops acting inside the cap stop", () => {
  it("does not settle the job when it was closed while the stop was in flight", async () => {
    const { store, sup, dir, home } = rig(h => `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${join(h, "killing")}'; sleep 0.6; touch '${join(h, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then if [ -f '${join(h, "killed")}' ]; then ${SIGTERMED}; else ${running}; fi; fi
exit 0
`, { logBytes: 8 });
    plant(store, "j1");
    writeFileSync(join(dir, "j1.log"), "0123456789abcdef");
    const sweeping = sup.sweep();
    expect(await until(() => existsSync(join(home, "killing")), 8000)).toBe(true);
    sup.close();
    await sweeping;
    expect(store.get("j1")).toMatchObject({ state: "running", outcome: null });
  });
});

describe("a slot freed by a job that did not start goes to the next queued job", () => {
  it("starts the next queued job when the one promoted before it fails to start", async () => {
    const { store, sup, home, dir } = rig(h => `#!/bin/sh
unit=""; for a in "$@"; do unit="$a"; done
if [ "$2" = "show-environment" ]; then printf '%s\\n' PATH=/usr/bin; exit 0; fi
if [ "$2" = "kill" ]; then touch '${join(h, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then
  case "$unit" in
    *morndo-job-jA.service) if [ -f '${join(h, "killed")}' ]; then ${SIGTERMED}; else ${running}; fi;;
    *) ${absent};;
  esac
fi
exit 0
`, { limits: { default: 1 }, systemdRun: () => `#!/bin/sh\ncase "$*" in *morndo-job-jB*) exit 1;; esac\nexit 0\n` });
    plant(store, "jA");
    for (const id of ["jB", "jC"]) {
      accept(store, id);
      writeFileSync(join(dir, `${id}.argv`), JSON.stringify({
        command: ["true"], cwd: home, logPath: join(dir, `${id}.log`), exitPath: join(dir, `${id}.exit`),
        childPath: join(dir, `${id}.child`), timeoutMs: null, logBytes: 1000, env: {},
      }), { mode: 0o600 });
    }
    expect(store.get("jB")?.state).toBe("queued");
    expect((await sup.cancel("jA")).ok).toBe(true);
    expect(store.get("jB")).toMatchObject({ outcome: "exited", error: "did_not_start" });
    expect(store.get("jC")?.state).toBe("running");
  });
});

// A unit systemd is already stopping (its RuntimeMaxSec, or a stop from outside) stays deactivating after a SIGTERM until
// TimeoutStopSec; a SIGKILL ends it at once, and Result=timeout is already set while it stops (systemd 255, observed
// 2026-10-26 with a transient unit that ignores SIGTERM).
const stoppingFor = (result: string) => `printf '%s\\n' LoadState=loaded ActiveState=deactivating SubState=stop-sigterm Result=${result} ExecMainCode=0 ExecMainStatus=0 MainPID=0 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0`;
const failedBy = (result: string, status: number) => `printf '%s\\n' LoadState=loaded ActiveState=failed SubState=failed Result=${result} ExecMainCode=2 ExecMainStatus=${status} MainPID=0 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=9000000000000000`;
const runningNoPid = "printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=0 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0";
// The unit shows `before` until it is signalled, `onTerm` after a SIGTERM and `onKill` after a SIGKILL.
const signals = (before: string, onTerm: string, onKill: string) => (home: string) => `#!/bin/sh
case "$*" in *--signal=SIGKILL*) touch '${join(home, "sigkill")}';; *--signal=SIGTERM*) touch '${join(home, "sigterm")}';; esac
if [ "$2" = "show" ]; then
  if [ -f '${join(home, "sigkill")}' ]; then ${onKill}
  elif [ -f '${join(home, "sigterm")}' ]; then ${onTerm}
  else ${before}; fi
fi
exit 0
`;

describe("a unit systemd is already stopping", () => {
  it("a cancel sends SIGKILL to a unit still deactivating after its SIGTERM and ends the job cancelled", async () => {
    const { store, sup, home } = rig(signals(stoppingFor("success"), stoppingFor("success"), failedBy("signal", 9)));
    plant(store, "j1");
    expect((await sup.cancel("j1")).ok).toBe(true);
    expect(existsSync(join(home, "sigkill"))).toBe(true);
    expect(store.get("j1")).toMatchObject({ outcome: "cancelled", exitCode: null });
    expect(sup.trackedJobs()).toBe(0);
  });

  it("a cancel of a unit stopping for its timeout keeps timed_out", async () => {
    const { store, sup, dir } = rig(signals(stoppingFor("timeout"), failedBy("timeout", 15), failedBy("timeout", 9)));
    plant(store, "j1");
    expect((await sup.cancel("j1")).ok).toBe(true);
    expect(store.get("j1")).toMatchObject({ outcome: "timed_out", exitCode: null });
    expect(existsSync(join(dir, "j1.cancel"))).toBe(false);
  });

  it("a signalled cancel of a unit stopping for its timeout leaves the end to systemd: timed_out", async () => {
    // Neither signal ends it within the wait; systemd's own SIGKILL does, later.
    const { store, sup, home, dir } = rig(h => `#!/bin/sh
if [ "$2" = "show" ]; then if [ -f '${join(h, "over")}' ]; then ${failedBy("timeout", 9)}; else ${stoppingFor("timeout")}; fi; fi
exit 0
`);
    plant(store, "j1");
    expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    expect(existsSync(join(dir, "j1.cancel"))).toBe(false);
    writeFileSync(join(home, "over"), "");
    await sup.sweep();
    expect(store.get("j1")).toMatchObject({ outcome: "timed_out", exitCode: null });
  });

  it("the cap stop sends SIGKILL to a unit still deactivating after its SIGTERM and records no exit code", async () => {
    const { store, sup, dir, home } = rig(signals(runningNoPid, stoppingFor("success"), failedBy("signal", 9)), { logBytes: 8 });
    plant(store, "j1");
    writeFileSync(join(dir, "j1.log"), "0123456789abcdef");
    await sup.sweep();
    expect(existsSync(join(home, "sigkill"))).toBe(true);
    expect(store.get("j1")).toMatchObject({ outcome: "exited", exitCode: null });
  });
});

describe("a cancel mark that cannot be written", () => {
  it("is logged, so losing it to an agent restart is not silent", async () => {
    const logged: string[] = [];
    const { store, sup, dir } = rig(killedThenUnreadable(() => SIGTERMED), { log: { error: (message: string) => { logged.push(message); } } });
    plant(store, "j1");
    chmodSync(dir, 0o500);
    try {
      expect(await sup.cancel("j1")).toEqual({ ok: false, error: "signalled" });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(existsSync(join(dir, "j1.cancel"))).toBe(false);
    expect(logged.some(m => m.includes("j1"))).toBe(true);
  });
});
