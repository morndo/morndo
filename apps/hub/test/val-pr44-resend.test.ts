// Review #44 (findings 1, 3, 5, 15) and PR #11 (findings 1 and 3), on the fleet's delivery queue (fleet-clients §9.1):
// a plain repeat of a request id is a status read. It answers where the message stands and never queues anything, even
// from a session that may not command. Only Send again (again: true) queues a message the queue gave up once more, as
// the second attempt under the same request id (`hub:<endpoint>:<request>~2`), and only after the same checks as a first
// send (AC7: a fresh passkey). One request is at most two messages, and never two that can both arrive. A body that can't
// be built again is cannot_resend. Over the fake fleet on a real Unix socket; synthetic data only.
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
import { localNode, memoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 10, 9);
const MANAGER = "pc.aaaaaaaa.0";
let dir: string;
let store: Store;
let rig: FleetRig;
let queues: ManagerQueue[] = [];
const endpoint: Authenticated["endpoint"] = { id: endpointId("ep1"), name: "Phone", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null };
const session = (verifiedAt: number): Authenticated => ({
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0 - 3_600_000, lastSeenAt: T0, verifiedAt, endedAt: null, endReason: null },
  endpoint,
});
const FRESH = session(T0 - 1000);
const LAPSED = session(T0 - 11 * 60_000);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-resend-"));
  store = new Store(dir);
  rig = await fleetRig([localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/manager", screen: "❯ ", sessionId: "s-m" } }))]);
});
afterEach(async () => { for (const q of queues.splice(0)) q.stop(); await rig.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// As main.ts builds it with a fleet. `expiredUpload`: the device's uploads store holds one image, 25 hours old.
async function steering(o: { expiredUpload?: boolean } = {}) {
  const queue = new ManagerQueue({ store, deliveries: fleetDeliveries(rig.client), lane: "manager", on: true, now: () => T0, pollMs: 60_000 });
  await queue.start();
  queues.push(queue);
  const inbox = o.expiredUpload ? { get: () => ({ id: "u", endpointId: endpoint.id, path: "/tmp/x.png", mime: "image/png" as const, size: 8, at: T0 - 25 * 3_600_000 }) } : null;
  const svc = new SteeringService(store, rig.ports.tmux, () => T0, () => ({ stay: "12h", stepUp: "10m" }), inbox, () => "none", () => null, rig.ports.uploads, rig.ports.sendStatus,
    { queue, isManager: id => id === MANAGER });
  return { svc, queue };
}
const commandsSent = () => store.audit(50).filter(a => a.type === "CommandSent");
async function givenUp(queue: ManagerQueue, id: string) {
  rig.fleet.moveDelivery(id, { state: "given_up", why: "expired" });
  await queue.poll();
}
const again = (svc: SteeringService, a: Authenticated, uploads: string[] = []) => svc.send(a, MANAGER, "ship it", "r1", uploads, undefined, undefined, undefined, true);

describe("a repeat is a status read", () => {
  it("of a message the queue gave up: given up, nothing queued, even from a session that may not command", async () => {
    const { svc, queue } = await steering();
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    await givenUp(queue, "hub:ep1:r1");
    expect(await svc.send(LAPSED, MANAGER, "ship it", "r1")).toMatchObject({ ok: false, problem: "duplicate", delivery: { requestId: "r1", state: "given_up", why: "expired" } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
    expect(commandsSent()).toHaveLength(1);
  });
  it("Send again of a message still queued, or delivered, reads where it stands and queues nothing", async () => {
    const { svc, queue } = await steering();
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    expect(await again(svc, FRESH)).toMatchObject({ ok: false, problem: "duplicate", delivery: { state: "queued" } });
    rig.fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 5 });
    await queue.poll();
    expect(await again(svc, FRESH)).toMatchObject({ ok: false, problem: "duplicate", delivery: { state: "delivered" } });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });
});

describe("Send again", () => {
  it("asks for a fresh passkey first (AC7): lapsed, step_up and nothing queued", async () => {
    const { svc, queue } = await steering();
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    await givenUp(queue, "hub:ep1:r1");
    expect(await again(svc, LAPSED)).toEqual({ ok: false, problem: "step_up" });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });
  it("queues the second attempt under the same request id, audited, and a repeat then reads that one", async () => {
    const { svc, queue } = await steering();
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    await givenUp(queue, "hub:ep1:r1");
    expect(await again(svc, FRESH)).toMatchObject({ ok: true, delivery: { requestId: "r1", state: "queued" } });
    expect(rig.fleet.deliveryCalls.map(c => c.id)).toEqual(["hub:ep1:r1", "hub:ep1:r1~2"]);
    expect(commandsSent()).toHaveLength(2);
    rig.fleet.moveDelivery("hub:ep1:r1~2", { state: "delivered", deliveredAt: T0 + 9 });
    await queue.poll();
    expect(await svc.send(LAPSED, MANAGER, "ship it", "r1")).toMatchObject({ ok: false, problem: "duplicate", at: T0 + 9, delivery: { state: "delivered" } });
  });
  it("at most two messages: the second, given up too, is final, and Send again then reads it", async () => {
    const { svc, queue } = await steering();
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    await givenUp(queue, "hub:ep1:r1");
    await again(svc, FRESH);
    await givenUp(queue, "hub:ep1:r1~2");
    expect(await again(svc, FRESH)).toMatchObject({ ok: false, problem: "duplicate", delivery: { state: "given_up" } });
    expect(rig.fleet.deliveryCalls).toHaveLength(2);
  });
  it("a body that can't be built again (its image expired) is cannot_resend, and nothing is queued", async () => {
    const { svc, queue } = await steering({ expiredUpload: true });
    await svc.send(FRESH, MANAGER, "ship it", "r1");
    await givenUp(queue, "hub:ep1:r1");
    expect(await again(svc, FRESH, ["u"])).toEqual({ ok: false, problem: "cannot_resend" });
    expect(rig.fleet.deliveryCalls).toHaveLength(1);
  });
});
