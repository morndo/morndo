// The feed's `fleet` frame (fleet core §7; Task 15b): whether the hub can reach the fleet service, sent after every
// hello (a feed that resumes may have missed a change) and on every change of ObservationService.fleet(). The real HTTP
// and WebSocket edges (inprocess-hub.ts) over an ObservationService in fleet mode whose listing fails on demand, as it
// does while the fleet is down. Synthetic workers; no tmux, no fleet.
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { ObservationService } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";
import { frameText } from "./http-crash-fixture.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const PC1 = "pc.3fa2c1d0.1";
let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });

// A fleet hub's listing (nodeStates set): it throws while `down.on`, as the fleet adapters do with the fleet gone.
function fleetObservation(down: { on: boolean }) {
  const tmux: Pick<Tmux, "listWorkers" | "captureMany"> = {
    listWorkers: async () => {
      if (down.on) throw new Error("fleet: no answer on the socket");
      return [{ id: PC1, name: "alpha", location: "alpha", node: "pc", offline: false, conflict: false }];
    },
    captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
  };
  return new ObservationService(tmux, 60_000, Date.now, { nodeStates: async () => new Map([["pc", "online"]]) });
}
// Every frame the socket gets, in order, as { t, … }.
function frames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  ws.on("message", raw => { got.push(JSON.parse(frameText(raw)) as Record<string, unknown>); });
  return got;
}
const fleetFrames = (got: Record<string, unknown>[]) => got.filter(f => f.t === "fleet").map(f => f.available);
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 10)); expect(ok()).toBe(true); };

describe("the feed's fleet frame", () => {
  it("after every hello, right after the snapshot, and on every change", async () => {
    const down = { on: false };
    const observation = fleetObservation(down);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const cookie = await hub.cookie();
    const ws = await hub.socket("/api/feed", cookie);
    const got = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await until(() => fleetFrames(got).length === 1);
    const kinds = got.map(f => f.t);
    expect(kinds.indexOf("fleet")).toBe(kinds.indexOf("snapshot") + 1);
    expect(fleetFrames(got)).toEqual([true]);
    down.on = true;
    await observation.poll();
    await until(() => fleetFrames(got).length === 2);
    expect(fleetFrames(got)).toEqual([true, false]);
    await observation.poll();                                         // still down: nothing new
    const again = await hub.socket("/api/feed", cookie);              // a feed that comes back while it is down
    const got2 = frames(again);
    again.send(JSON.stringify({ t: "hello" }));
    await until(() => fleetFrames(got2).length === 1);
    expect(fleetFrames(got2)).toEqual([false]);
    down.on = false;
    await observation.poll();
    await until(() => fleetFrames(got).length === 3);
    expect(fleetFrames(got)).toEqual([true, false, true]);
    expect(observation.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC1, false]]);
    ws.close();
    again.close();
  });
  it("a legacy hub says available after each hello, and nothing else", async () => {
    const observation = new ObservationService({ listWorkers: async () => [], captureMany: async () => new Map() }, 60_000);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const got = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await until(() => got.some(f => f.t === "decisions"));
    await observation.poll();
    await new Promise(r => setTimeout(r, 50));
    expect(fleetFrames(got)).toEqual([true]);
    ws.close();
  });
});
