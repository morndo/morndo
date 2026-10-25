// What a blocked task waits on (B18) and the board's own move when that is over (D7): the waits a block names, in a
// grammar the board checks itself, and nothing a person must remember to re-check. Pure.
import { describe, expect, it } from "vitest";
import {
  MORNDO_REPO, STALE_BLOCK_MS, WAITS_MAX, applyAction, createTask, endpointId, isStaleBlock, judgeWait, parseWait, sessionId, waitMove, waitSpec,
  type BoardActor, type Task, type TaskActor, type Wait,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const builder: BoardActor = { kind: "worker", name: "builder", token: "tok-w" };
const principal: BoardActor = { kind: "principal", endpointId: endpointId("ep-1"), sessionId: sessionId("s-1") };
const REPOS = [MORNDO_REPO, "acme/widgets"];

const task = (n = 1, assignee: string | null = "builder"): Task => {
  const r = createTask({ title: `task ${n}`, assignee }, manager, n, NOW);
  if (!r.ok) throw new Error(r.error.problem);
  return r.value.task;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const problem = (r: { ok: boolean; error?: unknown }) => (r.ok ? "ok" : (r.error as { problem: string }).problem);
const gate = { merges: [], liveness: () => ({ live: true as const }), repos: REPOS };
const block = (t: Task, waits: string[], by: TaskActor = manager, at = NOW + 1) =>
  applyAction(t, { action: "move", to: "blocked", reason: "waits for the merge", waits }, by, at, [t], gate);

describe("the waits a block may name (B18)", () => {
  it("reads a task, a pull request, an owner's card and a time, each in one canonical spelling", () => {
    const at = NOW + 2 * HOUR;
    const cases: [string, Wait, string][] = [
      ["T-12", { kind: "task", key: "T-12" as Task["key"] }, "T-12"],
      ["#93", { kind: "pr", repo: MORNDO_REPO, n: 93 }, "morndo/morndo#93"],
      ["morndo/morndo#93", { kind: "pr", repo: MORNDO_REPO, n: 93 }, "morndo/morndo#93"],
      ["pr@acme/widgets#7", { kind: "pr", repo: "acme/widgets", n: 7 }, "acme/widgets#7"],
      ["ny-530", { kind: "card", id: "ny-530" }, "ny-530"],
      [`until:${new Date(at).toISOString()}`, { kind: "time", at }, `until:${new Date(at).toISOString()}`],
      ["until:2027-01-15T09:30:00+01:00", { kind: "time", at: Date.parse("2027-01-15T08:30:00Z") }, "until:2027-01-15T08:30:00.000Z"],
    ];
    for (const [spec, wait, canonical] of cases) {
      const w = ok(parseWait(spec, NOW, REPOS));
      expect(w, spec).toEqual(wait);
      expect(waitSpec(w), spec).toBe(canonical);
    }
  });
  it("refuses what the board could never check, saying why", () => {
    for (const spec of [
      "", "T-0", "T-x", "tomorrow", "#0", "#-1", "pr@nobody#3", "other/repo#4",   // a repository the hub doesn't read
      "ny-", "NY-5", "until:2026-01-01T00:00:00Z",                                   // a time already past
      "until:2027-01-15T09:30",                                                         // no offset: whose 09:30?
      `until:${new Date(NOW + 91 * 24 * HOUR).toISOString()}`,                          // further than the board looks ahead
      "T-12 and #93",
    ]) {
      const r = parseWait(spec, NOW, REPOS);
      expect(r.ok, spec).toBe(false);
      if (!r.ok) {
        expect(r.error.problem, spec).toBe("bad_wait");
        expect(r.error.detail, spec).toBeTruthy();
      }
    }
  });
});

describe("a block that names its waits (B18)", () => {
  it("keeps the waits on the task and in the move's event", () => {
    const { task: t, event } = ok(block(task(), ["#93", "ny-530"]));
    expect(t.status).toBe("blocked");
    expect(t.waits).toEqual([{ kind: "pr", repo: MORNDO_REPO, n: 93 }, { kind: "card", id: "ny-530" }]);
    expect(event.change).toMatchObject({ kind: "moved", to: "blocked", reason: "waits for the merge", waits: t.waits });
  });
  it("may be the lane's own block of its own task", () => {
    const t = { ...task(), status: "doing" as const };
    expect(ok(block(t, ["T-7"], builder)).task.waits).toEqual([{ kind: "task", key: "T-7" }]);
  });
  it("names a wait once, at most WAITS_MAX of them, never the task itself", () => {
    expect(ok(block(task(), ["#93", "morndo/morndo#93", "pr@morndo/morndo#93"])).task.waits).toHaveLength(1);
    expect(problem(block(task(), ["#1", "#2", "#3", "#4"].slice(0, WAITS_MAX + 1)))).toBe("too_many");
    expect(problem(block(task(1), ["T-1"]))).toBe("bad_wait");
  });
  it("refuses a bad one whole: nothing is blocked on half a list", () => {
    expect(problem(block(task(), ["#93", "soon"]))).toBe("bad_wait");
  });
  it("names waits only on a move to blocked", () => {
    expect(problem(applyAction(task(), { action: "move", to: "doing", waits: ["#93"] }, manager, NOW + 1, [], gate))).toBe("bad_wait");
  });
  it("clears them when the task leaves blocked, whoever moves it", () => {
    const blocked = ok(block(task(), ["#93"])).task;
    for (const [to, by] of [["doing", builder], ["todo", manager], ["done", principal]] as const) {
      const moved = ok(applyAction(blocked, { action: "move", to, reason: "checked" }, by, NOW + 2, [blocked], gate)).task;
      expect(moved.waits ?? [], `${to}`).toEqual([]);
    }
  });
  it("may be restated on a task already blocked, to name its waits, by whoever may block it; the same again is refused", () => {
    const words = ok(applyAction(task(), { action: "move", to: "blocked", reason: "waits on the owner's tap" }, manager, NOW + 1, [], gate)).task;
    const restated = ok(applyAction(words, { action: "move", to: "blocked", reason: "waits on the owner's tap", waits: ["ny-530"] }, manager, NOW + 2, [words], gate));
    expect(restated.task.waits).toEqual([{ kind: "card", id: "ny-530" }]);
    expect(restated.event.change).toMatchObject({ kind: "moved", from: "blocked", to: "blocked", waits: [{ kind: "card", id: "ny-530" }] });
    expect(problem(applyAction(restated.task, { action: "move", to: "blocked", reason: "waits on the owner's tap", waits: ["ny-530"] }, manager, NOW + 3, [restated.task], gate))).toBe("same");
    expect(problem(applyAction(restated.task, { action: "move", to: "blocked", reason: "x", waits: ["#93"] }, { kind: "worker", name: "other", token: "t" }, NOW + 3, [restated.task], gate))).toBe("not_yours");
    expect(ok(applyAction(restated.task, { action: "move", to: "blocked", reason: "x", waits: ["#93"] }, builder, NOW + 3, [restated.task], gate)).task.waits).toHaveLength(1);
  });
  it("a block without waits is a block as before: words only", () => {
    const t = ok(applyAction(task(), { action: "move", to: "blocked", reason: "needs the owner" }, manager, NOW + 1, [], gate)).task;
    expect(t.waits ?? []).toEqual([]);
  });
});

describe("judging a wait (B18)", () => {
  const pr: Wait = { kind: "pr", repo: MORNDO_REPO, n: 93 };
  const other: Wait = { kind: "pr", repo: "acme/widgets", n: 7 };
  it("over only on what the board read itself; unread is unknown, never over", () => {
    expect(judgeWait({ kind: "task", key: "T-7" as Task["key"] }, { kind: "task", status: "done" }, NOW)).toEqual({ state: "over", label: "T-7 done" });
    expect(judgeWait({ kind: "task", key: "T-7" as Task["key"] }, { kind: "task", status: "review" }, NOW)).toEqual({ state: "open", label: "T-7 in review" });
    expect(judgeWait({ kind: "task", key: "T-7" as Task["key"] }, null, NOW)).toEqual({ state: "unknown", label: "T-7 is not on the board" });
    expect(judgeWait(pr, { kind: "pr", state: "merged" }, NOW)).toEqual({ state: "over", label: "#93 merged" });
    expect(judgeWait(pr, { kind: "pr", state: "closed" }, NOW)).toEqual({ state: "over", label: "#93 closed" });
    expect(judgeWait(other, { kind: "pr", state: "open" }, NOW)).toEqual({ state: "open", label: "acme/widgets#7 open" });
    expect(judgeWait(pr, null, NOW)).toEqual({ state: "unknown", label: "#93 can't be read now" });
    expect(judgeWait({ kind: "card", id: "ny-530" }, { kind: "card", state: "closed" }, NOW)).toEqual({ state: "over", label: "ny-530 closed" });
    expect(judgeWait({ kind: "card", id: "ny-530" }, { kind: "card", state: "open" }, NOW)).toEqual({ state: "open", label: "ny-530 still open" });
    expect(judgeWait({ kind: "card", id: "ny-530" }, null, NOW)).toEqual({ state: "unknown", label: "ny-530 is not on the owner's list" });
    const at = Date.parse("2026-10-28T08:00:00Z");
    expect(judgeWait({ kind: "time", at }, null, at - 1)).toEqual({ state: "open", label: "until 2026-10-28 08:00 UTC" });
    expect(judgeWait({ kind: "time", at }, null, at)).toEqual({ state: "over", label: "2026-10-28 08:00 UTC reached" });
  });
  it("a fact of another kind than the wait is unknown, never over", () => {
    expect(judgeWait(pr, { kind: "task", status: "done" }, NOW).state).toBe("unknown");
  });
});

describe("the board's move when a task's wait is over (D7)", () => {
  const blocked = (waits: string[]) => ok(block(task(), waits)).task;
  it("moves a blocked task to do once every wait it names is over, and says which", () => {
    const t = blocked(["#93", "ny-530"]);
    expect(waitMove(t, [{ state: "over", label: "#93 merged" }, { state: "over", label: "ny-530 closed" }]))
      .toEqual({ to: "todo", reason: "its wait is over: #93 merged, ny-530 closed", rule: "D7" });
  });
  it("moves nothing while one is open or unknown, or when the readings don't match the waits", () => {
    const t = blocked(["#93", "ny-530"]);
    expect(waitMove(t, [{ state: "over", label: "a" }, { state: "open", label: "b" }])).toBeNull();
    expect(waitMove(t, [{ state: "over", label: "a" }, { state: "unknown", label: "b" }])).toBeNull();
    expect(waitMove(t, [{ state: "over", label: "a" }])).toBeNull();
  });
  it("moves nothing for a block of words only, or a task no longer blocked", () => {
    const words = ok(applyAction(task(), { action: "move", to: "blocked", reason: "x" }, manager, NOW + 1, [], gate)).task;
    expect(waitMove(words, [])).toBeNull();
    expect(waitMove({ ...blocked(["#93"]), status: "todo" }, [{ state: "over", label: "a" }])).toBeNull();
  });
  it("is the board's own move, allowed only from blocked to to do, and on a task nobody changed since it read the waits", () => {
    const t = blocked(["#93"]);
    const d7: TaskActor = { kind: "board", rule: "D7", lane: "builder" };
    const moved = ok(applyAction(t, { action: "move", to: "todo", reason: "its wait is over: #93 merged", ifRev: t.rev }, d7, NOW + 2, [t], gate));
    expect(moved.task).toMatchObject({ status: "todo", blockedReason: null });
    expect(moved.event.actor).toEqual(d7);
    expect(problem(applyAction(t, { action: "move", to: "doing", reason: "x", ifRev: t.rev }, d7, NOW + 2, [t], gate))).toBe("bad_transition");
    expect(problem(applyAction({ ...t, status: "doing" }, { action: "move", to: "todo", reason: "x" }, d7, NOW + 2, [t], gate))).toBe("bad_transition");
    expect(problem(applyAction(t, { action: "move", to: "todo", reason: "x", ifRev: t.rev - 1 }, d7, NOW + 2, [t], gate))).toBe("changed");
  });
  it("needs no assignee: an unassigned task's wait ends as well", () => {
    const t = ok(block(task(1, null), ["#93"])).task;
    const d7: TaskActor = { kind: "board", rule: "D7", lane: "-" };
    expect(ok(applyAction(t, { action: "move", to: "todo", reason: "its wait is over: #93 merged", ifRev: t.rev }, d7, NOW + 2, [t], gate)).task.status).toBe("todo");
  });
});

describe("a block of words only that has sat for long (B18)", () => {
  it("is flagged after STALE_BLOCK_MS, so someone checks it; one with waits is the board's to watch", () => {
    const words = ok(applyAction(task(), { action: "move", to: "blocked", reason: "needs the owner" }, manager, NOW, [], gate)).task;
    expect(isStaleBlock(words, NOW + STALE_BLOCK_MS - 1)).toBe(false);
    expect(isStaleBlock(words, NOW + STALE_BLOCK_MS)).toBe(true);
    expect(isStaleBlock(ok(block(task(), ["#93"], manager, NOW)).task, NOW + 10 * STALE_BLOCK_MS)).toBe(false);
    expect(isStaleBlock({ ...words, status: "doing" }, NOW + 10 * STALE_BLOCK_MS)).toBe(false);
  });
});
