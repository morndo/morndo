// Filing a brief and reading its proof back (B13, ADR-0035): the brief is a board event like a comment, its references
// are seeded as pending rows for the hub to check, and a check is a row of its own, never a change of the task. Real
// Store in a temp dir, a BoardService with a fixed clock, synthetic repos, shas and lanes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BriefInput, type ProofMode, type TaskActor } from "@morndo/domain";
import type { RunView } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { GithubChecks } from "../src/adapters/github-checks.ts";
import { BoardService } from "../src/application/board-service.ts";
import { ProofService } from "../src/application/proof-service.ts";
import type { ForgeChecks } from "../src/application/ports.ts";
import { startFakeForge, type FakeForge } from "./fake-forge.ts";

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
    board.act("T-1", { action: "move", to: "blocked", reason: "waiting on design" }, manager);   // rev 5: left review (the manager may; a lane may not)
    expect(proof.view("T-1")?.brief).toBeNull();
    board.act("T-1", { action: "move", to: "doing" }, lane);   // rev 6: back in progress
    const stale = proof.view("T-1");
    expect(stale?.rev).toBeNull();
    expect(stale?.brief).toBeNull();
    expect(stale?.state.kind).toBe("no_brief");
    expect(store.proofResultsOf("T-1", 4)).toEqual([           // the rows stay, kept for the round they belong to
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW },
    ]);
    board.act("T-1", { action: "move", to: "review" }, lane);  // rev 7
    const again = await proof.file("T-1", brief, lane);        // rev 8: a new round files a new brief
    expect(again).toMatchObject({ ok: true, event: { rev: 8 } });
    const view = proof.view("T-1");
    expect(view?.rev).toBe(8);
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

  it("a merge record's repository does not join the allowlist", async () => {
    const { store, board, proof } = made();
    atReview(board);
    expect(await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane)).toEqual({ ok: false, problem: "ref_repo", detail: "acme/shop" });
    expect(board.act("T-1", { action: "merged", sha: "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01", repo: "acme/shop" }, lane).ok).toBe(true);
    expect(await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane)).toEqual({ ok: false, problem: "ref_repo", detail: "acme/shop" });
    store.close();
  });
});

describe("verifying (B14, B15)", () => {
  // The hub's own checking of a brief's refs, against the local fake forge and a clock a test moves (plan 3.5: the
  // adapter over the fake's base, the service driving it, rows written through `record` alone).
  const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
  const MOVED = "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
  const RUN_URL = "https://github.com/morndo/morndo/actions/runs/9";
  const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const greenRuns = () => [
    { id: 1, name: "ci", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "success" },
  ];
  const redRuns = () => [
    { id: 1, name: "ci", status: "completed", conclusion: "success" },
    { id: 2, name: "lint", status: "completed", conclusion: "failure", url: RUN_URL },
  ];
  const RED_LINE = `proof: 1 of 2 green · ✗ morndo/morndo@3e9d1a7:ci,lint "lint" failed ${RUN_URL}`;
  const asked = (f: FakeForge) => f.requests.map(r => r.path).sort();
  const proofSeen = (line: string, mode: ProofMode, kind: "accepted" | "warn-pass" | "override", overrideReason?: string): string => {
    if (kind === "accepted") return `${line} [mode ${mode}]`;
    if (kind === "warn-pass") return `${line} [mode warn: would have been refused]`;
    return `${line}; override: ${overrideReason} [mode ${mode === "on" ? "on" : "warn: would have been refused"}]`;
  };

  let fake: FakeForge;
  let clock = NOW;
  const now = () => clock;
  const withForge = (o: { mode?: ProofMode; allowedRepos?: readonly string[]; authenticated?: boolean; token?: string; runs?: () => RunView[]; auto?: { perTask?: number; hub?: number } } = {}) => {
    const store = new Store(tempDir());
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now, ...(o.runs ? { runs: o.runs } : {}) });
    const proof = new ProofService({
      store, board, now,
      forge: new GithubChecks({ baseUrl: fake.base, now, ...(o.token !== undefined ? { token: o.token } : {}) }),
      mode: o.mode ?? "off",
      ...(o.allowedRepos !== undefined ? { allowedRepos: o.allowedRepos } : {}),
      ...(o.authenticated !== undefined || o.token !== undefined ? { authenticated: o.authenticated ?? true } : {}),
      ...(o.auto ? { autoBudget: o.auto } : {}),
    });
    return { store, board, proof };
  };

  beforeEach(async () => { fake = await startFakeForge(); clock = NOW; });
  afterEach(async () => { await fake.close(); });

  it("a brief filed in review is verified at once", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, greenRuns());
    const { store, board, proof } = withForge();
    atReview(board);
    expect((await proof.file("T-1", brief, lane)).ok).toBe(true);            // rev 4
    await proof.idle();                                                       // the background verify finishes
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: NOW },
    ]);
    expect(proof.view("T-1")?.state.kind).toBe("verified");
    expect(fake.requests).toHaveLength(2);
    expect(asked(fake)).toEqual(["/repos/morndo/morndo/commits/3e9d1a7/check-runs", "/repos/morndo/morndo/pulls/42"]);
    store.close();
  });

  it("a task moved to review by the board's D1 has its refs verified", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, greenRuns());
    const { store, board, proof } = withForge();
    board.create({ title: "Ship the totals row", assignee: "builder" }, manager);   // T-1, to do
    board.act("T-1", { action: "move", to: "doing" }, lane);                        // rev 2
    await proof.file("T-1", brief, lane);                                           // rev 3, filed while in progress
    await proof.idle();
    clock = NOW + 1_000;                                                            // later, so the rows show which check wrote them
    fake.requests.length = 0;
    const r = board.follow("T-1", { to: "review", reason: "builder ended its round", rule: "D1" }, "builder", 3);
    expect(r.ok).toBe(true);
    await proof.idle();
    expect(asked(fake)).toEqual(["/repos/morndo/morndo/commits/3e9d1a7/check-runs", "/repos/morndo/morndo/pulls/42"]);
    expect(store.proofResultsOf("T-1", 3)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1_000 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: NOW + 1_000 },
    ]);
    expect(store.task("T-1")?.status).toBe("review");
    store.close();
  });

  it("a task moved to review by hand with a wake-up pending has its refs verified", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, greenRuns());
    const waiting: RunView = { lane: "builder", node: "pc", phase: "waiting", wait: { on: "wakeup", next: NOW + 60_000 }, deadline: NOW + 60_000, overdue: false, since: NOW, source: "hook" };
    const { store, board, proof } = withForge({ runs: () => [waiting] });
    board.create({ title: "Ship the totals row", assignee: "builder" }, manager);
    board.act("T-1", { action: "move", to: "doing" }, lane);
    await proof.file("T-1", brief, lane);                                           // rev 3
    await proof.idle();
    clock = NOW + 1_000;
    fake.requests.length = 0;
    expect(board.act("T-1", { action: "move", to: "review", reason: "the wake-up is hours off" }, manager).ok).toBe(true);   // by hand, not by the board
    await proof.idle();
    expect(asked(fake)).toEqual(["/repos/morndo/morndo/commits/3e9d1a7/check-runs", "/repos/morndo/morndo/pulls/42"]);
    expect(store.proofResultsOf("T-1", 3)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 1_000 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: NOW + 1_000 },
    ]);
    store.close();
  });

  it("a pending ref turns green at the next timer pass without any lane action", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "in_progress", conclusion: null },
      { id: 2, name: "lint", status: "completed", conclusion: "success" },
    ]);
    const { store, board, proof } = withForge({ authenticated: true });             // a hub with a credential checks sooner
    atReview(board);
    await proof.file("T-1", brief, lane);                                           // rev 4
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: `"ci" in progress`, checkedAt: NOW },
    ]);
    expect(store.tasksIn("review").map(t => t.key)).toEqual(["T-1"]);
    expect(await proof.tick()).toBe(0);                                             // the interval (2 min) has not passed
    expect(fake.requests).toHaveLength(2);
    clock = NOW + 120_000;
    fake.runs("morndo/morndo", FULL, greenRuns());                                  // the run finished since
    expect(await proof.tick()).toBe(1);                                             // one ref due again: only the pending one
    expect(fake.requests.filter(r => r.path.endsWith("/check-runs"))).toHaveLength(2);
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: NOW + 120_000 },
    ]);
    expect(proof.view("T-1")?.state.kind).toBe("verified");
    store.close();
  });

  it("a ref that stays unfetchable keeps the task in review with the reason on the card", async () => {
    const { store, board, proof } = withForge();
    fake.fail("/repos/morndo/morndo/pulls/42", 500);
    fake.fail("/repos/morndo/morndo/commits/3e9d1a7/check-runs", 500);
    atReview(board);
    await proof.file("T-1", brief, lane);                                           // rev 4
    await proof.idle();
    expect(store.task("T-1")?.status).toBe("review");                               // never a task change for a check
    expect(proof.view("T-1")?.state).toEqual({
      kind: "unfetchable", green: 0, total: 2, accepts: false,
      line: "proof: 0 of 2 green · ! morndo/morndo#42@3e9d1a7 unexpected answer (500) · ! morndo/morndo@3e9d1a7:ci,lint unexpected answer (500)",
    });
    fake.requests.length = 0;
    clock = NOW + 10 * 60_000;                                                      // the pass after the interval (10 min, no credential)
    expect(await proof.tick()).toBe(0);                                             // a 500 is not one the hub retries
    expect(fake.requests).toHaveLength(0);
    board.create({ title: "A second task", assignee: "builder" }, manager);         // T-2
    board.act("T-2", { action: "move", to: "doing" }, lane);
    board.act("T-2", { action: "move", to: "review" }, lane);
    fake.fail("/repos/morndo/morndo/pulls/43", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((NOW + 10 * 60_000 + 60_000) / 1000) });
    await proof.file("T-2", { ...brief, refs: ["morndo/morndo#43@3e9d1a7"] }, lane);
    await proof.idle();
    expect(store.proofResultsOf("T-2", 4)).toEqual([
      { ref: "morndo/morndo#43@3e9d1a7", state: "unfetchable", detail: `rate limit, retry ${hhmm(NOW + 10 * 60_000 + 60_000)} UTC`, checkedAt: NOW + 10 * 60_000 },
    ]);
    fake.requests.length = 0;
    clock = NOW + 20 * 60_000;
    fake.pr("morndo/morndo", 43, { head: FULL });
    expect(await proof.tick()).toBe(1);                                             // the rate limit is retried, T-1's 500 is not
    expect(fake.requests.map(r => r.path)).toEqual(["/repos/morndo/morndo/pulls/43"]);
    expect(store.proofResultsOf("T-2", 4)).toEqual([
      { ref: "morndo/morndo#43@3e9d1a7", state: "green", detail: null, checkedAt: NOW + 20 * 60_000 },
    ]);
    expect(store.task("T-1")?.status).toBe("review");
    store.close();
  });

  it("a rate-limited answer stops calls until the reset time", async () => {
    const { store, board, proof } = withForge();
    const reset = String((NOW + 60_000) / 1000);
    fake.fail("/repos/morndo/morndo/pulls/42", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
    fake.fail("/repos/morndo/morndo/commits/3e9d1a7/check-runs", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();                                                             // both refs asked, both walled off
    expect(fake.requests).toHaveLength(2);
    const wall = `rate limit, retry ${hhmm(NOW + 60_000)} UTC`;
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "unfetchable", detail: wall, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "unfetchable", detail: wall, checkedAt: NOW },
    ]);
    await proof.verify("T-1");                                                      // nothing is asked while the wall stands
    expect(fake.requests).toHaveLength(2);
    clock = NOW + 61_000;
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, greenRuns());
    await proof.verify("T-1");
    expect(fake.requests).toHaveLength(4);
    expect(proof.view("T-1")?.state.kind).toBe("verified");
    store.close();
  });

  it("a repository outside the allowlist is never fetched", async () => {
    const { store, board, proof } = withForge({ allowedRepos: ["acme/shop"] });
    fake.pr("acme/shop", 7, { head: FULL });
    atReview(board);
    await proof.file("T-1", { ...brief, refs: ["acme/shop#7@3e9d1a7"] }, lane);      // the gate's allowlist lets the ref through
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "acme/shop#7@3e9d1a7", state: "green", detail: null, checkedAt: NOW },
    ]);
    fake.requests.length = 0;
    const board2 = new BoardService({ store, policy: () => DEFAULT_POLICY, now });  // a second hub over the same store, its allowlist empty
    const proof2 = new ProofService({ store, board: board2, now, forge: new GithubChecks({ baseUrl: fake.base, now }), mode: "off", allowedRepos: [] });
    await proof2.verify("T-1");
    expect(fake.requests).toHaveLength(0);                                          // judged unread, never fetched
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "acme/shop#7@3e9d1a7", state: "unfetchable", detail: "repository not checked", checkedAt: NOW },
    ]);
    store.close();
  });

  it("the hub fetches nothing for a url in a brief", async () => {
    const { store, board, proof } = withForge();
    atReview(board);
    const url = "https://github.com/morndo/morndo/pull/42";
    expect(await proof.file("T-1", { ...brief, refs: [url] }, lane)).toEqual({ ok: false, problem: "bad_ref", detail: `${url}: a url is not a reference` });
    expect(store.proofResultsOf("T-1", 4)).toEqual([]);                             // nothing seeded, nothing to check
    await proof.verify("T-1");
    expect(fake.requests).toEqual([]);                                              // no address a lane wrote was ever fetched
    store.close();
  });

  it("a pr whose head moved reports mismatch with both shas", async () => {
    fake.pr("morndo/morndo", 42, { state: "open", head: MOVED });
    fake.runs("morndo/morndo", FULL, greenRuns());
    const { store, board, proof } = withForge();
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "mismatch", detail: `head is ${MOVED.slice(0, 7)}, ref says 3e9d1a7`, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: NOW },
    ]);
    expect(proof.view("T-1")?.state.kind).toBe("failing");
    store.close();
  });

  it("a skipped named check is missing, not green", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "skipped" },
    ]);
    const { store, board, proof } = withForge();
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: NOW },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "missing", detail: `"lint" skipped`, checkedAt: NOW },
    ]);
    expect(proof.view("T-1")?.state.kind).toBe("failing");                          // missing is not green
    store.close();
  });

  it("re-checking never changes the task's rev", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "in_progress", conclusion: null },
    ]);
    const { store, board, proof } = withForge();
    atReview(board);
    await proof.file("T-1", brief, lane);                                           // rev 4
    await proof.idle();
    const task = store.task("T-1");
    const events = store.taskEvents("T-1");
    expect(events).toHaveLength(4);
    expect(store.proofResultsOf("T-1", 4)[1]?.state).toBe("pending");
    clock = NOW + 10 * 60_000 + 1;                                                  // unauthenticated: 10 minutes between pending re-reads
    expect(await proof.tick()).toBe(1);
    expect(store.task("T-1")).toEqual(task);
    expect(store.taskEvents("T-1")).toEqual(events);
    store.close();
  });

  it("a done with a red ref is refused as proof_not_green in on mode", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, redRuns());
    const { store, board, proof } = withForge({ mode: "on" });
    atReview(board);
    await proof.file("T-1", brief, lane);                                           // rev 4
    await proof.idle();
    expect(proof.view("T-1")?.state.line).toBe(RED_LINE);
    const r = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships" }, manager);
    expect(r).toEqual({ ok: false, problem: "proof_not_green", detail: RED_LINE });
    expect(fake.requests).toHaveLength(2);                                          // the rows are fresh: nothing was re-checked
    expect(store.task("T-1")?.status).toBe("review");                               // a refused done moves nothing
    expect(store.taskEvents("T-1")).toHaveLength(4);
    store.close();
  });

  it("in warn mode the same done is accepted and the event records what was not green", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, redRuns());
    const { store, board, proof } = withForge({ mode: "warn" });
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    const r = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships" }, manager);
    expect(r).toMatchObject({ ok: true, task: { status: "done", rev: 5 } });
    expect(store.taskEvents("T-1").at(-1)?.change).toEqual({ kind: "moved", from: "review", to: "done", reason: "the row ships", proofSeen: proofSeen(RED_LINE, "warn", "warn-pass") });
    store.close();
  });

  it("a done attempt refreshes results older than 30 seconds first", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, redRuns());
    const { store, board, proof } = withForge({ mode: "on" });
    atReview(board);                                                                // T-1
    board.create({ title: "A second task", assignee: "builder" }, manager);         // T-2
    board.act("T-2", { action: "move", to: "doing" }, lane);
    board.act("T-2", { action: "move", to: "review" }, lane);
    await proof.file("T-1", brief, lane);                                           // both red at NOW
    await proof.file("T-2", brief, lane);
    await proof.idle();
    fake.requests.length = 0;
    clock = NOW + 10_000;
    expect(await board.actChecked("T-2", { action: "move", to: "done", reason: "the row ships" }, manager)).toMatchObject({ ok: false, problem: "proof_not_green" });
    expect(fake.requests).toHaveLength(0);                                          // 10 s old: too fresh to re-check, so still red
    clock = NOW + 31_000;
    fake.runs("morndo/morndo", FULL, greenRuns());                                  // the forge says green since
    const done = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships" }, manager);
    expect(done).toMatchObject({ ok: true, task: { status: "done", rev: 5 } });
    expect(asked(fake)).toEqual(["/repos/morndo/morndo/commits/3e9d1a7/check-runs", "/repos/morndo/morndo/pulls/42"]);   // 31 s old: both refs re-read first
    store.close();
  });

  it("mode off judges nothing and writes no proofSeen", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, redRuns());
    const { store, board, proof } = withForge({ mode: "off" });
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)[1]?.state).toBe("red");                   // the checks ran; the gate just ignores them
    const r = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships" }, manager);
    expect(r).toMatchObject({ ok: true, task: { status: "done", rev: 5 } });
    expect(store.taskEvents("T-1").at(-1)?.change).toEqual({ kind: "moved", from: "review", to: "done", reason: "the row ships" });   // no proofSeen at all
    store.close();
  });

  it("the manager's override reason lets a red done through and is recorded", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, redRuns());
    const { store, board, proof } = withForge({ mode: "on" });
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    const r = await board.actChecked("T-1", { action: "move", to: "done", reason: "the row ships", proofOverride: "the red lint is the old run" }, manager);
    expect(r).toMatchObject({ ok: true, task: { status: "done", rev: 5 } });
    expect(store.taskEvents("T-1").at(-1)?.change).toEqual({ kind: "moved", from: "review", to: "done", reason: "the row ships", proofSeen: proofSeen(RED_LINE, "on", "override", "the red lint is the old run") });
    store.close();
  });

  it("a lane's merge record for another repository never aims the hub at it", async () => {
    const VAULT = "acme/vault";
    const VAULT_REF = `${VAULT}#7@3e9d1a7`;
    const { store, board, proof } = withForge({ allowedRepos: ["morndo/morndo"] });
    fake.pr(VAULT, 7, { head: FULL });
    atReview(board);
    expect(board.act("T-1", { action: "merged", sha: FULL, repo: VAULT }, lane).ok).toBe(true);
    expect(await proof.file("T-1", { ...brief, refs: [VAULT_REF] }, lane)).toEqual({ ok: false, problem: "ref_repo", detail: VAULT });
    await proof.file("T-1", brief, lane);
    await proof.idle();
    store.saveProofResult("T-1", 4, { ref: VAULT_REF, state: "pending", detail: null, checkedAt: NOW });
    fake.requests.length = 0;
    await proof.verify("T-1");
    expect(fake.requests).toHaveLength(0);
    store.close();
  });

  it("a pr merged as another commit than the task's recorded merge reports mismatch", async () => {
    const RECORDED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fake.pr("morndo/morndo", 42, { head: OTHER, merged: true, merge: OTHER });
    const { store, board, proof } = withForge();
    atReview(board);
    await proof.file("T-1", brief, lane);
    board.act("T-1", { action: "merged", sha: RECORDED, repo: "morndo/morndo" }, lane);
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)[0]).toMatchObject({
      state: "mismatch",
      detail: `merged as ${OTHER.slice(0, 7)}, the task records ${RECORDED.slice(0, 7)}`,
    });
    store.close();
  });

  describe("the hub's GitHub budget is not a lane's to spend (B14)", () => {
    const PRREF = "morndo/morndo#42@3e9d1a7";
    const one = { ...brief, refs: [PRREF] };
    const prRequests = () => fake.requests.filter(r => r.path.endsWith("/pulls/42")).length;

    it("a brief filed over and over is verified a few times an hour; the rest wait for the timer", async () => {
      fake.pr("morndo/morndo", 42, { head: FULL });
      const { store, board, proof } = withForge();                   // the default allowance: 6 automatic verifications of a task an hour
      atReview(board);
      for (let i = 0; i < 8; i++) { await proof.file("T-1", one, lane); await proof.idle(); }
      expect(prRequests()).toBe(5);                                   // six in all: the move to review used one, before any brief
      clock = NOW + 61 * 60_000;                                      // the hour has passed: the allowance is back
      await proof.file("T-1", one, lane);
      await proof.idle();
      expect(prRequests()).toBe(6);
      store.close();
    });

    it("the whole hub has an allowance too, so several tasks cannot spend the budget together", async () => {
      fake.pr("morndo/morndo", 42, { head: FULL });
      const { store, board, proof } = withForge({ auto: { perTask: 6, hub: 3 } });
      for (const k of ["T-1", "T-2", "T-3", "T-4"]) {
        board.create({ title: `Task ${k}`, assignee: "builder" }, manager);
        board.act(k, { action: "move", to: "doing" }, lane);
        await proof.file(k, one, lane);
        await proof.idle();
        board.act(k, { action: "move", to: "todo" }, lane);          // frees the lane for the next task
      }
      expect(prRequests()).toBe(3);
      store.close();
    });

    it("a failure to reach the forge keeps a fresh green, and an old green gives way", async () => {
      fake.pr("morndo/morndo", 42, { head: FULL });
      const { store, board, proof } = withForge();
      atReview(board);
      await proof.file("T-1", one, lane);
      await proof.idle();
      expect(store.proofResultsOf("T-1", 4)[0]?.state).toBe("green");
      fake.fail("/repos/morndo/morndo/pulls/42", 500);
      clock = NOW + 10 * 60_000;
      fake.fail("/repos/morndo/morndo/pulls/42", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((clock + 60_000) / 1000) });
      await proof.verify("T-1");
      expect(store.proofResultsOf("T-1", 4)[0]).toMatchObject({ state: "green", checkedAt: NOW });   // not downgraded by a rate limit
      clock = NOW + 2 * 3_600_000;                                    // the green is two hours old now
      fake.fail("/repos/morndo/morndo/pulls/42", 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((clock + 60_000) / 1000) });
      await proof.verify("T-1");
      expect(store.proofResultsOf("T-1", 4)[0]?.state).toBe("unfetchable");
      store.close();
    });

    it("a lane's briefs are bounded per round, and the assigner's are not counted", async () => {
      const { store, board, proof } = withForge();
      atReview(board);
      for (let i = 0; i < 20; i++) expect((await proof.file("T-1", one, lane)).ok, String(i)).toBe(true);
      await proof.idle();
      expect(await proof.file("T-1", one, lane)).toEqual({ ok: false, problem: "too_many", detail: "briefs on this task" });
      expect((await proof.file("T-1", one, manager)).ok).toBe(true);                       // the assigner is never locked out
      board.act("T-1", { action: "move", to: "doing" }, lane);                              // a new round of work
      board.act("T-1", { action: "move", to: "review" }, lane);
      expect((await proof.file("T-1", one, lane)).ok).toBe(true);                           // the lane's count starts again
      store.close();
    });

    it("a lane's proof list changes are bounded, and the assigner is never locked out by them", async () => {
      const { store, board } = withForge();
      atReview(board);
      for (let i = 0; i < 100; i++) expect(board.act("T-1", { action: "proof_list", ...(i % 2 === 0 ? { add: ["data: lane junk"] } : { drop: ["data: lane junk"] }) }, lane).ok, String(i)).toBe(true);
      expect(board.act("T-1", { action: "proof_list", add: ["data: one more"] }, lane)).toMatchObject({ ok: false, problem: "too_many", detail: "proof list changes" });
      // the assigner still lists what it needs, and may drop what the lane left
      expect(board.act("T-1", { action: "proof_list", add: ["data: a sample of 30 rows"] }, manager).ok).toBe(true);
      expect(board.act("T-1", { action: "proof_list", add: ["tests: the suite"], drop: ["data: a sample of 30 rows"] }, manager).ok).toBe(true);
      store.close();
    });
  });

  describe("private repositories", () => {
    // A private repository answers 404 to a caller without the token, as the forge does for what it may not show. The
    // token is built here, never written in the source.
    const TOKEN = ["fake", "forge", "token"].join("-");
    const PRIV = "acme/vault";
    const priv = { refs: [`${PRIV}#7@3e9d1a7`, `${PRIV}@3e9d1a7:ci,lint`] };
    const NOTE = "private repo: not checked (404 without a token)";
    const seed = () => {
      fake.privateRepo(PRIV, TOKEN);
      fake.pr(PRIV, 7, { head: FULL });
      fake.runs(PRIV, FULL, greenRuns());
    };

    it("a ref in a private repository without a token is not checked: not red, not unfetchable, and no retry", async () => {
      seed();
      const { store, board, proof } = withForge({ mode: "on", allowedRepos: [PRIV] });
      atReview(board);
      expect((await proof.file("T-1", { ...brief, ...priv }, lane)).ok).toBe(true);        // rev 4
      await proof.idle();
      expect(store.proofResultsOf("T-1", 4)).toEqual([
        { ref: `${PRIV}#7@3e9d1a7`, state: "not_checked", detail: NOTE, checkedAt: NOW },
        { ref: `${PRIV}@3e9d1a7:ci,lint`, state: "not_checked", detail: NOTE, checkedAt: NOW },
      ]);
      expect(proof.view("T-1")?.state).toEqual({
        kind: "not_checked", green: 0, total: 2, accepts: false,
        line: `proof: 0 of 2 green · ○ ${PRIV}#7@3e9d1a7 ${NOTE} · ○ ${PRIV}@3e9d1a7:ci,lint ${NOTE}`,
      });
      expect(fake.requests.every(r => r.headers["authorization"] === undefined)).toBe(true);   // no credential was sent
      fake.requests.length = 0;
      clock = NOW + 60 * 60_000;
      expect(await proof.tick()).toBe(0);                                                 // asking again would answer the same
      expect(fake.requests).toHaveLength(0);
      expect(store.task("T-1")?.status).toBe("review");
      store.close();
    });

    it("the Done gate treats a ref that was not checked as not verified: held in on mode, overridable, recorded in warn", async () => {
      seed();
      const on = withForge({ mode: "on", allowedRepos: [PRIV] });
      atReview(on.board);
      await on.proof.file("T-1", { ...brief, ...priv }, lane);
      await on.proof.idle();
      const line = on.proof.view("T-1")!.state.line;
      expect(await on.board.actChecked("T-1", { action: "move", to: "done", reason: "shipped" }, manager)).toEqual({ ok: false, problem: "proof_not_green", detail: line });
      const overridden = await on.board.actChecked("T-1", { action: "move", to: "done", reason: "shipped", proofOverride: "private repo, read the CI page by hand" }, manager);
      expect(overridden).toMatchObject({ ok: true, task: { status: "done" } });
      expect(on.store.taskEvents("T-1").at(-1)?.change).toMatchObject({ proofSeen: proofSeen(line, "on", "override", "private repo, read the CI page by hand") });
      on.store.close();
      const warn = withForge({ mode: "warn", allowedRepos: [PRIV] });
      atReview(warn.board);
      await warn.proof.file("T-1", { ...brief, ...priv }, lane);
      await warn.proof.idle();
      expect(await warn.board.actChecked("T-1", { action: "move", to: "done", reason: "shipped" }, manager)).toMatchObject({ ok: true });
      expect(warn.store.taskEvents("T-1").at(-1)?.change).toMatchObject({ proofSeen: proofSeen(line, "warn", "warn-pass") });
      warn.store.close();
    });

    it("with the token the fake forge answers and the refs are green", async () => {
      seed();
      const { store, board, proof } = withForge({ mode: "on", allowedRepos: [PRIV], token: TOKEN });
      atReview(board);
      await proof.file("T-1", { ...brief, ...priv }, lane);
      await proof.idle();
      expect(proof.view("T-1")?.state.kind).toBe("verified");
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests.every(r => r.headers["authorization"] === `Bearer ${TOKEN}`)).toBe(true);
      expect(await board.actChecked("T-1", { action: "move", to: "done", reason: "shipped" }, manager)).toMatchObject({ ok: true, task: { status: "done" } });
      store.close();
    });

    it("with the token, a repository it cannot see is unfetchable, not private", async () => {
      fake.privateRepo(PRIV, "another-token");
      const { store, board, proof } = withForge({ mode: "on", allowedRepos: [PRIV], token: TOKEN });
      atReview(board);
      await proof.file("T-1", { ...brief, refs: [`${PRIV}#7@3e9d1a7`] }, lane);
      await proof.idle();
      expect(store.proofResultsOf("T-1", 4)).toEqual([{ ref: `${PRIV}#7@3e9d1a7`, state: "unfetchable", detail: "not found or not visible", checkedAt: NOW }]);
      store.close();
    });
  });
});

describe("a proof list is redacted like a brief (B17)", () => {
  it("a key pasted into an item is removed before it is stored, and a drop finds the stored form", () => {
    const { store, board } = made();
    atReview(board);
    const key = ["sk", "abcdefgh".repeat(3)].join("-");              // key-shaped, built here so none sits in the source
    expect(board.act("T-1", { action: "proof_list", add: [`data: a sample, token ${key} in the notes`] }, manager).ok).toBe(true);
    const change = JSON.stringify(store.taskEvents("T-1").at(-1)?.change);
    expect(change).not.toContain(key);
    expect(change).toContain("[redacted]");
    // the same words again are the same item (a repeat), and dropping them with the key in them finds the stored item
    expect(board.act("T-1", { action: "proof_list", drop: [`data: a sample, token ${key} in the notes`] }, manager).ok).toBe(true);
    store.close();
  });
});

describe("a stand-in forge is shown, not hidden (B14)", () => {
  it("the proof view says whether its references were read from a stand-in forge", async () => {
    const store = new Store(tempDir());
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    const real = new ProofService({ store, board, now: () => NOW });
    expect(real.view("T-9")).toBeNull();
    atReview(board);
    expect(real.view("T-1")?.standIn).toBe(false);
    const standIn = new ProofService({ store, board: new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW }), now: () => NOW, standIn: true });
    expect(standIn.view("T-1")?.standIn).toBe(true);
    store.close();
  });
});

describe("a stand-in forge is hub-wide, not only per task (B14)", () => {
  it("the board view says so when the hub reads a stand-in forge, and says nothing otherwise", () => {
    const store = new Store(tempDir());
    const plain = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    const standIn = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW, standIn: true });
    expect(plain.view()).not.toHaveProperty("standIn");
    expect(standIn.view().standIn).toBe(true);
    store.close();
  });
});

describe("a Done task is a snapshot (B13, B16)", () => {
  const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
  const greenForge = (): ForgeChecks => ({
    pullRequest: async () => ({ ok: true, value: { state: "open", merged: false, headSha: FULL, mergeSha: null } }),
    checkRuns: async () => ({ ok: true, value: [{ id: 1, name: "ci", status: "completed", conclusion: "success", url: null }, { id: 2, name: "lint", status: "completed", conclusion: "success", url: null }] }),
  });

  it("a merge recorded after the Done changes neither the card's line nor its rows, and asks the forge nothing", async () => {
    const store = new Store(tempDir());
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    const calls: string[] = [];
    const forge: ForgeChecks = { pullRequest: (...a) => { calls.push("pr"); return greenForge().pullRequest(...a); }, checkRuns: (...a) => { calls.push("ci"); return greenForge().checkRuns(...a); } };
    const proof = new ProofService({ store, board, now: () => NOW, forge, mode: "on" });
    atReview(board);
    await proof.file("T-1", brief, lane);
    await proof.idle();
    expect((await board.actChecked("T-1", { action: "move", to: "done", reason: "read the diff" }, manager)).ok).toBe(true);
    const before = { view: proof.view("T-1"), rows: store.proofResultsOf("T-1", 4), calls: calls.length };
    expect(before.view?.state.line).toBe("proof: 2 of 2 green");
    // a merge of the task recorded in another repository afterwards: the live rule would unverify the brief
    expect(board.act("T-1", { action: "merged", sha: "1111111", repo: "acme/vault" }, manager).ok).toBe(true);
    await proof.idle();
    expect(proof.view("T-1")).toEqual(before.view);
    expect(store.proofResultsOf("T-1", 4)).toEqual(before.rows);
    expect(calls.length).toBe(before.calls);
    store.close();
  });

  it("a check in flight when the Done lands writes nothing", async () => {
    const store = new Store(tempDir());
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const slow: ForgeChecks = {
      pullRequest: async (...a) => { await held; return greenForge().pullRequest(...a); },
      checkRuns: async (...a) => { await held; return greenForge().checkRuns(...a); },
    };
    const proof = new ProofService({ store, board, now: () => NOW + 5_000, forge: slow, mode: "off" });
    atReview(board);
    await proof.file("T-1", brief, lane);                 // the checks start and wait on the forge
    expect(board.act("T-1", { action: "move", to: "done", reason: "read the diff" }, manager).ok).toBe(true);   // the Done lands first
    release();
    await proof.idle();
    expect(store.proofResultsOf("T-1", 4)).toEqual([      // the seeds stand: the late answers were dropped
      { ref: "morndo/morndo#42@3e9d1a7", state: "pending", detail: null, checkedAt: NOW + 5_000 },
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "pending", detail: null, checkedAt: NOW + 5_000 },
    ]);
    store.close();
  });
});

describe("the assigner's proof list (B17)", () => {
  const PR = "morndo/morndo#42@3e9d1a7";
  const PR_SPEC = "pr@morndo/morndo: the pull request";
  const DATA_SPEC = "data: a sample of 30 rows";
  const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
  let fake: FakeForge;

  beforeEach(async () => { fake = await startFakeForge(); });
  afterEach(async () => { await fake.close(); });

  const withGate = () => {
    const store = new Store(tempDir());
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => NOW });
    const proof = new ProofService({
      store, board, now: () => NOW,
      forge: new GithubChecks({ baseUrl: fake.base, now: () => NOW }),
      mode: "on",
    });
    return { store, board, proof };
  };

  it("the view carries the coverage and the gate holds the done for an item not covered", async () => {
    fake.pr("morndo/morndo", 42, { head: FULL });
    fake.runs("morndo/morndo", FULL, [
      { id: 1, name: "ci", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "success" },
    ]);
    const { store, board, proof } = withGate();
    atReview(board);
    expect(board.act("T-1", { action: "proof_list", add: [PR_SPEC, DATA_SPEC] }, manager).ok).toBe(true);
    await proof.file("T-1", { summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known", refs: [PR] }, lane);
    await proof.idle();
    const view = proof.view("T-1");
    expect(view?.coverage).toEqual([
      { spec: PR_SPEC, kind: "pr", repo: "morndo/morndo", text: "the pull request", by: "assigner", status: "covered", via: PR },
      { spec: DATA_SPEC, kind: "data", repo: null, text: "a sample of 30 rows", by: "assigner", status: "not_covered" },
    ]);
    expect(await board.actChecked("T-1", { action: "move", to: "done", reason: "read the diff" }, manager)).toEqual({
      ok: false, problem: "proof_not_green", detail: `proof: 1 of 1 green · ◇ not covered: ${DATA_SPEC}`,
    });
    await proof.file("T-1", {
      summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known",
      refs: [PR], attested: [{ kind: "data", how: "30 rows read by hand" }],
    }, lane);
    await proof.idle();
    expect(proof.view("T-1")?.coverage?.find(c => c.spec === DATA_SPEC)?.status).toBe("told");
    expect((await board.actChecked("T-1", { action: "move", to: "done", reason: "read the diff" }, manager)).ok).toBe(true);
    store.close();
  });

  it("a list survives a round of work: the task returns to doing and the list still stands", async () => {
    const { store, board, proof } = withGate();
    atReview(board);
    expect(board.act("T-1", { action: "proof_list", add: [DATA_SPEC] }, manager).ok).toBe(true);
    board.act("T-1", { action: "move", to: "doing" }, lane);
    expect(proof.view("T-1")?.coverage).toEqual([
      { spec: DATA_SPEC, kind: "data", repo: null, text: "a sample of 30 rows", by: "assigner", status: "not_covered" },
    ]);
    store.close();
  });
});

