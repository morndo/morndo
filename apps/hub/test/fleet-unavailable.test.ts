// The fleet service down or restarting (spec §7): the hub keeps the roster it had, every worker offline (nothing is
// known of them now; Task 15b shows the marker), says "unavailable" once to whoever listens (the feed's banner, Task
// 15b), asks no node anything meanwhile, and is "ok" again with the first listing once the fleet answers. A legacy hub
// never says unavailable: a listing that fails there is the poll's own failure, as before. The fleet adapters over the
// fake fleet, on a socket path that outlives it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { FleetClient } from "../src/adapters/fleet-client.ts";
import { fleetPorts, type FleetPorts } from "../src/adapters/fleet-adapters.ts";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import { localNode, memoryBackend, startFakeFleet, type FakeFleet } from "./helpers/fake-fleet.ts";

const PC1 = "pc.aaaaaaaa.1";
const pcNode = () => localNode("pc", "aaaaaaaa", memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "$ " } }));

let dir: string;
let fleet: FakeFleet | null;
let ports: FleetPorts;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mf-"));
  fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
  ports = fleetPorts(new FleetClient(join(dir, "fleet.sock")), { files: null, stagingDir: join(dir, "staging") });
  await ports.start();
});
afterEach(async () => { ports.stop(); await fleet?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the fleet down", () => {
  it("keeps the roster, says unavailable once, asks no node meanwhile, and is ok again once the fleet answers", async () => {
    let captures = 0;
    const tmux = { listWorkers: () => ports.tmux.listWorkers(), captureMany: (ids: string[]) => { captures++; return ports.tmux.captureMany(ids); } };
    const svc = new ObservationService(tmux, 60_000, Date.now, { nodeStates: ports.nodeStates });
    const said: string[] = [];
    const events: FeedEvent[] = [];
    const listener: Listener = { events: e => { events.push(...e); }, screen: () => {}, messages: () => {}, history: () => {}, watching: () => null, fleet: s => { said.push(s); } };
    svc.subscribe(listener);
    await svc.poll();
    expect([svc.fleet(), svc.snapshot().workers.map(w => w.id)]).toEqual(["ok", [PC1]]);
    await fleet?.close();
    fleet = null;
    captures = 0;
    await svc.poll();
    await svc.poll();
    expect(svc.fleet()).toBe("unavailable");
    expect(svc.snapshot().workers.map(w => w.id)).toEqual([PC1]);                 // still listed, not gone
    expect(events.filter(e => e.body.type === "WorkerGone")).toEqual([]);
    expect(captures).toBe(0);                                                       // nothing asked of any node
    fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
    await svc.poll();
    expect(svc.fleet()).toBe("ok");
    expect(said).toEqual(["unavailable", "ok"]);                                    // once each way
  });
});

describe("a legacy hub", () => {
  it("never says unavailable: a listing that fails is the poll's failure, as before", async () => {
    const svc = new ObservationService({ listWorkers: async () => { throw new Error("tmux: server exited"); }, captureMany: async () => new Map() }, 60_000);
    await expect(svc.poll()).rejects.toThrow(/server exited/);
    expect(svc.fleet()).toBe("ok");
  });
});
