// The hook stream against a scripted fake fleet (spec §5.4, §9 "Stream"): replay from ackSeq + 1 before anything new,
// a window of 256 unacknowledged events, deletion on cumulative ack, late markers on replayed progress, a reset
// database that starts a new stream, a restored one (behind what the fleet accepted) that starts a new stream too, and
// a stream sender that never throws when its acks can't be written (a full disk must not crash the agent).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@morndo/protocol";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { Spool, type SpoolEvent } from "../src/relay/spool.ts";
import { StreamSender } from "../src/relay/stream-sender.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { dbFiles, joinedConfig, runAgent } from "./agent-harness.ts";
import { captureLog, isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet();
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  await t.kill();
  home.cleanup();
});

type Hook = { streamId: string; seq: number; at: number; path: string; node: string; window: string | null; late?: true; body: unknown };
const hooks = (from = 0): Hook[] => fleet.received.slice(from).filter(r => r.msg.t === "ev.hook").map(r => (r.msg as Msg & { event: Hook }).event);

async function offlineAgent() {
  fleet.script.hello = 1011;                                            // the fleet turns the agent away for now
  const before = fleet.connections();
  const run = await runAgent(config);
  stops.push(() => run.agent.stop());
  expect(await until(() => fleet.connections() > before)).toBe(true);
  return run;
}

describe("replay after a reconnect", () => {
  it("sends from ackSeq + 1 in order, replayed progress marked late with its original time, then new events", async () => {
    const { agent, post } = await offlineAgent();
    for (let i = 1; i <= 5; i++) expect((await post("/notify", { n: i })).status).toBe(202);
    expect((await post("/cc", { session_id: "s", n: "old" })).status).toBe(204);
    expect((await post("/cc", { session_id: "s", n: "latest" })).status).toBe(204);      // replaces the one before
    expect(agent.spool.depth()).toBe(6);
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 2, ackSeq: 2, streamKnown: true };
    fleet.script.hello = "challenge";
    expect(await until(() => hooks(cut).length === 4, 5000)).toBe(true);
    const replayed = hooks(cut);
    expect(replayed.map(e => e.seq)).toEqual([3, 4, 5, 7]);
    expect(replayed.map(e => e.body)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }, { session_id: "s", n: "latest" }]);
    expect(replayed.map(e => e.late ?? false)).toEqual([false, false, false, true]);
    expect(replayed.every(e => e.node === "pc" && e.streamId === agent.streamId)).toBe(true);
    expect(agent.spool.depth()).toBe(4);                                 // 1 and 2 were acknowledged by the welcome
    expect((await post("/notify", { n: "new" })).status).toBe(202);
    expect(await until(() => hooks(cut).length === 5)).toBe(true);
    expect(hooks(cut)[4]).toMatchObject({ seq: 8, body: { n: "new" } });
    expect(hooks(cut)[4]?.late).toBeUndefined();
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 8 });
    expect(await until(() => agent.spool.depth() === 0)).toBe(true);
  });

  it("keeps at most 256 events unacknowledged in flight, and sends more as acks arrive", async () => {
    const { agent } = await offlineAgent();
    for (let i = 1; i <= 300; i++) {
      const appended = agent.spool.append({ path: "/notify", at: Date.now(), session: null, window: null, body: { n: i } });
      expect(appended.ok).toBe(true);
    }
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 2, ackSeq: 0, streamKnown: true };
    fleet.script.hello = "challenge";
    await fleet.whenReady(() => hooks(cut).length === 256);
    fleet.send({ t: "req", id: "window", op: "inventory.get", args: {}, timeoutMs: 5000 });
    await fleet.whenReady(() => fleet.received.slice(cut).some(r => r.msg.t === "res" && r.msg.id === "window"));
    expect(hooks(cut)).toHaveLength(256);                                  // nothing past the window arrived on that round trip
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 100 });
    await fleet.whenReady(() => hooks(cut).length === 300);
    expect(hooks(cut).map(e => e.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(agent.spool.depth()).toBe(200);
  });

  it("ignores an ack for another stream", async () => {
    fleet.script.welcome = { connEpoch: 1, ackSeq: 0, streamKnown: true };
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    await post("/notify", { n: 1 });
    expect(await until(() => hooks().length === 1)).toBe(true);
    fleet.send({ t: "ack", streamId: randomUUID(), seq: 1 });
    await new Promise(r => setTimeout(r, 200));
    expect(agent.spool.depth()).toBe(1);
  });
});

describe("a reset database (spec §7 \"Agent database lost or reinstalled\")", () => {
  it("starts a new stream: a new streamId in hello, and the fleet's ackSeq for an unknown stream doesn't skip events", async () => {
    const first = await runAgent(config);
    expect(await until(() => fleet.received.some(r => r.msg.t === "hello"))).toBe(true);
    const oldStream = first.agent.streamId;
    await first.agent.stop();
    for (const f of dbFiles(config)) rmSync(f, { force: true });
    fleet.script.hello = 1011;
    const second = await runAgent(config);
    stops.push(() => second.agent.stop());
    expect(second.agent.streamId).not.toBe(oldStream);
    await second.post("/notify", { n: "after reset" });
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 3, ackSeq: 50, streamKnown: false };
    fleet.script.hello = "challenge";
    expect(await until(() => hooks(cut).length === 1)).toBe(true);
    expect(hooks(cut)[0]).toMatchObject({ seq: 1, streamId: second.agent.streamId, body: { n: "after reset" } });
    expect(fleet.received.filter(r => r.msg.t === "hello").at(-1)?.msg.streamId).toBe(second.agent.streamId);
  });
});

describe("a restored database (its stream behind what the fleet accepted)", () => {
  it("starts a new stream, so the fleet never takes its next events for ones it already has; the new id is kept", async () => {
    const before = openAgentDb(config.dbPath);
    const oldStream = before.streamId;
    before.close();
    fleet.script.streams = { [oldStream]: 50 };                          // the fleet accepted up to 50; this database never wrote one
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await until(() => fleet.received.filter(r => r.msg.t === "hello").length === 2)).toBe(true);
    const ids = fleet.received.filter(r => r.msg.t === "hello").map(r => r.msg.streamId);
    expect(ids[0]).toBe(oldStream);
    expect(ids[1]).not.toBe(oldStream);
    expect(agent.streamId).toBe(ids[1]);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const cut = fleet.received.length;
    expect((await post("/notify", { n: "after restore" })).status).toBe(202);
    expect(await until(() => hooks(cut).length === 1)).toBe(true);
    expect(hooks(cut)[0]).toMatchObject({ streamId: ids[1], seq: 1, body: { n: "after restore" } });
    await agent.stop();
    stops.length = 0;
    const after = openAgentDb(config.dbPath);
    expect(after.streamId).toBe(ids[1]);                                  // kept: a restart doesn't go back to the old stream
    after.close();
  });
});

describe("the stream sender on a disk that refuses writes", () => {
  const ev = (path: SpoolEvent["path"], session: string | null, body: unknown): SpoolEvent => ({ path, at: 1000, session, window: null, body });
  it("never throws: an ack it can't write is logged, the window opens, and sending goes on once the disk takes writes", () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    try {
      const spool = new Spool(adb.db, adb.streamId);
      for (let i = 1; i <= 3; i++) spool.append(ev("/notify", null, i));
      const sent: AgentMessage[] = [];
      const logged = captureLog();
      const sender = new StreamSender({ spool, node: "pc", send: m => { sent.push(m); return true; }, window: 3, log: logged.log });
      sender.online({ ackSeq: 0, streamKnown: true });
      expect(sent).toHaveLength(3);
      adb.db.pragma("query_only = ON");                                       // a full disk
      expect(() => sender.ack(3)).not.toThrow();
      expect(() => sender.online({ ackSeq: 2, streamKnown: true })).not.toThrow();
      expect(logged.lines.join("\n")).toMatch(/could not delete acknowledged hook events/);
      adb.db.pragma("query_only = OFF");
      spool.append(ev("/notify", null, 4));
      sender.kick();
      expect(sent.map(m => (m.t === "ev.hook" ? m.event.seq : 0)).slice(-1)).toEqual([4]);
    } finally { adb.close(); h.cleanup(); }
  });
});
