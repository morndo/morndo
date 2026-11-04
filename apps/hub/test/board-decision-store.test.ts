// A decision block survives in the store (T-805, B19): its deadline is read back from the move event, like a block's waits,
// so no migration of the tasks table is needed, a restart keeps it, and leaving blocked clears it. Real store and service.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DECISION_DUE_MS, DEFAULT_POLICY } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";

const T0 = 1_800_000_000_000;
const MANAGER = { kind: "manager", name: "manager", token: "tok-m" } as const;
const BUILDER = { kind: "worker", name: "builder", token: "tok-w" } as const;

let dir: string;
let store: Store;
let board: BoardService;
let now: number;
const open = () => {
  store = new Store(dir);
  board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY });
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-decision-")); now = T0; open(); });
afterEach(() => { board.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });

function blockedAsDecision(): string {
  const made = board.create({ title: "Plan it", assignee: "builder" }, MANAGER);
  if (!made.ok) throw new Error(made.problem);
  const doing = board.act(made.task.key, { action: "move", to: "doing" }, BUILDER);
  if (!doing.ok) throw new Error(doing.problem);
  now = T0 + 1000;
  const blocked = board.act(made.task.key, { action: "move", to: "blocked", reason: "checkpoint: plan", decision: true }, BUILDER);
  if (!blocked.ok) throw new Error(blocked.problem);
  return made.task.key;
}

describe("a decision block in the store", () => {
  it("is read back with its deadline, by the board's own readers", () => {
    const key = blockedAsDecision();
    expect(board.task(key)?.task.decisionDue).toBe(T0 + 1000 + DECISION_DUE_MS);
    expect(board.blockedTasks().map(t => [t.key, t.decisionDue])).toEqual([[key, T0 + 1000 + DECISION_DUE_MS]]);
    expect(board.view().tasks.find(t => t.key === key)?.decisionDue).toBe(T0 + 1000 + DECISION_DUE_MS);
  });
  it("survives a restart", () => {
    const key = blockedAsDecision();
    board.stop(); store.close();
    open();
    expect(board.task(key)?.task.decisionDue).toBe(T0 + 1000 + DECISION_DUE_MS);
  });
  it("is gone once the task leaves blocked, and does not come back from an older event", () => {
    const key = blockedAsDecision();
    now = T0 + 2000;
    const moved = board.act(key, { action: "move", to: "doing" }, BUILDER);
    expect(moved.ok).toBe(true);
    expect(board.task(key)?.task.decisionDue).toBeUndefined();
    board.stop(); store.close();
    open();
    expect(board.task(key)?.task.decisionDue).toBeUndefined();
    now = T0 + 3000;
    const plain = board.act(key, { action: "move", to: "blocked", reason: "waits on the API" }, BUILDER);
    expect(plain.ok).toBe(true);
    expect(board.task(key)?.task.decisionDue).toBeUndefined();         // a plain block after a decision is no decision
  });
  it("a review task is listed for the sweep, as a blocked one is", () => {
    const made = board.create({ title: "Ship it", assignee: "builder" }, MANAGER);
    if (!made.ok) throw new Error(made.problem);
    board.act(made.task.key, { action: "move", to: "doing" }, BUILDER);
    board.act(made.task.key, { action: "move", to: "review" }, BUILDER);
    expect(board.tasksIn("review").map(t => t.key)).toEqual([made.task.key]);
  });
});
