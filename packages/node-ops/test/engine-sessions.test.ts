// The engine layer's lane registry (ADR-0030) on files shaped like test/fixtures/engine-lane: which live engine lane runs in
// which pane (its process inside the pane's), under which stable id, and where its transcript is.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combineSessions, engineSessionRegistry, sessionRegistry } from "../src/index.ts";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/engine-lane/session-file.json"), "utf8")) as Record<string, unknown>;
const BOOT = recorded.bootId as string;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-engines-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (file: string, over: Record<string, unknown> = {}) => writeFileSync(join(dir, file), JSON.stringify({ ...recorded, ...over }));
// The lane (pid 4242) runs under a wrapper (4100), under the pane's process (4000); 1 is the root.
const TREE = new Map([[4242, 4100], [4100, 4000], [4000, 1], [4300, 4000]]);
const io = (o: { alive?: (pid: number) => boolean; ticks?: (pid: number) => { ticks: number; bootId: string } | null } = {}) => ({
  parentOf: (pid: number) => TREE.get(pid) ?? null,
  alive: o.alive ?? (() => true),
  identity: o.ticks ?? ((pid: number) => (pid === 4242 ? { ticks: 5500, bootId: BOOT } : null)),
});
const PANES = new Map([["%3", 4000], ["%9", 9000]]);

describe("engine session registry", () => {
  it("finds a live lane in the pane whose process holds it, from a recorded session file", () => {
    put("4242.json");
    expect(engineSessionRegistry(dir, io()).byPane(PANES).get("%3")).toEqual({
      sessionId: "engine-4242-5500", name: "demo-lane", pane: "%3", cwd: "/work/demo", version: null, pid: 4242, status: "idle", engine: "codex",
    });
  });

  it("keeps one id for the lane while its file's sessionId changes under it (the engine names a session, /clear)", () => {
    const ids = ["0b1c2d3e-0000-4000-8000-000000000001", "9f8e7d6c-0000-4000-8000-000000000002", "0b1c2d3e-0000-4000-8000-000000000001"].map(sessionId => {
      put("4242.json", { sessionId });
      return engineSessionRegistry(dir, io()).byPane(PANES).get("%3")?.sessionId;
    });
    expect(new Set(ids)).toEqual(new Set(["engine-4242-5500"]));
  });

  it("ignores a lane in no known pane, a dead process, and a pid another process took after a reboot (negative control)", () => {
    put("4242.json");
    expect(engineSessionRegistry(dir, io()).byPane(new Map([["%9", 9000]])).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ alive: () => false })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ ticks: () => ({ ticks: 77, bootId: BOOT }) })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ ticks: () => ({ ticks: 5500, bootId: "another-boot" }) })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(1);
  });

  it("takes a file without an identity on liveness alone, and a process whose identity can't be read", () => {
    put("4242.json", { pidStartTicks: undefined, bootId: undefined });
    expect(engineSessionRegistry(dir, io()).byPane(PANES).get("%3")?.sessionId).toBe("engine-4242-1791859999000");
    put("4242.json");
    expect(engineSessionRegistry(dir, io({ ticks: () => null })).byPane(PANES).has("%3")).toBe(true);
  });

  it("reads busy and idle; any other status, or none, is null", () => {
    for (const [status, kept] of [["busy", "busy"], ["idle", "idle"], ["thinking", null], [7, null], [undefined, null]] as const) {
      put("4242.json", { status });
      expect(engineSessionRegistry(dir, io()).byPane(PANES).get("%3")?.status, String(status)).toBe(kept);
    }
  });

  it("takes the newest of two lanes in one pane, and survives files that are not lanes", () => {
    put("4242.json", { updatedAt: 10 });
    put("4300.json", { pid: 4300, updatedAt: 20, name: "newer", pidStartTicks: 6000 });
    writeFileSync(join(dir, "junk.json"), "not json");
    writeFileSync(join(dir, "null.json"), "null");
    writeFileSync(join(dir, "notes.txt"), "x");
    const reg = engineSessionRegistry(dir, io({ ticks: () => null }));
    expect(reg.byPane(PANES).get("%3")?.name).toBe("newer");
  });

  it("finds the lane's transcript by its id, also before the pane map is asked", () => {
    put("4242.json");
    const reg = engineSessionRegistry(dir, io());
    expect(reg.transcriptPath("engine-4242-5500")).toBe(recorded.transcript);
    expect(reg.transcriptPath("engine-1-1")).toBeNull();
    expect(reg.transcriptPath("0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8")).toBeNull();
  });

  it("has nothing for a directory that is missing", () => {
    const reg = engineSessionRegistry(join(dir, "absent"), io());
    expect(reg.byPane(PANES).size).toBe(0);
    expect(reg.transcriptPath("engine-4242-5500")).toBeNull();
  });
});

describe("combined sessions", () => {
  it("adds the engine lanes to Claude Code's sessions; a pane Claude Code holds stays Claude Code's", () => {
    mkdirSync(join(dir, "claude", "sessions"), { recursive: true });
    mkdirSync(join(dir, "engines"));
    writeFileSync(join(dir, "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-claude", tmux: "qa:@0.%9", cwd: "/tmp/demo", updatedAt: 1 }));
    writeFileSync(join(dir, "engines", "4242.json"), JSON.stringify(recorded));
    const both = combineSessions(sessionRegistry(join(dir, "claude")), engineSessionRegistry(join(dir, "engines"), io()), () => new Map([...PANES, ["%3", 4000]]));
    expect([...both.byPane().keys()].sort()).toEqual(["%3", "%9"]);
    expect(both.byPane().get("%9")?.sessionId).toBe("s-claude");
    expect(both.byPane().get("%3")?.engine).toBe("codex");
    expect(both.transcriptPath("engine-4242-5500")).toBe(recorded.transcript);
    expect(both.transcriptPath("nope")).toBeNull();
  });

  it("a pane Claude Code holds is not an engine lane even when a lane's process is inside it", () => {
    mkdirSync(join(dir, "claude", "sessions"), { recursive: true });
    mkdirSync(join(dir, "engines"));
    writeFileSync(join(dir, "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-claude", tmux: "qa:@0.%3", cwd: "/tmp/demo", updatedAt: 1 }));
    writeFileSync(join(dir, "engines", "4242.json"), JSON.stringify(recorded));
    const both = combineSessions(sessionRegistry(join(dir, "claude")), engineSessionRegistry(join(dir, "engines"), io()), () => PANES);
    expect(both.byPane().get("%3")?.sessionId).toBe("s-claude");
  });
});
