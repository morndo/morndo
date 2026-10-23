// Filing a brief and reading its proof back (B13, ADR-0035): the brief is a board event like a comment, its references
// are seeded as pending rows for the hub to check, and a check is a row of its own, never a change of the task. Real
// Store in a temp dir, a BoardService with a fixed clock, synthetic repos, shas and lanes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BriefInput, type TaskActor } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { ProofService } from "../src/application/proof-service.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-proof-svc-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const manager: TaskActor = { kind: "manager", name: "manager", token: "tok-manager" };
const lane: TaskActor = { kind: "worker", name: "builder", token: "tok-builder" };
const NOW = 1_700_000_000_000;
const made = () => {
  const store = new Store(tempDir());
  const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
  const proof = new ProofService({ store, board, now: () => NOW });
  return { store, board, proof };
};
// A task T-1 assigned to builder, moved doing -> review by the lane: where a brief is filed from (revs 1, 2, 3).
const atReview = (board: BoardService) => {
  board.create({ title: "Ship the totals row", assignee: "builder" }, manager);
  board.act("T-1", { action: "move", to: "doing" }, lane);
  board.act("T-1", { action: "move", to: "review" }, lane);
};

const brief: BriefInput = {
  summary: "Totals row rounds to cents",
  leftOut: "nothing",
  limits: "locale formats not covered",
  refs: ["morndo/morndo#42@3e9d1a7", "morndo/morndo@3e9d1a7:ci,lint"],
};

describe("the proof service (B13)", () => {
  it("a brief filed in review seeds one pending row per ref and the view says pending", async () => {
    const { store, board, proof } = made();
    atReview(board);
    const r = await proof.file("T-1", brief, lane);
    expect(r).toMatchObject({ ok: true, event: { rev: 4, change: { kind: "briefed" } } });
    const seeded = [
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ];
    expect(store.proofResultsOf("T-1", 4)).toEqual(seeded);
    const view = proof.view("T-1");
    expect(view?.rev).toBe(4);
    expect(view?.brief).toEqual({ summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "locale formats not covered", refs: ["morndo/morndo#42@3e9d1a7", "morndo/morndo@3e9d1a7:ci,lint"], attested: [], noCode: "" });
    expect(view?.results).toEqual(seeded);
    expect(view?.state).toEqual({ kind: "pending", green: 0, total: 2, accepts: false, line: "proof: 0 of 2 green · … morndo/morndo#42@3e9d1a7 pending · … morndo/morndo@3e9d1a7:ci,lint pending" });
    store.close();
  });

  it("a refused brief writes no event and seeds nothing", async () => {
    const { store, board, proof } = made();
    atReview(board);
    const task = store.task("T-1");
    const events = store.taskEvents("T-1");
    expect(await proof.file("T-1", { ...brief, refs: ["morndo/morndo#42"] }, lane)).toEqual({ ok: false, problem: "bad_ref", detail: "morndo/morndo#42: a reference is owner/repo#PR@sha or owner/repo@sha:check,check" });
    expect(await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane)).toEqual({ ok: false, problem: "ref_repo", detail: "acme/shop" });
    board.create({ title: "A second task", assignee: "builder" }, manager);   // T-2, still to do
    expect(await proof.file("T-2", brief, lane)).toEqual({ ok: false, problem: "bad_transition", from: "todo" });
    expect(store.task("T-1")).toEqual(task);                   // the rev and the words are as they were
    expect(store.taskEvents("T-1")).toEqual(events);
    expect(store.proofResultsOf("T-1", 4)).toEqual([]);        // the rev a brief would have taken: nothing seeded
    store.close();
  });

  it("a brief older than the last review to doing move is stale", async () => {
    const { store, board, proof } = made();
    atReview(board);
    await proof.file("T-1", brief, lane);                      // rev 4
    expect(proof.record("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1 })).toBe(true);
    board.act("T-1", { action: "move", to: "doing" }, lane);   // rev 5: the task is back in progress
    const stale = proof.view("T-1");
    expect(stale?.rev).toBeNull();
    expect(stale?.brief).toBeNull();
    expect(stale?.state.kind).toBe("no_brief");
    expect(store.proofResultsOf("T-1", 4)).toEqual([           // the rows stay, kept for the round they belong to
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ]);
    board.act("T-1", { action: "move", to: "review" }, lane);  // rev 6
    const again = await proof.file("T-1", brief, lane);        // rev 7: a new round files a new brief
    expect(again).toMatchObject({ ok: true, event: { rev: 7 } });
    const view = proof.view("T-1");
    expect(view?.rev).toBe(7);
    expect(view?.results).toEqual([                            // the old round's rows are never shown
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ]);
    store.close();
  });

  it("results survive a hub restart", async () => {
    const dir = tempDir();
    const store = new Store(dir);
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    const proof = new ProofService({ store, board, now: () => NOW });
    atReview(board);
    await proof.file("T-1", brief, lane);                      // rev 4
    expect(proof.record("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1_000 })).toBe(true);
    expect(proof.record("T-1", 4, { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "red", detail: "lint: 2 problems", checkedAt: NOW + 1_000 })).toBe(true);
    expect(proof.view("T-1")?.state.kind).toBe("failing");
    store.close();                                             // the hub stops; the rows are in the database
    const reopened = new Store(dir);
    const board2 = new BoardService({ store: reopened, policy: () => DEFAULT_POLICY, now: () => NOW });
    const proof2 = new ProofService({ store: reopened, board: board2, now: () => NOW });
    const view = proof2.view("T-1");
    expect(view?.results).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1_000 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "red", detail: "lint: 2 problems", checkedAt: NOW + 1_000 },
    ]);
    expect(view?.state).toEqual({ kind: "failing", green: 1, total: 2, accepts: false, line: "proof: 1 of 2 green · ✗ morndo/morndo@3e9d1a7:ci,lint lint: 2 problems" });
    reopened.close();
  });

  it("re-checking never changes the task's rev", async () => {
    const { store, board, proof } = made();
    atReview(board);
    await proof.file("T-1", brief, lane);                      // rev 4
    const task = store.task("T-1");
    expect(task?.rev).toBe(4);
    for (const r of [
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW + 100 },
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 200 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "red", detail: "lint: 2 problems", checkedAt: NOW + 300 },
    ] as const) expect(proof.record("T-1", 4, r)).toBe(true);
    expect(store.task("T-1")).toEqual(task);                   // rev, updatedAt and events as they were
    expect(store.taskEvents("T-1")).toHaveLength(4);
    const moved = board.act("T-1", { action: "move", to: "doing", ifRev: 4 }, lane);   // the rev it saw still works
    expect(moved).toMatchObject({ ok: true, task: { status: "doing", rev: 5 } });
    store.close();
  });

  it("a result for a stale brief or for a ref the brief does not hold is ignored", async () => {
    const { store, board, proof } = made();
    atReview(board);
    await proof.file("T-1", brief, lane);                      // rev 4
    board.act("T-1", { action: "move", to: "doing" }, lane);   // rev 5: the brief went stale
    expect(proof.record("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 100 })).toBe(false);
    expect(store.proofResultsOf("T-1", 4)).toEqual([           // the answer wrote nothing: the seeds are as filing left them
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ]);
    board.act("T-1", { action: "move", to: "review" }, lane);  // rev 6
    await proof.file("T-1", brief, lane);                      // rev 7
    expect(proof.record("T-1", 7, { ref: "morndo/morndo#99@abcdef1", state: "green", detail: null, checkedAt: NOW + 200 })).toBe(false);   // not one of its refs
    expect(store.proofResultsOf("T-1", 7)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ]);
    store.close();
  });

  it("the brief's words lose key material before they are judged and stored", async () => {
    const madeUpKey = ["sk", "abcdefgh".repeat(3)].join("-");     // key-shaped, built here so no such string sits in the source
    const { store, board, proof } = made();
    atReview(board);
    const r = await proof.file("T-1", { ...brief, summary: `uploaded with token ${madeUpKey} and kept going` }, lane);
    expect(r.ok).toBe(true);
    const stored = store.taskEvents("T-1").at(-1);
    expect(stored?.change).toEqual({ kind: "briefed", brief: { summary: "uploaded with token [redacted] and kept going", decisions: "", leftOut: "nothing", limits: "locale formats not covered", refs: ["morndo/morndo#42@3e9d1a7", "morndo/morndo@3e9d1a7:ci,lint"], attested: [], noCode: "" } });
    expect(proof.view("T-1")?.brief?.summary).toBe("uploaded with token [redacted] and kept going");
    store.close();
  });

  it("a merge record's repository is allowed in a ref", async () => {
    const { store, board, proof } = made();
    atReview(board);
    expect(await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane)).toEqual({ ok: false, problem: "ref_repo", detail: "acme/shop" });
    expect(board.act("T-1", { action: "merged", sha: "3e9d1a7", repo: "acme/shop" }, manager).ok).toBe(true);
    const r = await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane);
    expect(r).toMatchObject({ ok: true, event: { change: { kind: "briefed", brief: { refs: ["acme/shop#7@3e9d1a7"] } } } });
    store.close();
  });
});
