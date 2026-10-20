// How the CLIs end (T-91): process.exit() right after a write cuts what a pipe has not taken yet, a plain exit code waits for
// every live handle, and a reader that closes the pipe early turns the next write into an unhandled EPIPE
// (https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-20). exitAfterOutput leaves
// once stdout and stderr hold what was written; quietBrokenPipe keeps a closed pipe from being an error.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "exit-after-output.fixture.ts");
const strays: number[] = [];
afterEach(() => { for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* it already ended */ } } });

function run(mode: string, closeAfterFirstRead = false) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--no-warnings", FIXTURE, mode], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.stdout.on("data", (c: Buffer) => { out.push(c); if (closeAfterFirstRead) child.stdout.destroy(); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ms: Date.now() - started }));
  });
}

describe("exitAfterOutput", () => {
  it("leaves with its code once the output is out, though a grandchild keeps a pipe open", async () => {
    const r = await run("lingering");
    const pid = /grandchild (\d+)/.exec(r.stdout)?.[1];
    if (pid) strays.push(Number(pid));
    expect(r.stdout).toContain("output\n");
    expect(r.code).toBe(7);
    expect(r.ms).toBeLessThan(5000);
  });
  it("delivers all of a long answer", async () => {
    const r = await run("big");
    expect(r.code).toBe(3);
    expect(r.stdout.length).toBe(4 * 1024 * 1024 + 1);
  });
});

describe("quietBrokenPipe: a gone terminal and a full disk", () => {
  it("treats EIO, which a closed terminal gives, like a closed pipe: the bin ends with its own code and no error text", async () => {
    const r = await run("eio");
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 5, stderr: "" });
  });
  it("keeps ENOSPC loud", async () => {
    const r = await run("enospc");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ENOSPC");
  });
});

describe("quietBrokenPipe", () => {
  it("lets a bin end with its own code and no error text when the reader closes the pipe early", async () => {
    const r = await run("big", true);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 3, stderr: "" });
  });
});
