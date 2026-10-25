// The board's record and frame in the app (ADR-0015, ADR-0032): the record's line for each actor (a lane, you, the
// console, the board itself by D1 to D4), the Runs of a `board` frame, decoded one by one and keyed by lane, and where
// a task's merges stand (B11), decoded the same way.
import { describe, expect, it } from "vitest";
import { GONE_REASON, type TaskActor, type TaskChange, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { acceptLabel, avatarOf, decodeMerged, decodeProof, decodeRuns, eventLine, REFUSALS, whoOf, type MergedView, type ProofView, type Task } from "../src/lib/desktop/board.ts";
import { ProofViewSchema, parseBody } from "@morndo/protocol";

const ev = (actor: TaskActor, change: TaskChange): TaskEvent => ({ key: "T-1" as TaskEvent["key"], rev: 2, at: 1, actor, change });
const moved = (from: TaskStatus, to: TaskStatus, reason: string | null = null): TaskChange => ({ kind: "moved", from, to, reason });
const line = (e: TaskEvent) => { const l = eventLine(e); return `${l.who} ${l.text}`; };
const board = (rule: "D1" | "D2" | "D3" | "D4"): TaskActor => ({ kind: "board", rule, lane: "builder" });

describe("the record's words", () => {
  it("a lane's own move reads as it always did", () => {
    expect(line(ev({ kind: "worker", name: "builder", token: "t" }, moved("todo", "doing")))).toBe("builder moved it from To do to In progress");
    expect(line(ev({ kind: "principal", endpointId: "e" as never, sessionId: "s" as never }, moved("review", "done")))).toBe("You moved it from In review to Done");
  });
  it("the console is \"console\" (lanes start --task)", () => {
    expect(line(ev({ kind: "console" }, { kind: "assigned", from: null, to: "builder" }))).toBe("console assigned it to builder");
    expect(line(ev({ kind: "console" }, moved("backlog", "todo")))).toBe("console moved it from Backlog to To do");
    expect(whoOf({ kind: "console" })).toBe("console");
  });
  it("the board's own moves say what the lane's Run did, by rule, and keep what the lane said", () => {
    expect(line(ev(board("D1"), moved("doing", "review", "STATUS: DONE. Fix pushed, 54 pass")))).toBe("board moved it to In review when builder said DONE: Fix pushed, 54 pass");
    expect(line(ev(board("D1"), moved("doing", "review", null)))).toBe("board moved it to In review when builder said DONE");
    expect(line(ev(board("D2"), moved("doing", "blocked", "STATUS: BLOCKED needs the token")))).toBe("board moved it to Blocked when builder said it is blocked or needs a decision: needs the token");
    // D2 with no status line carries the outcome's name as its reason: not repeated in the words
    expect(line(ev(board("D2"), moved("doing", "blocked", "needs_decision")))).toBe("board moved it to Blocked when builder said it is blocked or needs a decision");
    expect(line(ev(board("D3"), moved("doing", "todo", GONE_REASON)))).toBe("board moved it to To do when builder stopped");
    expect(line(ev(board("D4"), moved("blocked", "doing")))).toBe("board moved it to In progress when builder started on it");
  });
  it("the console and the board get the system's avatar, a lane an agent's, the manager its own, you yours", () => {
    expect([avatarOf({ kind: "console" }), avatarOf(board("D1")), avatarOf({ kind: "worker", name: "b", token: "t" }), avatarOf({ kind: "manager", name: "manager", token: "t" }), avatarOf({ kind: "principal", endpointId: "e" as never, sessionId: "s" as never })])
      .toEqual(["system", "system", "agent", "peer", "principal"]);
  });
  it("a merge recorded and one cleared read in the record's words (B11)", () => {
    expect(line(ev({ kind: "worker", name: "builder", token: "t" }, { kind: "merged", repo: "morndo/morndo", sha: "abc1234deadbeef" }))).toBe("builder recorded its merge in morndo/morndo (abc1234)");
    expect(line(ev({ kind: "manager", name: "manager", token: "t" }, { kind: "unmerged", repo: "morndo/morndo", sha: "abc1234deadbeef" }))).toBe("manager cleared its merge record in morndo/morndo (abc1234)");
  });
});

describe("the Runs of a board frame (BoardFrameSchema.runs)", () => {
  const good = (o: Record<string, unknown> = {}) => ({ lane: "builder", node: "pc", phase: "working", deadline: null, overdue: false, since: 10, source: "session", ...o });
  it("decodes each on its own and drops one it can't read, keyed by lane", () => {
    const { runs, dropped } = decodeRuns([
      good(),
      good({ lane: "reviewer", phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "npm test" }] }, source: "hook" }),
      good({ lane: "broken", phase: "sleeping" }),                     // a phase this build doesn't know
      { lane: "no-node", phase: "working" },                            // fields missing
      "not a run",
    ]);
    expect(dropped).toBe(3);                                            // negative control: decode the list whole and none of it survives
    expect([...(runs?.keys() ?? [])]).toEqual(["builder", "reviewer"]);
    expect(runs?.get("reviewer")?.wait).toEqual({ on: "background", tasks: [{ type: "shell", label: "npm test" }] });
  });
  it("is null from a hub that sends none, so the board shows no run counts; empty is empty", () => {
    expect(decodeRuns(undefined)).toEqual({ runs: null, dropped: 0 });
    expect(decodeRuns([]).runs?.size).toBe(0);
  });
  it("of two Runs of one lane name, keeps the one whose lane is there, else the later", () => {
    const there = decodeRuns([good({ node: "mac", phase: "working", since: 5 }), good({ node: "pc", phase: "gone", since: 50 })]).runs?.get("builder");
    expect(there?.node).toBe("mac");
    const later = decodeRuns([good({ node: "mac", phase: "ended", outcome: "done", since: 5 }), good({ node: "pc", phase: "working", since: 50 })]).runs?.get("builder");
    expect(later?.node).toBe("pc");
  });
});

describe("where a task's merges stand (BoardFrameSchema.merged, B11)", () => {
  const good = (o: Record<string, unknown> = {}) => ({
    key: "T-1", merges: [{ repo: "morndo/morndo", sha: "a".repeat(40), at: 1, by: "builder", override: null }],
    live: false, label: "merged, not live: pc on abc1234", ...o,
  });
  it("decodeMerged keeps the readable views by task key and drops the rest; null when the frame has none", () => {
    const { merged, dropped } = decodeMerged([
      good(),
      good({ key: "T-2", live: true, label: "merged, live" }),
      good({ key: "T-3", live: "yes" }),                        // live is a boolean or null, never a word
      "not a view",
    ]);
    expect(dropped).toBe(2);
    expect([...(merged?.keys() ?? [])]).toEqual(["T-1", "T-2"]);
    expect(merged?.get("T-1")).toMatchObject({ live: false, label: "merged, not live: pc on abc1234" });
    expect(merged?.get("T-2")?.merges[0]?.repo).toBe("morndo/morndo");
    expect(decodeMerged(undefined)).toEqual({ merged: null, dropped: 0 });
  });
  it("the words for the merge gate's refusals (B11)", () => {
    expect(REFUSALS.not_live).toBe("Its merge is not live on every node yet.");
    expect(REFUSALS.bad_sha).toBe("That isn't a commit hash.");
    expect(REFUSALS.bad_repo).toBe("That isn't a repo name (owner/name).");
    expect(REFUSALS.no_merge).toBe("That merge isn't recorded on this task.");
    expect(REFUSALS.too_many).toBe("A task holds at most 5 merge records.");
    expect(REFUSALS.no_commit).toBe("The hub's checkout doesn't have that commit yet.");
  });
});

describe("proof in the board app (ADR-0035 step 5)", () => {
  it("decodeProof reads a view, and null for a missing or malformed one", () => {
    const raw = {
      rev: 4,
      brief: { summary: "Totals row", decisions: "", leftOut: "nothing", limits: "none known", refs: ["acme/shop#42@3e9d1a7"], attested: [], noCode: "" },
      results: [{ ref: "acme/shop#42@3e9d1a7", state: "green", detail: null, checkedAt: 1 }],
      mode: "on",
      standIn: false,
      coverage: [],
      state: { kind: "verified", green: 1, total: 1, accepts: true, line: "proof: 1 of 1 green" },
    };
    const view = parseBody(ProofViewSchema, raw);
    expect(decodeProof(raw)).toEqual(view);
    expect(decodeProof(undefined)).toBeNull();
    expect(decodeProof({ rev: 4, state: { kind: "nope" } })).toBeNull();
  });

  it("a moved event with proofSeen shows it under the record entry", () => {
    const e = ev({ kind: "manager", name: "manager", token: "t" }, { kind: "moved", from: "review", to: "done", reason: "read the diff", proofSeen: "proof: 1 of 2 green · ✗ acme/shop@3e9d1a7:ci,lint \"lint\" failed" });
    expect(eventLine(e).comment).toBe("Proof when accepted: proof: 1 of 2 green · ✗ acme/shop@3e9d1a7:ci,lint \"lint\" failed");
  });

  it("Accept anyway names the proof when it is not green, the merge wins when both hold, and plain Accept as done otherwise", () => {
    const failing: ProofView = {
      rev: 4,
      brief: { summary: "x", decisions: "", leftOut: "nothing", limits: "none known", refs: ["acme/shop@3e9d1a7:ci,lint"], attested: [], noCode: "" },
      results: [{ ref: "acme/shop@3e9d1a7:ci,lint", state: "red", detail: "\"lint\" failed", checkedAt: 1 }],
      mode: "on",
      standIn: false,
      coverage: [],
      state: { kind: "failing", green: 0, total: 1, accepts: false, line: "proof: 0 of 1 green · ✗ acme/shop@3e9d1a7:ci,lint \"lint\" failed" },
    };
    const liveMerge: MergedView = { key: "T-1" as Task["key"], merges: [], live: true, label: "merged, live" };
    const notLiveMerge: MergedView = { key: "T-1" as Task["key"], merges: [], live: false, label: "merged, not live: pc offline" };
    expect(acceptLabel(failing, liveMerge)).toEqual({
      label: "Accept anyway",
      title: "Its proof is not green; this is recorded as accepted by you",
    });
    expect(acceptLabel(failing, notLiveMerge)).toEqual({
      label: "Accept anyway",
      title: "Its merge is not live on every node; this is recorded as accepted by you",
    });
    expect(acceptLabel(failing, null)).toEqual({
      label: "Accept anyway",
      title: "Its proof is not green; this is recorded as accepted by you",
    });
    const verified: ProofView = {
      rev: 4,
      brief: failing.brief,
      results: [{ ref: "acme/shop@3e9d1a7:ci,lint", state: "green", detail: null, checkedAt: 1 }],
      mode: "on",
      standIn: false,
      coverage: [],
      state: { kind: "verified", green: 1, total: 1, accepts: true, line: "proof: 1 of 1 green" },
    };
    expect(acceptLabel(verified, liveMerge)).toEqual({ label: "Accept as done", title: undefined });
    expect(acceptLabel(null, liveMerge)).toEqual({ label: "Accept as done", title: undefined });
    // the gate's mode decides what the label promises: warn records, off says nothing
    expect(acceptLabel({ ...failing, mode: "warn" }, liveMerge)).toEqual({ label: "Accept as done", title: "Its proof is not green; the gate is in warn mode, so this is recorded" });
    expect(acceptLabel({ ...failing, mode: "off" }, liveMerge)).toEqual({ label: "Accept as done", title: undefined });
    expect(acceptLabel({ ...failing, mode: "warn" }, notLiveMerge).label).toBe("Accept anyway");   // the merge still wins
    // negative control: proof must change the label when it does not accept
    expect(acceptLabel(failing, liveMerge).label).not.toBe("Accept as done");
  });
});

describe("a record this build cannot read in full", () => {
  it("an event of a kind this build does not know reads as one plain line, never a throw (a newer hub's record)", () => {
    const future = ev({ kind: "worker", name: "builder", token: "t" }, { kind: "from_the_future", detail: "x" } as unknown as TaskChange);
    expect(() => eventLine(future)).not.toThrow();
    expect(eventLine(future)).toEqual({ who: "builder", text: "made a change this version cannot show", comment: null });
  });
});

