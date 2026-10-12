// Polling per node, in parallel (fleet core §3.1, §9 "Isolation"): one captureMany per node and poll, a node that never
// answers doesn't hold up another's screens beyond one poll interval, and a node that isn't online is skipped at once.
// Both configurations (spec §9): nodes "a" and "b" as the ports' contract has them, and the same two nodes behind the
// fake fleet, through the hub's fleet adapters. No tmux, no transcripts.
import { afterEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { NodeState, NodeStates, Tmux } from "../src/application/ports.ts";
import { localNode, until } from "./helpers/fake-fleet.ts";
import { HUB_MODES, fleetRig, type HubMode } from "./helpers/hub-mode.ts";

const SERVERS: Record<string, string> = { a: "00000001", b: "00000002" };
const SLOW = "a.00000001.1";
const FAST = "b.00000002.1";
const idOf = (node: string, pane: string) => `${node}.${SERVERS[node] ?? ""}.${pane.slice(1)}`;

// A node: its panes (tmux id → window name) and how it answers a captureMany (by tmux ids).
type NodeSpec = { panes: Record<string, string>; capture(panes: string[]): Promise<Map<string, string | null>> };
type Nodes = { tmux: Pick<Tmux, "listWorkers" | "captureMany">; nodeStates: NodeStates; calls: { node: string; ids: string[] }[]; setState(node: string, s: NodeState): Promise<void>; close(): Promise<void> };

// Nodes "a" and "b" as the ports see them in `mode`; `calls` is every captureMany a node got, by worker id.
async function nodesFor(mode: HubMode, specs: Record<string, NodeSpec>): Promise<Nodes> {
  const calls: { node: string; ids: string[] }[] = [];
  const capture = (node: string, panes: string[]) => { calls.push({ node, ids: panes.map(p => idOf(node, p)) }); return specs[node]?.capture(panes) ?? Promise.resolve(new Map()); };
  if (mode === "legacy") {
    let states = new Map<string, NodeState>(Object.keys(specs).map(n => [n, "online"]));
    return {
      calls, close: async () => {},
      nodeStates: async () => states,
      setState: async (node, s) => { states = new Map(states).set(node, s); },
      tmux: {
        listWorkers: async () => Object.entries(specs).flatMap(([node, s]) => Object.entries(s.panes).map(([pane, name]) => ({ id: idOf(node, pane), name, location: "", node, offline: false }))),
        captureMany: async ids => {
          const node = ids[0]?.split(".")[0] ?? "";
          const got = await capture(node, ids.map(id => `%${id.split(".")[2] ?? ""}`));
          return new Map([...got].map(([pane, text]) => [idOf(node, pane), text]));
        },
      },
    };
  }
  const rig = await fleetRig(Object.entries(specs).map(([node, s]) => localNode(node, SERVERS[node] ?? "", {
    tmux: {
      listWorkers: async () => Object.entries(s.panes).map(([pane, name]) => ({ id: pane, name, location: "", node: "local", offline: false })),
      capture: async () => null, captureMany: panes => capture(node, panes), send: async () => ({ problem: null, typedAt: 0 }),
    },
  })));
  return {
    calls, tmux: rig.ports.tmux, nodeStates: rig.ports.nodeStates, close: () => rig.close(),
    setState: async (node, s) => { await rig.fleet.setStatus(node, s); await until(async () => (await rig.ports.nodeStates()).get(node) === s); },
  };
}
const until1 = async (ok: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await new Promise(r => setTimeout(r, 5));
  return ok();
};
const watcher = (watching: string, seen: { text: string; at: number }[], events: FeedEvent[] = []): Listener => ({
  events: e => { events.push(...e); },
  screen: (w, text) => { if (w === watching) seen.push({ text, at: performance.now() }); },
  messages: () => {}, history: () => {}, watching: () => watching,
});

let svc: ObservationService | null = null;
let nodes: Nodes | null = null;
afterEach(async () => { svc?.stop(); svc = null; await nodes?.close(); nodes = null; });

describe.each(HUB_MODES)("a node that never answers, %s hub", mode => {
  // Node "a" never answers a captureMany; node "b" answers at once with its current screen.
  let fastScreen = "b: first";
  const specs = (): Record<string, NodeSpec> => ({
    a: { panes: { "%1": "slow-lane" }, capture: () => new Promise(() => {}) },
    b: { panes: { "%1": "fast-lane" }, capture: async panes => new Map(panes.map(p => [p, fastScreen])) },
  });
  it("doesn't hold up another node's screens beyond one poll interval, and gets no second captureMany meanwhile", async () => {
    const POLL = 300;
    fastScreen = "b: first";
    nodes = await nodesFor(mode, specs());
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: POLL, nodeStates: nodes.nodeStates });
    const seen: { text: string; at: number }[] = [];
    svc.subscribe(watcher(FAST, seen));
    svc.start(POLL);
    expect(await until1(() => svc?.screen(FAST) === "b: first", 5 * POLL)).toBe(true);
    const changedAt = performance.now();
    fastScreen = "b: second";
    expect(await until1(() => seen.some(s => s.text === "b: second"), 10 * POLL)).toBe(true);
    const delay = (seen.find(s => s.text === "b: second")?.at ?? Infinity) - changedAt;
    expect(delay).toBeLessThanOrEqual(POLL + 150);                     // one poll interval, plus scheduling slack
    expect(nodes.calls.filter(c => c.node === "a")).toHaveLength(1);    // still waiting on the first: not asked again
    expect(nodes.calls.filter(c => c.node === "b").length).toBeGreaterThanOrEqual(2);
  });
  it("one poll returns after at most nodeWaitMs, with the answering node's screens applied", async () => {
    fastScreen = "b: first";
    nodes = await nodesFor(mode, specs());
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: 200, nodeStates: nodes.nodeStates });
    const t0 = performance.now();
    await svc.poll();
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(svc.screen(FAST)).toBe("b: first");
    expect(svc.screen(SLOW)).toBeUndefined();
  });
});

describe.each(HUB_MODES)("node states, %s hub", mode => {
  it("a node that is not online gets no captureMany; one that is online does (negative control)", async () => {
    nodes = await nodesFor(mode, {
      a: { panes: { "%1": "slow-lane" }, capture: async panes => new Map(panes.map(p => [p, "a"])) },
      b: { panes: { "%1": "fast-lane" }, capture: async panes => new Map(panes.map(p => [p, "b"])) },
    });
    await nodes.setState("a", "stale");
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeStates: nodes.nodeStates, nodeWaitMs: 5_000 });
    const t0 = performance.now();
    await svc.poll();
    expect(performance.now() - t0).toBeLessThan(1000);                        // skipped at once: no wait for node "a"
    expect(nodes.calls.map(c => c.node)).toEqual(["b"]);
    await nodes.setState("b", "offline");
    await svc.poll();
    expect(nodes.calls.map(c => c.node)).toEqual(["b"]);
    expect(svc.snapshot().workers.map(w => w.id).sort()).toEqual([SLOW, FAST]);   // still listed; only their screens wait
  });
});

describe.each(HUB_MODES)("one captureMany per node and poll, %s hub", mode => {
  it("each node is asked once, for its own workers only, and a late round is applied by the next poll", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    nodes = await nodesFor(mode, {
      a: { panes: { "%1": "a1", "%2": "a2" }, capture: async panes => { await gate; return new Map(panes.map(p => [p, `screen ${idOf("a", p)}`])); } },
      b: { panes: { "%3": "b3" }, capture: async panes => new Map(panes.map(p => [p, `screen ${idOf("b", p)}`])) },
    });
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: 50, nodeStates: nodes.nodeStates });
    await svc.poll();
    expect([...nodes.calls].sort((x, y) => x.node.localeCompare(y.node))).toEqual([{ node: "a", ids: ["a.00000001.1", "a.00000001.2"] }, { node: "b", ids: ["b.00000002.3"] }]);
    expect(svc.screen("a.00000001.1")).toBeUndefined();                 // node "a" hadn't answered within 50 ms
    release();
    await new Promise(r => setTimeout(r, 200));
    await svc.poll();
    expect(svc.screen("a.00000001.1")).toBe("screen a.00000001.1");     // its round, applied by the next poll
    expect(svc.screen("a.00000001.2")).toBe("screen a.00000001.2");
  });
});
