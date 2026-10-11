// The whole agent against a scripted fake fleet and an isolated tmux server (spec §5.2–5.4): ops answered over the
// connection (each with the database's store), inventory events (full after welcome, then on change), health events,
// the status a 4409 leaves for `morndo-node status`, housekeeping, a disk that refuses writes, and the test hooks
// (test-hooks.ts) as the agent and `morndo-node run` apply them.
import Database from "better-sqlite3";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, NodeStatusHealth } from "@morndo/protocol";
import { Flight } from "@morndo/service-kit";
import { loadConfig, type AgentConfig } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { openAgentDb } from "../src/db/open.ts";
import { Spool } from "../src/relay/spool.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  t.kill();
  home.cleanup();
});
const of = (type: string, from = 0) => fleet.received.slice(from).filter(r => r.msg.t === type).map(r => r.msg);

describe("over the connection", () => {
  it("a stop holds new work, then returns while an op is still running", async () => {
    const flight = new Flight();
    const stuck = flight.begin({ kind: "pane.send", id: "stuck" });
    const { agent } = await runAgent(config, { flight, stopWaitMs: 400 });
    let stopping: Promise<void> | null = null;
    stops.push(() => { stopping ??= agent.stop(); return stopping; });
    await fleet.waitFor(m => m.t === "ev.inventory");
    const started = Date.now();
    stopping = agent.stop();
    fleet.send({
      t: "req", id: "late", op: "pane.send", timeoutMs: 5000, key: "hub:late",
      args: { workerId: "pc.0a1b2c3d.4", text: "hi", expect: { server: "0a1b2c3d", window: "api" } },
    });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "late", 2000)).toMatchObject({ ok: false, error: { code: "updating", executed: "no" } });
    await stopping;
    expect(Date.now() - started).toBeLessThan(8000);
    stuck();
  });

  it("sends the full inventory and health after welcome, then inventory again when tmux changes", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    const inv = await fleet.waitFor(m => m.t === "ev.inventory");
    expect(inv).toMatchObject({ v: 1, invVersion: 1, panes: [{ window: "api", workerId: expect.stringMatching(/^pc\.[0-9a-f]{8}\.\d+$/) }] });
    const health = await fleet.waitFor(m => m.t === "ev.health");
    const h = (health as Msg & { health: Record<string, unknown> }).health;
    expect(Object.keys(h).sort()).toEqual(["diskFreeHome", "drops", "load1", "memAvailable", "memTotal", "psiFull10", "psiSome10", "spoolDepth", "tmuxOk", "wallClock"]);
    expect(Math.abs((h.wallClock as number) - Date.now())).toBeLessThan(5000);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "web", "sleep 600");
    const next = await fleet.waitFor(m => m.t === "ev.inventory" && m.invVersion === 2);
    expect((next.panes as { window: string }[]).map(p => p.window).sort()).toEqual(["api", "web"]);
    await new Promise(r => setTimeout(r, 400));
    expect(of("ev.inventory").filter(m => m.invVersion === 2)).toHaveLength(1);      // sent once, not every poll
  });

  it("reports a jobs config error on the error line, in status, and in health", async () => {
    const policyPath = agentPaths(home.home).policyFile;
    const stored = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, unknown>;
    writeFileSync(policyPath, JSON.stringify({ ...stored, jobs: { classes: { default: { limit: 0 } } } }));
    const { agent, lines } = await runAgent(loadConfig(home.home));
    stops.push(() => agent.stop());
    expect(lines.some(line => line.includes("error:") && line.includes("limit"))).toBe(true);
    expect(agent.status().jobs).toMatch(/disabled by config error/);
    const health = await fleet.waitFor(m => m.t === "ev.health");
    expect((health as { health: { jobs?: string } }).health.jobs).toMatch(/disabled by config error/);
  });

  it("writes the product version, ready, and the fleet state into status.json", async () => {
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await until(() => agent.status().state === "online")).toBe(true);
    const body = JSON.parse(readFileSync(agentPaths(home.home).statusFile, "utf8")) as { version?: string; ready?: boolean; state?: string };
    expect(NodeStatusHealth.safeParse(body).success).toBe(true);
    const root = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as { version: string };
    expect(body.version).toBe(root.version);
    expect(body.ready).toBe(true);
    expect(body.state).toBe("online");
  });

  it("asks the policy's tmux server for health (tmuxOk), not the default one", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await fleet.waitFor(m => m.t === "ev.health")).toMatchObject({ health: { tmuxOk: true } });
    t.kill();
    const from = fleet.received.length;
    expect(await fleet.waitFor(m => m.t === "ev.health" && (m.health as { tmuxOk: boolean }).tmuxOk === false, 5000, from)).toBeTruthy();
  });

  it("answers requests by id: a result, an unknown op, a malformed request", async () => {
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "q1", op: "inventory.get", args: {}, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "q2", op: "pane.exec", args: {}, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "q3", op: "pane.send", args: { workerId: "pc.0a1b2c3d.1" }, timeoutMs: 5000, key: "hub:x" });
    // Every answer carries the store: the stream id of the database whose done keys answer for it (plan Contracts, Res).
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q1")).toMatchObject({ ok: true, result: { panes: [] }, invVersion: 0, store: agent.streamId });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q2")).toMatchObject({ ok: false, error: { code: "unknown_op", executed: "no" }, store: agent.streamId });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q3")).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" }, store: agent.streamId });
    fleet.send({ t: "req", id: "q4", op: "op.status", args: { key: "hub:never" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q4")).toMatchObject({ ok: true, result: { state: "unknown" }, store: agent.streamId });
  });

  it("every answer carries the store sequence: one more for each keyed op started, and op.status's says where it is now (final review I2)", async () => {
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "s0", op: "inventory.get", args: {}, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s0")).toMatchObject({ ok: true, storeSeq: 0 });
    // A keyed op is started (and refused once started: no such lane, the key released): the sequence counts it all the same.
    fleet.send({ t: "req", id: "s1", op: "lane.stop", args: { name: "nothing-here" }, timeoutMs: 5000, key: "hub:one" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s1")).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" }, storeSeq: 1 });
    // A refusal before anything started (bad_args) leaves it as it is; reads report it.
    fleet.send({ t: "req", id: "s2", op: "lane.stop", args: {}, timeoutMs: 5000, key: "hub:two" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s2")).toMatchObject({ ok: false, error: { code: "bad_args" }, storeSeq: 1 });
    fleet.send({ t: "req", id: "s3", op: "op.status", args: { key: "hub:one" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s3")).toMatchObject({ ok: true, result: { state: "unknown" }, store: agent.streamId, storeSeq: 1 });
  });

  it("re-sends the full inventory after a reconnect", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config, { retry: { baseMs: 1, capMs: 1, random: () => 0 } });
    stops.push(() => agent.stop());
    await fleet.whenReady(() => fleet.received.some(r => r.msg.t === "ev.inventory"));
    const cut = fleet.received.length;
    fleet.closeAgent(1011, "fleet restart");
    await fleet.whenReady(() => fleet.received.slice(cut).some(r => {
      const panes = r.msg.panes;
      return r.msg.t === "ev.inventory" && r.msg.invVersion === 1 && Array.isArray(panes) && panes.some(p => (p as { window?: string }).window === "api");
    }));
  });
});

describe("status (spec §5.2: a refused second instance shows the conflict)", () => {
  it("after 4409 `morndo-node status` says conflict, and the next try is about 5 minutes away", async () => {
    fleet.script.welcome = 4409;
    const joins = fleet.connections();                                    // the join's own connection
    const second = randomUUID();
    const { agent } = await runAgent(config, { instanceId: second });
    stops.push(() => agent.stop());
    expect(await until(() => agent.status().state === "conflict")).toBe(true);
    const out = await until(() => execFileSync(process.execPath, [MAIN, "status"], { env: { ...process.env, HOME: home.home }, encoding: "utf8" }).includes("conflict"), 3000);
    expect(out).toBe(true);
    const text = execFileSync(process.execPath, [MAIN, "status"], { env: { ...process.env, HOME: home.home }, encoding: "utf8" });
    expect(text).toMatch(/node\s+pc/);
    expect(text).toMatch(/conflict: another agent with this node's key is connected \(4409\)\. This one tries again every 5 minutes/);
    expect(text).toMatch(new RegExp(`instance\\s+${second}`));
    const retry = Number(/retry in\s+(\d+) s/.exec(text)?.[1]);
    expect(retry).toBeGreaterThan(0.8 * LIMITS.conflictRetryMs / 1000 - 10);
    expect(retry).toBeLessThanOrEqual(1.2 * LIMITS.conflictRetryMs / 1000);
    expect(fleet.connections()).toBe(joins + 1);                          // dialed once; the next try is minutes away
  });
});

describe("housekeeping", () => {
  it("prunes done keys older than 7 days when the agent starts (and hourly after)", async () => {
    const adb = openAgentDb(config.dbPath);
    const insert = adb.db.prepare("INSERT INTO done_keys (key, hash, state, outcome, at) VALUES (?, 'h', 'done', '{}', ?)");
    insert.run("hub:old", Date.now() - LIMITS.doneKeyTtlMs - 60_000);
    insert.run("hub:fresh", Date.now());
    adb.close();
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "s-old", op: "op.status", args: { key: "hub:old" }, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "s-fresh", op: "op.status", args: { key: "hub:fresh" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s-old")).toMatchObject({ ok: true, result: { state: "unknown" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s-fresh")).toMatchObject({ ok: true, result: { state: "done" } });
  });
});

describe("a database restored by copy, with no hook traffic since (final review I2)", () => {
  it("answers a send in doubt from another store: unknown there can't vouch for the key, so the hub keeps it uncertain", async () => {
    const first = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const store = first.agent.streamId;                                            // the store the send in doubt went to
    await first.agent.stop();
    const files = (base: string) => ["", "-wal", "-shm"].map(s => `${base}${s}`).filter(f => existsSync(f));
    const backup = join(home.home, "backup");
    mkdirSync(backup);
    for (const f of files(config.dbPath)) execFileSync("cp", [f, join(backup, f.slice(f.lastIndexOf("/") + 1))]);   // the backup
    const live = openAgentDb(config.dbPath);
    live.db.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES ('hub:doubt', 'h', 'started', ?)").run(Date.now());   // the send, after it
    live.close();
    for (const f of files(config.dbPath)) renameSync(f, `${f}.lost`);              // the live database is gone (kept aside here)
    for (const f of files(join(backup, "agent.db"))) execFileSync("cp", [f, join(config.dbPath, "..", f.slice(f.lastIndexOf("/") + 1))]);   // restored
    const cut = fleet.received.length;
    const { agent, lines } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut);
    expect(agent.streamId).not.toBe(store);
    expect(fleet.received.slice(cut).find(r => r.msg.t === "hello")?.msg.streamId).toBe(agent.streamId);
    fleet.send({ t: "req", id: "doubt", op: "op.status", args: { key: "hub:doubt" }, timeoutMs: 5000 });
    const res = await fleet.waitFor(m => m.t === "res" && m.id === "doubt", 5000, cut);
    expect(res).toMatchObject({ ok: true, result: { state: "unknown" } });
    expect(res.store).not.toBe(store);                                            // another store: unknown proves nothing
    expect(lines.join("\n")).toMatch(/is not the file this database was made in/);
  });
});

describe("a database put back in place from an older copy (cp over the file: its inode, so its store, kept)", () => {
  it("keeps its store, which the file's identity can't tell, but op.status answers a lower store sequence than the send saw (final review I2)", async () => {
    const op = async (id: string, req: Record<string, unknown>, from: number) => {
      fleet.send({ t: "req", id, timeoutMs: 5000, ...req });
      return fleet.waitFor(m => m.t === "res" && m.id === id, 5000, from);
    };
    const first = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory");
    await op("a1", { op: "lane.stop", args: { name: "before-the-copy" }, key: "hub:before" }, 0);
    await first.agent.stop();                                                      // stopped cleanly: no -wal left beside it
    const backup = join(home.home, "agent.db.copy");
    execFileSync("cp", [config.dbPath, backup]);                                   // the copy
    const inode = statSync(config.dbPath).ino;
    let cut = fleet.received.length;
    const second = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut);
    const sent = await op("send", { op: "lane.stop", args: { name: "the-send" }, key: "hub:doubt" }, cut);   // the send, after the copy
    const store = second.agent.streamId;
    expect(sent).toMatchObject({ store, storeSeq: 2 });
    await second.agent.stop();
    execFileSync("cp", [backup, config.dbPath]);                                   // put back over the file, in place
    for (const f of [`${config.dbPath}-wal`, `${config.dbPath}-shm`]) rmSync(f, { force: true });
    expect(statSync(config.dbPath).ino).toBe(inode);                               // the same file: its identity can't tell
    cut = fleet.received.length;
    const { agent, lines } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut);
    expect(agent.streamId).toBe(store);                                            // the same store
    const res = await op("doubt", { op: "op.status", args: { key: "hub:doubt" } }, cut);
    expect(res).toMatchObject({ ok: true, result: { state: "unknown" }, store, storeSeq: 1 });   // behind the 2 the send saw
    expect(lines.join("\n")).not.toMatch(/is not the file this database was made in/);
  });
});

// The fix wave's follow-up: the fleet keeps the highest store sequence each store has shown, and the welcome says it
// (storeSeqSeen). A database behind it was put back from an older copy: the agent starts a new store before the
// connection goes online, so nothing runs under the old one, however many keyed ops it would run before a repeat.
describe("a welcome that has seen more of this store than this database holds", () => {
  const helloOf = (from: number) => fleet.received.slice(from).filter(r => r.msg.t === "hello").map(r => r.msg.streamId as string);

  it("starts a new store before it runs anything: a request sent with that welcome never runs, and the next hello names the new store", async () => {
    const first = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "k1", op: "lane.stop", args: { name: "one" }, timeoutMs: 5000, key: "hub:one" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "k1")).toMatchObject({ storeSeq: 1 });
    const store = first.agent.streamId;
    await first.agent.stop();
    fleet.script.storeSeqs = { [store]: 5 };                                       // the fleet saw 5 from this store: this database holds 1
    fleet.script.afterWelcome = [{ t: "req", id: "early", op: "lane.stop", args: { name: "early" }, timeoutMs: 5000, key: "hub:early" }];
    const cut = fleet.received.length;
    const { agent, lines } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory", 10_000, cut);
    expect(helloOf(cut)).toEqual([store, agent.streamId]);                           // turned down, then dialed again under the new one
    expect(agent.streamId).not.toBe(store);
    expect(fleet.received.slice(cut).some(r => r.msg.t === "res" && r.msg.id === "early")).toBe(false);   // never run, never answered
    fleet.send({ t: "req", id: "look", op: "op.status", args: { key: "hub:early" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "look", 5000, cut)).toMatchObject({ ok: true, result: { state: "unknown" }, store: agent.streamId, storeSeq: 1 });
    expect(lines.filter(l => l.includes("Starting a new store"))).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/the fleet has seen store sequence 5 from store .*, but this database holds 1/);
  });

  // The residual round: the stream's last seq that can't be read (a damaged sqlite_sequence, a read error) says nothing of
  // the store sequence, so the comparison with storeSeqSeen still runs, and a database behind it still starts a new
  // store before going online. Nothing is acknowledged from a stream whose end is unknown.
  it("compares the store sequence even when the stream's last seq can't be read, and starts a new store", async () => {
    const first = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "k1", op: "lane.stop", args: { name: "one" }, timeoutMs: 5000, key: "hub:one" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "k1")).toMatchObject({ storeSeq: 1 });
    const store = first.agent.streamId;
    await first.agent.stop();
    fleet.script.storeSeqs = { [store]: 5 };                                       // the fleet saw 5 from this store: this database holds 1
    const lastSeq = vi.spyOn(Spool.prototype, "lastSeq").mockImplementation(() => { throw new Error("disk I/O error"); });
    try {
      const cut = fleet.received.length;
      const { agent, lines } = await runAgent(config);
      stops.push(() => agent.stop());
      await fleet.waitFor(m => m.t === "ev.inventory", 10_000, cut);
      expect(lastSeq).toHaveBeenCalled();
      expect(lines.join("\n")).toMatch(/could not read the hook stream's last seq/);
      expect(helloOf(cut)).toEqual([store, agent.streamId]);                         // turned down, then dialed again under a new one
      expect(agent.streamId).not.toBe(store);
      expect(lines.filter(l => l.includes("Starting a new store"))).toHaveLength(1);
    } finally { lastSeq.mockRestore(); }
  });

  it("keeps its store when the database is level with or ahead of what the fleet has seen (no false rotation)", async () => {
    const first = await runAgent(config);
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "k1", op: "lane.stop", args: { name: "one" }, timeoutMs: 5000, key: "hub:one" });
    await fleet.waitFor(m => m.t === "res" && m.id === "k1");
    const store = first.agent.streamId;
    await first.agent.stop();
    for (const seen of [1, 0]) {
      fleet.script.storeSeqs = { [store]: seen };
      const cut = fleet.received.length;
      const { agent, lines } = await runAgent(config);
      await fleet.waitFor(m => m.t === "ev.inventory", 10_000, cut);
      expect(helloOf(cut)).toEqual([store]);
      expect(agent.streamId).toBe(store);
      expect(lines.join("\n")).not.toMatch(/Starting a new store/);
      await agent.stop();
    }
  });
});

describe("the disk budget: the spool, the relay's copies and the upload inbox together", () => {
  it("refuses a relay copy (503) and an upload chunk (too_large) that what the others hold leaves no room for", async () => {
    const { agent, post } = await runAgent(config, { diskBudgetBytes: 1000 });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "a.bin"), Buffer.alloc(700));
    writeFileSync(join(home.home, "work", "b.bin"), Buffer.alloc(400));
    expect((await post("/file", { path: join(home.home, "work", "a.bin") })).status).toBe(202);
    expect((await post("/file", { path: join(home.home, "work", "b.bin") })).status).toBe(503);   // 700 held + 400 > 1000
    fleet.send({ t: "req", id: "up", op: "file.put", args: { upload: "u1", offset: 0, bytes: Buffer.alloc(400).toString("base64"), final: true, name: "x.bin" }, timeoutMs: 5000, key: "hub:up" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "up")).toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    fleet.send({ t: "req", id: "up2", op: "file.put", args: { upload: "u2", offset: 0, bytes: Buffer.alloc(50, 0x61).toString("base64"), final: true, name: "note.txt" }, timeoutMs: 5000, key: "hub:up2" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "up2")).toMatchObject({ ok: true });   // negative control: what fits
  });
});

describe("a disk that refuses writes (spoolFail)", () => {
  it("never takes the agent down: a welcome acknowledging events it can't delete is logged, and the agent stays online", async () => {
    fleet.script.welcome = { connEpoch: 4, ackSeq: 3, streamKnown: true };
    const before = openAgentDb(config.dbPath);
    for (let i = 0; i < 3; i++) before.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)").run();   // seqs 1–3
    before.close();
    const { agent, lines } = await runAgent(config, { hooks: { spoolFail: true } });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    expect(agent.status().state).toBe("online");
    expect(lines.join("\n")).toMatch(/could not delete acknowledged hook events/);
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 3 });
    fleet.send({ t: "req", id: "after", op: "inventory.get", args: {}, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "after")).toMatchObject({ ok: true });   // still answering
  });
});

describe("test hooks over the connection (test-hooks.ts)", () => {
  // A lane "api" running the stand-in for Claude Code's input box, and what was submitted in it.
  async function claudeLane() {
    const dir = join(home.home, "lane");
    mkdirSync(dir);
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "-x", "100", "-y", "20", `${process.execPath} ${FIXTURE} ${dir}`);
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:0").includes("❯"))).toBe(true);
    const file = join(dir, "submitted.jsonl");
    return () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
  }
  const sendReq = (id: string, workerId: string, text: string, key: string) =>
    fleet.send({ t: "req", id, op: "pane.send", args: { workerId, text, expect: { server: workerId.split(".")[1], window: "api" } }, timeoutMs: 10_000, key });
  let n = 0;
  const opStatus = async (key: string) => {
    const id = `status-${++n}`;
    const from = fleet.received.length;
    fleet.send({ t: "req", id, op: "op.status", args: { key }, timeoutMs: 5000 });
    return ((await fleet.waitFor(m => m.t === "res" && m.id === id, 5000, from)).result) as { state: string; outcome?: unknown };
  };
  // Up again: the new connection's full inventory has arrived, so the agent is past its welcome.
  const backOnline = (from: number) => fleet.waitFor(m => m.t === "ev.inventory", 5000, from);

  it("dropAfterStarted: the socket is cut right after started; the op runs on, its answer is never sent, op.status says done", async () => {
    const submitted = await claudeLane();
    const { agent } = await runAgent(config, { hooks: { dropAfterStarted: "drop" } });
    stops.push(() => agent.stop());
    const workerId = ((await fleet.waitFor(m => m.t === "ev.inventory")).panes as { workerId: string }[])[0]?.workerId ?? "";
    const live = fleet.connections();
    const cut = fleet.received.length;
    sendReq("send-1", workerId, "typed once", "hub:drop-1");
    expect(await until(() => fleet.closes.some(c => c.conn === live))).toBe(true);           // the fleet saw the socket go
    expect(await until(() => submitted().length === 1)).toBe(true);                           // the op ran on
    await backOnline(cut);
    let status: { state: string; outcome?: unknown } = { state: "" };
    expect(await until(async () => (status = await opStatus("hub:drop-1")).state === "done", 10_000)).toBe(true);
    expect(status.outcome).toMatchObject({ problem: null, typedAt: expect.any(Number) });
    await wait(300);
    expect(fleet.received.some(r => r.msg.t === "res" && r.msg.id === "send-1")).toBe(false);
    // The repeat on the new connection gets the stored outcome and types nothing: the done key at work.
    sendReq("send-2", workerId, "typed once", "hub:drop-1");
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "send-2")).toMatchObject({ ok: true, result: status.outcome });
    await wait(300);
    expect(submitted()).toEqual(["typed once"]);
  });

  it("noDoneKeys with dropAfterStarted (negative control): op.status knows nothing, and the repeat types again", async () => {
    const submitted = await claudeLane();
    const { agent } = await runAgent(config, { hooks: { dropAfterStarted: "drop", noDoneKeys: true } });
    stops.push(() => agent.stop());
    const workerId = ((await fleet.waitFor(m => m.t === "ev.inventory")).panes as { workerId: string }[])[0]?.workerId ?? "";
    const live = fleet.connections();
    const cut = fleet.received.length;
    sendReq("send-1", workerId, "typed twice", "hub:drop-2");
    expect(await until(() => fleet.closes.some(c => c.conn === live))).toBe(true);
    expect(await until(() => submitted().length === 1)).toBe(true);
    await backOnline(cut);
    expect(await opStatus("hub:drop-2")).toEqual({ state: "unknown" });
    sendReq("send-2", workerId, "typed twice", "hub:drop-2");
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "send-2", 10_000)).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted().length === 2)).toBe(true);
    expect(submitted()).toEqual(["typed twice", "typed twice"]);
  });

  it("fixedStreamId: hello, hook events and acks use it instead of the database's stream id", async () => {
    const fixed = randomUUID();
    const { agent, post } = await runAgent(config, { hooks: { fixedStreamId: fixed } });
    stops.push(() => agent.stop());
    expect(await fleet.waitFor(m => m.t === "hello")).toMatchObject({ streamId: fixed });
    expect(agent.streamId).toBe(fixed);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const before = Date.now();
    expect((await post("/notify", { n: 1 })).status).toBe(202);
    const event = (await fleet.waitFor(m => m.t === "ev.hook")).event as { streamId: string; seq: number; at: number };
    expect(event).toMatchObject({ streamId: fixed, seq: 1 });
    expect(event.at).toBeGreaterThanOrEqual(before);                                           // no clock offset here
    expect(event.at).toBeLessThanOrEqual(Date.now());
    fleet.send({ t: "ack", streamId: fixed, seq: 1 });
    expect(await until(() => agent.spool.depth() === 0)).toBe(true);
    fleet.send({ t: "req", id: "st", op: "op.status", args: { key: "hub:x" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "st")).toMatchObject({ store: fixed });   // the store follows it too
    const db = new Database(config.dbPath, { readonly: true });
    try { expect((db.prepare("SELECT value FROM meta WHERE key = 'streamId'").get() as { value: string }).value).not.toBe(fixed); }
    finally { db.close(); }
  });

  it("clockOffsetMs moves health.wallClock and each hook event's at", async () => {
    const { agent, post } = await runAgent(config, { hooks: { clockOffsetMs: 3_600_000 } });
    stops.push(() => agent.stop());
    const health = (await fleet.waitFor(m => m.t === "ev.health")).health as { wallClock: number };
    expect(Math.abs(health.wallClock - (Date.now() + 3_600_000))).toBeLessThan(5000);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const before = Date.now();
    expect((await post("/notify", { n: 1 })).status).toBe(202);
    const event = (await fleet.waitFor(m => m.t === "ev.hook")).event as { at: number };
    expect(event.at).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(event.at).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it("spoolFail: /hook/stop answers 503 and /cc still 204; both count as drops in health", async () => {
    const { agent, post } = await runAgent(config, { hooks: { spoolFail: true } });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    expect((await post("/hook/stop", { session_id: "s" })).status).toBe(503);
    expect((await post("/cc", { session_id: "s" })).status).toBe(204);
    expect(agent.spool.depth()).toBe(0);
    expect(await fleet.waitFor(m => m.t === "ev.health" && (m.health as { drops: number }).drops === 2)).toBeTruthy();
  });
});

describe("`morndo-node run`: files it can't use stop it with one sentence, exit 78 (final review M3)", () => {
  // `run` on this joined HOME: exit 78, the sentence, no stack frame, and the fleet never dialed.
  const refusedWith = (sentence: RegExp) => {
    const before = fleet.connections();
    const r = spawnSync(process.execPath, [MAIN, "run"], { env: { ...process.env, HOME: home.home }, encoding: "utf8", timeout: 10_000 });
    expect(r.status, r.stderr).toBe(78);
    expect(r.stderr).toMatch(sentence);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
    expect(fleet.connections()).toBe(before);
  };
  it("a corrupt or half-written node key, a link to nothing, and an agent.db that isn't SQLite", () => {
    const pem = readFileSync(config.keyPath, "utf8");
    writeFileSync(config.keyPath, "not a key at all\n");
    refusedWith(/node-key\.pem is not a readable private key/);
    writeFileSync(config.keyPath, pem.slice(0, 40));
    refusedWith(/node-key\.pem is not a readable private key/);
    rmSync(config.keyPath);
    symlinkSync(join(home.home, "gone.pem"), config.keyPath);
    refusedWith(/node-key\.pem is missing or a link to nothing/);
    rmSync(config.keyPath);
    writeFileSync(config.keyPath, pem, { mode: 0o600 });
    mkdirSync(join(config.dbPath, ".."), { recursive: true });
    writeFileSync(config.dbPath, "these are not the bytes of a database ".repeat(40));
    refusedWith(/agent\.db is not a SQLite database/);
  });
});

describe("`morndo-node run` and test hooks", () => {
  it("refuses to start with MORNDO_NODE_TEST_HOOKS set outside NODE_ENV=test: exit 78, saying why, and never dials", () => {
    const before = fleet.connections();
    const r = spawnSync(process.execPath, [MAIN, "run"], {
      env: { ...process.env, HOME: home.home, NODE_ENV: "production", MORNDO_NODE_TEST_HOOKS: JSON.stringify({ spoolFail: true }) },
      encoding: "utf8", timeout: 10_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/MORNDO_NODE_TEST_HOOKS is set, but NODE_ENV is not "test"/);
    expect(fleet.connections()).toBe(before);
  });

  it("starts with them under NODE_ENV=test and a throwaway HOME, warns once naming each, and applies them", async () => {
    const fixed = randomUUID();
    const child = spawn(process.execPath, [MAIN, "run"], {
      env: { ...process.env, HOME: home.home, NODE_ENV: "test", MORNDO_NODE_TEST_HOOKS: JSON.stringify({ fixedStreamId: fixed, spoolFail: true }) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    try {
      expect(await fleet.waitFor(m => m.t === "hello", 10_000)).toMatchObject({ streamId: fixed });
      expect(stderr.match(/test hooks are on/g)).toHaveLength(1);
      expect(stderr).toMatch(/test hooks are on \(fixedStreamId, spoolFail\)/);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  });
});
