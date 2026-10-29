// A failed stat in the systemd cap watch is not a size of 0. node:fs is wrapped so one look can throw (an ESM
// namespace cannot be spied on).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobSupervisor } from "../src/ops/job-supervisor.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome, until, wait } from "./helpers.ts";

const fault = vi.hoisted(() => ({ left: 0, suffix: "", capBeforeSize: [] as boolean[] }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = ((path: import("node:fs").PathLike, opts?: import("node:fs").StatSyncOptions) => {
    // What the cap watch's every look at a log finds beside it: the .cap note, which must be there before the size is read.
    if (String(path).endsWith(".log") && new Error().stack?.includes("#logSize")) fault.capBeforeSize.push(real.existsSync(String(path).replace(/\.log$/, ".cap")));
    if (fault.left > 0 && String(path).endsWith(fault.suffix) && new Error().stack?.includes("#logSize")) {
      fault.left -= 1;
      throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    }
    return opts === undefined ? real.statSync(path) : real.statSync(path, opts);
  }) as typeof real.statSync;
  return { ...real, statSync };
});

const open: { adb: AgentDb; cleanup: () => void; sup: JobSupervisor }[] = [];
const later: JobSupervisor[] = [];   // supervisors of restarted agents
afterEach(() => {
  fault.left = 0;
  fault.suffix = "";
  fault.capBeforeSize.length = 0;
  for (const sup of later.splice(0)) sup.close();
  for (const row of open) { row.sup.close(); row.adb.close(); row.cleanup(); }
  open.length = 0;
});

const running = `printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0`;

// A supervisor over fake systemctl and systemd-run: every unit "runs" (main pid 1), and a kill leaves a file.
function rig(logBytes: number) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const dir = join(h.home, "job-logs");
  mkdirSync(dir, { recursive: true });
  const bin = join(h.home, "fake-bin");
  mkdirSync(bin);
  const systemctl = `#!/bin/sh
if [ "$2" = "kill" ]; then touch '${join(h.home, "killed")}'; exit 0; fi
if [ "$2" = "show" ]; then ${running}; fi
exit 0
`;
  writeFileSync(join(bin, "systemctl"), systemctl, { mode: 0o755 });
  writeFileSync(join(bin, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "systemd-run"), 0o755);
  const paths = agentPaths(h.home);
  // An agent over the same database and folder: a restart is a new store (its own cap) and a new supervisor.
  const agent = (cap: number) => {
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, logBytes: cap });
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    });
    later.push(sup);
    return { store, sup };
  };
  const first = agent(logBytes);
  open.push({ adb, cleanup: h.cleanup, sup: first.sup });
  return { h, adb, dir, store: first.store, sup: first.sup, agent, killed: join(h.home, "killed") };
}

// A job the store holds as running, with a log of 16 bytes.
async function runningJob(store: JobStore, dir: string): Promise<string> {
  const id = `j${randomBytes(4).toString("hex")}`;
  const hash = "ab".repeat(16);
  const accepted = store.accept({
    id, lane: "builder", name: "pack", jobClass: "default",
    notify: { kind: "lane", name: "builder" }, commandHash: hash, cwdHash: hash,
  });
  if (!accepted.ok) throw new Error(accepted.error);
  await store.applySchedule({ default: 1 }, "off");
  const started = store.started(id);
  if (!started.ok) throw new Error(started.error);
  writeFileSync(join(dir, `${id}.log`), "0123456789abcdef");
  return id;
}

describe("the systemd cap watch", () => {
  it("a stat that throws once does not sight the log at 0 or stop the unit", async () => {
    const { dir, store, sup, killed } = rig(8);
    const id = await runningJob(store, dir);
    fault.left = 1;
    fault.suffix = `${id}.log`;
    const sweeping = sup.sweep();
    try {
      expect(await until(() => fault.left === 0, 2000)).toBe(true);
      await wait(250);
      expect(existsSync(killed)).toBe(false);
      expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    } finally {
      sup.close();
      await sweeping;
    }
  });

  it("the .cap note is written before the watch looks at the log size (the helper's lookCap reads the note first for the same reason)", async () => {
    const { dir, store, sup } = rig(8);
    const id = await runningJob(store, dir);
    const sweeping = sup.sweep();
    try {
      expect(await until(() => fault.capBeforeSize.length > 0, 2000)).toBe(true);
      expect(fault.capBeforeSize[0]).toBe(true);
      expect(existsSync(join(dir, `${id}.cap`))).toBe(true);
    } finally {
      sup.close();
      await sweeping;
    }
  });

  // A job started under one cap, the agent restarted with another: a systemd job has no helper holding the old cap, so the
  // supervisor's cap of the running agent decides, in both directions (the helper path keeps the start-time cap in its spec).
  it.each([
    { name: "a larger cap leaves a log under it running", cap: 1_000_000, stopped: false },
    { name: "a cap the log is over stops the unit", cap: 8, stopped: true },
    // The note is the sighting: once the old agent wrote it, the log was at the cap and its bytes past it were already refused,
    // so the new agent stops the unit although its own cap is larger (the helper path does the same with a note on disk).
    { name: "a cap noted before the restart still stops the unit under a larger cap", cap: 1_000_000, stopped: true, noted: true },
  ])("after a restart, $name", async ({ cap, stopped, noted }) => {
    const { dir, store, sup, agent, killed } = rig(8);
    const id = await runningJob(store, dir);
    if (noted) writeFileSync(join(dir, `${id}.cap`), "");
    sup.close();
    const next = agent(cap);
    try {
      void next.sup.sweep();
      if (stopped) {
        expect(await until(() => existsSync(killed), 6000)).toBe(true);
      } else {
        await wait(1800);                                                  // past the 1 s grace a cap would have run
        expect(existsSync(killed)).toBe(false);
        expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
      }
    } finally {
      next.sup.close();
    }
  });
});
