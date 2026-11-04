// The board's own D2 block reads a status line's next: (T-805, B22): the wait it names becomes the block's until wait,
// resolved against the run the line rode in on; a next that is past or further than 31 days is dropped, never a
// refusal; and D2's own block is never held by the block gate (B21), nor lost to a wait that slipped into the past
// between the reading and the move. Real store, service and projector, the clock the test's own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECISION_DUE_MS, DEFAULT_POLICY } from "@morndo/domain";
import type { RunView } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { BoardProjector } from "../src/application/board-projector.ts";
import type { RunsSource } from "../src/application/ports.ts";

const NOW = Date.parse("2026-11-05T10:00:00Z");
const FROM = Date.parse("2026-11-12T00:00:00Z");
const MANAGER = { kind: "manager", name: "manager", token: "tok-m" } as const;
const BUILDER = { kind: "worker", name: "builder", token: "tok-w" } as const;
const HOUR = 3_600_000;

// The fleet as the projector sees it: a list to read and the events it is told (board-projector.test.ts's, minimal).
type FakeRuns = RunsSource & { list: RunView[]; tell(r: RunView): void };
function fakeRuns(): FakeRuns {
  let on: ((r: RunView) => void) | null = null;
  const s: FakeRuns = {
    list: [],
    async runs() { return s.list; },
    subscribe(o) { on = o; return () => { on = null; }; },
    tell: r => on?.(r),
  };
  return s;
}
const run = (phase: RunView["phase"], since: number, more: Partial<RunView> = {}): RunView =>
  ({ lane: "builder", node: "pc", phase, deadline: null, overdue: false, since, source: "status", ...more });

let dir: string;
let store: Store;
let now: number;
let board: BoardService;
let source: FakeRuns;
let projector: BoardProjector;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-next-d2-"));
  store = new Store(dir);
  now = NOW;
  // The gate is on for every move here: D2's own blocks must pass it whatever they carry (B21).
  board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY, blockGate: () => ({ mode: "on", from: FROM }) });
  source = fakeRuns();
  // The lane is listed with a run that began at the task's last change, so it is registered and D3 moves nothing (D6).
  source.list = [run("working", NOW)];
  projector = new BoardProjector({ source, board, log: { info: () => {}, warn: () => {}, error: () => {} } });
});
afterEach(() => { projector.stop(); board.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// A task of builder's, in progress, filed and taken up at `at`.
function doing(title: string, at: number): string {
  now = at;
  const made = board.create({ title, assignee: "builder" }, MANAGER);
  if (!made.ok) throw new Error(made.problem);
  const started = board.act(made.task.key, { action: "move", to: "doing" }, BUILDER);
  if (!started.ok) throw new Error(started.problem);
  return made.task.key;
}
const task = (key: string) => board.task(key)?.task;

describe("D2 reads the wait a next: names (B22)", () => {
  it("a BLOCKED line with next: blocks with that until wait, the line itself as the reason", async () => {
    const key = doing("Ship it", NOW);
    await projector.start();
    const line = `STATUS: BLOCKED ${key} stuck, next: owner by 2026-11-07`;
    now = NOW + 60_000;
    source.tell(run("ended", NOW + 30_000, { outcome: "blocked", line }));
    expect(task(key)).toMatchObject({ status: "blocked", blockedReason: line, waits: [{ kind: "time", at: Date.parse("2026-11-07T23:59:00Z") }] });
  });

  it("a NEEDS DECISION line with next: by in 3 h keeps its decision deadline and waits until the run began plus 3 h", async () => {
    const key = doing("Plan it", NOW);
    await projector.start();
    now = NOW + 60_000;
    source.tell(run("ended", NOW + 30_000, { outcome: "needs_decision", line: `STATUS: NEEDS DECISION ${key} which db?, next: manager by in 3 h` }));
    expect(task(key)).toMatchObject({
      status: "blocked",
      decisionDue: NOW + 60_000 + DECISION_DUE_MS,
      waits: [{ kind: "time", at: NOW + 30_000 + 3 * HOUR }],
    });
  });

  it("a next in the past is dropped: blocked with no waits, never a refusal", async () => {
    const key = doing("Ship it", NOW);
    await projector.start();
    now = NOW + 60_000;
    source.tell(run("ended", NOW + 30_000, { outcome: "blocked", line: `STATUS: BLOCKED ${key} stuck, next: owner by 2026-11-04` }));
    expect(task(key)?.status).toBe("blocked");
    expect(task(key)?.waits).toBeUndefined();
  });

  it("a next further than 31 days ahead is dropped: blocked with no waits", async () => {
    const key = doing("Ship it", NOW);
    await projector.start();
    now = NOW + 60_000;
    source.tell(run("ended", NOW + 30_000, { outcome: "blocked", line: `STATUS: BLOCKED ${key} stuck, next: owner by 2026-12-15` }));
    expect(task(key)?.status).toBe("blocked");
    expect(task(key)?.waits).toBeUndefined();
  });

  it("a line with no next blocks as before, with no waits", async () => {
    const key = doing("Ship it", NOW);
    await projector.start();
    now = NOW + 60_000;
    source.tell(run("ended", NOW + 30_000, { outcome: "blocked", line: `STATUS: BLOCKED ${key} stuck` }));
    expect(task(key)).toMatchObject({ status: "blocked", blockedReason: `STATUS: BLOCKED ${key} stuck` });
    expect(task(key)?.waits).toBeUndefined();
  });

  it("a D2 move whose until wait has passed blocks anyway: the board's own block is never lost to the clock", async () => {
    const key = doing("Ship it", NOW);
    const rev = task(key)?.rev ?? 0;
    // The lane said next: owner by in 1 h at 10:00:30; the hub applies the move at 12:00, the wait already past.
    now = NOW + 2 * HOUR;
    const r = board.follow(key, { to: "blocked", rule: "D2", reason: `STATUS: BLOCKED ${key} stuck, next: owner by in 1 h`, waits: [`until:${new Date(NOW + 30_000 + HOUR).toISOString()}`] }, "builder", rev);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(task(key)?.status).toBe("blocked");
  });
});
