// MORNDO_REPO (B11): a local Morndo checkout the board reads merge ancestry from, kept current by the operator. Unset
// or empty: none, and every ancestry answer is unknown (a merge in morndo/morndo holds done until the nodes carry it).
// A relative path is refused by `serve` alone (git -C would read it against wherever the service started), in one
// sentence with exit 78; reading the settings never throws for it, so the console commands still work (as
// MORNDO_FLEET_SOCKET, Task 14c review).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, morndoRepoOk } from "../src/config.ts";

let dir: string | null = null;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

describe("MORNDO_REPO", () => {
  it("unset or empty: no checkout, every ancestry answer unknown", () => {
    expect(loadConfig({}).morndoRepo).toBeNull();
    expect(loadConfig({ MORNDO_REPO: "" }).morndoRepo).toBeNull();
  });
  it("set: a checkout's path, an absolute path", () => {
    expect(loadConfig({ MORNDO_REPO: "/srv/checkouts/morndo" }).morndoRepo).toBe("/srv/checkouts/morndo");
    expect(morndoRepoOk("/srv/checkouts/morndo")).toBe(true);
  });
  it("a relative path is read as it is, and judged not usable, never guessed at", () => {
    expect(loadConfig({ MORNDO_REPO: "morndo" }).morndoRepo).toBe("morndo");   // reading never throws for it
    for (const relative of ["morndo", "./morndo", "src/morndo", "~/morndo"]) expect(morndoRepoOk(relative), relative).toBe(false);
  });
  it("serve refuses a relative path in one sentence with exit 78, and the console commands still work", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-repo-"));
    const main = join(import.meta.dirname, "../src/main.ts");
    // Port 0: were serve ever to get past the check, it would listen on a free port, never the hub's own.
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_TMUX_SOCKET: "morndo-test-none", MORNDO_REPO: "morndo" };
    delete env.MORNDO_PUSH_CONTACT;
    const serve = spawnSync(process.execPath, ["--no-warnings", main, "serve"], { env, encoding: "utf8", timeout: 20_000 });
    expect(serve.status, serve.stderr).toBe(78);                                       // EX_CONFIG: a setting to fix, not a restart
    expect(serve.stderr).toMatch(/MORNDO_REPO must be an absolute path.*"morndo"/s);
    expect(serve.stderr).not.toMatch(/\n\s+at /);                                     // a message, not a stack trace
    const devices = spawnSync(process.execPath, ["--no-warnings", main, "devices"], { env, encoding: "utf8", timeout: 20_000 });
    expect(devices.status, devices.stderr).toBe(0);
    const audit = spawnSync(process.execPath, ["--no-warnings", main, "audit"], { env, encoding: "utf8", timeout: 20_000 });
    expect(audit.status, audit.stderr).toBe(0);
  });
});
