// morndo job (ADR-0017, design §2, §12 step 5). A reused id with a different command is id_conflict:
// exit 1, one line on stderr, and nothing new is started.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callNode, runJob, type NodeRequest, type NodeResult } from "../src/job-cli.ts";

const TOKEN = "mat_secret-token";
const env = { MORNDO_HUB: "http://hub.test", MORNDO_AGENT_TOKEN: TOKEN, MORNDO_LANE: "builder", HOME: "/tmp/morndo-home" };

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const jobs = new Map<string, { command: string; job: { id: string; state: string } }>();
  let launches = 0;
  const nodeCalls: unknown[] = [];
  const io = {
    cwd: "/tmp/work",
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    node: async (msg: NodeRequest): Promise<NodeResult> => {
      nodeCalls.push(msg);
      if (msg.op !== "start") return { ok: false, error: "bad_command" };
      const command = msg.command.join("\0");
      const prior = jobs.get(msg.id);
      if (prior && prior.command !== command) return { ok: false, error: "id_conflict" };
      if (prior) return { ok: true, job: prior.job };
      launches += 1;
      const job = { id: msg.id ?? "", state: "running" };
      if (msg.id) jobs.set(msg.id, { command, job });
      return { ok: true, job };
    },
  };
  return { out, err, nodeCalls, launches: () => launches, io };
}

describe("id_conflict", () => {
  it("returns the existing job for the same command and refuses a different one without starting it", async () => {
    const h = harness();
    const first = ["start", "--notify", "lane:builder", "--id", "job-1", "--", "echo", "a"];
    expect(await runJob(first, env, h.io)).toBe(0);
    expect(await runJob(first, env, h.io)).toBe(0);
    expect(await runJob(["start", "--notify", "lane:builder", "--id", "job-1", "--", "echo", "b"], env, h.io)).toBe(1);
    expect(h.launches()).toBe(1);
    expect(h.nodeCalls).toHaveLength(3);
    expect(h.err).toEqual(["id_conflict: this id already belongs to a different job; nothing was started"]);
    expect(h.nodeCalls[0]).toMatchObject({ op: "start", token: TOKEN });
    expect(JSON.stringify(h.nodeCalls)).not.toContain("revoke");
    expect(h.out.filter(line => line.includes("job-1"))).toHaveLength(2);
  });
});

describe("exit codes", () => {
  const start = ["start", "--notify", "lane:builder", "--id", "job-9", "--", "echo", "a"];

  async function run(opts: {
    argv?: string[];
    node?: (msg: NodeRequest) => Promise<NodeResult>;
  }) {
    const err: string[] = [];
    const out: string[] = [];
    let nodeCalls = 0;
    const code = await runJob(opts.argv ?? start, env, {
      cwd: "/tmp/work",
      out: line => out.push(line),
      err: line => err.push(line),
      node: async msg => {
        nodeCalls += 1;
        if (opts.node) return opts.node(msg);
        if (msg.op === "list") return { ok: true, jobs: [{ id: "job-9", state: "running" }] };
        if (msg.op === "show") return { ok: true, job: { id: msg.id, state: "running", text: "job-9 running" } };
        if (msg.op === "logs") return { ok: true, text: "line" };
        if (msg.op === "cancel") return { ok: true, job: { id: msg.id, state: "cancelled" } };
        return { ok: true, job: { id: "job-9", state: "running" } };
      },
    });
    return { code, err, out, nodeCalls };
  }

  it("prints a view for 0, refuses for 1, and rejects usage for 2", async () => {
    expect((await run({ argv: ["list"] })).code).toBe(0);
    expect((await run({ argv: ["show", "job-9"] })).out.join("\n")).toContain("job-9");
    for (const error of ["denied", "disk", "disabled", "bad_class", "not_yours"]) {
      const r = await run({ node: async () => ({ ok: false, error }) });
      expect(r.code, error).toBe(1);
      expect(r.err, error).toHaveLength(1);
    }
    expect((await run({ argv: ["start", "echo"] })).code).toBe(2);
    expect((await run({ argv: ["nope"] })).code).toBe(2);
    expect((await run({ argv: ["show"] })).code).toBe(2);
    const lines: NodeRequest[] = [];
    const logged = await run({
      argv: ["logs", "--lines", "50", "job:abc"],
      node: async msg => { lines.push(msg); return { ok: true, text: "tail" }; },
    });
    expect(logged.code).toBe(0);
    expect(lines[0]).toMatchObject({ op: "logs", id: "job:abc", lines: 50, token: TOKEN });
    const after = await run({
      argv: ["logs", "job:abc", "--lines", "50"],
      node: async msg => msg.op === "logs" && msg.id === "job:abc" ? { ok: true, text: "tail" } : { ok: false, error: "missing" },
    });
    expect(after.code).toBe(0);
  });

  it("exits 3 when the node cannot be reached, and 4 when the hub refuses or the cache misses", async () => {
    const down = await run({ node: async () => { throw new Error("down"); } });
    expect(down.code).toBe(3);
    expect(down.nodeCalls).toBe(1);
    const revoked = await run({
      node: async msg => {
        expect(msg.op).toBe("start");
        if (msg.op === "start") expect(msg.token).toBe(TOKEN);
        return { ok: false, error: "hub" };
      },
    });
    expect(revoked.code).toBe(4);
    expect(revoked.nodeCalls).toBe(1);
    const otherLane = await run({
      node: async msg => {
        expect(msg.op).toBe("start");
        return { ok: false, error: "not_yours" };
      },
    });
    expect(otherLane.code).toBe(1);
    expect(otherLane.nodeCalls).toBe(1);
    expect(otherLane.err[0]).toContain("not this lane");
    const offline = await run({
      node: async msg => {
        expect(msg.op).toBe("start");
        if (msg.op === "start") expect(msg.token).toBe(TOKEN);
        return { ok: false, error: "no_cache" };
      },
    });
    expect(offline.code).toBe(4);
    expect(offline.nodeCalls).toBe(1);
    expect(offline.err[0]).toContain("24 hours");
    const unconfigured = await run({ node: async () => ({ ok: false, error: "no_hub" }) });
    expect(unconfigured.code).toBe(4);
    expect(unconfigured.err[0]).toContain("no hub address");
  });

  it("sends the token to the node once and does not grant it itself", async () => {
    const ops: NodeRequest[] = [];
    const started = await run({
      node: async msg => {
        ops.push(msg);
        return { ok: true, job: { id: "job-9", state: "running" } };
      },
    });
    expect(started.code).toBe(0);
    expect(started.nodeCalls).toBe(1);
    expect(ops).toEqual([expect.objectContaining({ op: "start", token: TOKEN })]);
  });
});

describe("the socket", () => {
  it("rejects when the node closes without a line, and when it never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-job-sock-"));
    const closedPath = join(dir, "closed.sock");
    const quiet = createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => {
      quiet.once("error", reject);
      quiet.listen(closedPath, () => resolve());
    });
    await expect(callNode(closedPath, { op: "list", lane: "builder", token: TOKEN }, 1000)).rejects.toThrow("closed");
    quiet.close();

    const hungPath = join(dir, "hung.sock");
    const hung = createServer(socket => { socket.on("data", () => {}); });
    await new Promise<void>((resolve, reject) => {
      hung.once("error", reject);
      hung.listen(hungPath, () => resolve());
    });
    const started = performance.now();
    await expect(callNode(hungPath, { op: "list", lane: "builder", token: TOKEN }, 200)).rejects.toThrow("timeout");
    expect(performance.now() - started).toBeLessThan(1000);
    hung.close();
  });

  it("rejects when the node answers with a line that is not JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-job-sock-"));
    const path = join(dir, "bad.sock");
    const server = createServer(socket => { socket.on("data", () => socket.end("not-json\n")); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    const started = performance.now();
    const result = await Promise.race([
      callNode(path, { op: "list", lane: "builder", token: TOKEN }, 10_000).then(() => "resolved", (e: unknown) => e),
      new Promise(resolve => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(result).toBeInstanceOf(SyntaxError);
    expect(performance.now() - started).toBeLessThan(1000);
    server.close();
  });
});
