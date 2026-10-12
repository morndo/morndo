// The manager is always on the phone's and the desktop's list (QA on two machines): POST /api/manager/send writes to it by
// its role. Into its window when it has one; while it has none (a restart), into the fleet's queue for its sticky lane;
// with the queue off, or with files, no_pane. The feed's `manager` frame tells the app which. A real hub HTTP server in
// this process, its queue over the fake fleet on a real Unix socket.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { FleetClient } from "@morndo/fleet-client";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let fleet: FakeFleet | null = null;
let hub: InProcessHub;
let queue: ManagerQueue | null = null;
let ws: WebSocket | null = null;
afterEach(async () => { ws?.close(); ws = null; queue?.stop(); queue = null; await hub.close(); await fleet?.close(); fleet = null; });

async function start(o: { queue: "on" | "off" | "none"; manager?: string; typed?: string[] }) {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
  const socket = fleet.socketPath;
  hub = await startInProcessHub({
    ...(o.queue === "none" ? {} : { queue: store => (queue = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(socket)), lane: "manager", on: o.queue === "on", pollMs: 60_000 })) }),
    ...(o.manager ? { manager: o.manager } : {}), ...(o.typed ? { typed: o.typed } : {}),
  });
  if (queue) await queue.start();
  return hub.cookie();
}
const R1 = randomUUID();
const send = (cookie: string, body: Record<string, unknown>) =>
  hub.post("/api/manager/send", { text: "status please", requestId: R1, seen: "none", createdAt: Date.now(), ...body }, { cookie: `__Host-morndo=${cookie}` });

describe("POST /api/manager/send", () => {
  it("no manager window, the queue on: queued for its sticky lane; the same request again is a status read, never a second message", async () => {
    const cookie = await start({ queue: "on" });
    const r = await send(cookie, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, delivery: { requestId: R1 } });
    expect(fleet?.deliveryCalls).toEqual([expect.objectContaining({ lane: "manager", workerId: null, text: "status please" })]);
    const again = await send(cookie, {});
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ error: "duplicate", ok: true, delivery: { requestId: R1 } });
    expect(fleet?.deliveryCalls).toHaveLength(1);
  });

  it("no manager window and the queue off: no_pane, nothing queued", async () => {
    const off = await send(await start({ queue: "off" }), {});
    expect([off.status, await off.json()]).toEqual([404, { error: "no_pane" }]);
    expect(fleet?.deliveryCalls).toEqual([]);
  });

  it("no manager window and files: no_pane (they go onto its machine), nothing queued", async () => {
    const files = await send(await start({ queue: "on" }), { uploads: ["0123456789abcdef0123456789abcdef"] });
    expect([files.status, await files.json()]).toEqual([404, { error: "no_pane" }]);
    expect(fleet?.deliveryCalls).toEqual([]);
  });

  it("its window there, the queue on: through the queue, as any send to the manager", async () => {
    expect((await send(await start({ queue: "on", manager: "pc.aaaaaaaa.0" }), {})).status).toBe(200);
    expect(fleet?.deliveryCalls).toEqual([expect.objectContaining({ lane: "manager" })]);
  });

  it("its window there, without a fleet: typed into that window", async () => {
    const typed: string[] = [];
    const r = await send(await start({ queue: "none", manager: "%7", typed }), {});
    expect(r.status).toBe(200);
    expect(typed).toEqual(["%7"]);
  });
});

describe("the feed's manager frame", () => {
  const managerFrame = async (cookie: string) => {
    const frames: { t: string; queue?: boolean }[] = [];
    ws = await hub.socket("/api/feed", cookie);
    ws.on("message", raw => frames.push(JSON.parse(frameText(raw)) as { t: string; queue?: boolean }));
    ws.send(JSON.stringify({ t: "hello" }));
    await until(() => frames.some(f => f.t === "manager"));
    return frames.find(f => f.t === "manager");
  };
  it("after every hello: true with the queue on", async () => {
    expect(await managerFrame(await start({ queue: "on" }))).toEqual({ t: "manager", queue: true });
  });
  it("false with the queue off, and without a fleet", async () => {
    expect(await managerFrame(await start({ queue: "off" }))).toEqual({ t: "manager", queue: false });
  });
  it("false without a fleet", async () => {
    expect(await managerFrame(await start({ queue: "none" }))).toEqual({ t: "manager", queue: false });
  });
});
