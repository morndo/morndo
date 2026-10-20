// The real bins with their output on a pipe (T-91). Node writes to a pipe asynchronously on POSIX, so a bin that ends in
// process.exit() right after writing loses whatever the pipe had not taken yet: 64 KiB of a longer answer reached the
// reader and the JSON was cut (https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-20).
// A made-up hub on a real port answers with more than 64 KiB; the bin runs as a child with stdout a pipe, and the reader
// takes nothing for a moment, as a busy consumer would, so a bin that exits at once is cut every time.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PIPE_LIMIT = 64 * 1024;
let hub: Server;
let base = "";
beforeEach(async () => {
  const tasks = Array.from({ length: 4000 }, (_, i) => ({
    key: `T-${i + 1}`, title: `Task ${i + 1} ${"x".repeat(200)}`, description: "d".repeat(100), status: "todo", assignee: "builder", priority: "normal", blockedReason: null, rev: 1,
  }));
  const requests = Array.from({ length: 4000 }, (_, i) => ({ id: `D-${i + 1}`, version: 1, status: "open", topic: `Topic ${i + 1} ${"y".repeat(200)}`, draftedBy: null }));
  hub = createServer((req, res) => {
    const body = req.url?.startsWith("/api/agent/decisions") ? { requests } : { tasks, lanes: [] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise(resolve => hub.close(resolve)); });

function runBin(main: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_HUB: base, MORNDO_AGENT_TOKEN: "made-up-token", MORNDO_LANE: "builder" };
  delete env.TMUX;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", join(import.meta.dirname, "../src", main), ...args], { env, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let reading = false;
    const drain = () => { for (let c; reading && (c = child.stdout.read() as Buffer | null) !== null;) chunks.push(c); };
    child.stdout.on("readable", drain);
    setTimeout(() => { reading = true; drain(); }, 300);
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

describe("output longer than a pipe takes at once", () => {
  it("morndo-board list --json arrives whole", async () => {
    const { code, stdout } = await runBin("main.ts", ["list", "--json"]);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(PIPE_LIMIT);
    expect(JSON.parse(stdout)).toHaveLength(4000);
  });
  it("morndo-decide list --json arrives whole", async () => {
    const { code, stdout } = await runBin("decide-main.ts", ["list", "--json"]);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(PIPE_LIMIT);
    expect(JSON.parse(stdout)).toHaveLength(4000);
  });
});
