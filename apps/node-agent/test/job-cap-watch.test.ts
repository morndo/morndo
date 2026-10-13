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

const fault = vi.hoisted(() => ({ left: 0, suffix: "" }));
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = ((path: import("node:fs").PathLike, opts?: import("node:fs").StatSyncOptions) => {
    if (fault.left > 0 && String(path).endsWith(fault.suffix) && new Error().stack?.includes("#logSize")) {
      fault.left -= 1;
      throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
    }
    return opts === undefined ? real.statSync(path) : real.statSync(path, opts);
  }) as typeof real.statSync;
  return { ...real, statSync };
});

const open: { adb: AgentDb; cleanup: () => void; sup: JobSupervisor }[] = [];
afterEach(() => {
  fault.left = 0;
  fault.suffix = "";
  for (const row of open) { row.sup.close(); row.adb.close(); row.cleanup(); }
  open.length = 0;
});

const running = `printf '%s\\n' LoadState=loaded ActiveState=active SubState=running Result=success ExecMainCode=0 ExecMainStatus=0 MainPID=1 RemainAfterExit=yes ExecMainStartTimestampMonotonic=1 ExecMainExitTimestampMonotonic=0`;

describe("the systemd cap watch", () => {
  it("a stat that throws once does not sight the log at 0 or stop the unit", async () => {
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
    const store = new JobStore(adb.db, dir, () => Date.now(), { home: h.home, logBytes: 8 });
    const paths = agentPaths(h.home);
    const sup = new JobSupervisor(store, {
      home: h.home, stateDir: paths.stateDir, socketPath: paths.jobSock,
      systemd: { slice: "morndofake.slice", toolEnv: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } },
    });
    open.push({ adb, cleanup: h.cleanup, sup });
    const id = `j${randomBytes(4).toString("hex")}`;
    const hash = "ab".repeat(16);
    const accepted = store.accept({
      id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, commandHash: hash, cwdHash: hash,
    });
    if (!accepted.ok) throw new Error(accepted.error);
    store.applySchedule({ default: 1 }, "off");
    const started = store.started(id);
    if (!started.ok) throw new Error(started.error);
    writeFileSync(join(dir, `${id}.log`), "0123456789abcdef");
    fault.left = 1;
    fault.suffix = `${id}.log`;
    const sweeping = sup.sweep();
    try {
      expect(await until(() => fault.left === 0, 2000)).toBe(true);
      await wait(250);
      expect(existsSync(join(h.home, "killed"))).toBe(false);
      expect(store.get(id)).toMatchObject({ state: "running", outcome: null });
    } finally {
      sup.close();
      await sweeping;
    }
  });
});
