// Lane events delivered to the manager (fleet clients spec §7): batched for batchMs, one delivery to deliverTo with the
// header and one JSON line per event; answered, the manager's own lane and ignored lanes left out; a batch given up goes
// again in the next one under a new id; a batch over 8000 characters as several deliveries (Review Focus 4); events not
// yet delivered when the fleet stops go after its restart, and a stored batch is never sent twice.
import type { Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Delivery, OpArgs, Pane } from "@morndo/protocol";
import type { LaneEventsConfig } from "../src/config.ts";
import { createLogger } from "../src/adapters/log.ts";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { deliveryOf, nodeQueue } from "./helpers/node-queue.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { LaneEventsStore } from "../src/adapters/lane-events-store.ts";
import { LaneEventsPush } from "../src/application/lane-events-push.ts";
import { tempDir } from "./helpers/temp.ts";

const HEADER = "[lane-event] Lane events from kira (handle them as the Dispatching work section says):";
const CONFIG: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: ["pooltest*"], batchMs: 100 };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const AT = (seq: number) => 1_700_000_000_000 + seq;                                // FakeAgent.hook's time of seq
const pane = (n: number, window: string): Pane => ({ workerId: `pc.3fa2c1d0.${n}`, window, cwd: "/w", status: "idle", pid: n });
const delivered = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.deliver").map(r => r.args as OpArgs["lane.deliver"]);
const linesOf = (text: string) => text.split("\n").slice(1).map(l => JSON.parse(l) as Record<string, unknown>);
// The fleet marks a part sent once its node's answer is in, a moment after the node got it.
const marks = (fleet: TestFleet) => fleet.db.prepare("SELECT seq, to_manager, delivery_id FROM lane_events ORDER BY seq").all();
const sentCount = (fleet: TestFleet) => (fleet.db.prepare("SELECT COUNT(*) AS n FROM lane_events WHERE to_manager = 1").get() as { n: number }).n;

async function managerNode(fleet: TestFleet, o: { key?: FakeAgent } = {}): Promise<FakeAgent> {
  const pc = o.key ? fleet.agent({ node: "pc", key: o.key.key, instanceId: o.key.instanceId, streamId: o.key.streamId }) : await fleet.joined("pc");
  expect((await pc.connect()).ok).toBe(true);
  nodeQueue(pc);
  pc.inventory([pane(0, "manager"), pane(1, "api"), pane(2, "web")]);
  await vi.waitFor(() => expect(fleet.lanes.get("manager")).not.toBeNull());
  return pc;
}

describe("lane events to the manager", () => {
  it("one delivery per batch to the manager: the header, then today's lines; answered, the manager's own lane and ignored lanes left out", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    pc.hook(1, "/hook/stop", { session_id: SID, text: "STATUS: DONE", background: 1, crons: 0 }, { window: "api" });
    pc.hook(2, "/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }, { window: "web" });
    pc.hook(3, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    pc.hook(4, "/hook/stop", { text: "the manager's own turn" }, { window: "manager" });
    pc.hook(5, "/hook/stop", { text: "a pool probe" }, { window: "pooltest-1" });
    await vi.waitFor(() => expect(delivered(pc)).toHaveLength(1));
    const [d] = delivered(pc);
    expect(d?.id).toBe(`fleet:lane-events:pc:${AT(1)}`);
    expect(d?.target).toEqual({ lane: "manager", sticky: true });
    expect(d?.text.split("\n")[0]).toBe(HEADER);
    expect(d?.text.split("\n").slice(1)).toEqual([
      `{"ts":"${new Date(AT(1)).toISOString()}","lane":"api","sessionId":"${SID}","event":"finished","status":"done","firstLine":"STATUS: DONE","bg":1,"crons":0}`,
      `{"ts":"${new Date(AT(2)).toISOString()}","lane":"web","sessionId":"${SID}","event":"needs_input","question":"Which branch?"}`,
    ]);
    await vi.waitFor(() => expect(marks(fleet)).toEqual([
      { seq: 1, to_manager: 1, delivery_id: d?.id }, { seq: 2, to_manager: 1, delivery_id: d?.id }, { seq: 3, to_manager: null, delivery_id: null },
    ]));
    expect(fleet.audit.of("delivery.post").map(e => e.detail.client)).toEqual(["fleet"]);
  });

  it("a batch given up goes again in the next batch, under a new id", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    pc.hook(1, "/hook/stop", { text: "one" }, { window: "api" });
    await vi.waitFor(() => expect(sentCount(fleet)).toBe(1));
    const first = `fleet:lane-events:pc:${AT(1)}`;
    pc.delivery(deliveryOf("pc", first, { target: { lane: "manager" }, state: "given_up", why: "expired" }));
    pc.hook(2, "/hook/stop", { text: "two" }, { window: "api" });
    await vi.waitFor(() => expect(delivered(pc)).toHaveLength(2));
    const again = delivered(pc)[1];
    expect(again?.id).toBe(`${first}.2`);                                             // negative control: not put back, only "two"
    expect(again ? linesOf(again.text).map(l => l.firstLine) : []).toEqual(["one", "two"]);
  });

  it("a batch over 8000 characters goes as several deliveries of at most 8000, each with the header, in order; none refused", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    for (let seq = 1; seq <= 60; seq++) pc.hook(seq, "/hook/stop", { text: `${seq} ${"w".repeat(195)}` }, { window: "api" });
    await vi.waitFor(() => expect(sentCount(fleet)).toBe(60));
    const parts = delivered(pc);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(p => p.id)).toEqual(parts.map((_, i) => `fleet:lane-events:pc:${AT(1)}-${i + 1}`));   // one batch: -1, -2 …
    for (const p of parts) { expect(p.text.length).toBeLessThanOrEqual(8000); expect(p.text.split("\n")[0]).toBe(HEADER); }
    expect(parts.flatMap(p => linesOf(p.text).map(l => Number(String(l.firstLine).split(" ")[0])))).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(fleet.audit.of("delivery.post").map(e => e.detail.outcome)).toEqual(parts.map(() => "queued"));
  });

  it("events not delivered while the manager's node is offline go after a fleet restart, with one warning; a stored batch never goes twice", async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const log = createLogger({ level: "warn", sink: line => warnings.push(line) });
    const before = await startTestFleet({ dir, log, config: { laneEvents: CONFIG } });
    const pc = await managerNode(before);
    await pc.close();                                                                  // the manager's node goes offline
    await vi.waitFor(() => expect(before.connections.status("pc")).toBe("offline"));
    const mac = await before.online("mac");
    mac.hook(1, "/hook/stop", { text: "while pc is away" }, { window: "api", at: Date.now() });   // within 7 days: kept at the restart
    expect(await mac.acked(1)).toBe(1);
    await new Promise(r => setTimeout(r, 450));                                        // several batches, each refused node_offline
    expect(warnings.filter(w => w.includes("not delivered yet"))).toHaveLength(1);
    await before.close();
    const after = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const back = await managerNode(after, { key: pc });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    expect(linesOf(delivered(back)[0]?.text ?? "").map(l => l.firstLine)).toEqual(["while pc is away"]);
    await vi.waitFor(() => expect(sentCount(after)).toBe(1));                        // its answer is in: marked sent
    await after.close();
    const again = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const third = await managerNode(again, { key: pc });
    await new Promise(r => setTimeout(r, 300));
    expect(delivered(third)).toEqual([]);                                              // marked sent: not again
  });

  it("lane events stored while deliverTo was null are never delivered later, once it is turned on", async () => {
    const dir = tempDir();
    const off = await startTestFleet({ dir, config: { laneEvents: { ...CONFIG, deliverTo: null } } });
    const pc = await managerNode(off);
    pc.hook(1, "/hook/stop", { text: "before" }, { window: "api", at: Date.now() });
    expect(await pc.acked(1)).toBe(1);
    await off.close();
    const on = await startTestFleet({ dir, config: { laneEvents: CONFIG } });         // rollout step 3b
    const back = await managerNode(on, { key: pc });
    back.hook(2, "/hook/stop", { text: "after" }, { window: "api", at: Date.now() });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    await new Promise(r => setTimeout(r, 300));
    expect(delivered(back).flatMap(d => linesOf(d.text).map(l => l.firstLine))).toEqual(["after"]);   // negative control: "before" too
  });

  it("a batch given up while the fleet was down goes again after its start", async () => {
    const dir = tempDir();
    const before = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const pc = await managerNode(before);
    pc.hook(1, "/hook/stop", { text: "one" }, { window: "api", at: Date.now() });
    await vi.waitFor(() => expect(sentCount(before)).toBe(1));
    const id = delivered(pc)[0]?.id ?? "";
    await before.close();
    const db = openFleetDb(join(dir, "fleet.db"));                                    // the mirror says given up; the requeue was lost
    db.prepare("UPDATE lane_deliveries SET state = 'given_up', body = json_set(body, '$.state', 'given_up', '$.why', 'expired') WHERE id = ?").run(id);
    db.close();
    const after = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const back = await managerNode(after, { key: pc });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    expect(delivered(back)[0]?.id).toBe(`${id}.2`);                                   // negative control: no check at start, nothing
    expect(linesOf(delivered(back)[0]?.text ?? "").map(l => l.firstLine)).toEqual(["one"]);
  });

  it("an event committed while a batch is still being sent is delivered when that send ends, without another lane event", async () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const store = new LaneEventsStore(db);
    const texts: string[] = [];
    let posts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const push = new LaneEventsPush({
      store,
      deliveries: {
        post: async r => {
          posts++;
          texts.push(r.text);
          if (posts === 1) await gate;
          return { ok: true, delivery: { id: r.id, node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: 1, notAfter: 2 } };
        },
        get: () => null,
      },
      config: { ...CONFIG, batchMs: 20 },
      log: createLogger({ level: "error", sink: () => {} }),
    });
    const draft = (n: number, line: string) => ({
      v: 1 as const, t: "lane" as const, event: "finished" as const, node: "pc", window: "api", lane: "api", at: AT(n), firstLine: line,
    });
    store.insert(draft(1, "one"), 0);
    push.kick();
    await vi.waitFor(() => expect(posts).toBe(1));
    store.insert(draft(2, "two"), 0);
    push.kick();
    await new Promise(r => setTimeout(r, 50));                                 // the timer fires while the first post is still held
    release();
    await vi.waitFor(() => expect(posts).toBe(2));
    expect(texts.flatMap(t => linesOf(t).map(l => l.firstLine))).toEqual(["one", "two"]);
    db.close();
  });

  // Review (fleet-clients branch) #3: the node's answer and its given_up event can come in one read of the socket
  // (deliveries.ts): the event is mirrored before the post's answer is acted on, so the batch must not end up marked sent.
  it("a part given up in the same read as its queued answer waits again; it is never left marked sent", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    const queue = pc.answer;
    let raced = 0;
    pc.answer = req => {
      const a = queue(req);
      if (req.op !== "lane.deliver" || a === "never" || !a.ok || raced++ > 0) return a;
      const { delivery } = a.result as { delivery: Delivery };
      // The answer and the event leave in one write, so the fleet reads both at once (ws emits each at once: 8.22.0).
      const socket = (pc.ws as unknown as { _socket: Socket })._socket;
      socket.cork();
      queueMicrotask(() => { pc.delivery({ ...delivery, state: "given_up", why: "gone" }); socket.uncork(); });
      return a;
    };
    pc.hook(1, "/hook/stop", { text: "one" }, { window: "api" });
    await vi.waitFor(() => expect(delivered(pc)).toHaveLength(2), { timeout: 3000 });
    const [first, again] = delivered(pc);
    expect(again?.id).toBe(`${first?.id ?? ""}.2`);
    expect(again ? linesOf(again.text).map(l => l.firstLine) : []).toEqual(["one"]);
  });
});
