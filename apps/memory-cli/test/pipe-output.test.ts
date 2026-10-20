// morndo-memory with its output on a pipe (T-91): the real bin as a child, against a made-up hub that answers a search
// with more than 64 KiB. A bin that exits right after writing loses what a pipe (asynchronous on POSIX) had not taken yet
// (https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-20). The reader takes
// nothing for a moment, as a busy consumer would, so a bin that exits at once is cut every time.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let hub: Server;
let base = "";
beforeEach(async () => {
  const notes = Array.from({ length: 4000 }, (_, i) => ({ id: `N-${i + 1}`, title: `Note ${i + 1} ${"x".repeat(200)}` }));
  hub = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ notes })); });
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise(resolve => hub.close(resolve)); });

// `closeAfterFirstRead`: the reader takes one chunk and closes the pipe, as `| head -c 100` does.
function search(closeAfterFirstRead: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HUB: base, MORNDO_AGENT_TOKEN: "made-up-token", MORNDO_LANE: "builder" };
  delete env.TMUX;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "../src/main.ts"), "search", "x", "--scope", "repo:demo", "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => errors.push(c));
    let reading = false;
    const drain = () => {
      for (let c; reading && (c = child.stdout.read() as Buffer | null) !== null;) {
        chunks.push(c);
        if (closeAfterFirstRead) { child.stdout.destroy(); return; }
      }
    };
    child.stdout.on("readable", drain);
    setTimeout(() => { reading = true; drain(); }, 300);
    child.once("error", reject);
    child.once("close", c => resolve({ code: c, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") }));
  });
}

describe("output longer than a pipe takes at once", () => {
  it("morndo-memory search --json arrives whole", async () => {
    const { code, stdout } = await search(false);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(stdout).notes).toHaveLength(4000);
  });
  it("morndo-memory ends quietly with its own code when the reader closes the pipe early", async () => {
    const { code, stderr } = await search(true);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  });
});
