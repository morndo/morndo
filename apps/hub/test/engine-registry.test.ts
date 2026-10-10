// The engine-lane registry: one JSON file per process, read on every poll. No `lanes` process, no cache.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processAlive } from "@morndo/node-ops";
import { engineLanesFor, engineRegistry } from "../src/adapters/engine-registry.ts";
import { log } from "../src/adapters/log.ts";
import { engineSessionsOk, loadConfig } from "../src/config.ts";

const LIVE = { ticks: 1, bootId: "boot" };
const row = (over: Record<string, unknown> = {}) => JSON.stringify({
  pid: 4242, name: "cur-x", status: "busy", engine: "cursor", model: "m",
  pidStartTicks: 1, bootId: "boot", pidStartedAt: 1, startedAt: 1, updatedAt: 1, ...over,
});

function io(map: Record<string, string>, o: { failDir?: () => boolean } = {}) {
  return {
    readDir: async () => {
      if (o.failDir?.()) throw new Error("ENOENT: no such directory");
      return Object.keys(map);
    },
    readFile: async (path: string) => {
      const base = path.split("/").pop() ?? "";
      const text = map[base];
      if (text === undefined) throw new Error("ENOENT");
      if (text === "UNREADABLE") throw new Error("EACCES");
      return text;
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("engine registry", () => {
  it("reads busy and idle, and skips a dead pid, bad JSON, a wrong shape and an unreadable file", async () => {
    const map = {
      "4242.json": row({}),
      "7.json": row({ pid: 7, name: "done", status: "idle" }),
      "9.json": row({ pid: 9, name: "gone", status: "busy" }),
      "3.json": row({ pid: 3, name: "held", status: "busy" }),
      "bad.json": "{",
      "shape.json": row({ pid: 8, name: "", status: "busy" }),
      "other.json": row({ pid: 11, name: "sh", status: "shell" }),
      "noengine.json": row({ pid: 12, name: "plain", engine: "" }),
      "locked.json": "UNREADABLE",
      "notes.txt": "not a registry file",
    };
    const list = engineRegistry("/reg", {
      ...io(map),
      alive: pid => pid === 3 || pid !== 9,
      identity: () => LIVE,
    });
    const got = await list();
    expect(got.map(r => r.name).sort()).toEqual(["cur-x", "done", "held"]);
    expect(got.find(r => r.name === "cur-x")).toEqual({ name: "cur-x", status: "busy", engine: "cursor" });
    expect(got.find(r => r.name === "done")?.status).toBe("idle");
    expect(got.find(r => r.name === "held")?.status).toBe("busy");
  });

  it("a missing directory is empty, warned once, and a recovery is logged once", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    let missing = true;
    const map = { "4242.json": row({}) };
    const list = engineRegistry("/reg", { ...io(map, { failDir: () => missing }), alive: () => true, identity: () => LIVE });
    for (let i = 0; i < 10; i++) expect(await list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    missing = false;
    expect(await list()).toHaveLength(1);
    expect(await list()).toHaveLength(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a read that fails is not served, including a busy report from the poll before", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    let n = 0;
    const map = { "4242.json": row({}) };
    const list = engineRegistry("/reg", {
      ...io(map, { failDir: () => n++ > 0 }),
      alive: () => true,
      identity: () => LIVE,
    });
    expect(await list()).toHaveLength(1);
    expect(await list()).toEqual([]);
    expect(await list()).toEqual([]);
  });

  it("does not re-export the pid check", async () => {
    const registry = await import("../src/adapters/engine-registry.ts");
    expect(registry).not.toHaveProperty("pidAlive");
  });

  it("this process counts as alive, and pid 0 is never signalled", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-1)).toBe(false);
  });

  // A file is live when the process answers, the file name's pid is the body's, and pidStartTicks plus bootId
  // are exactly the live process. startedAt, pidStartedAt and updatedAt are not gates: the writer has no heartbeat.
  it("a file 30 minutes old still counts when the pid is alive and its start tick and boot id match", async () => {
    const start = 1_700_000_000_000;
    const map = {
      "7.json": row({ pid: 7, name: "cur-x", status: "busy", pidStartedAt: start + 10 * 60_000, startedAt: start - 60_000, updatedAt: start - 30 * 60 * 1000 }),
    };
    const list = engineRegistry("/reg", { ...io(map), alive: () => true, identity: () => LIVE });
    expect((await list()).map(r => r.name)).toEqual(["cur-x"]);
  });

  it("a reused pid, whose start tick or boot id is not the file's, does not count", async () => {
    const map = {
      "7.json": row({ pid: 7, name: "cur-x", status: "busy", pidStartTicks: 100, bootId: "boot" }),
    };
    const offTick = engineRegistry("/reg", { ...io(map), alive: () => true, identity: () => ({ ticks: 101, bootId: "boot" }) });
    expect(await offTick()).toEqual([]);
    const offBoot = engineRegistry("/reg", { ...io(map), alive: () => true, identity: () => ({ ticks: 100, bootId: "other" }) });
    expect(await offBoot()).toEqual([]);
  });

  it("skips a file whose pid does not match its name, and keeps one whose updatedAt is old when the start tick matches", async () => {
    const now = 1_700_000_000_000;
    const map = {
      "4242.json": row({ pid: 9999, name: "reused", pidStartedAt: now, startedAt: now, updatedAt: now }),
      "7.json": row({ pid: 7, name: "stale", pidStartedAt: now, startedAt: now, updatedAt: now - 11 * 60 * 1000 }),
      "8.json": row({ pid: 8, name: "live", status: "idle", pidStartedAt: now, startedAt: now, updatedAt: now }),
    };
    const list = engineRegistry("/reg", { ...io(map), alive: () => true, identity: () => LIVE });
    expect((await list()).map(r => r.name).sort()).toEqual(["live", "stale"]);
  });

  it("does not read a file whose pid is dead", async () => {
    const reads: string[] = [];
    const map: Record<string, string> = {
      "7.json": row({ pid: 7, name: "cur-x", status: "busy", startedAt: 1 }),
      "9.json": row({ pid: 9, name: "gone", status: "busy", startedAt: 1 }),
    };
    const list = engineRegistry("/reg", {
      readDir: async () => Object.keys(map),
      readFile: async (path) => {
        reads.push(path);
        const base = path.split("/").pop() ?? "";
        return map[base] ?? "";
      },
      alive: pid => pid !== 9,
      identity: () => LIVE,
    });
    expect((await list()).map(r => r.name)).toEqual(["cur-x"]);
    expect(reads.some(p => p.endsWith("9.json"))).toBe(false);
    expect(reads.some(p => p.endsWith("7.json"))).toBe(true);
  });

  it("reads the files of one poll together, not one after another", async () => {
    const map: Record<string, string> = { "1.json": row({ pid: 1, name: "a" }), "2.json": row({ pid: 2, name: "b" }) };
    let pending = 0;
    let max = 0;
    const list = engineRegistry("/reg", {
      readDir: async () => Object.keys(map),
      readFile: async (path) => {
        pending += 1;
        max = Math.max(max, pending);
        await new Promise(r => setTimeout(r, 40));
        pending -= 1;
        const base = path.split("/").pop() ?? "";
        return map[base] ?? "";
      },
      alive: () => true,
      identity: () => LIVE,
    });
    await list();
    expect(max).toBe(2);
  });
});

describe("sample registry files", () => {
  const dir = join(import.meta.dirname, "fixtures/engine-registry");
  const files = ["10001.json", "10002.json", "10003.json"];
  const BOOT = "11111111-2222-3333-4444-555555555555";
  type Fixture = {
    pid: number; name: string; status: "busy" | "idle"; engine: string; startedAt: number;
    pidStartedAt?: number; pidStartTicks?: number; bootId?: string;
  };
  const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Fixture;
  const listOf = async (body: Fixture, live: { ticks: number; bootId: string }) => {
    const list = engineRegistry("/reg", {
      readDir: async () => [`${body.pid}.json`],
      readFile: async () => JSON.stringify(body),
      alive: () => true,
      identity: () => live,
    });
    return list();
  };

  it("an old file without pidStartTicks and bootId does not govern", async () => {
    for (const name of files) {
      const body = load(name);
      expect(body).not.toHaveProperty("pidStartTicks");
      expect(body).not.toHaveProperty("bootId");
      // pidStartedAt equal to the wall clock would have governed under the previous reader.
      const got = await listOf({ ...body, pidStartedAt: body.startedAt }, { ticks: 100, bootId: BOOT });
      expect(got).toEqual([]);
    }
  });

  it("a file governs when pidStartTicks and bootId match the live process exactly", async () => {
    const body = load("10001.json");
    const got = await listOf({
      ...body, pidStartTicks: 5000, bootId: BOOT, pidStartedAt: body.startedAt + 10 * 60_000,
    }, { ticks: 5000, bootId: BOOT });
    expect(got).toEqual([{ name: body.name, status: "busy", engine: body.engine }]);
  });

  it("a reused pid does not govern when the start tick or the boot id differs", async () => {
    const body = load("10002.json");
    const stamped = { ...body, pidStartTicks: 100, bootId: BOOT, pidStartedAt: body.startedAt };
    expect(await listOf(stamped, { ticks: 101, bootId: BOOT })).toEqual([]);
    expect(await listOf(stamped, { ticks: 100, bootId: "other-boot" })).toEqual([]);
  });
});

describe("MORNDO_ENGINE_SESSIONS", () => {
  it("is off when unset, empty, 0 or off, and a path otherwise", () => {
    expect(loadConfig({}).engineSessions).toBeNull();
    expect(loadConfig({ MORNDO_ENGINE_SESSIONS: "" }).engineSessions).toBeNull();
    expect(loadConfig({ MORNDO_ENGINE_SESSIONS: "0" }).engineSessions).toBeNull();
    expect(loadConfig({ MORNDO_ENGINE_SESSIONS: "off" }).engineSessions).toBeNull();
    expect(loadConfig({ MORNDO_ENGINE_SESSIONS: "/var/engines/sessions" }).engineSessions).toBe("/var/engines/sessions");
    expect(engineSessionsOk("/var/engines/sessions")).toBe(true);
    for (const relative of ["engine", "./engine", "var/engines", "~/engines"]) expect(engineSessionsOk(relative), relative).toBe(false);
    expect(loadConfig({}).engineNode).toBeNull();
    expect(loadConfig({ MORNDO_ENGINE_NODE: "pc" }).engineNode).toBe("pc");
  });

  it("stays off on a fleet when MORNDO_ENGINE_NODE is unset", () => {
    const off = engineLanesFor({ engineSessions: "/reg", engineNode: null, fleetSocket: "/run/fleet.sock" });
    expect(off.lanes).toBeNull();
    expect(off.notice).toMatch(/MORNDO_ENGINE_NODE/);
    const legacy = engineLanesFor({ engineSessions: "/reg", engineNode: null, fleetSocket: null });
    expect(legacy.lanes).not.toBeNull();
    expect(legacy.notice).toBeNull();
    const named = engineLanesFor({ engineSessions: "/reg", engineNode: "pc", fleetSocket: "/run/fleet.sock" });
    expect(named.lanes).not.toBeNull();
    expect(named.engineNode).toBe("pc");
    expect(named.notice).toBeNull();
    expect(engineLanesFor({ engineSessions: null, engineNode: null, fleetSocket: "/run/fleet.sock" })).toEqual({ lanes: null, engineNode: null, notice: null });
  });

  it("serve refuses a relative path in one sentence with exit 78, and the console commands still work", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engine-sessions-"));
    const main = join(import.meta.dirname, "../src/main.ts");
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_TMUX_SOCKET: "morndo-test-none", MORNDO_ENGINE_SESSIONS: "engine" };
    delete env.MORNDO_PUSH_CONTACT;
    delete env.MORNDO_FLEET_SOCKET;
    try {
      const serve = spawnSync(process.execPath, ["--no-warnings", main, "serve"], { env, encoding: "utf8", timeout: 20_000 });
      expect(serve.status, serve.stderr).toBe(78);
      expect(serve.stderr).toMatch(/MORNDO_ENGINE_SESSIONS must be an absolute path.*"engine"/s);
      expect(serve.stderr).not.toMatch(/\n\s+at /);
      const devices = spawnSync(process.execPath, ["--no-warnings", main, "devices"], { env, encoding: "utf8", timeout: 20_000 });
      expect(devices.status, devices.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
