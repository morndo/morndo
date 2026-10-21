// The phone's agents list order (ADR-0008 phase F): a push's tap lands on it, so who needs him comes first.
// And the sidebar's sections: who works — mid-turn, waiting for him, or on its own background work (R2).
import type { RosterEntry, Run, RunWait, WorkerId } from "@morndo/domain";
import { describe, expect, it } from "vitest";
import { inBackground, partitionAgents, phoneOrder } from "../src/lib/lanes.ts";

const w = (name: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id: `%${name}` as WorkerId, name, location: "demo", node: "local", offline: false, title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0, ...over,
});
const run = (o: Partial<Run> = {}): Run => ({ lane: "builder", node: "pc", phase: "working", deadline: null, overdue: false, since: 0, source: "session", ...o });
const waiting = (lane: string, wait: RunWait): Run => run({ lane, phase: "waiting", wait });

describe("the phone's agents list", () => {
  it("who needs him first, then who is working, then the rest, each by name", () => {
    const order = phoneOrder([w("builder"), w("worker-02", { state: "active" }), w("reviewer", { needsYou: true }), w("alpha", { needsYou: true, state: "active" }), w("worker-01", { state: "active" }), w("manager")]);
    expect(order.map(x => x.name)).toEqual(["alpha", "reviewer", "worker-01", "worker-02", "builder", "manager"]);
  });
});

describe("the sidebar's sections", () => {
  it("a lane waiting on its own background work is listed under Working", () => {
    const runs = new Map([["builder", waiting("builder", { on: "background", tasks: [{ type: "shell", label: "gh run watch" }] })]]);
    const parts = partitionAgents([w("builder"), w("idle")], runs, () => false);
    expect(parts.working.map(x => x.name)).toEqual(["builder"]);
    expect(parts.idle.map(x => x.name)).toEqual(["idle"]);
  });
  it.each([
    ["job", { on: "job", jobs: [{ id: "j1", name: "e2e" }] }],
    ["wake-up", { on: "wakeup", next: null }],
  ] as [string, RunWait][])("a lane waiting on a %s of its own is listed under Working", (_what, wait) => {
    const parts = partitionAgents([w("builder")], new Map([["builder", waiting("builder", wait)]]), () => false);
    expect(parts.working.map(x => x.name)).toEqual(["builder"]);
    expect(parts.idle).toEqual([]);
  });
  it("a lane waiting on the principal is not: its Run's needs-you, a declared wait or an ended run stays idle, and another lane's run never moves it", () => {
    const idle = (r: Run) => partitionAgents([w("builder")], new Map([["builder", r]]), () => false).idle.map(x => x.name);
    expect(idle(run({ phase: "needs_you" }))).toEqual(["builder"]);                                  // waiting on his answer
    expect(idle(waiting("builder", { on: "declared", what: "the deploy" }))).toEqual(["builder"]);   // nothing will wake it (R4)
    expect(idle(run({ phase: "ended", outcome: "done" }))).toEqual(["builder"]);
    const other = new Map([["reviewer", waiting("reviewer", { on: "background", tasks: [] })]]);
    expect(partitionAgents([w("builder")], other, () => false).idle.map(x => x.name)).toEqual(["builder"]);
    // a lane that needs him is working, as today
    expect(partitionAgents([w("stuck", { needsYou: true })], new Map([["stuck", run({ phase: "needs_you" })]]), () => false).working.map(x => x.name)).toEqual(["stuck"]);
    // an active lane is just working: mid-turn, not waiting on its own work
    const busy = new Map([["busy", waiting("busy", { on: "background", tasks: [] })]]);
    expect(inBackground(w("busy", { state: "active" }), busy)).toBe(false);
    expect(partitionAgents([w("busy", { state: "active" })], busy, () => false).working.map(x => x.name)).toEqual(["busy"]);
  });
  it("a lane that is offline is not in the background, whatever its last Run says: offline wins", () => {
    const runs = new Map([["builder", waiting("builder", { on: "background", tasks: [{ type: "shell", label: "gh run watch" }] })]]);
    expect(inBackground(w("builder", { offline: true }), runs)).toBe(false);
    const parts = partitionAgents([w("builder", { offline: true })], runs, () => false);
    expect(parts.working).toEqual([]);
    expect(parts.idle.map(x => x.name)).toEqual(["builder"]);
  });
  it("a lane that needs him is not tagged as in the background either: needs-you wins, and it is still working", () => {
    const runs = new Map([["builder", waiting("builder", { on: "background", tasks: [] })]]);
    const needs = w("builder", { needsYou: true });
    expect(inBackground(needs, runs)).toBe(false);
    expect(partitionAgents([needs], runs, () => false).working.map(x => x.name)).toEqual(["builder"]);
  });
  it("starred lanes stay in starred whatever their run says, and each section is sorted by name", () => {
    const runs = new Map([["zeta", waiting("zeta", { on: "background", tasks: [] })], ["alpha", waiting("alpha", { on: "wakeup", next: null })]]);
    const parts = partitionAgents([w("zeta"), w("alpha"), w("mid", { needsYou: true }), w("beta")], runs, x => x.name === "alpha");
    expect(parts.starred.map(x => x.name)).toEqual(["alpha"]);
    expect(parts.working.map(x => x.name)).toEqual(["mid", "zeta"]);
    expect(parts.idle.map(x => x.name)).toEqual(["beta"]);
  });
});
