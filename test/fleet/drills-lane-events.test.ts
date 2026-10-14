// Lane-event and hook-bus drills (fleet clients spec §12 "Drills"; §7 lane events, §6 the subscriber contract): a real
// fleet and agent; lanes that are the fake input box (test/fixtures/fake-claude-pane.ts); hooks posted to the agent's own
// relay in the CLI's Stop form (https://code.claude.com/docs/en/hooks, "Stop", read 2026-10-08).
// - The manager gets lane events in batches, as one delivery per batch: a header line, then one JSON line per event.
//   Its own lane, the lanes `laneEvents.ignore` matches, and `answered` are not sent.
// - The events not yet delivered when the fleet is killed are sent once it runs again (they were in its synced intake).
// - A subscriber answering 503 holds its stream (the bus sends one event at a time, in order), raises subscriber_lagging
//   once its oldest undelivered event is 60 s old, and loses nothing once it answers again. That one takes about two
//   minutes: the lag itself, then the bus's backoff (up to 64 s by then) before its next try.
import { afterEach, describe, expect, it } from "vitest";
import type { FleetConfig } from "../../apps/fleet/src/config.ts";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import {
  fakeLane, hook, joinAgent, keyParts, paneOf, sleep, startFleet, stopAll, subscriber, tmuxServer, until, type Agent, type Lane,
} from "../fleet-harness.ts";

afterEach(stopAll);

const HEADER = "[lane-event] Drill events:";
type Line = { lane: string; event: string; status: string | null; sessionId: string | null };

async function office(laneEvents: Partial<FleetConfig["laneEvents"]> = {}) {
  const fleet = await startFleet({ laneEvents: { deliverTo: "manager", header: HEADER, ignore: ["pooltest*"], ...laneEvents } });
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const lane = (window: string) => fakeLane(tmux, { window, claudeHome: agent.home });
  const manager = await lane("manager");
  const w1 = await lane("w1");
  const w2 = await lane("w2");
  const pool = await lane("pooltest-1");
  await agent.run();
  await agent.waitOnline();
  for (const w of ["manager", "w1", "w2", "pooltest-1"]) {
    await until(`${w} idle in n1's inventory`, async () => (await paneOf(fleet.client, "n1", w)).status === "idle", 15_000);
  }
  return { fleet, agent, manager, w1, w2, pool };
}
// A turn's end, as the CLI's Stop hook posts it.
const stopped = (agent: Agent, lane: Lane, text: string) => hook(agent, "/hook/stop", {
  session_id: lane.sessionId, transcript_path: lane.transcript, cwd: lane.dir, permission_mode: "default", hook_event_name: "Stop",
  last_assistant_message: text, background_tasks: [], session_crons: [],
});
// What the manager received as lane events: each batch's JSON lines, in the order typed.
const batches = (manager: Lane): Line[][] =>
  manager.submitted().filter(t => t.startsWith(HEADER)).map(t => t.split("\n").slice(1).filter(Boolean).map(l => JSON.parse(l) as Line));

describe("lane events delivered to the manager", () => {
  it("in one batch per window; not the manager's own lane, not ignored lanes, and answered is published only", async () => {
    const o = await office();
    for (const r of await Promise.all([
      stopped(o.agent, o.w1, "STATUS: DONE\nshipped the docs"),
      stopped(o.agent, o.w2, "STATUS: BLOCKED\nneeds the staging key"),
      stopped(o.agent, o.pool, "STATUS: DONE\na pool probe"),
      stopped(o.agent, o.manager, "STATUS: DONE\nthe manager's own turn"),
    ])) expect(r.status).toBe(200);
    await until("one batch at the manager", () => batches(o.manager).length === 1, 20_000);
    const [batch = []] = batches(o.manager);
    expect(batch.map(e => [e.lane, e.event, e.status]).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([["w1", "finished", "done"], ["w2", "finished", "blocked"]]);
    expect(batch.find(e => e.lane === "w1")?.sessionId).toBe(o.w1.sessionId);
    await o.w1.control({ status: "waiting", question: "Merge the docs branch?" });
    await until("needs_input published", async () => (await o.fleet.client.laneEvents(0)).some(e => e.event === "needs_input" && e.lane === "w1"), 15_000);
    expect((await o.fleet.client.laneEvents(0)).find(e => e.event === "needs_input")?.question).toBe("Merge the docs branch?");
    await o.w1.control({ status: "idle" });
    await until("answered published", async () => (await o.fleet.client.laneEvents(0)).some(e => e.event === "answered" && e.lane === "w1"), 15_000);
    await until("the second batch", () => batches(o.manager).length === 2, 20_000);
    await sleep(LIMITS.laneEventBatchMs + 3000);
    const all = batches(o.manager).flat();
    expect(all.filter(e => e.event === "needs_input")).toHaveLength(1);
    expect(all.some(e => e.event === "answered")).toBe(false);
    expect(all.some(e => e.lane === "manager" || e.lane === "pooltest-1")).toBe(false);
    expect(batches(o.manager)).toHaveLength(2);
  });

  it("the ones not yet delivered when the fleet dies are sent once it runs again, once", async () => {
    const o = await office({ batchMs: 6000 });
    expect((await stopped(o.agent, o.w1, "STATUS: DONE\nbefore the crash")).status).toBe(200);
    await until("the event in the fleet", async () => (await o.fleet.client.laneEvents(0)).some(e => e.lane === "w1" && e.event === "finished"), 5000, 50);
    expect(batches(o.manager)).toEqual([]);                          // still inside its 6 s batch
    await o.fleet.restart("SIGKILL");
    await until("the batch after the restart", () => batches(o.manager).length === 1, 30_000);
    expect(batches(o.manager)[0]?.map(e => [e.lane, e.event])).toEqual([["w1", "finished"]]);
    await sleep(8000);
    expect(batches(o.manager)).toHaveLength(1);
  });
});

describe("the subscriber contract", () => {
  it("a subscriber answering 503 holds its stream, raises subscriber_lagging, and loses nothing once it answers", async () => {
    let refusing = true;
    const sub = await subscriber({ answer: () => (refusing ? 503 : 200) });
    const fleet = await startFleet({ subscribers: [{ name: "slow", url: sub.url, paths: ["/notify"] }] });
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    await agent.run();
    await agent.waitOnline();
    for (let i = 0; i < 5; i++) expect((await hook(agent, "/notify", { window: "w1", text: `note ${i}` })).status).toBe(202);
    await until("the first event tried", () => sub.received.length > 0, 15_000);
    const alert = await until("subscriber_lagging", async () => (await fleet.client.alerts()).find(a => a.kind === "subscriber_lagging") ?? null, 100_000, 1000);
    expect(alert.detail).toMatchObject({ subscriber: "slow" });
    expect(new Set(sub.received.map(d => d.key)).size).toBe(1);     // only the first event, tried again and again
    refusing = false;
    await until("all five delivered", () => sub.unique().size === 5, 120_000, 500);
    const got = [...sub.unique().values()];
    expect(got.map(d => keyParts(d.key).seq)).toEqual(got.map(d => keyParts(d.key).seq).sort((a, b) => a - b));
    expect(got.map(d => (d.event.body as { text: string }).text)).toEqual(["note 0", "note 1", "note 2", "note 3", "note 4"]);
  }, 240_000);
});
