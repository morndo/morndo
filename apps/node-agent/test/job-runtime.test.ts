// The running agent is what listens on job.sock (ADR-0017). A job that finishes through that socket is one
// lane delivery. A start the caller grants itself is a later check; this test only shows the agent is the one
// that builds the supervisor, the grants and the delivery.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noticeIdOf } from "@morndo/domain";
import { agentPaths } from "../src/paths.ts";
import { unitOf } from "../src/ops/job-systemd.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
const TOKEN = "mat_secret-token";
const HASH = createHash("sha256").update(TOKEN).digest("hex");
let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
const stops: (() => Promise<void>)[] = [];
const units: string[] = [];

beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
  home = tempHome();
  t = isolatedTmux();
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const unit of units.splice(0)) {
    await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
    await exec("systemctl", ["--user", "reset-failed", unit]).catch(() => {});
  }
  await fleet.close();
  t.kill();
  home.cleanup();
});

function exec(file: string, args: string[]): Promise<void> {
  return new Promise(resolve => { execFile(file, args, () => resolve()); });
}

function ask(sock: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buf = "";
    socket.on("error", reject);
    socket.on("data", chunk => {
      buf += String(chunk);
      const i = buf.indexOf("\n");
      if (i < 0) return;
      socket.end();
      resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
    });
    socket.write(`${JSON.stringify(payload)}\n`);
  });
}

describe("the running agent", () => {
  it("delivers a finished job once, and a start with no grant does not run", async () => {
    const hub = createServer((req, res) => {
      req.resume();
      const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, lane: "builder", hash: createHash("sha256").update(token).digest("hex") }));
    });
    await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", () => resolve()));
    const address = hub.address();
    if (!address || typeof address === "string") throw new Error("hub");
    const hubUrl = `http://127.0.0.1:${address.port}`;
    const previous = process.env.MORNDO_HUB;
    delete process.env.MORNDO_HUB;
    stops.push(async () => { if (previous === undefined) delete process.env.MORNDO_HUB; else process.env.MORNDO_HUB = previous; await new Promise(resolve => hub.close(() => resolve(undefined))); });
    const laneDir = join(home.home, "lane");
    mkdirSync(laneDir);
    t.tmux("new-session", "-d", "-s", "main", "-n", "builder", "-x", "100", "-y", "24", `${process.execPath} ${FIXTURE} ${laneDir}`);
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:builder").includes("❯"))).toBe(true);
    const config = await joinedConfig(home.home, fleet, t.socket, hubUrl);
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    const id = `wire${randomBytes(4).toString("hex")}`;
    units.push(unitOf(id));
    const work = join(home.home, "work");
    mkdirSync(work);
    const sock = agentPaths(home.home).jobSock;
    const started = await ask(sock, {
      op: "start", id, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
      token: TOKEN,
    });
    expect(started.ok).toBe(true);
    const db = new Database(config.dbPath, { readonly: true });
    try {
      expect(await until(() => {
        const row = db.prepare("SELECT typed FROM job_deliveries WHERE id = ?").get(noticeIdOf(id)) as { typed: number } | undefined;
        return row?.typed === 1;
      }, 8000)).toBe(true);
      const row = db.prepare("SELECT id, lane, text, typed FROM job_deliveries WHERE id = ?").get(noticeIdOf(id)) as { id: string; lane: string; text: string; typed: number };
      expect(row).toMatchObject({ id: noticeIdOf(id), lane: "builder", typed: 1 });
      expect(row.text).toContain("pack exited");
      const submitted = join(laneDir, "submitted.jsonl");
      expect(existsSync(submitted) ? readFileSync(submitted, "utf8") : "").toContain("[morndo-job] pack exited");
      expect(db.prepare("SELECT notice FROM jobs WHERE id = ?").get(id)).toEqual({ notice: "typed" });
      expect(db.prepare("SELECT lane, hash FROM token_cache").get()).toEqual({ lane: "builder", hash: HASH });
      expect(db.prepare("SELECT COUNT(*) AS n FROM job_deliveries").get()).toEqual({ n: 1 });
      expect(JSON.stringify(db.prepare("SELECT * FROM jobs").all())).not.toContain(TOKEN);
    } finally { db.close(); }
    const bare = await ask(sock, {
      op: "start", id: `wire${randomBytes(4).toString("hex")}`, lane: "builder", name: "pack", jobClass: "default",
      notify: { kind: "lane", name: "builder" }, cwd: work,
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    expect(bare).toEqual({ ok: false, error: "hub" });
  });
});
