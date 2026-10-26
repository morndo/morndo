// The hub's port onto the fleet's delivery queue (fleet-clients §4, §8, §9.1), over the fake fleet on a real Unix socket:
// a delivery queued, the same id again (its state now, nothing queued twice), the fleet's refusals (nothing queued),
// a fleet that can't be reached (node_offline: nothing queued, §10) and one that took it and never answered (in doubt),
// a delivery read back, cancelled, followed by its events, and the fleet's sticky names. Synthetic panes only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { FleetClient } from "@morndo/fleet-client";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import type { Deliveries } from "../src/application/ports.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

let fleet: FakeFleet;
let port: Deliveries;
let stops: (() => void)[] = [];
const panes = () => ({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-manager" }, "%1": { name: "alpha", cwd: "/w/alpha", screen: "❯ " } });
beforeEach(async () => {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend(panes()))] });
  port = fleetDeliveries(new FleetClient(fleet.socketPath));
});
afterEach(async () => { for (const s of stops.splice(0)) s(); await fleet.close(); });

describe("the fleet's delivery queue, as the hub's port", () => {
  it("queues a delivery to a lane by name; the same id again answers its state and queues nothing", async () => {
    const r = await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    expect(r).toMatchObject({ ok: true, delivery: { id: "hub:ep1:r1", node: "pc", target: { lane: "manager" }, state: "queued" } });
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: 5 });
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" })).toMatchObject({ ok: true, delivery: { state: "typed" } });
    expect(fleet.deliveries.size).toBe(1);
    expect(fleet.clients.every(c => c === "hub")).toBe(true);
  });

  it("asks for how long it may wait: the fleet's 24 hours, or the ttlMs it is given", async () => {
    const wait = (r: Awaited<ReturnType<Deliveries["deliver"]>>) => (r.ok ? r.delivery.notAfter - r.delivery.queuedAt : null);
    expect(wait(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "now or tomorrow" }))).toBe(LIMITS.deliveryTtlMs);
    expect(wait(await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "within the hour", ttlMs: 3_600_000 }))).toBe(3_600_000);
  });

  it("the fleet's refusals queue nothing, and say so", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "one" });
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "another" })).toEqual({ ok: false, refused: "id_conflict" });
    expect(await port.deliver({ id: "hub:ep1:r2", lane: "nobody", text: "x" })).toEqual({ ok: false, refused: "no_pane" });
    await fleet.setStatus("pc", "offline");
    expect(await port.deliver({ id: "hub:ep1:r3", lane: "manager", text: "x" })).toEqual({ ok: false, refused: "node_offline" });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("a fleet that can't be reached is node_offline (nothing queued); one that took it and never answered is in doubt", async () => {
    fleet.loseDeliveryAnswers(1);
    expect(await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "lost" })).toEqual({ ok: false, inDoubt: true });
    expect(fleet.deliveries.has("hub:ep1:r1")).toBe(true);                          // it was queued after all
    await fleet.close();
    expect(await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "x" })).toEqual({ ok: false, refused: "node_offline" });
    expect(await port.get("hub:ep1:r1")).toBe("unavailable");
    expect(await port.stickyLanes()).toBeNull();
    fleet = await startFakeFleet({ nodes: [] });                                     // for afterEach
  });

  it("reads a delivery back, or null for one the fleet doesn't know (negative control)", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    fleet.moveDelivery("hub:ep1:r1", { state: "queued", waiting: { reason: "menu_open", since: 7 } });
    expect(await port.get("hub:ep1:r1")).toMatchObject({ id: "hub:ep1:r1", state: "queued", waiting: { reason: "menu_open" } });
    expect(await port.get("hub:ep1:nope")).toBeNull();
  });

  it("cancels a queued delivery; one typed already is refused already_typed; one the fleet doesn't know is unknown (ruling 56)", async () => {
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    await port.deliver({ id: "hub:ep1:r2", lane: "manager", text: "y" });
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: 5 });
    expect(await port.cancel("hub:ep1:r1")).toMatchObject({ ok: true, delivery: { state: "given_up", why: "cancelled" } });
    expect(await port.cancel("hub:ep1:r2")).toEqual({ ok: false, refused: "already_typed" });
    expect(await port.cancel("hub:ep1:nope")).toEqual({ ok: false, unknown: true });
  });

  it("follows each delivery's changes as events, and says when its subscription opens", async () => {
    const seen: Delivery[] = [];
    let opened = 0;
    stops.push(port.subscribe(d => seen.push(d), () => { opened++; }));
    await until(() => opened === 1);
    await port.deliver({ id: "hub:ep1:r1", lane: "manager", text: "x" });
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: 9 });
    await until(() => seen.some(d => d.state === "delivered"));
    expect(seen.map(d => d.state)).toEqual(["queued", "delivered"]);
  });

  it("names the fleet's sticky lanes", async () => {
    expect(await port.stickyLanes()).toEqual(["manager"]);
  });
});
