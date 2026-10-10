// MORNDO_FLEET_SOCKET (spec §10): set, the hub's ports go through the fleet service's client socket; unset, the legacy
// local adapters, exactly as before. A relative path is refused by `serve` alone (ws names the socket by its absolute
// path), in one sentence with exit 78; reading the settings never throws for it, so the console commands (devices,
// revoke, audit, pair) still work to put it right (Task 14c review).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fleetSocketOk, loadConfig } from "../src/config.ts";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe("MORNDO_FLEET_SOCKET", () => {
  it("unset or empty: no fleet, the legacy local adapters", () => {
    expect(loadConfig({}).fleetSocket).toBeNull();
    expect(loadConfig({ MORNDO_FLEET_SOCKET: "" }).fleetSocket).toBeNull();
  });
  it("set: the fleet's client socket, an absolute path", () => {
    expect(loadConfig({ MORNDO_FLEET_SOCKET: "/home/o/.local/state/morndo-fleet/fleet.sock" }).fleetSocket).toBe("/home/o/.local/state/morndo-fleet/fleet.sock");
    expect(fleetSocketOk("/home/o/.local/state/morndo-fleet/fleet.sock")).toBe(true);
  });
  it("a relative path is read as it is, and judged not usable, never guessed at", () => {
    expect(loadConfig({ MORNDO_FLEET_SOCKET: "fleet.sock" }).fleetSocket).toBe("fleet.sock");   // reading never throws for it
    for (const relative of ["fleet.sock", "./fleet.sock", "state/fleet.sock", "~/fleet.sock"]) expect(fleetSocketOk(relative), relative).toBe(false);
  });
  it("serve refuses a relative path in one sentence with exit 78, and the console commands still work", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-fleet-socket-"));
    const main = join(import.meta.dirname, "../src/main.ts");
    // Port 0: were serve ever to get past the check, it would listen on a free port, never the hub's own.
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_TMUX_SOCKET: "morndo-test-none", MORNDO_FLEET_SOCKET: "fleet.sock" };
    delete env.MORNDO_PUSH_CONTACT;
    const serve = spawnSync(process.execPath, ["--no-warnings", main, "serve"], { env, encoding: "utf8", timeout: 20_000 });
    expect(serve.status, serve.stderr).toBe(78);                                       // EX_CONFIG: a setting to fix, not a restart
    expect(serve.stderr).toMatch(/MORNDO_FLEET_SOCKET must be an absolute path.*"fleet\.sock"/s);
    expect(serve.stderr).not.toMatch(/\n\s+at /);                                     // a message, not a stack trace
    const devices = spawnSync(process.execPath, ["--no-warnings", main, "devices"], { env, encoding: "utf8", timeout: 20_000 });
    expect(devices.status, devices.stderr).toBe(0);
    const audit = spawnSync(process.execPath, ["--no-warnings", main, "audit"], { env, encoding: "utf8", timeout: 20_000 });
    expect(audit.status, audit.stderr).toBe(0);
  });
});
