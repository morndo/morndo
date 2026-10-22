// RL10, amending S5 (updates design §11.5): each Command is stamped with the hub store its device saw before its first
// attempt. A hub whose database was restored answers under a new store (hub-store.test.ts), so:
// - stamped with this hub's store → typed, as any send;
// - stamped with another store, and this store does not hold its request id → `uncertain` (409): nothing typed, nothing
//   recorded — the hub that may have typed it was another database, and no clock decides this (FL13);
// - stamped with another store, and this store holds its id → the held answer as today (this store recorded the typing):
//   duplicate, or the in-doubt path;
// - no stamp (an older app, or a record written before any answer) → as today.
// The route is the last line: POST /api/workers/:id/send passes the stamp through, and its 409 answers the app's Retry.
// SteeringService on a real store, the fake fleet; no tmux. The domain's own rule is releases-invariants.test.ts (RL10).
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { localNode, memoryBackend, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const NOW = Date.UTC(2026, 9, 6, 9);
const PC1 = "pc.aaaaaaaa.1";
const RID = "0b7a52c1-4d2e-4f3a-9b8c-7d6e5f4a3b2c";
const KEY = `ep1:${RID}`;
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};

let dir: string;
let store: Store;
let pc: MemoryBackend;
let rig: FleetRig;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-store-stamp-"));
  store = new Store(dir);
  pc = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "──────\n❯ " } });
  pc.typedAt = NOW + 7;
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)]);
  await rig.ports.tmux.listWorkers();
});
afterEach(async () => {
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const send = (hubStore?: string) => steeringFor(rig.ports, { store, now: () => NOW }).send(A, PC1, "ship it", RID, [], "none", undefined, undefined, false, hubStore);
const rows = () => store.db.prepare("SELECT key, state FROM sends ORDER BY key").all();
const paneSends = () => rig.fleet.calls.filter(c => c.op === "pane.send");

describe("a Command stamped with a hub store (RL10, amending S5)", () => {
  it("stamped with this hub's store: typed once", async () => {
    expect(await send(store.storeId)).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "done" }]);
  });

  it("stamped with another store, its request id not held here: uncertain, nothing typed, nothing recorded", async () => {
    expect(await send(randomUUID())).toEqual({ ok: false, problem: "uncertain" });
    expect(paneSends()).toEqual([]);                          // the fake fleet never saw a pane.send
    expect(pc.typed).toEqual([]);
    expect(rows()).toEqual([]);                               // nothing recorded: a later send of the id starts clean
    expect(await send(store.storeId)).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("stamped with another store, its request id held here: the held answer, as today (duplicate)", async () => {
    expect(await send(store.storeId)).toEqual({ ok: true, at: NOW + 7 });   // this store typed it
    expect(await send(randomUUID())).toEqual({ ok: false, problem: "duplicate", at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("no stamp (an older app): typed, as before", async () => {
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });
});

describe("the send route", () => {
  let hub: InProcessHub;
  afterEach(async () => { await hub.close(); });

  it("passes the stamp to steering: another store, its id not held, answers 409 uncertain", async () => {
    hub = await startInProcessHub();
    const cookie = await hub.cookie();
    const r = await hub.post(`/api/workers/${encodeURIComponent("%1")}/send`,
      { text: "ship it", requestId: RID, seen: "none", hubStore: randomUUID() }, { cookie: `__Host-morndo=${cookie}` });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "uncertain" });
  });
});
