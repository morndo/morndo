// Runs in the running fleet (ADR-0032; docs/design/agent-board/README.md §3, §6, §8): a scripted node's hooks, inventory,
// health and jobs give each lane's Run as GET /v1/runs serves it and the `run` event carries it. A Stop with background
// tasks waits on them (R2), by label and never the command (R6); a later turn works; a wake-up's fire time comes from the
// node's UTC offset (R3); a WAITING with nothing pending is declared (R4); a job of the lane comes before background
// work (R7); a menu needs you; a window gone is gone and a node offline is unknown (R5); one event per change; and a
// turn end's pending lists survive a fleet restart. The fleet's clock is the test's; hook times are the node's.
import { describe, expect, it, vi } from "vitest";
import type { LaneEvent, RunView } from "@morndo/protocol";
import { FleetClient, type FleetEvent as ClientEvent } from "../../../packages/fleet-client/src/index.ts";
import type { FleetConfig, LaneEventsConfig } from "../src/config.ts";
import type { FleetEvent } from "../src/application/events.ts";
import { health, type AgentKey, type FakeAgent } from "./helpers/fake-agent.ts";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const MIN = 60_000;
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const ALPHA = { workerId: "pc.3fa2c1d0.1", window: "alpha", cwd: "/w/alpha", sessionId: SID, pid: 41 };
const TO_MANAGER: LaneEventsConfig = { deliverTo: "manager", header: "[lane-event] h", ignore: [], batchMs: 60_000 };
const SHELL = { id: "task-1", type: "shell", status: "running", description: "Watch the CI run", command: "gh run watch 4242 --exit-status" };

type Rig = { fleet: TestFleet; pc: FakeAgent; at(t: number): void; seq(): number; run(lane?: string): RunView | undefined; runs(): Promise<RunView[]>; events: FleetEvent[] };
// A fleet with node pc online: joined anew, or, after a restart in the same directory, back with its key.
async function rig(o: { dir?: string; config?: Partial<FleetConfig>; back?: { key: AgentKey; streamId: string } } = {}): Promise<Rig> {
  let clock = T0;
  const fleet = await startTestFleet({ now: () => clock, runsSweepMs: 3_600_000, laneWatchSweepMs: 3_600_000, ...(o.dir ? { dir: o.dir } : {}), ...(o.config ? { config: o.config } : {}) });
  const events: FleetEvent[] = [];
  fleet.events.subscribe(e => { if (e.t === "run") events.push(e); });
  let pc: FakeAgent;
  if (o.back) {
    pc = fleet.agent({ node: "pc", ...o.back });
    if (!(await pc.connect()).ok) throw new Error("pc could not connect again");
  } else pc = await fleet.online("pc");
  let n = 0;
  return {
    fleet, pc, events, at: t => { clock = t; }, seq: () => ++n,
    run: (lane = "alpha") => fleet.runs.view().find(r => r.lane === lane),
    runs: async () => {
      const got = await client(fleet.config.socketPath).get("/v1/runs");
      if (got?.status !== 200) throw new Error(`GET /v1/runs answered ${got?.status ?? "nothing"}`);
      return (got.body as { runs: RunView[] }).runs;
    },
  };
}
const stop = (r: Rig, at: number, body: Record<string, unknown>, window = "alpha") => {
  const seq = r.seq();
  r.pc.hook(seq, "/hook/stop", { session_id: SID, hook_event_name: "Stop", ...body }, { window, at });
  return r.pc.acked(seq);
};
const hook = (r: Rig, at: number, path: "/cc" | "/lane" | "/sl" = "/cc", body: unknown = { session_id: SID, hook_event_name: "PreToolUse" }, window = "alpha") => {
  const seq = r.seq();
  r.pc.hook(seq, path, body, { window, at });
  return r.pc.acked(seq);
};
const job = (over: Record<string, unknown> = {}) => ({
  v: 1, t: "job", id: "job-1", node: "pc", lane: "alpha", name: "pack", class: "default", state: "running", outcome: null, exit: null,
  durationSec: null, notify: { kind: "lane", name: "alpha" }, task: null, notice: "none", at: T0 + 2 * MIN, ended: null, tail: "",
  position: null, reason: null, error: null, ...over,
});

describe("Runs in the fleet (ADR-0032)", () => {
  it("a Stop with background tasks waits on them by label, never the command; the next turn works (R2, R6)", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r, T0, { last_assistant_message: "STATUS: DONE\nShipped the parser.", background_tasks: [SHELL], session_crons: [] });
    r.at(T0 + MIN);
    await vi.waitFor(() => expect(r.run()).toEqual({
      lane: "alpha", node: "pc", sessionId: SID, phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "Watch the CI run" }] },
      outcome: "done", deadline: T0 + 30 * MIN, overdue: false, line: "STATUS: DONE", since: T0, source: "hook",
    }));
    expect(await r.runs()).toEqual([r.run()]);
    const wire = JSON.stringify([await r.runs(), r.events, r.fleet.db.prepare("SELECT body FROM lane_events").all()]);
    expect(wire).not.toContain("gh run watch");                                       // negative control: pendingOf keeping the command
    // The session busy (or `shell`) while its own background work runs is no turn: it still waits on that work.
    r.pc.inventory([{ ...ALPHA, status: "shell" }]);
    await new Promise(res => setTimeout(res, 100));                                   // the inventory taken and the run recomputed
    expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "background" } });
    // The next turn: a hook after the turn end (its start fires one), and the node reports the session busy.
    await hook(r, T0 + 2 * MIN);
    r.pc.inventory([{ ...ALPHA, status: "busy" }]);
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "working", source: "session", since: T0 + 2 * MIN }));
    expect(r.run()?.wait).toBeUndefined();
  });

  it("a pane with no session works on hooks after the turn end, and is not working on them once they are ACTIVE_MS old", async () => {
    const r = await rig();
    r.pc.inventory([{ workerId: "pc.3fa2c1d0.2", window: "alpha", cwd: "/w/alpha" }]);  // the owner's scripts: no session state
    await stop(r, T0, { text: "Built.", background: 1, crons: 0 });
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "background", tasks: [{ type: "task", label: "background work" }] } }));
    await hook(r, T0 + MIN, "/sl", { session_id: SID });                               // the status line's refresh is no activity
    await hook(r, T0 + 2 * MIN);
    await hook(r, T0 + 3 * MIN);
    r.at(T0 + 4 * MIN);
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "working", source: "hook", since: T0 + 2 * MIN }));
    r.at(T0 + 14 * MIN);
    r.fleet.runs.recompute();                                                           // the sweep: time alone
    expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "background" }, overdue: false });
  });

  it("a Stop with a wake-up waits on it until its next fire time in the node's local time, from its health's UTC offset (R3)", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    // 12:30 local is 10:30 UTC at UTC+2; the prompt never travels.
    await stop(r, T0, { last_assistant_message: "Checking back at half past.", background_tasks: [], session_crons: [{ id: "cron-1", schedule: "30 12 * * *", recurring: false, prompt: "look at the staging deploy" }] });
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "wakeup", next: null }, deadline: T0 + 30 * MIN }));   // no offset yet
    r.pc.health(health({ tzOffsetMin: 120 }));
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "wakeup", next: T0 + 30 * MIN }, deadline: T0 + 35 * MIN, source: "hook" }));
    expect(JSON.stringify([r.run(), r.events])).not.toContain("staging deploy");
    r.at(T0 + 36 * MIN);
    r.fleet.runs.recompute();
    expect(r.run()).toMatchObject({ wait: { on: "wakeup" }, overdue: true });          // past its fire time and grace, nothing since
  });

  it("a WAITING Stop with nothing pending is declared, with its lease (R4)", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r, T0, { last_assistant_message: "STATUS: WAITING on the review for 20 min", background_tasks: [], session_crons: [] });
    await vi.waitFor(() => expect(r.run()).toMatchObject({
      phase: "waiting", wait: { on: "declared", what: "the review" }, deadline: T0 + 40 * MIN, overdue: false, source: "status", line: "STATUS: WAITING on the review for 20 min",
    }));
  });

  it("a job of the lane comes before its background tasks (R7), and they show again once it ends", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r, T0, { last_assistant_message: "Started the pack job.", background_tasks: [SHELL], session_crons: [] });
    await vi.waitFor(() => expect(r.run()?.wait?.on).toBe("background"));
    r.pc.send(job());
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "waiting", wait: { on: "job", jobs: [{ id: "job-1", name: "pack" }] }, since: T0 + 2 * MIN, source: "job" }));
    expect(r.run()?.wait?.on).toBe("job");                                              // negative control: background first
    r.pc.send(job({ state: "exited", outcome: "exited", exit: 0, durationSec: 60, notice: "pending", at: T0 + 3 * MIN, tail: "packed" }));
    await vi.waitFor(() => expect(r.run()?.wait?.on).toBe("background"));
  });

  it("a WAITING turn with a queued job of the lane, whose notice goes elsewhere, waits on that job from its queue time, then from its start", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r, T0, { last_assistant_message: "STATUS: WAITING on the build", background_tasks: [], session_crons: [] });
    await vi.waitFor(() => expect(r.run()?.wait).toEqual({ on: "declared", what: "the build" }));
    r.pc.send(job({ id: "job-2", state: "queued", position: 1, reason: "class", notify: { kind: "fleet" }, at: T0 + MIN }));
    await vi.waitFor(() => expect(r.run()).toMatchObject({ wait: { on: "job", jobs: [{ id: "job-2", name: "pack" }] }, since: T0 + MIN }));   // not declared
    r.pc.send(job({ id: "job-2", state: "running", notify: { kind: "fleet" }, at: T0 + 4 * MIN }));
    await vi.waitFor(() => expect(r.run()).toMatchObject({ wait: { on: "job" }, since: T0 + 4 * MIN }));
  });

  it("a menu after the turn end needs you, with its question; answered, the run is back", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r, T0, { last_assistant_message: "STATUS: DONE", background_tasks: [], session_crons: [] });
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "ended", outcome: "done" }));
    await hook(r, T0 + MIN, "/lane", { event: "needs_input", sessionId: SID, question: "Allow npm test?" });
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "needs_you", question: "Allow npm test?", since: T0 + MIN, source: "hook" }));
    await hook(r, T0 + 2 * MIN, "/lane", { event: "answered", sessionId: SID });
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "ended", outcome: "done", since: T0 }));
  });

  it("a window gone from the inventory is gone; its node offline is unknown (R5); a day gone, it drops", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }, { workerId: "pc.3fa2c1d0.3", window: "beta", cwd: "/w/beta" }]);
    await vi.waitFor(() => expect(r.fleet.runs.view().map(x => `${x.lane}:${x.phase}`)).toEqual(["alpha:ended", "beta:ended"]));
    r.at(T0 + 5 * MIN);
    r.pc.inventory([{ workerId: "pc.3fa2c1d0.3", window: "beta", cwd: "/w/beta" }]);
    await vi.waitFor(() => expect(r.run()).toMatchObject({ phase: "gone", since: T0 + 5 * MIN, source: "session" }));
    expect(r.run()?.sessionId).toBe(SID);                                              // the session it had
    r.at(T0 + 6 * MIN);
    await r.pc.close();
    await vi.waitFor(() => expect(r.fleet.runs.view().map(x => `${x.lane}:${x.phase}:${x.since}`)).toEqual([`alpha:unknown:${T0 + 6 * MIN}`, `beta:unknown:${T0 + 6 * MIN}`]));
    r.at(T0 + 6 * MIN + 86_400_000);
    r.fleet.runs.recompute();
    expect(r.fleet.runs.view().map(x => x.lane)).toEqual(["beta"]);                    // gone a day: dropped; beta's node is only away
  });

  it("a node back online is unknown until its first inventory, so a window is never called gone on an old one", async () => {
    const r = await rig();
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await vi.waitFor(() => expect(r.run()?.phase).toBe("ended"));
    await r.pc.close();
    await vi.waitFor(() => expect(r.run()?.phase).toBe("unknown"));
    const back = r.fleet.agent({ node: "pc", key: r.pc.key, streamId: r.pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    await new Promise(res => setTimeout(res, 50));
    expect(r.run()?.phase).toBe("unknown");                                            // negative control: the old inventory read as fresh
    back.inventory([{ ...ALPHA, status: "busy" }]);
    await vi.waitFor(() => expect(r.run()?.phase).toBe("working"));
  });

  it("GET /v1/runs and the run event: one event per change, none for a recompute that changes nothing, and the client decodes both", async () => {
    const r = await rig();
    const fc = new FleetClient(r.fleet.config.socketPath, { client: "test" });
    const seen: ClientEvent[] = [];
    const unsubscribe = fc.events(e => { if (e.t === "run") seen.push(e); });
    r.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await vi.waitFor(() => expect(r.events.filter(e => (e.body as RunView).lane === "alpha")).toHaveLength(1));
    for (let i = 0; i < 3; i++) r.fleet.runs.recompute();
    r.pc.health(health());                                                              // a fact that changes no Run
    await hook(r, T0 - MIN);                                                            // nor does a hook from before
    await new Promise(res => setTimeout(res, 50));
    const alpha = () => r.events.filter(e => (e.body as RunView).lane === "alpha").map(e => (e.body as RunView).phase);
    expect(alpha()).toEqual(["ended"]);                                                 // negative control: no JSON compare sends four
    await stop(r, T0, { last_assistant_message: "STATUS: BLOCKED on the key", background_tasks: [], session_crons: [] });
    await vi.waitFor(() => expect(alpha()).toEqual(["ended", "ended"]));
    expect(r.events.at(-1)).toEqual({ t: "run", node: "pc", body: r.run() });
    expect(r.run()).toMatchObject({ phase: "ended", outcome: "blocked", line: "STATUS: BLOCKED on the key", since: T0, source: "status" });
    expect(await fc.runs()).toEqual(r.fleet.runs.view());
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ t: "run", node: "pc", body: r.run() }));
    unsubscribe();
  });

  it("the manager's own window has a Run, from its Stops, though they make no lane event", async () => {
    const r = await rig({ config: { laneEvents: TO_MANAGER } });
    r.pc.inventory([{ ...ALPHA, status: "idle" }, { workerId: "pc.3fa2c1d0.4", window: "manager", cwd: "/m", sessionId: "m-1", status: "idle", pid: 7 }]);
    await stop(r, T0, { last_assistant_message: "Watching the lanes.", background_tasks: [{ id: "t9", type: "monitor", status: "running", description: "lane events" }], session_crons: [] }, "manager");
    await vi.waitFor(() => expect(r.run("manager")).toMatchObject({ phase: "waiting", wait: { on: "background", tasks: [{ type: "monitor", label: "lane events" }] } }));
    expect(r.fleet.db.prepare("SELECT COUNT(*) AS n FROM lane_events").get()).toEqual({ n: 0 });
    expect(r.fleet.laneWatch.view()).toEqual([]);                                       // and it is not watched for stale
  });

  it("a turn end's tasks and wake-ups are stored with its lane event and survive a fleet restart", async () => {
    const dir = tempDir();
    const r1 = await rig({ dir });
    r1.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await stop(r1, T0, {
      last_assistant_message: "STATUS: DONE", background_tasks: [SHELL],
      session_crons: [{ id: "cron-1", schedule: "*/20 * * * *", recurring: true, prompt: "poll the queue" }],
    });
    await vi.waitFor(() => expect(r1.run()?.wait?.on).toBe("background"));
    r1.pc.terminate();
    await r1.fleet.close();
    const r2 = await rig({ dir, back: { key: r1.pc.key, streamId: r1.pc.streamId } });   // the fleet back; its clock from T0 again
    r2.at(T0 + 10 * MIN);
    const lane = (await client(r2.fleet.config.socketPath).get("/v1/lane-events?since=0"))?.body as { events: LaneEvent[] };
    expect(lane.events).toEqual([expect.objectContaining({
      event: "finished", bg: 1, crons: 1, tasks: [{ type: "shell", label: "Watch the CI run" }], wakes: [{ schedule: "*/20 * * * *", recurring: true }],
    })]);
    expect(JSON.stringify(lane)).not.toContain("gh run watch");
    expect(JSON.stringify(lane)).not.toContain("poll the queue");
    r2.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await vi.waitFor(() => expect(r2.run()).toMatchObject({ phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "Watch the CI run" }] }, since: T0 }));
  });

  it("after a restart, a lane the registry knows is unknown from the restart until its node reports", async () => {
    const dir = tempDir();
    const r1 = await rig({ dir });
    r1.pc.inventory([{ ...ALPHA, status: "idle" }]);
    await vi.waitFor(() => expect(r1.fleet.lanes.get("alpha")).not.toBeNull());
    r1.pc.terminate();
    await r1.fleet.close();
    const restart = T0 + 7 * MIN;
    let clock = restart;
    const f2 = await startTestFleet({ dir, now: () => clock, runsSweepMs: 3_600_000 });
    expect(f2.runs.view()).toEqual([{ lane: "alpha", node: "pc", phase: "unknown", deadline: null, overdue: false, since: restart, source: "session" }]);
    clock = restart + MIN;
    await f2.close();
  });
});
