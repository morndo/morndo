// Runs (docs/domain.md "Runs"; ADR-0032): R1 to R8 on deriveRun, R6 on pendingOf, R3's fire time on nextFire.
import { describe, expect, it } from "vitest";
import { deriveRun, nextFire, pendingOf, ACTIVE_MS, WAKE_GRACE_MS, type RunFacts, type TurnEnd } from "../src/run.ts";

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const MIN = 60_000;
const WAIT = 30 * MIN;
const turn = (o: Partial<TurnEnd> = {}): TurnEnd => ({ at: T0, status: "done", line: "STATUS: DONE", tasks: [], wakes: [], waitingOn: null, until: null, ...o });
const facts = (o: Partial<RunFacts> = {}): RunFacts => ({
  lane: "alpha", node: "pc", nodeOnline: true, windowAlive: true, session: "idle", turn: turn(), activity: null, needsInput: null, jobs: [],
  waitMs: WAIT, tzOffsetMin: 0, changedAt: T0 - 5 * MIN, now: T0 + MIN, ...o,
});
const redact = (s: string) => s.replace(/sk-[A-Za-z0-9]+/g, "[redacted]");

describe("R7: precedence, first match wins", () => {
  it("gone, then unknown, then needs you, then working, then job, then background, then wake-up, then declared, then ended", () => {
    // A turn running: the session busy and a hook after the last turn end (a turn's start always fires one).
    const busy = { session: "busy" as const, activity: { first: T0 + 2 * MIN, last: T0 + 2 * MIN }, needsInput: { at: T0 + 1 }, jobs: [{ id: "j1", name: "ci", startedAt: T0 }], turn: turn({ status: "waiting", tasks: [{ type: "shell", label: "npm test" }], wakes: [{ schedule: "5 12 * * *", recurring: false }] }) };
    expect(deriveRun(facts({ ...busy, windowAlive: false })).phase).toBe("gone");
    expect(deriveRun(facts({ ...busy, nodeOnline: false, windowAlive: false })).phase).toBe("unknown");
    expect(deriveRun(facts(busy)).phase).toBe("needs_you");
    expect(deriveRun(facts({ ...busy, needsInput: null })).phase).toBe("working");
    expect(deriveRun(facts({ ...busy, needsInput: null, session: "idle" })).wait?.on).toBe("job");
    expect(deriveRun(facts({ ...busy, needsInput: null, session: "idle", jobs: [] })).wait?.on).toBe("background");
    expect(deriveRun(facts({ session: "idle", turn: turn({ status: "waiting", wakes: [{ schedule: "5 12 * * *", recurring: false }] }) })).wait?.on).toBe("wakeup");
    expect(deriveRun(facts({ session: "idle", turn: turn({ status: "waiting", waitingOn: "CI" }) })).wait).toEqual({ on: "declared", what: "CI" });
    expect(deriveRun(facts()).phase).toBe("ended");
  });
});

describe("R2: a turn end with work pending is never ended", () => {
  it("background tasks make it waiting on its own work, whatever the status line said", () => {
    const r = deriveRun(facts({ turn: turn({ status: "done", tasks: [{ type: "shell", label: "gh run watch" }] }) }));
    expect(r.phase).toBe("waiting");                                       // negative control: without R2 a DONE line says ended
    expect(r.wait).toEqual({ on: "background", tasks: [{ type: "shell", label: "gh run watch" }] });
    expect(r.source).toBe("hook");
  });
  it("the turn's own outcome stays on the Run while background work is pending", () => {
    const tasks = [{ type: "shell", label: "gh run watch" }];
    expect(deriveRun(facts({ turn: turn({ status: "done", tasks }) })).outcome).toBe("done");
    expect(deriveRun(facts({ turn: turn({ status: "blocked", tasks }) })).outcome).toBe("blocked");
    expect(deriveRun(facts({ turn: turn({ status: "waiting", tasks }) })).outcome).toBeUndefined();
    expect(deriveRun(facts({ turn: turn({ status: null, tasks }) })).outcome).toBeUndefined();
  });
  it("a later turn start makes it working; a later turn end with nothing pending ends it", () => {
    expect(deriveRun(facts({ session: "busy", turn: turn({ tasks: [{ type: "shell", label: "x" }] }), activity: { first: T0 + 2 * MIN, last: T0 + 3 * MIN } })).phase).toBe("working");
    expect(deriveRun(facts({ turn: turn({ at: T0 + 5 * MIN }) })).phase).toBe("ended");
  });
  it("the turn's own word stays on the Run while it waits on a wake-up or a job, as it does for background work (the board's D1 reads it)", () => {
    const wake = [{ schedule: "30 12 * * *", recurring: false }];
    for (const status of ["done", "blocked", "needs_decision"] as const) {
      expect(deriveRun(facts({ turn: turn({ status, wakes: wake }) }))).toMatchObject({ phase: "waiting", wait: { on: "wakeup" }, outcome: status });
      expect(deriveRun(facts({ turn: turn({ status }), jobs: [{ id: "j1", name: "ci", startedAt: T0 }] }))).toMatchObject({ phase: "waiting", wait: { on: "job" }, outcome: status });
    }
    // a WAITING line, or no line at all, says no outcome
    expect(deriveRun(facts({ turn: turn({ status: "waiting", wakes: wake }) })).outcome).toBeUndefined();
    expect(deriveRun(facts({ turn: turn({ status: null, wakes: wake }) })).outcome).toBeUndefined();
    expect(deriveRun(facts({ turn: turn({ status: null }), jobs: [{ id: "j1", name: "ci", startedAt: T0 }] })).outcome).toBeUndefined();
    expect(deriveRun(facts({ turn: null, jobs: [{ id: "j1", name: "ci", startedAt: T0 }] })).outcome).toBeUndefined();
  });
  it("a scheduled wake-up makes it waiting on the wake-up", () => {
    expect(deriveRun(facts({ turn: turn({ status: null, wakes: [{ schedule: "30 12 * * *", recurring: false }] }) })).wait).toEqual({ on: "wakeup", next: T0 + 30 * MIN });
  });
});

describe("R2: a session that looks busy while its own background work runs", () => {
  const shellTask = { type: "shell", label: "Sleep 75s then print marker" };
  it("`shell` (or `busy`) after a turn end that left work pending, with no hook since, waits on that work", () => {
    expect(deriveRun(facts({ session: "shell", turn: turn({ status: "waiting", tasks: [shellTask] }) })).wait?.on).toBe("background");   // negative control: the session state alone said working
    expect(deriveRun(facts({ session: "busy", turn: turn({ status: null, tasks: [shellTask] }) })).wait?.on).toBe("background");
  });
  it("a hook after the turn end is a new turn: working", () => {
    expect(deriveRun(facts({ session: "shell", turn: turn({ tasks: [shellTask] }), activity: { first: T0 + MIN, last: T0 + MIN } })).phase).toBe("working");
  });
  it("with nothing pending, the session state alone is a turn running", () => {
    expect(deriveRun(facts({ session: "shell", turn: turn() })).phase).toBe("working");
  });
});

describe("R3: every wait has a deadline; past it with nothing since, overdue", () => {
  it("background: the WAITING line's lease, else the lane watch's", () => {
    expect(deriveRun(facts({ turn: turn({ tasks: [{ type: "shell", label: "x" }] }) })).deadline).toBe(T0 + WAIT);
    expect(deriveRun(facts({ turn: turn({ status: "waiting", until: T0 + 12 * MIN, tasks: [{ type: "shell", label: "x" }] }) })).deadline).toBe(T0 + 12 * MIN);
  });
  it("overdue only past the deadline and only with no activity since the turn end", () => {
    const t = turn({ status: "waiting", waitingOn: "CI", until: T0 + 10 * MIN });
    expect(deriveRun(facts({ turn: t, now: T0 + 9 * MIN })).overdue).toBe(false);
    expect(deriveRun(facts({ turn: t, now: T0 + 11 * MIN })).overdue).toBe(true);
    expect(deriveRun(facts({ turn: t, now: T0 + 11 * MIN, activity: { first: T0 + 10.5 * MIN, last: T0 + 10.5 * MIN } })).overdue).toBe(false);
  });
  it("a wake-up's deadline is its next fire time plus the grace; an unreadable one falls back to the lease", () => {
    const at = T0;                                                              // 12:00 UTC
    expect(deriveRun(facts({ turn: turn({ at, status: null, wakes: [{ schedule: "45 12 * * *", recurring: false }] }) })).deadline).toBe(T0 + 45 * MIN + WAKE_GRACE_MS);
    expect(deriveRun(facts({ turn: turn({ at, status: null, wakes: [{ schedule: "nonsense", recurring: false }] }) })).deadline).toBe(T0 + WAIT);
    expect(deriveRun(facts({ tzOffsetMin: null, turn: turn({ at, status: null, wakes: [{ schedule: "45 12 * * *", recurring: false }] }) })).wait).toEqual({ on: "wakeup", next: null });
  });
});

describe("R4: a declared wait has no waker", () => {
  it("WAITING with nothing pending and no job is declared, from the status line", () => {
    const r = deriveRun(facts({ turn: turn({ status: "waiting", waitingOn: "the deploy", line: "STATUS: WAITING the deploy for 20 min" }) }));
    expect(r).toMatchObject({ phase: "waiting", wait: { on: "declared", what: "the deploy" }, source: "status" });
  });
  it("a running job of the lane is a waker: waiting on the job, not declared", () => {
    const r = deriveRun(facts({ turn: turn({ status: "waiting" }), jobs: [{ id: "j7", name: "deploy", startedAt: T0 - MIN }] }));
    expect(r).toMatchObject({ phase: "waiting", wait: { on: "job", jobs: [{ id: "j7", name: "deploy" }] }, source: "job", since: T0 - MIN });
  });
});

describe("R5: gone and unknown", () => {
  it("a window gone from an online node is gone, since its change", () => {
    expect(deriveRun(facts({ windowAlive: false, session: null }))).toMatchObject({ phase: "gone", since: T0 - 5 * MIN });
  });
  it("a node not online makes the run unknown, never working, whatever its last state", () => {
    expect(deriveRun(facts({ nodeOnline: false, session: "busy" })).phase).toBe("unknown");
  });
  it("hooks alone call a lane with no session state working only while they are recent", () => {
    const activity = { first: T0 + MIN, last: T0 + 2 * MIN };
    expect(deriveRun(facts({ session: null, activity, now: T0 + 3 * MIN })).phase).toBe("working");
    expect(deriveRun(facts({ session: null, activity, now: T0 + 2 * MIN + ACTIVE_MS + 1 })).phase).toBe("ended");
    expect(deriveRun(facts({ session: "idle", activity, now: T0 + 3 * MIN })).phase).toBe("ended");  // the session state is the truth when there is one
  });
});

describe("R8: every run names its source and since", () => {
  it("working by the session since the first hook after the turn end", () => {
    expect(deriveRun(facts({ session: "busy", activity: { first: T0 + MIN, last: T0 + 4 * MIN } }))).toMatchObject({ source: "session", since: T0 + MIN });
  });
  it("needs you by the session, or by a needs_input with its question", () => {
    expect(deriveRun(facts({ session: "waiting" })).source).toBe("session");
    expect(deriveRun(facts({ needsInput: { at: T0 + 2 * MIN, question: "Which year?" } }))).toMatchObject({ phase: "needs_you", source: "hook", since: T0 + 2 * MIN, question: "Which year?" });
  });
  it("ended carries the outcome and the line; no turn yet is ended without a status", () => {
    expect(deriveRun(facts({ turn: turn({ status: "blocked", line: "STATUS: BLOCKED on keys" }) }))).toMatchObject({ phase: "ended", outcome: "blocked", line: "STATUS: BLOCKED on keys", source: "status", since: T0 });
    expect(deriveRun(facts({ turn: null }))).toMatchObject({ phase: "ended", outcome: "no_status", since: T0 - 5 * MIN });
  });
});

describe("R6: pending lists keep no command and no prompt", () => {
  it("a task is its type and its description, redacted and cut; never its command", () => {
    const { tasks } = pendingOf([{ id: "b1", type: "shell", status: "running", description: "Watch CI with sk-abc123", command: "gh run watch 1220 --token sk-abc123" }], [], redact);
    expect(tasks).toEqual([{ type: "shell", label: "Watch CI with [redacted]" }]);
    expect(JSON.stringify(tasks)).not.toContain("gh run watch");             // negative control: the command never shows
  });
  it("a long description is cut to 80 characters; no description falls back to the type", () => {
    const { tasks } = pendingOf([{ type: "subagent", description: "x".repeat(300) }, { type: "monitor" }], [], redact);
    expect(tasks[0]?.label.length).toBe(80);
    expect(tasks[1]).toEqual({ type: "monitor", label: "monitor" });
  });
  it("a wake-up is its schedule and whether it recurs; never its prompt; at most 8 of each; counts from the owner's scripts", () => {
    const { wakes } = pendingOf([], [{ id: "c1", schedule: "7 15 20 10 *", recurring: false, prompt: "check the deploy secret" }], redact);
    expect(wakes).toEqual([{ schedule: "7 15 20 10 *", recurring: false }]);
    expect(pendingOf(Array.from({ length: 20 }, () => ({ type: "shell" })), [], redact).tasks).toHaveLength(8);
    expect(pendingOf(2, 1, redact)).toEqual({ tasks: [{ type: "task", label: "background work" }, { type: "task", label: "background work" }], wakes: [{ schedule: "", recurring: false }] });
  });
});

describe("nextFire: a five-field schedule in the node's local time", () => {
  const at = Date.parse("2026-10-20T12:00:00.000Z");
  it("a one-shot wake-up at its single time, after the turn end", () => {
    expect(nextFire("7 15 20 10 *", at, 0)).toBe(Date.parse("2026-10-20T15:07:00.000Z"));
  });
  it("the node's offset: 15:07 in UTC+2 is 13:07 UTC", () => {
    expect(nextFire("7 15 20 10 *", at, 120)).toBe(Date.parse("2026-10-20T13:07:00.000Z"));
  });
  it("steps, ranges, lists and weekdays", () => {
    expect(nextFire("*/15 * * * *", at, 0)).toBe(Date.parse("2026-10-20T12:15:00.000Z"));
    expect(nextFire("0 9 * * 1-5", Date.parse("2026-10-23T10:00:00.000Z"), 0)).toBe(Date.parse("2026-10-26T09:00:00.000Z"));  // Friday after 9 → Monday
    expect(nextFire("0 8,20 * * *", at, 0)).toBe(Date.parse("2026-10-20T20:00:00.000Z"));
    expect(nextFire("0 0 * * 7", at, 0)).toBe(Date.parse("2026-10-25T00:00:00.000Z"));       // 7 is Sunday
  });
  it("unreadable schedules and impossible dates are null", () => {
    for (const s of ["", "* * * *", "61 * * * *", "a b c d e", "0 0 31 2 *", "*/0 * * * *"]) expect(nextFire(s, at, 0), s).toBeNull();
  });
});
