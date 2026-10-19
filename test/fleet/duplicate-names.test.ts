// Duplicate lane names (spec §4 "Lane names"; plan Contracts: "Hub ports" listWorkers, "Hub services" the manager, and
// the client API's routing). Real fleet, real agents and the hub in fleet mode (test/fleet-harness.ts).
// - Two `claude` windows on one node: the hub lists both, each under its own worker ID, and a send by worker ID types
//   into the pane picked, and only there (the owner picked one pane). The fleet keeps one row for the name, in
//   conflict, with no worker, and refuses a route by the name itself (lane_conflict, not executed, nothing sent).
// - A `manager` window on each of two nodes: the manager's name is in conflict, so an answer to the manager's ask is
//   refused (409 lane_conflict) and typed in neither pane.
// Negative control: once one of the two managers is gone, the same answer types once, into the one left. The refusal
// was the conflict, not a broken answer path.
// No manager pane has a session file: with one, the hub would read the tap back from its conversation and count the
// ask as answered there (E8).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { fakeLane, joinAgent, sleep, startFleet, startHub, stopAll, tmuxServer, until, type FeedWatch, type Lane } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";
const ledger = () => ({ needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the conflict build?",
  options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }],
  deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() }] });
// The worker ID the hub lists for a lane's pane (`%N` is the worker ID's pane number).
const idOf = (feed: FeedWatch, lane: Lane) => {
  const id = feed.workers().find(w => parseWorkerId(w.id)?.pane === Number(lane.paneId.slice(1)))?.id;
  if (!id) throw new Error(`the hub doesn't list ${lane.paneId}: ${JSON.stringify(feed.workers())}`);
  return id;
};

describe("two windows of one name on one node", () => {
  it("the hub lists both and steers each by its worker ID; a route by the name is refused", async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    const first = await fakeLane(tmux, { window: "claude", prose: "the first claude" });
    const second = await fakeLane(tmux, { window: "claude", prose: "the second claude" });
    await agent.run();
    await agent.waitOnline();
    const lane = await until("claude in conflict in the registry", async () => {
      const l = (await fleet.client.lanes()).find(x => x.name === "claude");
      return l?.conflict ? l : null;
    }, 15_000);
    expect(lane).toMatchObject({ node: "n1", workerId: null, conflict: true });
    // The direct path, which the hub still types with the switch off (step 2's rollback) and for every other lane.
    const hub = await startHub(fleet, { managerQueue: false });
    const feed = await hub.feed();
    const both = await until("both claude windows on the hub", () => {
      const ws = feed.workers().filter(w => w.name === "claude");
      return ws.length === 2 ? ws : null;
    }, 15_000);
    expect(both.every(w => w.id.startsWith("n1."))).toBe(true);
    expect(new Set(both.map(w => w.id)).size).toBe(2);
    expect(await hub.send(idOf(feed, second), "to the second claude")).toMatchObject({ status: 200, body: { ok: true } });
    await until("the text in the second claude", () => second.submitted().includes("to the second claude"));
    const byName = await fleet.client.op({ lane: "claude" }, "pane.send",
      { workerId: idOf(feed, first), text: "by the name", expect: { server: parseWorkerId(idOf(feed, first))?.server ?? "", window: "claude" } },
      { key: `hub:dup-${randomUUID()}` });
    expect(byName).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    await sleep(1000);
    expect(first.submitted()).toEqual([]);
    expect(second.submitted()).toEqual(["to the second claude"]);
  });
});

describe("a manager window on each of two nodes", () => {
  it("an answer is refused (lane_conflict) and typed in neither; with one manager left, it types once (negative control)", async () => {
    const fleet = await startFleet();
    const [t1, t2] = [tmuxServer(), tmuxServer()];
    const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
    const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
    const m1 = await fakeLane(t1, { window: "manager", prose: "manager on n1" });
    const m2 = await fakeLane(t2, { window: "manager", prose: "manager on n2" });
    await Promise.all([n1.run(), n2.run()]);
    await Promise.all([n1.waitOnline(), n2.waitOnline()]);
    await until("manager in conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === true, 15_000);
    // The direct path, which the hub still types with the switch off (step 2's rollback) and for every other lane.
    const hub = await startHub(fleet, { managerQueue: false, ledger: ledger() });
    const feed = await hub.feed();
    await until("both managers on the hub", () => feed.workers().filter(w => w.name === "manager").length === 2, 15_000);
    expect(await hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "lane_conflict" } });
    await sleep(1500);
    expect([m1.submitted(), m2.submitted()]).toEqual([[], []]);
    // The control: n2's manager window goes (its server with it: it was the only window), so the name has one claim.
    t2.run("kill-window", "-t", m2.paneId);
    await until("manager out of conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === false, 15_000);
    // The hub learns it on its next polls; each refused attempt typed nothing, so trying again is safe.
    await until("the answer accepted", async () => (await hub.answer("ny-1", "ship")).status === 200, 20_000);
    await until("the tap in n1's manager pane", () => m1.submitted().includes(TAP));
    await sleep(1000);
    expect(m1.submitted().filter(t => t === TAP)).toHaveLength(1);
    expect(m2.submitted()).toEqual([]);
  });
});
