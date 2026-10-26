// Process-level handlers (ADR-0008, A5): an unhandled rejection or an uncaught exception is logged through the hub's
// logger (redacted, with its cause chain), then the process exits 1 so the service manager restarts it.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "crash-handlers.fixture.ts");
const run = (how: string, extra = "") => spawnSync(process.execPath, ["--no-warnings", FIXTURE, how, extra], { encoding: "utf8", timeout: 20_000 });

describe("the hub's process-level crash handlers", () => {
  it("log an unhandled rejection through the logger, with its cause, then exit 1", () => {
    const r = run("rejection");
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/still running/);
    expect(r.stderr).toMatch(/\[hub\] error: unhandled promise rejection/);
    expect(r.stderr).toMatch(/Error: boom in ~\/somewhere\/x\.ts/);       // the home directory redacted
    expect(r.stderr).toMatch(/Caused by: Error: root cause/);
  });
  it("log an uncaught exception through the logger, then exit 1", () => {
    const r = run("exception");
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/still running/);
    expect(r.stderr).toMatch(/\[hub\] error: uncaught exception/);
    expect(r.stderr).toMatch(/TypeError: thrown in ~\/somewhere\/x\.ts/);
  });
  it("run the hub's close first when one is set (a start that fails), then exit 1", () => {
    const r = run("rejection", "cleanup");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("cleaned");
    expect(r.stderr).toMatch(/unhandled promise rejection/);
  });
  it("do not wait for a close that never ends: exit 1 after its bound", () => {
    const r = run("exception", "hang");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncaught exception/);
  });
  it("run no close once the hub serves (beforeExit(null)): a crash then exits 1 at once", () => {
    const r = run("rejection", "done");
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("cleaned");
  });
});
