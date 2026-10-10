// The harness itself (test/fleet-harness.ts), which Tasks 17, 18 and 20 build on: isolated tmux servers and temporary
// HOMEs only.
// - cleanEnv drops every CLAUDE* variable: these tests run inside a Claude Code session.
// - stopAll leaves no socket file behind for a tmux server it started (Task 17 runs it after each test).
// - a fleet whose child exits at once rejects within seconds, with the child's log, not after the 15 s wait.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv, startFleet, stopAll, tmuxServer } from "../fleet-harness.ts";
import type { FleetConfig } from "../../apps/fleet/src/config.ts";

afterEach(stopAll);

describe("the harness", () => {
  it("cleanEnv drops CLAUDECODE and every CLAUDE_* variable, and keeps the rest", () => {
    const set = { CLAUDECODE: "1", CLAUDE_CODE_X: "x", CLAUDE_CONFIG_DIR: "/somewhere", CLAUDE_OTHER: "y", KEEP_ME: "yes" };
    const before = Object.fromEntries(Object.keys(set).map(k => [k, process.env[k]]));
    Object.assign(process.env, set);
    try {
      const env = cleanEnv("/tmp/some-home");
      expect(Object.keys(env).filter(k => k.startsWith("CLAUDE"))).toEqual([]);
      expect(env).toMatchObject({ HOME: "/tmp/some-home", KEEP_ME: "yes" });
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("stopAll kills a tmux server it started and removes its socket file", async () => {
    const t = tmuxServer();
    t.run("new-session", "-d", "-s", "qa", "sleep", "60");
    const file = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, t.socket);
    expect(existsSync(file)).toBe(true);
    await stopAll();
    expect(existsSync(file)).toBe(false);
  });

  it("stopAll also stops a server recreated on a socket whose first server was killed through its handle", async () => {
    const t = tmuxServer();
    t.run("new-session", "-d", "-s", "first", "sleep", "60");
    const file = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, t.socket);
    t.kill();                                                          // as the tmux-restart drill does
    expect(t.has("first")).toBe(false);
    t.run("new-session", "-d", "-s", "second", "sleep", "60");         // a new server on the same socket
    expect(t.has("second")).toBe(true);
    expect(existsSync(file)).toBe(true);
    await stopAll();
    expect(t.has("second")).toBe(false);                               // nothing answers on the socket
    expect(existsSync(file)).toBe(false);
  });

  it("startFleet rejects at once, with the log, when the fleet exits during startup", async () => {
    const bad = [{ name: "BAD NAME", url: "x", paths: [] }] as unknown as FleetConfig["subscribers"];
    const start = performance.now();
    await expect(startFleet({ subscribers: bad })).rejects.toThrow(/the fleet exited during startup/);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
