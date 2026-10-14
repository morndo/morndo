// The deliveries' mirror (fleet clients spec §4.4, §4.5, §4.6): ev.delivery's latest state wins; a final state stays; an
// answer never replaces a newer event's state; `stale` while the node is offline; a `delivery` event per change; the
// list by lane and state, the newest of the last 7 days; cancel through the node that stored it; delivery_waiting at
// 2, 15 and 60 minutes, once each, across a restart, never for a final or stale delivery.
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { deliveryOf, nodeQueue, T0 } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const api = (fleet: TestFleet) => client(fleet.config.socketPath);
const one = (fleet: TestFleet, id: string) => api(fleet).get(`/v1/deliveries/${encodeURIComponent(id)}`);
const stateOf = async (fleet: TestFleet, id: string) => ((await one(fleet, id))?.body as { delivery?: Delivery } | undefined)?.delivery?.state;
const MIN = 60_000;

describe("the deliveries' mirror", () => {
  it("takes each ev.delivery, latest wins; a final state stays; each change is a delivery event", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const events = await api(fleet).events();
    pc.delivery(deliveryOf("pc", "hub:a", { waiting: { reason: "menu_open", since: T0 } }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "typed", typedAt: T0 + 5, sessionId: "s1" }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "delivered", typedAt: T0 + 5, deliveredAt: T0 + 9, sessionId: "s1" }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "typed", typedAt: T0 + 5, sessionId: "s1" }));     // late: never over a final state
    pc.delivery(deliveryOf("pc", "hub:a", { state: "delivered", typedAt: T0 + 5, deliveredAt: T0 + 9, sessionId: "s1" }));   // the same again
    await vi.waitFor(() => expect(events.received.filter(e => e.t === "delivery")).toHaveLength(3));
    await new Promise(r => setTimeout(r, 50));
    expect(events.received.filter(e => e.t === "delivery").map(e => [e.node, (e.body as Delivery & { stale: boolean }).state, (e.body as { stale: boolean }).stale]))
      .toEqual([["pc", "queued", false], ["pc", "typed", false], ["pc", "delivered", false]]);
    expect(await stateOf(fleet, "hub:a")).toBe("delivered");                          // negative control: no final guard leaves "typed"
    expect(fleet.audit.of("delivery.final").map(e => e.detail)).toEqual([{ id: "hub:a", state: "delivered" }]);
    events.close();
  });

  it("marks the mirror stale while the node is offline", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:s"));
    await vi.waitFor(async () => expect(await one(fleet, "hub:s")).toMatchObject({ status: 200, body: { stale: false } }));
    await pc.close();
    await vi.waitFor(async () => expect(await one(fleet, "hub:s")).toMatchObject({ status: 200, body: { stale: true } }));
    expect(await api(fleet).get("/v1/deliveries/nothing%3Ahere")).toEqual({ status: 404, body: { error: "no_such_delivery" } });
  });

  it("closes a connection that reports another node's delivery (1008)", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("mac", "hub:x"));
    expect((await pc.closed).code).toBe(1008);
  });

  // Review (fleet-clients branch) #2: a node replays its deliveries after every welcome, so closing it for an id another
  // node holds would close it again on every reconnect, for as long as it keeps that delivery (7 days).
  it("a node reporting another node's delivery id stays connected; the report is dropped, the row and its routing stay with the owner", async () => {
    const fleet = await startTestFleet();
    const mac = await fleet.online("mac");
    const pc = await fleet.online("pc");
    mac.delivery(deliveryOf("mac", "hub:x", { state: "typed", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:x")).toBe("typed"));
    pc.delivery(deliveryOf("pc", "hub:x", { state: "given_up", why: "cancelled" }));
    pc.delivery(deliveryOf("pc", "hub:own"));                                        // its own, after the foreign one
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:own")).toBe("queued"));
    expect(pc.open).toBe(true);
    expect(fleet.audit.of("delivery.foreign").map(e => e.detail)).toEqual([{ id: "hub:x", owner: "mac" }]);
    expect(await stateOf(fleet, "hub:x")).toBe("typed");
    await api(fleet).post(`/v1/deliveries/${encodeURIComponent("hub:x")}/cancel`);
    expect(mac.reqs.filter(r => r.op === "delivery.cancel").map(r => r.args)).toEqual([{ id: "hub:x" }]);
    expect(pc.reqs.filter(r => r.op === "delivery.cancel")).toEqual([]);
  });

  it("an answer whose delivery id is not the one asked does not move another node's row", async () => {
    const fleet = await startTestFleet();
    const mac = await fleet.online("mac");
    const pc = await fleet.online("pc");
    mac.delivery(deliveryOf("mac", "hub:x", { state: "typed", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:x")).toBe("typed"));
    nodeQueue(pc);
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    pc.answer = req => {
      if (req.op !== "lane.deliver") return { ok: true, result: { panes: [], invVersion: 1 } };
      return { ok: true, result: { delivery: deliveryOf("pc", "hub:x", { state: "given_up", why: "cancelled" }) } };
    };
    await api(fleet).post("/v1/deliveries", { id: "kira:new", lane: "api", text: "x" });
    expect(await stateOf(fleet, "hub:x")).toBe("typed");
    expect(await one(fleet, "kira:new")).toMatchObject({ status: 404 });
  });

  it("an answer fills a row the mirror lacks, but never replaces a newer event's state", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    nodeQueue(pc);                                                                    // answers the stored state: queued
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    await api(fleet).post("/v1/deliveries", { id: "kira:r", lane: "api", text: "x" });
    expect(await stateOf(fleet, "kira:r")).toBe("queued");
    pc.delivery(deliveryOf("pc", "kira:r", { state: "typed", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "kira:r")).toBe("typed"));
    await api(fleet).post("/v1/deliveries", { id: "kira:r", lane: "api", text: "x" });   // a retry: the node answers "queued" (older)
    expect(await stateOf(fleet, "kira:r")).toBe("typed");
  });

  it("lists by lane and state, the newest of the last 7 days, oldest first; a state that isn't one is 400", async () => {
    let now = T0;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:old"));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:old")).toBe("queued"));
    now += LIMITS.deliveryKeepMs + 1;
    pc.delivery(deliveryOf("pc", "hub:1"));
    pc.delivery(deliveryOf("pc", "hub:2", { target: { lane: "manager" } }));
    pc.delivery(deliveryOf("pc", "hub:3", { target: { lane: "manager" }, state: "given_up", why: "expired" }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:3")).toBe("given_up"));
    const ids = async (q: string) => (((await api(fleet).get(`/v1/deliveries${q}`))?.body as { deliveries?: Delivery[] } | undefined)?.deliveries ?? []).map(d => d.id);
    expect(await ids("")).toEqual(["hub:1", "hub:2", "hub:3"]);                        // hub:old is past 7 days
    expect(await ids("?lane=manager")).toEqual(["hub:2", "hub:3"]);
    expect(await ids("?lane=manager&state=queued")).toEqual(["hub:2"]);
    expect(await api(fleet).get("/v1/deliveries?state=lost")).toMatchObject({ status: 400 });
    expect(fleet.deliveries.prune()).toBe(1);                                         // the hourly prune takes hub:old
  });

  it("cancel goes to the node that stored the delivery; already_typed passes through; an id the fleet doesn't know is 404 no_such_delivery", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const stored = nodeQueue(pc);
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    await api(fleet).post("/v1/deliveries", { id: "kira:c1", lane: "api", text: "x" });
    await api(fleet).post("/v1/deliveries", { id: "kira:c2", lane: "api", text: "y" });
    const typed = stored.get("kira:c2");
    if (typed) stored.set("kira:c2", { ...typed, state: "typed" });
    expect(await api(fleet).post(`/v1/deliveries/${encodeURIComponent("kira:c1")}/cancel`))
      .toEqual({ status: 200, body: { ok: true, delivery: expect.objectContaining({ state: "given_up", why: "cancelled" }) } });
    expect(await stateOf(fleet, "kira:c1")).toBe("given_up");
    expect(await api(fleet).post(`/v1/deliveries/${encodeURIComponent("kira:c2")}/cancel`)).toMatchObject({ status: 200, body: { ok: false, error: { code: "already_typed" } } });
    expect(await api(fleet).post("/v1/deliveries/kira%3Anever/cancel")).toEqual({ status: 404, body: { error: "no_such_delivery" } });
    expect(pc.reqs.filter(r => r.op === "delivery.cancel").map(r => r.args)).toEqual([{ id: "kira:c1" }, { id: "kira:c2" }]);
    expect(fleet.audit.of("delivery.cancel").map(e => e.detail.outcome)).toEqual(["given_up", "already_typed"]);
  });
});

describe("delivery_waiting", () => {
  it("at 2, 15 and 60 minutes, once each, and not again after a restart; never for a final delivery", async () => {
    let now = T0;
    const dir = tempDir();
    const first = await startTestFleet({ dir, now: () => now });
    const pc = await first.online("pc");
    pc.delivery(deliveryOf("pc", "hub:w", { waiting: { reason: "menu_open", since: T0 } }));
    pc.delivery(deliveryOf("pc", "hub:done", { state: "delivered", deliveredAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(first, "hub:done")).toBe("delivered"));
    const alerts = (f: TestFleet) => f.audit.of("alert.delivery_waiting").map(e => [e.node, e.detail.id, e.detail.minutes, e.detail.state, e.detail.reason]);
    now = T0 + 2 * MIN - 1;
    first.deliveries.scanAlerts();
    expect(alerts(first)).toEqual([]);
    now = T0 + 2 * MIN;
    first.deliveries.scanAlerts();
    first.deliveries.scanAlerts();
    expect(alerts(first)).toEqual([["pc", "hub:w", 2, "queued", "menu_open"]]);       // negative control: no `alerted` raises it twice
    expect(first.audit.of("alert.delivery_waiting")[0]?.detail).toEqual({ id: "hub:w", lane: "api", state: "queued", reason: "menu_open", minutes: 2 });
    now = T0 + 15 * MIN;
    first.deliveries.scanAlerts();
    expect(alerts(first).map(a => a[2])).toEqual([2, 15]);
    await first.close();
    const again = await startTestFleet({ dir, now: () => now });                      // a restart: `alerted` is kept in fleet.db
    const back = again.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    again.deliveries.scanAlerts();
    expect(alerts(again).map(a => a[2])).toEqual([2, 15]);
    now = T0 + 60 * MIN;
    again.deliveries.scanAlerts();
    expect(alerts(again).map(a => a[2])).toEqual([2, 15, 60]);
  });

  it("skips a stale delivery until its node reports, and raises only the highest threshold a scan finds crossed", async () => {
    let now = T0;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:late", { state: "held", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:late")).toBe("held"));
    await pc.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    now = T0 + 20 * MIN;
    fleet.deliveries.scanAlerts();
    expect(fleet.audit.of("alert.delivery_waiting")).toEqual([]);                    // offline: its state may be old
    const back = fleet.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    fleet.deliveries.scanAlerts();
    expect(fleet.audit.of("alert.delivery_waiting").map(e => e.detail.minutes)).toEqual([15]);
  });
});

describe("ev.delivery and the per-node rate limit", () => {
  it("a node replaying 200 delivery states at once after a reconnect is not closed (inventory and health are)", async () => {
    const fleet = await startTestFleet({ agentLimits: { capacity: 20, refillPerSecond: 1 } });
    const pc = await fleet.online("pc");
    for (let i = 0; i < 200; i++) pc.delivery(deliveryOf("pc", `hub:${i}`));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:199")).toBe("queued"));
    expect(pc.open).toBe(true);                                                       // negative control: rate limited, closed 1008
  });
});
