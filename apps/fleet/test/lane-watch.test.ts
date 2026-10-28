// The lane watch (reliable lanes §3.2): each lane's last turn and its deadline, past it a nudge first and then, if the
// lane stays quiet, one stale event, stalls counted until the lane settles, and a rebuild at start that never calls a
// lane stale for time the fleet did not see. Driven with its own clock; the fleet wiring is in lane-watch-intake.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { HookEvent, LaneEvent, LaneEventName } from "@morndo/protocol";
import type { LaneEventDraft } from "../src/adapters/lane-events-store.ts";
import { createLogger, type Logger } from "../src/adapters/log.ts";
import type { DeliveryRequest } from "../src/application/deliveries.ts";
import { LaneWatch, LOST_TURN_GRACE_MS, LOST_TURN_SKEW_MS, NUDGE_MAX_STALLS, PROBE_ANSWER_MS, REBUILD_WINDOW_MS, nudgeText, type LaneWatchConfig, type NudgeAnswer } from "../src/application/lane-watch.ts";
import { quiet } from "./helpers/fleet.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const CONFIG: LaneWatchConfig = { waitingMin: 30, noStatusMin: 15, nudge: true };
const WORKER = "pc.3fa2c1d0.1";                                                       // the pane that runs api's session

function rig(o: {
  config?: LaneWatchConfig; alive?: boolean; online?: () => boolean; nudgeTarget?: (node: string, window: string) => string | null;
  raise?: (d: LaneEventDraft) => LaneEvent | null; answer?: NudgeAnswer; log?: Logger;
  watched?: (window: string) => boolean; lostTurnMs?: number;
} = {}) {
  let now = T0;
  let seq = 0;
  const raised: LaneEventDraft[] = [];
  const nudged: DeliveryRequest[] = [];
  const alive = { value: o.alive ?? true };
  const watch = new LaneWatch({
    config: o.config ?? CONFIG, log: o.log ?? quiet, now: () => now, alive: () => alive.value, ...(o.online ? { online: o.online } : {}),
    nudgeTarget: o.nudgeTarget ?? (() => WORKER),
    raise: o.raise ?? (d => { raised.push(d); return { ...d, seq: ++seq } as LaneEvent; }),
    nudge: async r => { nudged.push(r); return o.answer ?? { ok: true }; },
    ...(o.watched ? { watched: o.watched } : {}), ...(o.lostTurnMs === undefined ? {} : { lostTurnMs: o.lostTurnMs }),
  });
  let n = 0;
  const finished = (at: number, over: Partial<LaneEvent> = {}): LaneEvent =>
    ({ v: 1, t: "lane", seq: ++n, event: "finished", node: "pc", window: "api", lane: "api", at, status: null, firstLine: "", bg: 0, crons: 0, ...over });
  // A stored lane event that is no turn end: a session state change or a failed turn.
  const state = (event: LaneEventName, at: number): LaneEvent => ({ v: 1, t: "lane", seq: ++n, event, node: "pc", window: "api", lane: "api", at });
  const hook = (at: number, path: HookEvent["path"] = "/cc", body: unknown = {}): HookEvent => ({ streamId: "s", seq: ++n, at, path, node: "pc", window: "api", body });
  // One pane of api on pc. `over` replaces window, session or status.
  const panes = (status: "busy" | "idle" | "waiting" | "shell" | null, over: { window?: string; sessionId?: string; status?: "busy" | "idle" | "waiting" | "shell" | null } = {}) => {
    watch.panes("pc", [{ window: "api", sessionId: "s1", status, ...over }]);
  };
  return { watch, raised, nudged, alive, finished, state, hook, panes, at: (t: number) => { now = t; } };
}

describe("the lane watch", () => {
  it("gives each kind of turn end its deadline: no status 15 min, background work 30, a wait its lease, a settled turn none", () => {
    const r = rig();
    r.watch.turn(r.finished(T0));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 15 * MIN, reason: "no_status", status: null });
    r.watch.turn(r.finished(T0, { bg: 2 }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 30 * MIN, reason: "waiting", waitingOn: "background work" });
    r.watch.turn(r.finished(T0, { crons: 1 }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 30 * MIN, waitingOn: "a scheduled wake-up" });
    r.watch.turn(r.finished(T0, { status: "waiting", waitingOn: "CI", until: T0 + 5 * MIN }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 5 * MIN, reason: "waiting", waitingOn: "CI", status: "waiting" });
    for (const status of ["done", "blocked", "needs_decision"] as const) {
      r.watch.turn(r.finished(T0, { status, bg: 1 }));
      expect(r.watch.view()[0]).toMatchObject({ deadline: null, status });
      expect(r.watch.view()[0]?.reason).toBeUndefined();
    }
  });

  it("past the deadline with nothing since: the nudge at it, the stale event PROBE_ANSWER_MS later; any hook since keeps it quiet", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { status: "waiting", waitingOn: "CI", until: T0 + 10 * MIN, sessionId: "s1" }));
    r.at(T0 + 10 * MIN - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // not yet
    r.at(T0 + 10 * MIN);
    r.watch.sweep();
    r.watch.sweep();                                                                    // one nudge for that turn, no stale event yet
    expect(r.raised).toEqual([]);
    expect(r.nudged).toHaveLength(1);
    expect(r.nudged[0]).toMatchObject({ id: `fleet:nudge:${WORKER}:${T0}`, workerId: WORKER });
    expect(r.nudged[0]).not.toHaveProperty("lane");                                   // never by name: another node may use it
    expect(r.nudged[0]?.text).toContain("waiting on CI");
    expect(r.nudged[0]?.text).toContain("STATUS: DONE");
    r.at(T0 + 10 * MIN + PROBE_ANSWER_MS - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // the lane may still answer
    r.at(T0 + 10 * MIN + PROBE_ANSWER_MS);
    r.watch.sweep();
    r.watch.sweep();                                                                    // once per turn
    expect(r.raised).toEqual([{ v: 1, t: "lane", event: "stale", node: "pc", window: "api", lane: "api", at: T0 + 10 * MIN + PROBE_ANSWER_MS, sessionId: "s1", reason: "waiting", waitingOn: "CI", since: T0, stalls: 1 }]);
    // A new turn with a hook after it: activity, so no stale event (negative control: without the hook, one more).
    // Status line refreshes are not activity: Claude Code may re-run it on a timer while the lane sits idle.
    r.watch.turn(r.finished(T0 + 20 * MIN));
    r.watch.saw(r.hook(T0 + 21 * MIN));
    const idle = rig();
    idle.watch.turn(idle.finished(T0));
    for (let m = 1; m <= 16; m++) idle.watch.saw(idle.hook(T0 + m * MIN, "/sl"));
    idle.at(T0 + 16 * MIN);
    idle.watch.sweep();
    expect(idle.nudged).toHaveLength(1);
    idle.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    idle.watch.sweep();
    expect(idle.raised).toHaveLength(1);
    r.at(T0 + 60 * MIN);
    r.watch.sweep();
    expect(r.raised).toHaveLength(1);
  });

  it("counts stalls until the lane settles, and stops nudging after the second", () => {
    const r = rig();
    let t = T0;
    for (let i = 1; i <= NUDGE_MAX_STALLS + 1; i++) {
      r.watch.turn(r.finished(t));
      t += 16 * MIN;
      r.at(t);
      r.watch.sweep();                                                                 // the nudge, or nothing left to nudge
      r.at(t + PROBE_ANSWER_MS);
      r.watch.sweep();                                                                 // the stale event once the lane has not answered
      expect(r.raised.at(-1)?.stalls).toBe(i);
    }
    expect(r.raised).toHaveLength(3);
    expect(r.nudged).toHaveLength(NUDGE_MAX_STALLS);                                   // the third is the orchestrator's to re-plan
    r.watch.turn(r.finished(t, { status: "done" }));
    r.watch.turn(r.finished(t + 1));
    r.at(t + 20 * MIN);
    r.watch.sweep();
    r.at(t + 20 * MIN + PROBE_ANSWER_MS);
    r.watch.sweep();
    expect(r.raised.at(-1)?.stalls).toBe(1);                                            // DONE reset the count
  });

  it("drops a lane whose window is gone instead of calling it stale; nudges off by config", () => {
    const gone = rig({ alive: false });
    gone.watch.turn(gone.finished(T0));
    gone.at(T0 + 16 * MIN);
    gone.watch.sweep();
    expect([gone.raised, gone.watch.view()]).toEqual([[], []]);
    const noSession = rig({ nudgeTarget: () => null });                                // a lane that runs no agent CLI
    noSession.watch.turn(noSession.finished(T0));
    noSession.at(T0 + 16 * MIN);
    noSession.watch.sweep();
    expect([noSession.raised.length, noSession.nudged.length]).toEqual([1, 0]);
    const quietRig = rig({ config: { ...CONFIG, nudge: false } });
    quietRig.watch.turn(quietRig.finished(T0));
    quietRig.at(T0 + 16 * MIN);
    quietRig.watch.sweep();
    expect([quietRig.raised.length, quietRig.nudged.length]).toEqual([1, 0]);
  });

  it("rebuilds from stored events with the restart as the new base: a deadline runs again in full, a reported turn stays reported", () => {
    const r = rig();
    const restart = T0 + 60 * MIN;
    r.at(restart);
    r.watch.rebuild([
      r.finished(T0, { window: "api", lane: "api" }),
      r.finished(T0, { window: "web", lane: "web" }),
      { v: 1, t: "lane", seq: 99, event: "stale", node: "pc", window: "web", lane: "web", at: T0 + 16 * MIN, since: T0, stalls: 1, reason: "no_status" },
    ]);
    expect(r.watch.view().find(v => v.window === "api")).toMatchObject({ deadline: restart + 15 * MIN, stale: false });
    expect(r.watch.view().find(v => v.window === "web")).toMatchObject({ stale: true, stalls: 1 });
    r.at(restart + 15 * MIN - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // negative control: no rebase, stale at once
    r.at(restart + 15 * MIN);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // the nudge; the probe is not stored, so the restart runs it again
    expect(r.nudged).toHaveLength(1);
    r.at(restart + 15 * MIN + PROBE_ANSWER_MS);
    r.watch.sweep();
    expect(r.raised.map(e => e.window)).toEqual(["api"]);
  });

  it("leaves a lane alone while its node is not online, and reports it once the node is back", () => {
    let online = false;
    const r = rig({ online: () => online });
    r.watch.turn(r.finished(T0));
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    expect([r.raised, r.nudged, r.watch.view().length]).toEqual([[], [], 1]);       // kept, not dropped as gone
    online = true;
    r.watch.sweep();
    r.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    r.watch.sweep();
    expect(r.raised).toHaveLength(1);
  });

  it("lets go of a settled turn a day old", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { status: "done" }));
    r.at(T0 + REBUILD_WINDOW_MS + 1);
    r.watch.sweep();
    expect(r.watch.view()).toEqual([]);
  });

  it("counts a hook from after the turn end that the fleet took before it (one intake batch: the turn is told on commit)", () => {
    const r = rig();
    r.watch.saw(r.hook(T0, "/hook/stop"));                                              // the Stop itself
    r.watch.saw(r.hook(T0 + MIN));                                                      // the next turn's first tool call, same batch
    r.watch.turn(r.finished(T0));                                                       // the Stop's lane event, once committed
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    expect(r.raised).toEqual([]);
    const before = rig();                                                               // negative control: a hook from before the end
    before.watch.saw(before.hook(T0 - MIN));
    before.watch.turn(before.finished(T0));
    before.at(T0 + 16 * MIN);
    before.watch.sweep();
    before.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    before.watch.sweep();
    expect(before.raised).toHaveLength(1);
  });

  it("after a rebuild, counts a hook from the outage by its own time, and a stored state change or failure after the turn end", () => {
    const restart = T0 + 10 * MIN;
    const replayed = rig();
    replayed.at(restart);
    replayed.watch.rebuild([replayed.finished(T0)]);
    replayed.watch.saw(replayed.hook(T0 + 5 * MIN));                                   // spooled on the node while the fleet was down
    replayed.at(restart + 16 * MIN);
    replayed.watch.sweep();
    expect(replayed.raised).toEqual([]);
    for (const event of ["needs_input", "answered", "stop_failure"] as const) {
      const r = rig();
      r.at(restart);
      r.watch.rebuild([r.finished(T0), r.state(event, T0 + MIN)]);
      r.at(restart + 16 * MIN);
      r.watch.sweep();
      expect([event, r.raised]).toEqual([event, []]);
    }
    const old = rig();                                                                  // negative control: one from before the end
    old.at(restart);
    old.watch.rebuild([old.state("needs_input", T0 - MIN), old.finished(T0)]);
    old.at(restart + 16 * MIN);
    old.watch.sweep();
    old.at(restart + 16 * MIN + PROBE_ANSWER_MS);
    old.watch.sweep();
    expect(old.raised).toHaveLength(1);
  });

  it("takes Claude Code's idle notice as no activity, and any other notification as some", () => {
    const notice = (r: ReturnType<typeof rig>, type: string) =>
      r.hook(T0 + MIN, "/notify", { hook_event_name: "Notification", notification_type: type, message: "Claude is waiting for your input" });
    const idle = rig();
    idle.watch.turn(idle.finished(T0));
    idle.watch.saw(notice(idle, "idle_prompt"));
    idle.at(T0 + 16 * MIN);
    idle.watch.sweep();
    expect(idle.raised).toEqual([]);
    idle.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    idle.watch.sweep();
    expect(idle.raised).toHaveLength(1);
    const prompt = rig();
    prompt.watch.turn(prompt.finished(T0));
    prompt.watch.saw(notice(prompt, "permission_prompt"));
    prompt.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    prompt.watch.sweep();
    expect(prompt.raised).toEqual([]);
  });

  it("tries a stale event fleet.db refused again on the next sweep, and counts it once it is stored", () => {
    let calls = 0;
    const stored: LaneEventDraft[] = [];
    const r = rig({ raise: d => { calls += 1; if (calls === 1) throw new Error("database is locked"); stored.push(d); return { ...d, seq: calls } as LaneEvent; } });
    r.watch.turn(r.finished(T0));
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    expect([stored.length, r.nudged.length, r.watch.view()[0]?.stale, r.watch.view()[0]?.stalls]).toEqual([0, 1, false, 1]);
    r.at(T0 + 16 * MIN + PROBE_ANSWER_MS);
    r.watch.sweep();
    expect(stored).toEqual([]);                                                          // fleet.db refused it
    expect(r.watch.view()[0]?.stale).toBe(false);
    r.watch.sweep();
    expect(stored).toMatchObject([{ event: "stale", since: T0, stalls: 1 }]);
    expect([r.nudged.length, r.watch.view()[0]?.stale, r.watch.view()[0]?.stalls]).toEqual([1, true, 1]);
  });

  it("nudges each lane at its own pane by worker ID, with an id no other lane's nudge shares", () => {
    const panes: Record<string, string> = { api: "pc.3fa2c1d0.1", web: "pc.3fa2c1d0.2" };
    const r = rig({ nudgeTarget: (_node, window) => panes[window] ?? null });
    r.watch.turn(r.finished(T0));
    r.watch.turn(r.finished(T0, { window: "web", lane: "web" }));                       // the same ms
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    expect(r.nudged.map(q => ({ id: q.id, workerId: "workerId" in q ? q.workerId : null }))).toEqual([
      { id: `fleet:nudge:pc.3fa2c1d0.1:${T0}`, workerId: "pc.3fa2c1d0.1" },
      { id: `fleet:nudge:pc.3fa2c1d0.2:${T0}`, workerId: "pc.3fa2c1d0.2" },
    ]);
  });

  it("logs a nudge the fleet refused", async () => {
    const lines: string[] = [];
    const r = rig({ log: createLogger({ level: "warn", sink: line => { lines.push(line); } }), answer: { ok: false, error: { code: "no_pane" } } });
    r.watch.turn(r.finished(T0));
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    await vi.waitFor(() => expect(lines.some(l => l.includes("nudging api on pc was refused (no_pane)"))).toBe(true));
  });

  it("says in the nudge how long ago, on what, and the line to start with", () => {
    expect(nudgeText({ at: T0, reason: "no_status" }, T0 + 16 * MIN)).toMatch(/^\[fleet\] Your last turn ended 16 min ago without a status line/);
    expect(nudgeText({ at: T0, reason: "waiting", waitingOn: "the deploy" }, T0 + 31 * MIN)).toContain("31 min ago waiting on the deploy");
  });
});

// What a Run reads of a window (ADR-0032; runOf): the last turn end with its pending lists, the first and latest activity
// after it by the node's clock, and a menu still open after it. Kept apart from the stale turns.
describe("the lane watch: what a Run reads (runOf)", () => {
  const lane = (event: "needs_input" | "answered", question?: string) => ({ event, sessionId: "s1", ...(question ? { question } : {}) });

  it("keeps the turn end's pending lists, and the hooks after it, first and latest; one the fleet took before its turn end counts", () => {
    const r = rig();
    r.watch.saw(r.hook(T0 - MIN));                                                      // the turn before it
    r.watch.saw(r.hook(T0, "/hook/stop"));
    r.watch.saw(r.hook(T0 + 2 * MIN));                                                  // the next turn's first tool call, same batch
    r.watch.saw(r.hook(T0 + 3 * MIN, "/sl"));                                           // the status line's refresh: no activity
    r.watch.turn(r.finished(T0, { status: "done", firstLine: "STATUS: DONE", bg: 1, tasks: [{ type: "shell", label: "npm test" }], wakes: [{ schedule: "0 9 * * *", recurring: true }] }));
    r.watch.saw(r.hook(T0 + 4 * MIN));
    expect(r.watch.runOf("pc", "api")).toEqual({
      turn: { at: T0, status: "done", line: "STATUS: DONE", tasks: [{ type: "shell", label: "npm test" }], wakes: [{ schedule: "0 9 * * *", recurring: true }], waitingOn: null, until: null },
      activity: { first: T0 + 2 * MIN, last: T0 + 4 * MIN }, needsInput: null,          // negative control: T0 - MIN kept as first
    });
    expect(r.watch.runOf("pc", "web")).toBeNull();
    expect(r.watch.view()).toHaveLength(1);                                             // the stale turns are as they were
  });

  it("a turn end stored before the lists (counts only) gets a placeholder per count", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { bg: 2, crons: 1 }));
    expect(r.watch.runOf("pc", "api")?.turn).toMatchObject({
      tasks: [{ type: "task", label: "background work" }, { type: "task", label: "background work" }], wakes: [{ schedule: "", recurring: false }],
    });
  });

  it("a needs_input after the turn end until it is answered; one from before the turn end is not kept", () => {
    const r = rig();
    r.watch.turn(r.finished(T0));
    r.watch.saw(r.hook(T0 + MIN, "/lane", lane("needs_input", "Allow npm test?")));
    expect(r.watch.runOf("pc", "api")?.needsInput).toEqual({ at: T0 + MIN, question: "Allow npm test?" });
    r.watch.saw(r.hook(T0 + 2 * MIN, "/lane", lane("answered")));
    expect(r.watch.runOf("pc", "api")?.needsInput).toBeNull();
    r.watch.saw(r.hook(T0 + 3 * MIN, "/lane", lane("needs_input")));
    r.watch.turn(r.finished(T0 + 4 * MIN));                                             // the menu was before this turn end
    expect(r.watch.runOf("pc", "api")?.needsInput).toBeNull();
  });

  it("a turn end only a Run reads (the manager's) is kept, and not watched for stale", () => {
    const r = rig();
    const { seq: _, ...draft } = r.finished(T0, { window: "manager", lane: "manager", tasks: [{ type: "monitor", label: "lane events" }] });
    r.watch.runTurn(draft);
    expect(r.watch.runOf("pc", "manager")?.turn?.tasks).toEqual([{ type: "monitor", label: "lane events" }]);
    expect(r.watch.view()).toEqual([]);
  });

  it("after a rebuild, the stored turn end's lists, and a stored menu after it", () => {
    const r = rig();
    r.at(T0 + 10 * MIN);
    r.watch.rebuild([
      r.finished(T0, { tasks: [{ type: "shell", label: "npm test" }] }),
      { ...r.state("needs_input", T0 + MIN), question: "Which branch?" },
    ]);
    expect(r.watch.runOf("pc", "api")).toMatchObject({ turn: { tasks: [{ type: "shell", label: "npm test" }] }, needsInput: { at: T0 + MIN, question: "Which branch?" }, activity: { first: T0 + MIN } });
  });

  it("lets a window's entry go a day after its last sign once the window is gone, and keeps it while it is there", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { status: "done" }));
    r.at(T0 + REBUILD_WINDOW_MS + 1);
    r.watch.sweep();
    expect(r.watch.runOf("pc", "api")).not.toBeNull();
    r.alive.value = false;
    r.watch.sweep();
    expect(r.watch.runOf("pc", "api")).toBeNull();
  });
});

// A turn whose Stop never arrived (T-422): the session was seen leaving idle, then working, then idle, no turn end
// covers that busy start, and the watch heard a hook from it in that span — Claude Code's idle compaction fires none,
// so a span with no hook in it is not a lost turn. A lane first seen already working is a restart and is not judged.
describe("a turn end that never arrived (T-422)", () => {
  const BUSY = T0 + 10 * MIN;
  const IDLE = T0 + 40 * MIN;
  const seed = (r: ReturnType<typeof rig>) => r.watch.turn(r.finished(T0, { status: "blocked", sessionId: "s1" }));
  // Idle first, so the following busy is a start the watch saw. A first sighting already busy is not one.
  const began = (r: ReturnType<typeof rig>, busyAt = BUSY) => { r.at(busyAt - MIN); r.panes("idle"); r.at(busyAt); r.panes("busy"); };
  // A hook the watch takes inside the busy span: the lane was working, not compacting.
  const worked = (r: ReturnType<typeof rig>, busyAt = BUSY, at = busyAt + MIN) => { r.at(at); r.watch.saw(r.hook(at)); };
  const ended = (r: ReturnType<typeof rig>, idleAt = IDLE) => { r.at(idleAt); r.panes("idle"); };

  it("flags a working lane that went idle with no turn end after the grace, once", () => {
    const r = rig();
    seed(r);
    began(r);
    worked(r);
    ended(r);
    r.at(IDLE + LOST_TURN_GRACE_MS - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);
    r.at(IDLE + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    r.watch.sweep();
    expect(r.raised).toEqual([{
      v: 1, t: "lane", event: "stale", node: "pc", window: "api", lane: "api", at: IDLE + LOST_TURN_GRACE_MS,
      sessionId: "s1", reason: "no_turn_end", since: IDLE, stalls: 1,
    }]);
    expect(r.nudged).toEqual([]);
  });

  it("an interrupted session gets no resume nudge (T-422)", () => {
    const r = rig({ config: { ...CONFIG, nudge: true } });
    seed(r);
    began(r);
    worked(r);
    ended(r);
    r.at(IDLE + LOST_TURN_GRACE_MS + 10 * MIN);
    r.watch.sweep();
    expect(r.raised).toEqual([{
      v: 1, t: "lane", event: "stale", node: "pc", window: "api", lane: "api", at: IDLE + LOST_TURN_GRACE_MS + 10 * MIN,
      sessionId: "s1", reason: "no_turn_end", since: IDLE, stalls: 1,
    }]);
    expect(r.nudged).toEqual([]);
    let idleAt = IDLE;
    for (let i = 2; i <= 3; i++) {
      const busyAt = idleAt + 10 * MIN;
      began(r, busyAt);
      worked(r, busyAt);
      idleAt = busyAt + 30 * MIN;
      ended(r, idleAt);
      r.at(idleAt + LOST_TURN_GRACE_MS + 10 * MIN);
      r.watch.sweep();
      expect(r.raised.at(-1)).toMatchObject({ reason: "no_turn_end", stalls: i });
      expect(r.nudged).toEqual([]);
    }
  });

  it("does not flag when the turn end arrives", () => {
    for (const at of [IDLE, IDLE + 4 * MIN]) {
      const r = rig();
      seed(r);
      began(r);
      worked(r);
      ended(r);
      r.at(at);                                                                         // the fleet takes it now, after the busy start
      r.watch.turn(r.finished(at, { status: "done", sessionId: "s1" }));
      r.at(IDLE + LOST_TURN_GRACE_MS);
      r.watch.sweep();
      expect([r.raised, r.nudged]).toEqual([[], []]);
    }
  });

  it("covers a turn end the fleet took at the busy start minus the skew, on its own clock", () => {
    const covered = rig();
    covered.at(BUSY - LOST_TURN_SKEW_MS);
    covered.watch.turn(covered.finished(0, { status: "blocked", sessionId: "s1" }));   // the node's clock is irrelevant
    began(covered);
    worked(covered);
    ended(covered);
    covered.at(IDLE + LOST_TURN_GRACE_MS);
    covered.watch.sweep();
    expect(covered.raised).toEqual([]);
    const missed = rig();
    missed.at(BUSY - LOST_TURN_SKEW_MS - 1);
    missed.watch.turn(missed.finished(T0 + 24 * 60 * MIN, { status: "blocked", sessionId: "s1" }));
    began(missed);
    worked(missed);
    ended(missed);
    missed.at(IDLE + LOST_TURN_GRACE_MS);
    missed.watch.sweep();
    expect(missed.raised).toHaveLength(1);
    expect(missed.raised[0]).toMatchObject({ reason: "no_turn_end", since: IDLE });
  });

  it("a node whose clock is behind does not make short turns look lost (T-422)", () => {
    const T = T0;
    const behind = rig();
    behind.at(T - MIN);                                                                 // a prior turn, taken before the busy start
    behind.watch.turn(behind.finished(T - 10 * MIN, { status: "blocked", sessionId: "s1" }));
    began(behind, T);
    behind.at(T + 30_000);
    behind.watch.turn(behind.finished(T - 5 * MIN, { status: "done", sessionId: "s1" })); // node 5.5 min behind the fleet
    ended(behind, T + 30_000);
    behind.at(T + 30_000 + LOST_TURN_GRACE_MS);
    behind.watch.sweep();
    expect(behind.raised).toEqual([]);
    const lost = rig();
    lost.at(T - MIN);
    lost.watch.turn(lost.finished(T - 10 * MIN, { status: "blocked", sessionId: "s1" }));
    began(lost, T);
    worked(lost, T, T + 10_000);
    ended(lost, T + 30_000);
    lost.at(T + 30_000 + LOST_TURN_GRACE_MS);
    lost.watch.sweep();
    expect(lost.raised).toHaveLength(1);
    expect(lost.raised[0]).toMatchObject({ reason: "no_turn_end" });
  });

  it("a node whose clock is ahead does not hide a lost turn end", () => {
    const r = rig();
    r.at(BUSY - LOST_TURN_SKEW_MS - MIN);
    r.watch.turn(r.finished(BUSY + 60 * MIN, { status: "blocked", sessionId: "s1" }));  // taken before the busy start
    began(r);
    worked(r);
    ended(r);
    r.at(IDLE + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toMatchObject({ reason: "no_turn_end", since: IDLE });
  });

  it("does not judge a lane first seen working (a restart)", () => {
    const restart = rig();
    seed(restart);
    restart.at(BUSY);
    restart.panes("busy");
    restart.at(IDLE);
    restart.panes("idle");
    restart.at(IDLE + LOST_TURN_GRACE_MS);
    restart.watch.sweep();
    expect(restart.raised).toEqual([]);
  });

  it("does not judge a lane that never had a turn end", () => {
    const never = rig();
    began(never);
    worked(never);
    ended(never);
    never.at(IDLE + LOST_TURN_GRACE_MS);
    never.watch.sweep();
    expect(never.raised).toEqual([]);
  });

  it("a failed turn is a turn end", () => {
    const r = rig();
    seed(r);
    began(r);
    r.at(BUSY + 1_000);                                                                 // the fleet takes the failure after the busy start
    r.watch.saw(r.hook(T0 - 60 * MIN, "/hook/failure", {}));                            // the hook's own time is far in the past
    ended(r);
    r.at(IDLE + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    expect([r.raised, r.nudged]).toEqual([[], []]);
  });

  it("leaves out unwatched, multi-pane and offline cases", () => {
    const unseen = rig({ watched: () => false });
    seed(unseen);
    began(unseen);
    ended(unseen);
    unseen.at(IDLE + LOST_TURN_GRACE_MS);
    unseen.watch.sweep();
    expect(unseen.raised).toEqual([]);

    const many = rig();
    seed(many);
    many.at(BUSY - MIN);
    many.watch.panes("pc", [{ window: "api", sessionId: "s1", status: "idle" }, { window: "api", sessionId: "s2", status: "idle" }]);
    many.at(BUSY);
    many.watch.panes("pc", [{ window: "api", sessionId: "s1", status: "busy" }, { window: "api", sessionId: "s2", status: "busy" }]);
    many.at(IDLE);
    many.watch.panes("pc", [{ window: "api", sessionId: "s1", status: "idle" }, { window: "api", sessionId: "s2", status: "idle" }]);
    many.at(IDLE + LOST_TURN_GRACE_MS);
    many.watch.sweep();
    expect(many.raised).toEqual([]);

    let up = false;
    const offline = rig({ online: () => up });
    seed(offline);
    began(offline);
    worked(offline);
    ended(offline);
    offline.at(IDLE + LOST_TURN_GRACE_MS);
    offline.watch.sweep();
    expect(offline.raised).toEqual([]);
    up = true;
    offline.watch.sweep();
    expect(offline.raised).toHaveLength(1);

    const gone = rig();
    seed(gone);
    began(gone);
    ended(gone);
    gone.alive.value = false;
    gone.at(IDLE + LOST_TURN_GRACE_MS);
    gone.watch.sweep();
    expect(gone.raised).toEqual([]);
    gone.alive.value = true;
    gone.watch.sweep();
    expect(gone.raised).toEqual([]);
  });

  it("counts stalls for repeated losses; a settled turn resets the count, and none of them nudge", () => {
    const r = rig();
    seed(r);
    let idleAt = T0;
    for (let i = 1; i <= 3; i++) {
      const busyAt = idleAt + 10 * MIN;
      began(r, busyAt);
      worked(r, busyAt);
      idleAt = busyAt + 30 * MIN;
      ended(r, idleAt);
      r.at(idleAt + LOST_TURN_GRACE_MS);
      r.watch.sweep();
      expect(r.raised.at(-1)?.stalls).toBe(i);
    }
    expect(r.nudged).toEqual([]);
    r.at(idleAt + LOST_TURN_GRACE_MS);
    r.watch.turn(r.finished(idleAt + LOST_TURN_GRACE_MS, { status: "done", sessionId: "s1" }));
    const busyAt = idleAt + LOST_TURN_GRACE_MS + 10 * MIN;
    began(r, busyAt);
    worked(r, busyAt);
    idleAt = busyAt + 30 * MIN;
    ended(r, idleAt);
    r.at(idleAt + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    expect(r.raised.at(-1)?.stalls).toBe(1);
    expect(r.nudged).toEqual([]);
  });

  it("stays quiet when the lane went busy again before the grace", () => {
    const r = rig();
    seed(r);
    began(r);
    ended(r);
    r.at(IDLE + MIN);
    r.panes("busy");
    r.at(IDLE + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    expect([r.raised, r.nudged]).toEqual([[], []]);
  });

  it("a store failure is retried at the next sweep", () => {
    const stored: LaneEventDraft[] = [];
    let left = 1;
    const r = rig({
      raise: d => {
        if (left > 0) { left -= 1; throw new Error("busy"); }
        stored.push(d);
        return { ...d, seq: stored.length } as LaneEvent;
      },
    });
    seed(r);
    began(r);
    worked(r);
    ended(r);
    r.at(IDLE + LOST_TURN_GRACE_MS);
    r.watch.sweep();
    expect(stored).toEqual([]);
    r.watch.sweep();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ reason: "no_turn_end", stalls: 1, since: IDLE });
  });
});
