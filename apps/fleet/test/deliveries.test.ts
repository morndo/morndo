// Deliveries through the fleet (fleet clients spec §4.6, §8): POST /v1/deliveries routes a lane name through the lane
// registry, a sticky name whose window is gone to the node that last reported it, a worker ID to its node, and a known
// id back to the node that stored it; it sends lane.deliver with { lane, sticky } or { workerId }; lane_conflict,
// no_pane and node_offline are refused and nothing is sent. The answer is mirrored and audited, never the text.
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { nodeQueue } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const W = (node: string, n: number) => `${node}.3fa2c1d0.${n}`;
const pane = (node: string, n: number, window: string): Pane => ({ workerId: W(node, n), window, cwd: "/work", status: "idle", pid: 100 + n });
const post = (fleet: TestFleet, body: unknown, who = "kira") => client(fleet.config.socketPath).raw("/v1/deliveries", {
  method: "POST", headers: { "content-type": "application/json", "x-morndo-client": who }, body: JSON.stringify(body),
}).then(r => ({ status: r.status, body: JSON.parse(r.body.toString()) as Record<string, unknown> }));
const sent = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.deliver").map(r => r.args);

async function nodeWith(fleet: TestFleet, node: string, windows: string[]): Promise<FakeAgent> {
  const a = await fleet.online(node);
  nodeQueue(a);
  a.inventory(windows.map((w, i) => pane(node, i, w)));
  await vi.waitFor(() => expect(fleet.lanes.list().filter(l => l.node === node).map(l => l.name).sort()).toEqual([...new Set(windows)].sort()));
  return a;
}

describe("POST /v1/deliveries", () => {
  it("sends lane.deliver to the lane's node with { lane, sticky: false }; the answer is mirrored, and audited without the text", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    const r = await post(fleet, { id: "kira:tap-1", lane: "api", text: "the secret words", ttlMs: 60_000 });
    expect(r).toEqual({ status: 200, body: { ok: true, delivery: expect.objectContaining({ id: "kira:tap-1", node: "pc", state: "queued", target: { lane: "api" } }) } });
    expect(sent(pc)).toEqual([{ id: "kira:tap-1", target: { lane: "api", sticky: false }, text: "the secret words", ttlMs: 60_000 }]);
    expect(await client(fleet.config.socketPath).get(`/v1/deliveries/${encodeURIComponent("kira:tap-1")}`))
      .toEqual({ status: 200, body: { delivery: expect.objectContaining({ id: "kira:tap-1", state: "queued" }), stale: false } });
    expect(fleet.audit.of("delivery.post").map(e => [e.node, e.detail])).toEqual([["pc", { id: "kira:tap-1", target: { lane: "api" }, client: "kira", outcome: "queued" }]]);
    expect(JSON.stringify(fleet.audit.recent(100))).not.toContain("secret");
  });

  it("a sticky name whose window is gone goes to the node that last reported it, as { lane, sticky: true }; another unknown name is no_pane", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["manager", "api"]);
    pc.inventory([pane("pc", 1, "api")]);                                             // the manager restarts: its window is gone
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    expect((await post(fleet, { id: "hub:answer:e1:a1:c1", lane: "manager", text: "yes" })).body).toMatchObject({ ok: true, delivery: { state: "queued" } });
    expect(sent(pc)).toEqual([{ id: "hub:answer:e1:a1:c1", target: { lane: "manager", sticky: true }, text: "yes" }]);
    expect((await post(fleet, { id: "kira:2", lane: "gone-lane", text: "x" })).body)
      .toEqual({ ok: false, error: { code: "no_pane", executed: "no", message: expect.stringContaining("gone-lane") } });
    expect(sent(pc)).toHaveLength(1);                                                 // negative control: no sticky fallback refuses manager too
  });

  it("without stickyLanes the manager is an ordinary name: { sticky: false }, and no_pane once its window is gone", async () => {
    const fleet = await startTestFleet({ config: { stickyLanes: [] } });
    const pc = await nodeWith(fleet, "pc", ["manager"]);
    await post(fleet, { id: "hub:1", lane: "manager", text: "x" });
    expect(sent(pc)).toEqual([{ id: "hub:1", target: { lane: "manager", sticky: false }, text: "x" }]);
    pc.inventory([]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    expect((await post(fleet, { id: "hub:2", lane: "manager", text: "x" })).body).toMatchObject({ ok: false, error: { code: "no_pane" } });
  });

  it("sticky_lanes follows the node that last reported the name", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["manager"]);
    pc.inventory([]);
    const mac = await nodeWith(fleet, "mac", ["manager"]);
    mac.inventory([]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    await post(fleet, { id: "hub:moved", lane: "manager", text: "x" });
    expect([sent(pc).length, sent(mac).length]).toEqual([0, 1]);
  });

  it("a sticky name survives a fleet restart: with fleet.db reopened, it still goes to the node that last had it", async () => {
    const dir = tempDir();
    const before = await startTestFleet({ dir });
    const pc = await nodeWith(before, "pc", ["manager"]);
    await before.close();
    const after = await startTestFleet({ dir });                                      // the same fleet.db, reopened
    const back = after.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    nodeQueue(back);
    back.inventory([]);                                                               // the manager restarting: its window is gone
    await vi.waitFor(() => expect(after.lanes.get("manager")).toBeNull());
    expect((await post(after, { id: "hub:after-restart", lane: "manager", text: "yes" })).body).toMatchObject({ ok: true, delivery: { node: "pc" } });
    expect(sent(back)).toEqual([{ id: "hub:after-restart", target: { lane: "manager", sticky: true }, text: "yes" }]);   // negative control: no_pane
    back.inventory([pane("pc", 0, "manager")]);                                      // the same pane, back
    await vi.waitFor(() => expect(after.lanes.get("manager")).toMatchObject({ node: "pc", workerId: W("pc", 0) }));
  });

  it("refuses a name in conflict (lane_conflict) and a node offline (node_offline); neither sends anything", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api", "api", "manager"]);
    expect((await post(fleet, { id: "kira:c", lane: "api", text: "x" })).body).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" } });
    await pc.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect((await post(fleet, { id: "hub:off", lane: "manager", text: "x" })).body).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(sent(pc)).toEqual([]);
  });

  it("a worker ID goes to its node as { workerId }; an id the fleet knows goes back to the node that stored it", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    await post(fleet, { id: "lanes:w", workerId: W("pc", 0), text: "x" });
    expect(sent(pc)).toEqual([{ id: "lanes:w", target: { workerId: W("pc", 0) }, text: "x" }]);
    await post(fleet, { id: "hub:k", lane: "api", text: "y" });
    pc.inventory([]);                                                                 // the lane moves to another node
    const mac = await nodeWith(fleet, "mac", ["api"]);
    expect((await post(fleet, { id: "hub:k", lane: "api", text: "y" })).body).toMatchObject({ ok: true, delivery: { node: "pc" } });
    expect(sent(pc)).toHaveLength(3);                                                 // negative control: routed by name, mac gets it twice over
    expect(sent(mac)).toEqual([]);
  });

  it("a body that doesn't fit, lane.deliver's own rules included, is 400 bad_args, and not JSON 415; nothing is sent", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    for (const body of [{}, { id: "k:1", lane: "api", workerId: W("pc", 0), text: "x" }, { id: "k:1", lane: "api", text: "x", expect: {} },
      { id: 1, lane: "api", text: "x" }, { id: "k:1", lane: "api" }, { id: "k:1", lane: "api", text: "x", ttlMs: 1.5 }, { id: "k:1", lane: "", text: "x" }]) {
      expect(await post(fleet, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" } } });
    }
    for (const body of [{ id: "no-namespace", lane: "api", text: "x" }, { id: `k:${"a".repeat(200)}`, lane: "api", text: "x" },
      { id: "k:1", lane: "api", text: "" }, { id: "k:1", lane: "api", text: "x".repeat(8001) }, { id: "k:1#2", lane: "api", text: "x" }]) {
      expect(await post(fleet, body), JSON.stringify(body).slice(0, 60)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" } } });
    }
    const r = await client(fleet.config.socketPath).raw("/v1/deliveries", { method: "POST", body: "{}" });
    expect([r.status, JSON.parse(r.body.toString())]).toMatchObject([415, { ok: false, error: { code: "bad_args" } }]);
    expect(sent(pc)).toEqual([]);
  });

  it("POST /v1/op refuses lane.deliver and delivery.cancel: deliveries go through /v1/deliveries", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    for (const [op, args] of [["lane.deliver", { id: "k:1", target: { lane: "api", sticky: false }, text: "x" }], ["delivery.cancel", { id: "k:1" }]] as const) {
      expect(await client(fleet.config.socketPath).post("/v1/op", { node: "pc", op, args }))
        .toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", message: expect.stringContaining("use /v1/deliveries") } } });
    }
    expect(pc.reqs).toEqual([]);
  });

  it("an answer lost after lane.deliver was sent is uncertain (executed maybe), never node_offline", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    pc.answer = () => "never";
    const answer = post(fleet, { id: "hub:lost", lane: "api", text: "x" });
    await vi.waitFor(() => expect(sent(pc)).toHaveLength(1));
    await fleet.close();
    expect((await answer).body).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
  });
});
