// The principal's messages to the manager through the fleet's delivery queue (fleet-clients §9.1): queued under the key
// a direct send types under (`hub:<endpoint>:<request>`), audited once, answered with where it stands; a repeat answers
// what became of it and queues nothing; one in doubt is asked again under its own id. Messages to other lanes stay typed
// directly. Off, the manager's are typed directly too, and one given up while off is typed then (nothing of it was typed).
// Over the fake fleet on a real Unix socket.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { localNode, memoryBackend, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
const MANAGER = "pc.aaaaaaaa.0";
const ALPHA = "pc.aaaaaaaa.1";
let dir: string;
let store: Store;
let backend: MemoryBackend;
let rig: FleetRig;
let queues: ManagerQueue[] = [];
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-steering-queue-"));
  store = new Store(dir);
  backend = memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-m" }, "%1": { name: "alpha", cwd: "/w/alpha", screen: "❯ ", sessionId: "s-a" } });
  rig = await fleetRig([localNode("pc", "aaaaaaaa", backend)]);
});
afterEach(async () => { for (const q of queues.splice(0)) q.stop(); await rig.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// SteeringService as main.ts builds it with a fleet: the manager's pane goes through the queue while it is on.
async function steering(o: { on?: boolean } = {}) {
  const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: o.on ?? true, now: () => T0, pollMs: 60_000 });
  await queue.start();
  queues.push(queue);
  const svc = new SteeringService(store, rig.ports.tmux, () => T0, undefined, null, () => "none", () => null, rig.ports.uploads, rig.ports.sendStatus,
    { queue, isManager: id => id === MANAGER });
  return { svc, queue };
}
const commandsSent = () => store.audit(50).filter(a => a.type === "CommandSent");

describe("a message to the manager through the queue", () => {
  it("is queued under the key a direct send would use, audited once, and answered with where it stands", async () => {
    const { svc } = await steering();
    const r = await svc.send(auth, MANAGER, "status please", "r1");
    expect(r).toEqual({ ok: true, at: expect.any(Number), delivery: { requestId: "r1", state: "queued", waiting: null, why: null } });
    expect(rig.fleet.deliveryCalls).toEqual([{ id: "hub:ep1:r1", lane: "manager", workerId: null, text: "status please" }]);
    expect(backend.typed).toEqual([]);
    expect(commandsSent()).toHaveLength(1);
  });

  it("a repeat answers what became of it, and queues nothing", async () => {
    const { svc, queue } = await steering();
    await svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await queue.poll();
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "duplicate", at: T0 + 9, delivery: { requestId: "r1", state: "delivered", waiting: null, why: null } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
    expect(commandsSent()).toHaveLength(1);
  });

  it("one in doubt (the fleet never answered, nor told) is uncertain; its repeat finds it, once", async () => {
    const { svc } = await steering();
    rig.fleet.loseDeliveryAnswers(1);
    rig.fleet.quietDeliveries(true);
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "uncertain" });
    expect(commandsSent()).toHaveLength(1);                                    // recorded when the hub queued it (ruling 28)
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true, delivery: { state: "queued" } });
    expect(rig.fleet.deliveries.size).toBe(1);
    expect(commandsSent()).toHaveLength(1);
  });

  it("a refusal says why, and nothing is queued or audited", async () => {
    const { svc } = await steering();
    await rig.client.lanes();
    await rig.fleet.setStatus("pc", "offline");
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "node_offline" });
    expect(commandsSent()).toEqual([]);
  });

  it("a message to another lane is typed directly, as before", async () => {
    const { svc } = await steering();
    expect(await svc.send(auth, ALPHA, "carry on", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%1", text: "carry on", key: "hub:ep1:r1" }]);
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });
});

describe("the switch off", () => {
  it("the manager's messages are typed directly, under the same key (negative control)", async () => {
    const { svc } = await steering({ on: false });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%0", text: "status please", key: "hub:ep1:r1" }]);
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });

  it("a message still in doubt is never typed directly on its repeat (ruling 49)", async () => {
    const { svc } = await steering({ on: false });
    // In doubt: its cancel at start went unanswered, so its row is still "sending".
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: T0, state: "sending", updatedAt: T0 });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toEqual({ ok: false, problem: "uncertain" });
    expect(backend.typed).toEqual([]);
  });

  it("one given up while the switch is off is typed directly on its repeat; while on, the repeat says given up", async () => {
    const on = await steering();
    await on.svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "given_up", why: "expired" });
    await on.queue.poll();
    expect(await on.svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: false, problem: "duplicate", delivery: { state: "given_up", why: "expired" } });
    on.queue.stop();
    const off = await steering({ on: false });
    expect(await off.svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true });
    expect(backend.typed).toEqual([{ pane: "%0", text: "status please", key: "hub:ep1:r1" }]);
  });
});

describe("waiting, and the principal's cancel (ruling 83: up to 24 hours, with why it waits and a cancel; no two-minute deadline, no Retry)", () => {
  const HOUR = 3_600_000;
  const waits = (id: string) => { const d = rig.fleet.deliveries.get(id)?.delivery; return d ? d.notAfter - d.queuedAt : null; };

  it("waits up to 24 hours from when it was written; a time that can't be right counts from its arrival", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "written an hour ago", "r1", [], undefined, undefined, T0 - HOUR);
    await svc.send(auth, MANAGER, "no time given", "r2");
    await svc.send(auth, MANAGER, "a clock ahead", "r3", [], undefined, undefined, T0 + HOUR);
    await svc.send(auth, MANAGER, "two days old", "r4", [], undefined, undefined, T0 - 48 * HOUR);
    expect(["hub:ep1:r1", "hub:ep1:r2", "hub:ep1:r3", "hub:ep1:r4"].map(waits)).toEqual([23 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it("still waiting: the principal cancels it, and nothing reaches the manager", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "never mind", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { waiting: { reason: "busy", since: T0 } });
    expect(await svc.cancel(auth, "r1")).toEqual({ ok: true, delivery: { requestId: "r1", state: "given_up", waiting: null, why: "cancelled" } });
    expect(rig.fleet.cancels).toEqual(["hub:ep1:r1"]);
    expect(await svc.cancel(auth, "r1")).toMatchObject({ ok: true, delivery: { state: "given_up" } });   // again: what it came to
    expect(backend.typed).toEqual([]);
  });

  it("typed already: too late; another device's message, or a message to another lane, is no such message (negative control)", async () => {
    const { svc } = await steering();
    await svc.send(auth, MANAGER, "status please", "r1");
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });
    expect(await svc.cancel(auth, "r1")).toEqual({ ok: false, problem: "already_typed" });
    const other: Authenticated = { ...auth, endpoint: { ...auth.endpoint, id: endpointId("ep2") } };
    expect(await svc.cancel(other, "r1")).toEqual({ ok: false, problem: "unknown" });
    await svc.send(auth, ALPHA, "carry on", "r2");
    expect(await svc.cancel(auth, "r2")).toEqual({ ok: false, problem: "unknown" });
  });
});

// #29's review cases (its tests went with its inbox; ruling 81), on the queue.
describe("#29's review cases, on the queue", () => {
  it("B9: a message empty once control characters go is refused as empty, and nothing is queued", async () => {
    const { svc } = await steering();
    expect(await svc.send(auth, MANAGER, "\u001b\u0007\u0000 \r\n", "r1")).toEqual({ ok: false, problem: "empty" });
    expect(rig.fleet.deliveryCalls).toEqual([]);
  });

  it("B10: the manager is the pane its window has now; with that window gone, a message is no_pane, and nothing is queued", async () => {
    const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: true, now: () => T0, pollMs: 60_000 });
    await queue.start();
    queues.push(queue);
    // As main.ts wires it: the manager is the pane the roster names for the manager's window, right now.
    const managerPane = () => (backend.panes["%0"] ? MANAGER : null);
    const svc = new SteeringService(store, rig.ports.tmux, () => T0, undefined, null, () => "none", () => null, rig.ports.uploads, rig.ports.sendStatus,
      { queue, isManager: id => id === managerPane() });
    expect(await svc.send(auth, MANAGER, "status please", "r1")).toMatchObject({ ok: true, delivery: { state: "queued" } });
    delete backend.panes["%0"];
    expect(await svc.send(auth, MANAGER, "are you there?", "r2")).toEqual({ ok: false, problem: "no_pane" });
    expect(rig.fleet.deliveryCalls.map(c => c.id)).toEqual(["hub:ep1:r1"]);
  });
});
