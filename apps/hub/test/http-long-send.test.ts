// A message the principal types reaches its lane whole at the new bound: POST /api/workers/:id/send takes
// LIMITS.maxMessageText characters and types exactly what was posted, through the fleet as production sends; the
// manager's route queues the same whole text for its lane. One character more is 400 (the body's own schema, before
// any service sees it), and a body over the send routes' byte cap is 413 before it is read.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FleetClient } from "@morndo/fleet-client";
import { LIMITS } from "@morndo/protocol";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import { ManagerQueue } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
import { fleetRig, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";
import { ORIGIN, startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const RID = randomUUID();
const WHOLE = 'ü€"\n'.repeat(24_999) + 'ü€".';               // exactly maxMessageText, with what a paste must survive

let rig: FleetRig | null = null;
let hub: InProcessHub | null = null;
let fleet: FakeFleet | null = null;
let queue: ManagerQueue | null = null;
afterEach(async () => { queue?.stop(); queue = null; await hub?.close(); hub = null; await rig?.close(); rig = null; await fleet?.close(); fleet = null; });

describe("a long message through the hub's HTTP", () => {
  it("POST /api/workers/:id/send types the whole message, exactly, through the fleet", async () => {
    const backend = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "❯ " } });
    const made = await fleetRig([localNode("pc", "aaaaaaaa", backend)]);
    rig = made;
    hub = await startInProcessHub({ steering: store => steeringFor(made.ports, { store }) });
    await made.ports.tmux.listWorkers();
    const cookie = await hub.cookie();
    const r = await hub.post("/api/workers/pc.aaaaaaaa.1/send", { text: WHOLE, requestId: RID, seen: "none" }, { cookie: `__Host-morndo=${cookie}` });
    expect(r.status, await r.text()).toBe(200);
    await until(() => backend.typed.length === 1);
    expect(backend.typed[0]?.text).toBe(WHOLE);
  });

  it("the manager's route queues the whole message for its lane", async () => {
    const made = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
    fleet = made;
    hub = await startInProcessHub({
      queue: store => (queue = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(made.socketPath)), lane: "manager", on: true, pollMs: 60_000 })),
    });
    await queue?.start();
    const cookie = await hub.cookie();
    const r = await hub.post("/api/manager/send", { text: WHOLE, requestId: RID, seen: "none", createdAt: Date.now() }, { cookie: `__Host-morndo=${cookie}` });
    expect(r.status).toBe(200);
    expect(fleet?.deliveryCalls[0]).toMatchObject({ lane: "manager", workerId: null, text: WHOLE });
  });

  it("refuses one character more with 400, and a body over the send routes' byte cap with 413", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const headers = { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-morndo=${cookie}` };
    const over = await hub.post("/api/workers/pc.aaaaaaaa.1/send", { text: WHOLE + "x", requestId: RID, seen: "none" }, { cookie: headers.cookie });
    expect([over.status, await over.json()]).toEqual([400, { error: "bad_request" }]);
    // maxMessageText characters can be six bytes each on the wire once escaped, so this body is past the route's cap.
    const raw = JSON.stringify({ text: "x".repeat(LIMITS.maxMessageText * 7), requestId: RID, seen: "none" });
    const big = await fetch(hub.base + "/api/workers/pc.aaaaaaaa.1/send", { method: "POST", headers, body: raw });
    expect(big.status).toBe(413);
  });
});
