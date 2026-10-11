// The feed tells each device where its messages to the manager stand in the fleet's delivery queue (fleet-clients §9.1;
// the app's words are Task 13's): every one of the last day after a hello, then each change, by request id; never
// another device's. And the principal cancels one still waiting (ruling 83). A real hub HTTP server in this process, its
// queue over the fake fleet on a real Unix socket.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { FleetClient } from "@morndo/fleet-client";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { ManagerQueue, type NewDelivery } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let fleet: FakeFleet;
let hub: InProcessHub;
let queue: ManagerQueue | null = null;
let ws: WebSocket | null = null;
beforeEach(async () => {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
  hub = await startInProcessHub({ queue: store => (queue = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(fleet.socketPath)), lane: "manager", on: true, pollMs: 60_000 })) });
});
afterEach(async () => { ws?.close(); queue?.stop(); await hub.close(); await fleet.close(); });

const command = (endpointId: string, request: string): NewDelivery => ({
  deliveryId: `hub:${endpointId}:${request}`, kind: "command", escalationId: null, ask: null, choice: null, endpointId, sessionId: "s1", requestId: request, queuedAt: Date.now(),
});
async function feed(cookie: string) {
  const frames: { t: string; items?: unknown[] }[] = [];
  ws = await hub.socket("/api/feed", cookie);
  ws.on("message", raw => frames.push(JSON.parse(frameText(raw)) as { t: string; items?: unknown[] }));
  ws.send(JSON.stringify({ t: "hello" }));
  return frames;
}
const items = (frames: { t: string; items?: unknown[] }[]) => frames.filter(f => f.t === "deliveries").flatMap(f => f.items ?? []);

describe("the deliveries frame", () => {
  it("after a hello: this device's messages to the manager; then each change", async () => {
    const cookie = await hub.cookie();
    const me = hub.store.endpoints()[0]?.id ?? "";
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command(me, "r1"), "status please");
    const frames = await feed(cookie);
    await until(() => items(frames).length === 1);
    expect(items(frames)).toEqual([{ requestId: "r1", state: "queued", waiting: null, why: null }]);
    fleet.moveDelivery(`hub:${me}:r1`, { waiting: { reason: "draft_present", since: 1 } });
    fleet.moveDelivery(`hub:${me}:r1`, { state: "delivered", deliveredAt: 9 });
    await until(() => items(frames).some(i => (i as { state: string }).state === "delivered"));
    expect(items(frames).slice(1)).toEqual([
      { requestId: "r1", state: "queued", waiting: "draft_present", why: null },
      { requestId: "r1", state: "delivered", waiting: null, why: null },
    ]);
  });

  it("never another device's (negative control)", async () => {
    const cookie = await hub.cookie();
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command("ep-other", "r9"), "someone else's");
    const frames = await feed(cookie);
    await until(() => frames.some(f => f.t === "decisions"));
    fleet.moveDelivery("hub:ep-other:r9", { state: "delivered", deliveredAt: 9 });
    await new Promise(r => setTimeout(r, 200));
    expect(items(frames)).toEqual([]);
  });
});

describe("POST /api/manager/cancel (ruling 83)", () => {
  it("cancels one of this device's messages still waiting; too late once typed; no such message of another device's", async () => {
    const cookie = await hub.cookie();
    const me = hub.store.endpoints()[0]?.id ?? "";
    const q = queue as unknown as ManagerQueue;
    await q.start();
    await q.put(command(me, "11111111-1111-4111-8111-111111111111"), "never mind");
    await q.put(command(me, "22222222-2222-4222-8222-222222222222"), "status please");
    await q.put(command("ep-other", "33333333-3333-4333-8333-333333333333"), "someone else's");
    fleet.moveDelivery(`hub:${me}:22222222-2222-4222-8222-222222222222`, { state: "typed", typedAt: 5 });
    const cancel = async (requestId: string) => {
      const r = await hub.post("/api/manager/cancel", { requestId }, { cookie: `__Host-morndo=${cookie}` });
      return { status: r.status, body: await r.json() as unknown };
    };
    expect(await cancel("11111111-1111-4111-8111-111111111111")).toEqual({ status: 200, body: { ok: true, delivery: { requestId: "11111111-1111-4111-8111-111111111111", state: "given_up", waiting: null, why: "cancelled" } } });
    expect(await cancel("22222222-2222-4222-8222-222222222222")).toEqual({ status: 409, body: { error: "already_typed" } });
    expect(await cancel("33333333-3333-4333-8333-333333333333")).toEqual({ status: 404, body: { error: "unknown" } });
    expect(fleet.deliveries.get("hub:ep-other:33333333-3333-4333-8333-333333333333")?.delivery.state).toBe("queued");
  });

  it("a cancel the fleet refuses because the node is offline is not 409, so the app does not treat it as already typed", async () => {
    const cookie = await hub.cookie();
    const me = hub.store.endpoints()[0]?.id ?? "";
    const q = queue as unknown as ManagerQueue;
    await q.start();
    const requestId = "44444444-4444-4444-8444-444444444444";
    await q.put(command(me, requestId), "still waiting");
    await fleet.setStatus("pc", "offline");
    const r = await hub.post("/api/manager/cancel", { requestId }, { cookie: `__Host-morndo=${cookie}` });
    expect({ status: r.status, body: await r.json() }).toEqual({ status: 503, body: { error: "node_offline" } });
  });
});
