// `morndo serve` stopped by SIGTERM or SIGINT at any moment of its start (before it logs "morndo hub on") removes the
// fleet files staging dir it made and exits 0, as it does when stopped while serving. The real hub as a child process on
// port 0, a temporary home and its own TMPDIR, against the fake fleet on a real Unix socket. Never the owner's hub, fleet
// or ports.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const staged = (scratch: string) => readdirSync(scratch).filter(n => n.startsWith("morndo-fleet-files-"));
let dir: string;
let scratch: string;                                    // the hub's TMPDIR, so nothing else's dirs are counted
let fleet: FakeFleet;
let child: ChildProcess | null = null;
let out = "";
let release: Array<() => void> = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-startup-signal-"));
  scratch = join(dir, "tmp");
  mkdirSync(scratch);
  out = "";
  release = [];
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))], stickyLanes: ["manager"] });
});
afterEach(async () => {
  for (const r of release) r();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(r => child?.once("exit", r)); }
  child = null;
  await fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

function start() {
  const e: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_FLEET_SOCKET: fleet.socketPath, MORNDO_POLL_MS: "200", TMPDIR: scratch };
  delete e.MORNDO_PUSH_CONTACT;
  delete e.MORNDO_MANAGER_QUEUE;
  const c = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  c.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  child = c;
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => c.once("exit", (code, signal) => resolve({ code, signal })));
}

// Every op the first look sends to the node waits until the test ends.
function holdFirstLook() {
  const gate = new Promise<void>(resolve => release.push(resolve));
  for (const op of ["inventory.get", "pane.captureMany"]) fleet.intercept(op, async (_call, next) => { await gate; return next(); });
}

describe("morndo serve stopped while it starts", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    for (const afterMs of [0, 30, 120, 400]) {
      it(`${signal} ${afterMs} ms after the staging dir exists: no dir left, exit 0, nothing said of a crash`, async () => {
        holdFirstLook();
        const exited = start();
        await until(() => staged(scratch).length > 0 || out.includes("morndo hub on"), 20_000);
        await new Promise(r => setTimeout(r, afterMs));
        expect(out, "the hub must still be starting").not.toContain("morndo hub on");
        child?.kill(signal);
        const end = await exited;
        expect(end, out).toEqual({ code: 0, signal: null });
        expect(staged(scratch), out).toEqual([]);
        expect(out).not.toMatch(/uncaught exception|unhandled promise rejection/);
      });
    }
  }

  it("SIGTERM during the first look, with the hub's socket already listening", async () => {
    holdFirstLook();
    const exited = start();
    await until(() => fleet.calls.length > 0, 20_000);
    expect(existsSync(scratch)).toBe(true);
    expect(out).not.toContain("morndo hub on");
    child?.kill("SIGTERM");
    const end = await exited;
    expect(end, out).toEqual({ code: 0, signal: null });
    expect(staged(scratch), out).toEqual([]);
  });

  it("negative control: stopped while serving, the same dir is removed too", async () => {
    const exited = start();
    await until(() => out.includes("morndo hub on"), 20_000);
    expect(staged(scratch)).toHaveLength(1);
    child?.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(staged(scratch)).toEqual([]);
  });
});
