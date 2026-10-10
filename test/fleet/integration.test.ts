// Real agent + real fleet (spec §9 "Integration"):
// - `node add` → `join` → `run`;
// - the agent's inventory in /v1/lanes;
// - every pane op and the transcript ops through the fleet's client API (FleetClient);
// - revocation.
// Child processes with temporary HOMEs and random ports, one isolated tmux server, and a throwaway ~/.claude in the agent's
// HOME. The fixture pane writes its own session file there (test/fleet-harness.ts, test/fixtures/fake-claude-pane.ts).
// Negative control (spec §9): a send to a missing pane answers no_pane, not executed, and types nothing.
// Review Focus 1: a window named "fix: a/b ü.2" keeps its name through the agent, the fleet and its lane registry.
// Every answer to an op the fleet sent to the node carries the node's store (its database's stream id), op.status's
// too; a refusal before anything was sent carries null (plan Contracts, "Behaviour the agent and the fleet agree on").
// One setup for the whole file, so its tmux server and processes are stopped in afterAll (as apps/hub/test/tmux.test.ts).
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { WORKER_ID, formatWorkerId, parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { expectOf, fakeLane, joinAgent, paneOf, shellLane, sleep, startFleet, stopAll, tmuxServer, until, type Agent, type Fleet, type Lane, type TmuxServer } from "../fleet-harness.ts";

const ODD = "fix: a/b ü.2";
let fleet: Fleet;
let agent: Agent;
let tmux: TmuxServer;
let box: Lane;
let plain: Lane;

beforeAll(async () => {
  fleet = await startFleet();
  tmux = tmuxServer();
  agent = await joinAgent(fleet, "n1", { tmux });
  box = await fakeLane(tmux, { window: "box", prose: "box on n1", claudeHome: agent.home });
  plain = await fakeLane(tmux, { window: "plain" });
  shellLane(tmux, { window: ODD });
  shellLane(tmux, { window: "split", split: true });                 // two panes: not a lane
  shellLane(tmux, { window: "elsewhere", session: "other" });        // not the policy's session
  await agent.run();
  await agent.waitOnline();
}, 60_000);
afterAll(stopAll);

const key = () => `hub:it-${randomUUID()}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let sendKey = "";
let sendStore = "";

describe("a real agent joined to a real fleet", () => {
  it("joins through node add → join → run, and is online with its agent version", async () => {
    const n = (await fleet.client.nodes()).find(x => x.name === "n1");
    expect(n?.status).toBe("online");
    expect(n?.agent).toBeTruthy();
  });

  it("puts its lanes in /v1/lanes: one-pane windows of the policy's session only, the odd name intact", async () => {
    const lanes = await until("n1's three lanes", async () => {
      const l = (await fleet.client.lanes()).filter(x => x.node === "n1");
      return l.length === 3 ? l : null;
    });
    expect(lanes.map(l => l.name).sort()).toEqual(["box", ODD, "plain"].sort());
    const stamp = tmux.stamp();
    expect(stamp).toMatch(/^[0-9a-f]{8}/);
    for (const l of lanes) {
      expect(l.workerId).toMatch(WORKER_ID);
      expect(parseWorkerId(l.workerId ?? "")).toMatchObject({ node: "n1", server: stamp?.slice(0, 8) });
      expect(l.conflict).toBe(false);
    }
  });

  it("reports the session that the pane's session file names", async () => {
    expect((await paneOf(fleet.client, "n1", "box")).sessionId).toBe(box.sessionId);
    expect((await paneOf(fleet.client, "n1", "plain")).sessionId).toBeUndefined();
  });

  it("pane.send types once into the input box and answers the node's time of typing", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const before = Date.now();
    sendKey = key();
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.send", { workerId: p.workerId, text: "integration: hello box", expect: expectOf(p) }, { key: sendKey });
    const after = Date.now();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.store).toMatch(UUID);
    sendStore = r.store;
    expect(r.result.problem).toBeNull();
    expect(r.result.typedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(r.result.typedAt).toBeLessThanOrEqual(after + 1000);
    await until("the text in box", () => box.submitted().includes("integration: hello box"));
    await sleep(500);
    expect(box.submitted().filter(t => t === "integration: hello box")).toHaveLength(1);
  });

  it("op.status: the send's key is done with its result, from the store that took it; a key never used is unknown", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const done = await fleet.client.op({ workerId: p.workerId }, "op.status", { key: sendKey });
    expect(done).toMatchObject({ ok: true, store: sendStore, result: { state: "done", outcome: { problem: null } } });
    expect(await fleet.client.op({ workerId: p.workerId }, "op.status", { key: key() })).toMatchObject({ ok: true, store: sendStore, result: { state: "unknown" } });
  });

  it("answers a send to a missing pane with no_pane, not executed, and types nothing (negative control)", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const missing = formatWorkerId({ node: "n1", server: parseWorkerId(p.workerId)?.server ?? "", pane: 999 });
    const before = [box.submitted().length, plain.submitted().length];
    const r = await fleet.client.op({ workerId: missing }, "pane.send", { workerId: missing, text: "integration: nowhere", expect: expectOf(p) }, { key: key() });
    expect(r).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" }, store: sendStore });   // the node answered it
    await sleep(500);
    expect([box.submitted().length, plain.submitted().length]).toEqual(before);
  });

  it("pane.keys types into the pane, and the Enter in them submits", async () => {
    const p = await paneOf(fleet.client, "n1", "plain");
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.keys", { workerId: p.workerId, data: "keys-ok\r", expect: expectOf(p) });
    expect(r).toMatchObject({ ok: true, result: { ok: true } });
    await until("the keys submitted in plain", () => plain.submitted().includes("keys-ok"));
  });

  it("pane.frame returns the pane as tmux draws it", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.frame", { workerId: p.workerId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.frame).toMatchObject({ cols: 100, rows: 30 });
    const text = r.result.frame?.lines.join("\n") ?? "";
    expect(text).toContain("box on n1");
    expect(text).toContain("❯");
  });

  it("pane.captureMany captures several panes in one op, with null for a missing one", async () => {
    const [b, o] = await Promise.all([paneOf(fleet.client, "n1", "box"), paneOf(fleet.client, "n1", ODD)]);
    const missing = formatWorkerId({ node: "n1", server: parseWorkerId(b.workerId)?.server ?? "", pane: 999 });
    const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [b.workerId, o.workerId, missing] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = new Map(r.result.captures.map(c => [c.workerId, c]));
    expect(by.get(b.workerId)?.text).toContain("box on n1");
    expect(typeof by.get(o.workerId)?.text).toBe("string");
    expect(by.get(missing)?.text).toBeNull();
  });

  it("transcript.size and transcript.read return the session's bytes, in chunks of at most 256 KiB, past a long line", async () => {
    const path = box.transcript ?? "";
    const sid = box.sessionId ?? "";
    // A 600 KiB line: more than two chunks (real transcripts carry lines up to 3.7 MB, spec §1).
    appendFileSync(path, `${JSON.stringify({ type: "assistant", uuid: "long-1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(600 * 1024) }] } })}\n`);
    expect(await fleet.client.op({ node: "n1" }, "transcript.size", { sessionId: sid })).toMatchObject({ ok: true, result: { size: statSync(path).size } });
    expect(await fleet.client.op({ node: "n1" }, "transcript.size", { sessionId: randomUUID() })).toMatchObject({ ok: true, result: { size: null } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await fleet.client.op({ node: "n1" }, "transcript.read", { sessionId: sid, offset, max: LIMITS.chunkBytes });
      if (!r.ok) throw new Error(`transcript.read at ${offset}: ${r.error.code}`);
      const bytes = Buffer.from(r.result.bytes, "base64");
      expect(bytes.length).toBeLessThanOrEqual(LIMITS.chunkBytes);
      parts.push(bytes);
      offset += bytes.length;
      eof = r.result.eof;
      expect(parts.length).toBeLessThan(10);                          // a read that never moves would loop forever
    }
    expect(Buffer.concat(parts).equals(readFileSync(path))).toBe(true);
  });

  it("transcript.locate finds the line that holds a message id, and null for an absent one", async () => {
    const sid = box.sessionId ?? "";
    const file = readFileSync(box.transcript ?? "");
    const at = file.indexOf('"uuid":"seed-2"');
    const lineStart = file.lastIndexOf(0x0a, at) + 1;
    const lineEnd = file.indexOf(0x0a, at);
    const r = await fleet.client.op({ node: "n1" }, "transcript.locate", { sessionId: sid, needle: "seed-2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.offset).not.toBeNull();
    expect(r.result.offset ?? -1).toBeGreaterThanOrEqual(lineStart);
    expect(r.result.offset ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(lineEnd);
    expect(await fleet.client.op({ node: "n1" }, "transcript.locate", { sessionId: sid, needle: "no-such-message" })).toMatchObject({ ok: true, result: { offset: null } });
  });

  it("revoke: the live node is cut off at once, its ops are refused as not executed, and it never comes back", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    fleet.revoke("n1");
    await agent.waitOffline(5000);
    const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [p.workerId] });
    expect(r).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" }, store: null });   // never sent
    expect((await fleet.client.lanes()).filter(l => l.node === "n1")).toEqual([]);                       // its lanes are dropped
    await agent.stop();
    await agent.run();                                                // a fresh process with the revoked key
    for (const end = performance.now() + 5000; performance.now() < end;) {
      expect((await fleet.client.nodes()).find(n => n.name === "n1")?.status ?? "offline").not.toBe("online");
      await sleep(250);
    }
  });
});
