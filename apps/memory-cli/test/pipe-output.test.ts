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

describe("output longer than a pipe takes at once", () => {
  it("morndo-memory search --json arrives whole", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HUB: base, MORNDO_AGENT_TOKEN: "made-up-token", MORNDO_LANE: "builder" };
    delete env.TMUX;
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "../src/main.ts"), "search", "x", "--scope", "repo:demo", "--json"], { env, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let reading = false;
      const drain = () => { for (let c; reading && (c = child.stdout.read() as Buffer | null) !== null;) chunks.push(c); };
      child.stdout.on("readable", drain);
      setTimeout(() => { reading = true; drain(); }, 300);
      child.once("error", reject);
      child.once("close", c => resolve({ code: c, stdout: Buffer.concat(chunks).toString("utf8") }));
    });
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(stdout).notes).toHaveLength(4000);
  });
});
