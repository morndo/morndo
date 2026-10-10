// A worker on a node that doesn't answer (fleet core §3.1, §7): the port lists it with `offline: true`, and the roster
// keeps it, marked offline, never gone. The feed says so once each way, and a worker listed offline from the start
// appears offline. Fake port; no tmux, no transcripts.
import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";

const PC = "pc.3fa2c1d0.1";
const BOX = "box.0a0a0a0a.2";
// The nodes in `down` don't answer: their workers are listed with offline true, as the fleet adapters list them.
function port(down: Set<string>): Pick<Tmux, "listWorkers" | "captureMany"> {
  return {
    listWorkers: async () => [
      { id: PC, name: "alpha", location: "a", node: "pc", offline: down.has("pc") },
      { id: BOX, name: "beta", location: "b", node: "box", offline: down.has("box") },
    ],
    captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
  };
}
const listener = (events: FeedEvent[]): Listener => ({ events: e => { events.push(...e); }, screen: () => {}, messages: () => {}, history: () => {}, watching: () => null });

describe("a worker on a node that doesn't answer", () => {
  it("stays listed, marked offline, and the feed says so once each way; the other node's worker is untouched", async () => {
    const down = new Set<string>();
    const svc = new ObservationService(port(down), 60_000);
    const events: FeedEvent[] = [];
    svc.subscribe(listener(events));
    await svc.poll();
    expect(svc.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC, false], [BOX, false]]);
    down.add("pc");
    await svc.poll();
    await svc.poll();                                                   // still offline: no second event
    expect(svc.snapshot().workers.map(w => [w.id, w.offline])).toEqual([[PC, true], [BOX, false]]);
    down.delete("pc");
    await svc.poll();
    expect(events.map(e => e.body).filter(b => b.type === "WorkerOfflineChanged" || b.type === "WorkerGone")).toEqual([
      { type: "WorkerOfflineChanged", workerId: PC, offline: true },
      { type: "WorkerOfflineChanged", workerId: PC, offline: false },
    ]);
  });
  it("one listed offline from the start appears offline", async () => {
    const svc = new ObservationService(port(new Set(["box"])), 60_000);
    const events: FeedEvent[] = [];
    svc.subscribe(listener(events));
    await svc.poll();
    expect(events.flatMap(e => (e.body.type === "WorkerAppeared" ? [[e.body.worker.id, e.body.offline]] : []))).toEqual([[PC, false], [BOX, true]]);
    expect(svc.snapshot().workers.find(w => w.id === BOX)?.offline).toBe(true);
  });
});
