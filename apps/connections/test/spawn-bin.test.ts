// The one place a CLI binary is started for a read (review of the Codex runtime, point 10): a script runs through this Node, a
// child leads a group of its own, the group is stopped with SIGTERM and then SIGKILL, and a missing binary is told truthfully.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { binCommand, notStartedProblem, stopGroup } from "../src/adapters/spawn-bin.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("spawn-bin", () => {
  it("runs a script through this Node and anything else as it is", () => {
    expect(binCommand("/x/codex.mjs", ["a"])).toEqual({ command: process.execPath, argv: ["/x/codex.mjs", "a"] });
    expect(binCommand("/x/codex.js", [])).toEqual({ command: process.execPath, argv: ["/x/codex.js"] });
    expect(binCommand("codex", ["a"])).toEqual({ command: "codex", argv: ["a"] });
  });

  it("says what is missing: PATH for a bare name, the file or its interpreter for an absolute path", () => {
    const enoent = Object.assign(new Error("x"), { code: "ENOENT" });
    expect(notStartedProblem(enoent, "codex")).toBe("codex is not on PATH");
    expect(notStartedProblem(enoent, "/opt/codex/bin/codex")).toBe("/opt/codex/bin/codex could not be started: it is missing, or its interpreter is not on PATH");
    expect(notStartedProblem(new Error("x"), "codex")).toBe("codex could not be started");
  });

  it("stops a group that ignores SIGTERM with SIGKILL, before it returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-spawn-bin-"));
    dirs.push(dir);
    const file = join(dir, "deaf.mjs");
    writeFileSync(file, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("up\\n");');
    const child = spawn(process.execPath, [file], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise(resolve => child.stdout.once("data", resolve));
    const pid = child.pid ?? 0;
    const started = Date.now();
    await stopGroup(pid, 300);
    expect(alive(pid) && !child.killed && child.exitCode === null && child.signalCode === null ? "running" : "stopped").toBe("stopped");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});
