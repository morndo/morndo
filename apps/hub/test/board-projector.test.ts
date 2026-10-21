// The board's own moves (ADR-0032, B10 with D1 to D6; docs/design/agent-board/README.md §4, §8 "Hub") against a real
// board store: BoardProjector reads a lane's runs from a fake Runs source (the fleet's list and its `run` events) and
// moves that lane's tasks through BoardService, as actor { kind: "board", rule, lane }, with the event and the audit
// row any change has (B6). Synthetic lanes and times only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY, GONE_REASON, type Task, type TaskEvent } from "@morndo/domain";
import type { RunView } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { BoardProjector } from "../src/application/board-projector.ts";
import type { RunsSource } from "../src/application/ports.ts";

const T0 = 1_800_000_000_000;
const MANAGER = { kind: "manager", name: "manager", token: "tok-m" } as const;
const BUILDER = { kind: "worker", name: "builder", token: "tok-w" } as const;

// The fleet as the projector sees it: a list to read (or a failure), and the events it is told.
type FakeRuns = RunsSource & { list: RunView[] | Error; reads: number; tell(r: RunView): void; reopen(): void };
function fakeRuns(): FakeRuns {
  let on: ((r: RunView) => void) | null = null;
  let opened: (() => void) | null = null;
  const s: FakeRuns = {
    list: [], reads: 0,
    async runs() { s.reads++; if (s.list instanceof Error) throw s.list; return s.list; },
    subscribe(o, onOpen) { on = o; opened = onOpen; return () => { on = null; opened = null; }; },
    tell: r => on?.(r),
    reopen: () => opened?.(),
  };
  return s;
}
const run = (lane: string, phase: RunView["phase"], since: number, more: Partial<RunView> = {}): RunView =>
  ({ lane, node: "pc", phase, deadline: null, overdue: false, since, source: "status", ...more });

let dir: string;
let store: Store;
let now: number;
let board: BoardService;
let source: FakeRuns;
let projector: BoardProjector;
let logged: { level: "info" | "warn" | "error"; line: string }[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-projector-"));
  store = new Store(dir);
  now = T0;
  board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY });
  source = fakeRuns();
  logged = [];
  const at = (level: "info" | "warn" | "error") => (line: string) => { logged.push({ level, line }); };
  projector = new BoardProjector({ source, board, log: { info: at("info"), warn: at("warn"), error: at("error") } });
});
afterEach(() => { projector.stop(); board.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// A task for `lane`, filed by the manager at `at`, then moved as the lane would (at `at` too).
function task(title: string, lane: string, at: number, status: "todo" | "doing" | "blocked" | "review" = "todo"): Task {
  now = at;
  const made = board.create({ title, assignee: lane }, MANAGER);
  if (!made.ok) throw new Error(made.problem);
  if (status === "todo") return made.task;
  const lanesOwn = { ...BUILDER, name: lane };
  const doing = board.act(made.task.key, { action: "move", to: "doing" }, lanesOwn);
  if (!doing.ok) throw new Error(doing.problem);
  if (status === "doing") return doing.task;
  const moved = board.act(made.task.key, { action: "move", to: status, ...(status === "blocked" ? { reason: "waits on the API" } : {}) }, lanesOwn);
  if (!moved.ok) throw new Error(moved.problem);
  return moved.task;
}
const shown = (key: string) => board.task(key)?.task;
const lastEvent = (key: string): TaskEvent | undefined => board.task(key)?.events.at(-1);
const boardMoves = () => (store.auditOf("BoardChanged", 0) as { actor: { kind: string; name: string | null; rule?: string }; key: string; change: string }[])
  .filter(e => e.actor.kind === "board");

describe("the board follows its assignee's run (B10)", () => {
  it("D4: a to do task goes into progress once its lane's run works since after the task's last change, recorded as the board", async () => {
    const t = task("Build the login page", "builder", T0);
    await projector.start();
    expect(shown(t.key)?.status).toBe("todo");                        // nothing runs yet
    now = T0 + 60_000;
    source.tell(run("builder", "working", T0 + 30_000, { source: "session" }));
    expect(shown(t.key)?.status).toBe("doing");
    expect(lastEvent(t.key)).toMatchObject({ actor: { kind: "board", rule: "D4", lane: "builder" }, change: { kind: "moved", from: "todo", to: "doing", reason: null } });
    // B6: its audit row names the board, the rule and the lane it read.
    expect(boardMoves()).toEqual([expect.objectContaining({ key: t.key, change: "moved", actor: { kind: "board", name: "builder", endpointId: null, token: null, rule: "D4" } })]);
    // The run's frame data is held for the board view.
    expect(projector.runs()).toEqual([run("builder", "working", T0 + 30_000, { source: "session" })]);
  });

  it("D1 and D2: a turn that ends DONE goes to review, BLOCKED or NEEDS DECISION to blocked, each with its status line", async () => {
    const a = task("A", "builder", T0, "doing");
    const b = task("B", "reviewer", T0, "doing");
    const c = task("C", "tester", T0, "doing");
    await projector.start();
    now = T0 + 120_000;
    source.tell(run("builder", "ended", T0 + 60_000, { outcome: "done", line: "STATUS: DONE npm test: 14 passed" }));
    source.tell(run("reviewer", "ended", T0 + 60_000, { outcome: "blocked", line: "STATUS: BLOCKED needs the API key from the manager" }));
    source.tell(run("tester", "ended", T0 + 60_000, { outcome: "needs_decision" }));
    expect(lastEvent(a.key)).toMatchObject({ actor: { kind: "board", rule: "D1" }, change: { from: "doing", to: "review", reason: "STATUS: DONE npm test: 14 passed" } });
    expect(shown(b.key)).toMatchObject({ status: "blocked", blockedReason: "STATUS: BLOCKED needs the API key from the manager" });
    expect(lastEvent(b.key)?.actor).toEqual({ kind: "board", rule: "D2", lane: "reviewer" });
    expect(shown(c.key)).toMatchObject({ status: "blocked", blockedReason: "needs_decision" });   // no line: the outcome names it
  });

  it("DONE with background work left moves doing to review (D1), though a comment came during the turn", async () => {
    const t = task("Ship it", "builder", T0, "doing");
    await projector.start();
    now = T0 + 30_000;
    source.tell(run("builder", "working", T0 + 20_000, { source: "session" }));
    expect(shown(t.key)?.status).toBe("doing");
    now = T0 + 40_000;                                                // the lane comments during its turn
    expect(board.act(t.key, { action: "comment", text: "pushed, CI is running" }, { ...BUILDER, name: "builder" }).ok).toBe(true);
    now = T0 + 50_000;
    source.tell(run("builder", "waiting", T0 + 45_000, {
      source: "hook", outcome: "done", line: "STATUS: DONE pushed", wait: { on: "background", tasks: [{ type: "shell", label: "gh run watch" }] }, deadline: T0 + 900_000,
    }));
    expect(shown(t.key)?.status).toBe("review");
    expect(lastEvent(t.key)).toMatchObject({ actor: { kind: "board", rule: "D1", lane: "builder" }, change: { kind: "moved", from: "doing", to: "review", reason: "background work still running" } });
    // the same run, told again, moves nothing further (D6 on the move's own change)
    source.tell(run("builder", "waiting", T0 + 45_000, { source: "hook", outcome: "done", wait: { on: "background", tasks: [] } }));
    expect(boardMoves().map(e => e.change)).toEqual(["moved"]);
  });

  it("D3: a lane gone while its task is in progress puts the task back to to do, with GONE_REASON", async () => {
    const t = task("Ship it", "builder", T0, "doing");
    await projector.start();
    now = T0 + 120_000;
    source.tell(run("builder", "gone", T0 + 60_000, { source: "session", line: "half way" }));
    expect(shown(t.key)?.status).toBe("todo");
    expect(lastEvent(t.key)).toMatchObject({ actor: { kind: "board", rule: "D3", lane: "builder" }, change: { kind: "moved", from: "doing", to: "todo", reason: GONE_REASON } });
  });

  it("D6: a move a person made after the run began is not undone, by later events or a fresh list of the same run", async () => {
    const t = task("Fix the build", "builder", T0);
    await projector.start();
    now = T0 + 60_000;
    const working = run("builder", "working", T0 + 30_000, { source: "session" });
    source.tell(working);
    expect(shown(t.key)?.status).toBe("doing");
    now = T0 + 90_000;                                                // the manager puts it back, mid-turn
    expect(board.act(t.key, { action: "move", to: "todo", reason: "wrong lane" }, MANAGER).ok).toBe(true);
    now = T0 + 120_000;
    source.tell({ ...working, overdue: true });                       // the same run, told again
    source.list = [working];
    source.reopen();                                                  // and read whole after a reconnect
    await projector.refresh();
    // negative control: without D6 in derivedMove (packages/domain/src/board.ts), the board takes it up again (b10-d6-projector).
    expect(shown(t.key)?.status).toBe("todo");
    expect(boardMoves().map(e => e.key)).toEqual([t.key]);            // the one D4 move, before the manager's
    // A run that begins after the manager's move may take it up again (D4).
    source.tell(run("builder", "working", T0 + 110_000, { source: "hook" }));
    expect(shown(t.key)?.status).toBe("doing");
  });

  it("D4 with two to do tasks for the lane, or one already in progress, moves nothing", async () => {
    const a = task("A", "builder", T0);
    const b = task("B", "builder", T0);
    const c = task("C", "reviewer", T0, "doing");
    const d = task("D", "reviewer", T0);
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("builder", "working", T0 + 30_000));
    source.tell(run("reviewer", "waiting", T0 + 30_000, { wait: { on: "background", tasks: [{ type: "bash", label: "npm test" }] } }));
    expect([shown(a.key)?.status, shown(b.key)?.status, shown(c.key)?.status, shown(d.key)?.status]).toEqual(["todo", "todo", "doing", "todo"]);
    expect(boardMoves()).toEqual([]);
  });

  it("a run of another lane, or a phase with no edge, moves nothing (B10: only the assignee's run)", async () => {
    const t = task("A", "builder", T0, "doing");
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("reviewer", "gone", T0 + 30_000));
    source.tell(run("builder", "needs_you", T0 + 30_000, { question: "which branch?" }));
    source.tell(run("builder", "unknown", T0 + 40_000));
    expect(shown(t.key)?.status).toBe("doing");
    expect(boardMoves()).toEqual([]);
  });

  it("B12: with no key a DONE moves the lane's task in progress, as before", async () => {
    const t = task("Ship it", "builder", T0, "doing");
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("builder", "ended", T0 + 30_000, { outcome: "done", line: "STATUS: DONE npm test: 14 passed" }));
    expect(shown(t.key)?.status).toBe("review");
    expect(lastEvent(t.key)).toMatchObject({ actor: { kind: "board", rule: "D1", lane: "builder" }, change: { kind: "moved", from: "doing", to: "review" } });
  });

  it("B12: a keyed DONE moves only the named task, and a key naming another lane's task moves nothing and is noted once", async () => {
    const a = task("A", "builder", T0, "doing");
    const b = task("B", "reviewer", T0, "doing");
    await projector.start();
    now = T0 + 60_000;
    const naming = run("builder", "ended", T0 + 30_000, { outcome: "done", line: `STATUS: DONE ${b.key} the review is in` });
    source.tell(naming);
    expect([shown(a.key)?.status, shown(b.key)?.status]).toEqual(["doing", "doing"]);   // nothing moved
    expect(lastEvent(a.key)).toMatchObject({ actor: { kind: "board", rule: "D1", lane: "builder" }, change: { kind: "commented", text: expect.stringContaining(b.key) } });
    source.tell({ ...naming, deadline: T0 + 90_000 });                                  // the same run again: no second comment
    source.list = [naming];
    source.reopen();                                                                    // nor from a list read again
    await projector.refresh();
    const comments = () => board.task(a.key)?.events.filter(e => e.change.kind === "commented") ?? [];
    expect(comments()).toHaveLength(1);
    const src2 = fakeRuns();
    const again = new BoardProjector({ source: src2, board, log: { info: () => {}, warn: () => {}, error: () => {} } });
    await again.start();                                                                // a hub restart: only the history keeps it one
    src2.tell(naming);
    again.stop();
    expect(comments()).toHaveLength(1);
    now = T0 + 120_000;
    source.tell(run("builder", "ended", T0 + 110_000, { outcome: "done", line: `STATUS: DONE ${a.key} all checks pass` }));
    expect(shown(a.key)?.status).toBe("review");
  });

  it("B12: three turn starts after a task is in review leave it in review (D4)", async () => {
    const t = task("Check the build", "builder", T0, "review");
    const b = task("Wait on the API key", "reviewer", T0, "blocked");
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("builder", "working", T0 + 30_000, { source: "session" }));
    now = T0 + 120_000;
    source.tell(run("builder", "working", T0 + 90_000, { source: "session" }));
    now = T0 + 180_000;
    source.tell(run("builder", "working", T0 + 150_000, { source: "session" }));
    expect(shown(t.key)?.status).toBe("review");
    now = T0 + 60_000;
    source.tell(run("reviewer", "working", T0 + 30_000, { source: "session" }));
    expect(shown(b.key)?.status).toBe("blocked");
    expect(boardMoves()).toEqual([]);
  });

  it("B12: a keyed WAITING that names a task in review takes it back into progress (D1)", async () => {
    const t = task("Check the build", "builder", T0, "review");
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("builder", "waiting", T0 + 30_000, { line: `STATUS: WAITING ${t.key} on CI`, wait: { on: "declared", what: "CI" } }));
    expect(shown(t.key)?.status).toBe("doing");
    expect(lastEvent(t.key)).toMatchObject({ actor: { kind: "board", rule: "D1", lane: "builder" }, change: { kind: "moved", from: "review", to: "doing", reason: `STATUS: WAITING ${t.key} on CI` } });
  });
});

describe("safe and idempotent", () => {
  it("at start, the first list applies what is due once; reading it again moves nothing more", async () => {
    const a = task("A", "builder", T0, "doing");
    const b = task("B", "reviewer", T0, "doing");
    source.list = [run("builder", "ended", T0 + 30_000, { outcome: "done", line: "STATUS: DONE" }), run("reviewer", "gone", T0 + 30_000)];
    now = T0 + 60_000;
    await projector.start();
    expect([shown(a.key)?.status, shown(b.key)?.status]).toEqual(["review", "todo"]);
    source.reopen();
    await projector.refresh();
    expect(boardMoves().map(e => e.key)).toEqual([a.key, b.key]);
  });

  it("a refusal is logged once and not tried again for the same task and run", async () => {
    const t = task("A", "builder", T0, "doing");
    await projector.start();
    const follow = vi.spyOn(board, "follow");
    // The board refuses the move once, as it does when the task changed between the read and the write (B6).
    follow.mockImplementationOnce(() => ({ ok: false, problem: "changed" }));
    now = T0 + 60_000;
    const blocked = run("builder", "ended", T0 + 30_000, { outcome: "blocked", line: "STATUS: BLOCKED on the keys" });
    source.tell(blocked);
    source.tell({ ...blocked, deadline: T0 + 90_000 });
    source.tell({ ...blocked, overdue: true });
    source.list = [blocked];
    await projector.refresh();
    expect(shown(t.key)?.status).toBe("doing");
    // negative control: without the remembered refusal, each run told tries again, several times (b10-refusal-once).
    expect(follow).toHaveBeenCalledTimes(1);
    expect(logged.filter(l => l.level === "warn")).toEqual([{ level: "warn", line: `board: D2 would move ${t.key} doing → blocked for builder, refused (changed); it stays where it is` }]);
    // A new run is judged afresh.
    source.tell(run("builder", "ended", T0 + 50_000, { outcome: "done", line: "STATUS: DONE" }));
    expect(shown(t.key)?.status).toBe("review");
  });

  it("never acts while the fleet's runs can't be read; says so once, and follows again once they can", async () => {
    const t = task("A", "builder", T0);
    source.list = new Error("connect ENOENT fleet.sock");
    await projector.start();
    now = T0 + 60_000;
    source.tell(run("builder", "working", T0 + 30_000));             // an event while the last list failed
    await projector.refresh();                                       // and the list failing again
    expect(shown(t.key)?.status).toBe("todo");
    expect(logged.filter(l => l.level === "warn").map(l => l.line)).toEqual(["board: the fleet's runs can't be read (connect ENOENT fleet.sock); the board moves nothing by itself until they can"]);
    source.list = [run("builder", "working", T0 + 30_000)];
    source.reopen();                                                 // the fleet is back: the list is read, and what is due applied
    await projector.refresh();
    expect(shown(t.key)?.status).toBe("doing");
    expect(logged.map(l => l.line)).toContain("board: the fleet's runs are read again; the board follows them");
  });

  it("a list replaces what was held: a lane the fleet no longer lists is dropped from the runs", async () => {
    source.list = [run("builder", "working", T0), run("reviewer", "ended", T0, { outcome: "done" })];
    await projector.start();
    expect(projector.runs().map(r => r.lane)).toEqual(["builder", "reviewer"]);
    source.list = [run("reviewer", "ended", T0, { outcome: "done" })];
    await projector.refresh();
    expect(projector.runs().map(r => r.lane)).toEqual(["reviewer"]);
  });

  it("a store that throws is logged, never thrown into the event loop", async () => {
    task("A", "builder", T0);
    await projector.start();
    vi.spyOn(board, "openTasksOf").mockImplementation(() => { throw new Error("disk I/O error"); });
    expect(() => source.tell(run("builder", "working", T0 + 30_000))).not.toThrow();
    expect(logged.filter(l => l.level === "error").map(l => l.line)).toEqual(["board: following builder's run failed; its next run tries again"]);
  });
});

describe("the store keeps the board's and the console's actors (ADR-0032 §6)", () => {
  it("a task made by the console and an event of the board read back as written", () => {
    const made = { key: "T-7", n: 7, title: "From the console", description: "", status: "todo", assignee: "builder", priority: "normal", blockedReason: null,
      createdAt: T0, updatedAt: T0, stateChangedAt: T0, createdBy: { kind: "console" }, rev: 1, doneAt: null, comments: 0 } as unknown as Task;
    store.saveTask(made);
    const e: TaskEvent = { key: made.key, rev: 2, at: T0 + 1, actor: { kind: "board", rule: "D3", lane: "builder" }, change: { kind: "moved", from: "doing", to: "todo", reason: GONE_REASON } };
    store.saveTaskEvent(e);
    expect(store.task("T-7")?.createdBy).toEqual({ kind: "console" });
    expect(store.taskEvents("T-7")).toEqual([e]);
  });
});
