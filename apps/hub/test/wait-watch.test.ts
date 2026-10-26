// What a blocked task waits on, read by the hub itself (B18), and the board's move once it is over (D7, ADR-0038): a
// real Store in a temp dir, the BoardService over it, and a forge, an owner's list and a clock that the test holds.
// Synthetic tasks, lanes, pull requests and cards only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, STALE_BLOCK_MS, type PrFacts, type TaskActor } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { LedgerItem, LedgerRead } from "../src/adapters/ledger.ts";
import { BoardService } from "../src/application/board-service.ts";
import type { ForgeAnswer, ForgeChecks } from "../src/application/ports.ts";
import { PR_EVERY_MS, WaitWatch } from "../src/application/wait-watch.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-waits-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const manager: TaskActor = { kind: "manager", name: "manager", token: "tok-manager" };
const lane: TaskActor = { kind: "worker", name: "builder", token: "tok-builder" };
const NOW = 1_800_000_000_000;

// A forge that answers what the test set, and counts its asks.
class Forge implements ForgeChecks {
  prs = new Map<string, ForgeAnswer<PrFacts>>();
  asks: string[] = [];
  during: (() => void) | null = null;          // runs inside a read, to change the board while the hub waits on the forge
  set(repo: string, n: number, state: "open" | "merged" | "closed" | "fail") {
    this.prs.set(`${repo}#${n}`, state === "fail" ? { ok: false, failure: { reason: "timeout", detail: "timeout" } }
      : { ok: true, value: { state: state === "open" ? "open" : "closed", merged: state === "merged", headSha: "a".repeat(40), mergeSha: null, baseRef: "main" } });
  }
  async pullRequest(repo: string, n: number): Promise<ForgeAnswer<PrFacts>> {
    this.asks.push(`${repo}#${n}`);
    this.during?.();
    return this.prs.get(`${repo}#${n}`) ?? { ok: false, failure: { reason: "not_found", detail: "not found" } };
  }
  async checkRuns(): Promise<never> { throw new Error("not asked for waits"); }
  async requiredChecks(): Promise<never> { throw new Error("not asked for waits"); }
}
const card = (id: string, open: boolean): LedgerItem => ({
  id, need: "decision", title: id, shortTitle: null, summary: null, minutes: null, options: [], link: null, details: null, ifNoAnswer: null,
  recommendation: null, deadline: null, blocking: false, project: null, addedAt: null, open, resolution: open ? null : "answered", closedAt: open ? null : NOW,
});

const made = (o: { ledger?: () => LedgerRead; prReadsPerHour?: number; repos?: () => readonly string[]; gapMs?: number } = {}) => {
  const clock = { now: NOW };
  const store = new Store(tempDir());
  const repos = o.repos ?? (() => ["morndo/morndo", "acme/widgets"]);
  const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => clock.now, repos, cards: o.ledger !== undefined });
  const forge = new Forge();
  const watch = new WaitWatch({ board, forge, ledger: o.ledger ?? null, now: () => clock.now, repos, ...(o.prReadsPerHour !== undefined ? { prReadsPerHour: o.prReadsPerHour } : {}), ...(o.gapMs !== undefined ? { gapMs: o.gapMs } : {}) });
  board.attachWaits(watch);
  return { clock, store, board, forge, watch };
};
// T-1, assigned to builder and blocked by the manager on `waits`.
const blocked = (board: BoardService, waits: string[], title = "Ship the totals row") => {
  const t = board.create({ title, assignee: "builder" }, manager);
  if (!t.ok) throw new Error(t.problem);
  const r = board.act(t.task.key, { action: "move", to: "blocked", reason: "waits for its dependency", waits }, manager);
  if (!r.ok) throw new Error(`${r.problem} ${r.detail ?? ""}`);
  return r.task;
};

describe("a block's waits, as the store keeps them (B18)", () => {
  it("are read back with the task, in the view, and gone once the task leaves blocked or is blocked on words only", () => {
    const { store, board } = made({ ledger: () => ({ ok: true, items: [], at: NOW }) });
    blocked(board, ["#93", "ny-530"]);
    expect(store.task("T-1")?.waits).toEqual([{ kind: "pr", repo: "morndo/morndo", n: 93 }, { kind: "card", id: "ny-530" }]);
    expect(board.view().tasks.find(t => t.key === "T-1")?.waits).toHaveLength(2);
    board.act("T-1", { action: "move", to: "doing" }, lane);
    expect(store.task("T-1")?.waits).toBeUndefined();
    board.act("T-1", { action: "move", to: "blocked", reason: "needs the owner" }, lane);
    expect(store.task("T-1")?.waits).toBeUndefined();
  });
  it("a pull request in a repository the hub doesn't read is refused at the block, saying which it reads", () => {
    const { board } = made();
    board.create({ title: "x", assignee: "builder" }, manager);
    const r = board.act("T-1", { action: "move", to: "blocked", reason: "x", waits: ["other/repo#4"] }, manager);
    expect(r).toMatchObject({ ok: false, problem: "bad_wait", detail: expect.stringContaining("morndo/morndo, acme/widgets") });
  });
});

describe("the wait watch (D7)", () => {
  it("moves a task to do once the pull request it waits on is merged, as the board's own move, and says why", async () => {
    const { clock, board, forge, watch, store } = made();
    blocked(board, ["#93"]);
    forge.set("morndo/morndo", 93, "open");
    expect((await watch.tick()).moved).toEqual([]);
    expect(store.task("T-1")?.status).toBe("blocked");
    expect(watch.readings("T-1")).toEqual([{ state: "open", label: "#93 open" }]);
    forge.set("morndo/morndo", 93, "merged");
    clock.now += PR_EVERY_MS;                          // a pull request is read again once its last reading is this old
    expect((await watch.tick()).moved).toEqual(["T-1"]);
    const t = store.task("T-1");
    expect(t).toMatchObject({ status: "todo", blockedReason: null });
    const last = store.taskEvents("T-1").at(-1);
    expect(last?.actor).toEqual({ kind: "board", rule: "D7", lane: "builder" });
    expect(last?.change).toMatchObject({ kind: "moved", from: "blocked", to: "todo", reason: "its wait is over: #93 merged" });
  });
  it("leaves it blocked while the forge can't be read: unknown is never over", async () => {
    const { board, forge, watch, store } = made();
    blocked(board, ["acme/widgets#7"]);
    forge.set("acme/widgets", 7, "fail");
    await watch.tick();
    expect(store.task("T-1")?.status).toBe("blocked");
    expect(watch.readings("T-1")).toEqual([{ state: "unknown", label: "acme/widgets#7 can't be read now" }]);
  });
  it("reads a pull request at most once per pass budget, however many tasks wait on it", async () => {
    const { board, forge, watch } = made();
    blocked(board, ["#93"], "one");
    blocked(board, ["#93"], "two");
    forge.set("morndo/morndo", 93, "open");
    await watch.tick();
    await watch.tick();
    expect(forge.asks).toEqual(["morndo/morndo#93"]);
  });
  it("follows another task on the board: done ends the wait, review does not", async () => {
    const { board, watch, store } = made();
    board.create({ title: "the dependency", assignee: "builder" }, manager);           // T-1
    const t2 = board.create({ title: "the dependent", assignee: "builder" }, manager); // T-2
    if (!t2.ok) throw new Error("no T-2");
    board.act("T-2", { action: "move", to: "blocked", reason: "after T-1", waits: ["T-1"] }, manager);
    board.act("T-1", { action: "move", to: "doing" }, lane);
    board.act("T-1", { action: "move", to: "review" }, lane);
    await watch.tick();
    expect(store.task("T-2")?.status).toBe("blocked");
    expect(watch.readings("T-2")).toEqual([{ state: "open", label: "T-1 in review" }]);
    board.act("T-1", { action: "move", to: "done", reason: "checked the tests" }, manager);
    await watch.tick();
    expect(store.task("T-2")?.status).toBe("todo");
  });
  it("follows the owner's list for a card, and an unreadable list is unknown, never closed", async () => {
    let list: LedgerRead = { ok: true, items: [card("ny-530", true)], at: NOW };
    const { board, watch, store } = made({ ledger: () => list });
    blocked(board, ["ny-530"]);
    await watch.tick();
    expect(watch.readings("T-1")).toEqual([{ state: "open", label: "ny-530 still open" }]);
    list = { ok: false, error: "ENOENT", at: NOW };
    await watch.tick();
    expect(watch.readings("T-1")).toEqual([{ state: "unknown", label: "the owner's list can't be read now" }]);
    list = { ok: true, items: [], at: NOW };
    await watch.tick();
    expect(watch.readings("T-1")).toEqual([{ state: "unknown", label: "ny-530 is not on the owner's list" }]);
    expect(store.task("T-1")?.status).toBe("blocked");
    list = { ok: true, items: [card("ny-530", false)], at: NOW };
    await watch.tick();
    expect(store.task("T-1")?.status).toBe("todo");
  });
  it("ends a time wait when the time comes", async () => {
    const { clock, board, watch, store } = made();
    blocked(board, [`until:${new Date(NOW + 3_600_000).toISOString()}`]);
    await watch.tick();
    expect(store.task("T-1")?.status).toBe("blocked");
    clock.now = NOW + 3_600_000;
    await watch.tick();
    expect(store.task("T-1")?.status).toBe("todo");
  });
  it("waits until every wait is over", async () => {
    const { board, forge, watch, store } = made();
    blocked(board, ["#93", "#94"]);
    forge.set("morndo/morndo", 93, "merged");
    forge.set("morndo/morndo", 94, "open");
    await watch.tick();
    expect(store.task("T-1")?.status).toBe("blocked");
  });
  it("moves nothing on a reading made before the task changed (B6): the next pass judges it again", async () => {
    const { board, forge, watch, store } = made();
    blocked(board, ["#93"]);
    forge.set("morndo/morndo", 93, "merged");
    forge.during = () => { board.act("T-1", { action: "move", to: "blocked", reason: "restated while the hub read", waits: ["#93", "#95"] }, manager); forge.during = null; };
    expect((await watch.tick()).moved).toEqual([]);
    expect(store.task("T-1")).toMatchObject({ status: "blocked", blockedReason: "restated while the hub read" });
  });
});

describe("what the wait watch may ask the forge (review of #161)", () => {
  it("asks again for a pull request it could not read only after PR_EVERY_MS, not on every pass", async () => {
    const { clock, board, forge, watch } = made();
    blocked(board, ["acme/widgets#7"], "one");
    blocked(board, ["acme/widgets#7"], "two");
    forge.set("acme/widgets", 7, "fail");
    await watch.tick();
    await watch.tick();
    expect(forge.asks).toEqual(["acme/widgets#7"]);
    clock.now += PR_EVERY_MS;
    await watch.tick();
    expect(forge.asks).toEqual(["acme/widgets#7", "acme/widgets#7"]);
  });
  it("spends at most prReadsPerHour reads; past it a pull request is unknown and not asked", async () => {
    const { clock, board, forge, watch } = made({ prReadsPerHour: 2 });
    for (const n of [1, 2, 3]) { forge.set("morndo/morndo", n, "open"); blocked(board, [`#${n}`], `task ${n}`); }
    await watch.tick();
    expect(forge.asks).toHaveLength(2);
    expect(watch.readings("T-3")).toEqual([{ state: "unknown", label: "#3 can't be read now" }]);
    clock.now += 3_600_000;
    await watch.tick();
    expect(forge.asks).toContain("morndo/morndo#3");
  });
  it("a lane that keeps naming new pull requests does not starve another task's older one", async () => {
    const { clock, board, forge, watch } = made({ prReadsPerHour: 1 });
    board.create({ title: "the busy one", assignee: "builder" }, manager);          // T-1
    blocked(board, ["#500"], "the patient one");                                      // T-2, waits since now
    forge.set("morndo/morndo", 500, "open");
    for (let i = 1; i <= 4; i++) {
      board.act("T-1", { action: "move", to: "blocked", reason: `try ${i}`, waits: [`#${600 + i}`] }, manager);
      clock.now += 3_600_000 / 1 + 1;                                                 // one read's worth of budget per round
      await watch.tick();
    }
    expect(forge.asks.slice(0, 2)).toContain("morndo/morndo#500");
  });
  it("shows no readings of a block's earlier waits once it is restated", async () => {
    const { board, forge, watch } = made();
    blocked(board, ["#93"]);
    forge.set("morndo/morndo", 93, "open");
    await watch.tick();
    expect(board.view().waits).toEqual([{ key: "T-1", readings: [{ state: "open", label: "#93 open" }] }]);
    board.act("T-1", { action: "move", to: "blocked", reason: "now after #94", waits: ["#94"] }, manager);
    expect(board.view().waits ?? []).toEqual([]);
    expect(board.task("T-1")?.waitsRead).toBeUndefined();
  });
  it("reads no repository the hub no longer reads, whatever an older block named (B14)", async () => {
    let repos: readonly string[] = ["morndo/morndo", "acme/widgets"];
    const { board, forge, watch } = made({ repos: () => repos });
    blocked(board, ["acme/widgets#7"]);
    repos = ["morndo/morndo"];
    forge.set("acme/widgets", 7, "merged");
    await watch.tick();
    expect(forge.asks).toEqual([]);
    expect(watch.readings("T-1")).toEqual([{ state: "unknown", label: "acme/widgets#7 is outside the repositories the hub reads" }]);
  });
  it("judges a task it waits on as it is after the forge answered, not before", async () => {
    const { board, forge, watch, store } = made();
    board.create({ title: "the dependency", assignee: "builder" }, manager);           // T-1
    board.act("T-1", { action: "move", to: "done", reason: "checked" }, manager);
    board.create({ title: "the dependent", assignee: "builder" }, manager);            // T-2
    board.act("T-2", { action: "move", to: "blocked", reason: "after T-1 and #93", waits: ["T-1", "#93"] }, manager);
    forge.set("morndo/morndo", 93, "merged");
    forge.during = () => { board.act("T-1", { action: "move", to: "doing", reason: "reopened" }, manager); forge.during = null; };
    await watch.tick();
    expect(store.task("T-2")?.status).toBe("blocked");
    expect(watch.readings("T-2")).toEqual([{ state: "open", label: "T-1 in progress" }, { state: "over", label: "#93 merged" }]);
  });
  it("a hub that reads no owner's list refuses a card wait at the block", () => {
    const { board } = made();
    board.create({ title: "x", assignee: "builder" }, manager);
    expect(board.act("T-1", { action: "move", to: "blocked", reason: "x", waits: ["ny-530"] }, manager)).toMatchObject({ ok: false, problem: "bad_wait" });
  });
});

describe("the pass a block starts (D7)", () => {
  it("runs soon after a block that names waits, and once per gap however many blocks come", async () => {
    const { board, forge, watch, store } = made({ gapMs: 40 });
    watch.follow(board);
    forge.set("morndo/morndo", 93, "merged");
    forge.set("morndo/morndo", 94, "merged");
    blocked(board, ["#93"], "one");
    blocked(board, ["#94"], "two");
    await new Promise(r => setTimeout(r, 15));
    expect(store.task("T-1")?.status).toBe("todo");                 // the first block's pass ran at once
    expect(store.task("T-2")?.status).toBe("blocked");              // the second waits for the gap
    await new Promise(r => setTimeout(r, 80));
    await watch.idle();
    expect(store.task("T-2")?.status).toBe("todo");
    watch.stop();
  });
});

describe("the board's view of blocks (B18)", () => {
  it("carries each block's readings, and flags a block of words only that has sat for STALE_BLOCK_MS", async () => {
    const { clock, board, forge, watch } = made();
    blocked(board, ["#93"], "with a wait");                                                  // T-1
    board.create({ title: "words only", assignee: "builder" }, manager);                     // T-2
    board.act("T-2", { action: "move", to: "blocked", reason: "needs the owner's keys" }, manager);
    forge.set("morndo/morndo", 93, "open");
    await watch.tick();
    let v = board.view();
    expect(v.waits).toEqual([{ key: "T-1", readings: [{ state: "open", label: "#93 open" }] }]);
    expect(v.staleBlocks ?? []).toEqual([]);
    clock.now = NOW + STALE_BLOCK_MS;
    v = board.view();
    expect(v.staleBlocks).toEqual(["T-2"]);
  });
});
