// The board on the wire, B11: a merged action's body (and an unmerged one's), the notLive a move to done may carry, a
// merged change in the events, and the MergedView the board frame carries (decoded one by one by whoever reads it).
// B13 to B16: the brief action's body, and the briefed change and the proofSeen a move to done may carry.
import { describe, expect, it } from "vitest";
import { BoardActionBody, BoardFrameSchema, MergedViewSchema, ProofViewSchema, TaskChangeSchema, TaskEventSchema, parseBody } from "../src/index.ts";

describe("the board wire (B11)", () => {
  it("a merged action's body: a sha, a repo optionally; a move to done may carry notLive", () => {
    expect(parseBody(BoardActionBody, { action: "merged", sha: "abc1234" })).toEqual({ action: "merged", sha: "abc1234" });
    expect(parseBody(BoardActionBody, { action: "merged", sha: "abc1234", repo: "acme/other" })).toEqual({ action: "merged", sha: "abc1234", repo: "acme/other" });
    expect(parseBody(BoardActionBody, { action: "unmerged", sha: "abc1234" })).toEqual({ action: "unmerged", sha: "abc1234" });
    expect(parseBody(BoardActionBody, { action: "unmerged", sha: "abc1234", repo: "acme/other" })).toEqual({ action: "unmerged", sha: "abc1234", repo: "acme/other" });
    expect(parseBody(BoardActionBody, { action: "move", to: "done", reason: "x", notLive: "y" })).toEqual({ action: "move", to: "done", reason: "x", notLive: "y" });
    expect(parseBody(BoardActionBody, { action: "merged" })).toBeNull();                        // no sha
    expect(parseBody(BoardActionBody, { action: "unmerged" })).toBeNull();                      // no sha either
    expect(parseBody(BoardActionBody, { action: "move", to: "done", reason: "x", notLive: 7 })).toBeNull();
  });
  it("a merged change and a moved one with notLive parse; the frame accepts merged", () => {
    expect(parseBody(TaskChangeSchema, { kind: "merged", repo: "morndo/morndo", sha: "abc1234" })).toEqual({ kind: "merged", repo: "morndo/morndo", sha: "abc1234" });
    expect(parseBody(TaskChangeSchema, { kind: "unmerged", repo: "morndo/morndo", sha: "abc1234" })).toEqual({ kind: "unmerged", repo: "morndo/morndo", sha: "abc1234" });
    expect(parseBody(TaskChangeSchema, { kind: "moved", from: "review", to: "done", reason: "r", notLive: "pc offline" }))
      .toEqual({ kind: "moved", from: "review", to: "done", reason: "r", notLive: "pc offline" });
    const frame = parseBody(BoardFrameSchema, { t: "board", tasks: [], lanes: [], at: 1, merged: [{ key: "T-1", merges: [], live: false, label: "merged, not live: no node reports a build" }] });
    expect(frame).toMatchObject({ t: "board", merged: [{ key: "T-1", live: false }] });
    expect(parseBody(BoardFrameSchema, { t: "board", tasks: [], lanes: [], at: 1 })).toMatchObject({ t: "board" });   // still fine without it
  });
  it("MergedView parses a merge record whole, override null or a string", () => {
    const record = { repo: "morndo/morndo", sha: "abc1234", at: 5, by: "manager", override: null };
    expect(parseBody(MergedViewSchema, { key: "T-1", merges: [record], live: false, label: "merged, not live: pc unknown" }))
      .toEqual({ key: "T-1", merges: [record], live: false, label: "merged, not live: pc unknown" });
    expect(parseBody(MergedViewSchema, { key: "T-2", merges: [{ ...record, override: "pc rebuilds overnight" }], live: null, label: "merged in acme/other" })?.merges[0]).toMatchObject({ override: "pc rebuilds overnight" });
    expect(parseBody(MergedViewSchema, { key: "T-3", merges: [record], label: "x" })).toBeNull();          // live missing
  });
});

describe("the board wire (B13 to B16)", () => {
  it("a brief action's body: summary, leftOut and limits, the rest optional; a move to done may carry proofOverride", () => {
    expect(parseBody(BoardActionBody, { action: "brief", brief: { summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known" } }))
      .toEqual({ action: "brief", brief: { summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known" } });
    const full = {
      summary: "Totals row rounds to cents", decisions: "round at display, not at sum", leftOut: "nothing", limits: "none known",
      refs: ["acme/shop#42@3e9d1a7", "acme/shop@3e9d1a7:ci,lint"], attested: [{ kind: "tests", how: "npm test: 14 passed" }], noCode: "",
    };
    expect(parseBody(BoardActionBody, { action: "brief", brief: full })).toEqual({ action: "brief", brief: full });
    expect(parseBody(BoardActionBody, { action: "move", to: "done", reason: "x", proofOverride: "flaky lint, rerun queued" }))
      .toEqual({ action: "move", to: "done", reason: "x", proofOverride: "flaky lint, rerun queued" });
    // no leftOut, or past the wire's loose caps on the lists (the domain judges the real ones)
    expect(parseBody(BoardActionBody, { action: "brief", brief: { summary: "x", limits: "none known" } })).toBeNull();
    expect(parseBody(BoardActionBody, { action: "brief", brief: { summary: "x", leftOut: "nothing", limits: "none known", refs: Array.from({ length: 51 }, (_, i) => `acme/shop#4${i}@3e9d1a7`) } })).toBeNull();
  });

  it("a briefed event and a moved one with proofSeen round-trip", () => {
    const brief = {
      summary: "Totals row rounds to cents", decisions: "round at display, not at sum", leftOut: "nothing", limits: "none known",
      refs: ["acme/shop#42@3e9d1a7"], attested: [{ kind: "tests", how: "npm test: 14 passed" }], noCode: "",
    };
    const worker = { kind: "worker", name: "builder", token: "tok-w" };
    expect(parseBody(TaskEventSchema, { key: "T-1", rev: 2, at: 5, actor: worker, change: { kind: "briefed", brief } }))
      .toEqual({ key: "T-1", rev: 2, at: 5, actor: worker, change: { kind: "briefed", brief } });
    expect(parseBody(TaskEventSchema, { key: "T-1", rev: 3, at: 6, actor: { kind: "manager", name: "manager", token: "tok-m" }, change: { kind: "moved", from: "review", to: "done", reason: "npm test: 14 passed", proofSeen: "proof: 1 of 1 green" } }))
      .toEqual({ key: "T-1", rev: 3, at: 6, actor: { kind: "manager", name: "manager", token: "tok-m" }, change: { kind: "moved", from: "review", to: "done", reason: "npm test: 14 passed", proofSeen: "proof: 1 of 1 green" } });
    expect(parseBody(TaskEventSchema, { key: "T-1", rev: 2, at: 5, actor: worker, change: { kind: "briefed", brief: { ...brief, attested: [{ kind: "quick", how: "had a look" }] } } })).toBeNull();   // the kinds are fixed
  });
});

describe("the proof view on the wire (ADR-0035 step 5)", () => {
  const PR = "acme/shop#42@3e9d1a7";
  const CI = "acme/shop@3e9d1a7:ci,lint";
  const full = {
    rev: 4,
    brief: {
      summary: "Totals row rounds to cents", decisions: "round at display", leftOut: "nothing", limits: "none known",
      refs: [PR, CI], attested: [{ kind: "tests", how: "npm test: 14 passed" }], noCode: "",
    },
    results: [
      { ref: PR, state: "green", detail: null, checkedAt: 1 },
      { ref: CI, state: "green", detail: null, checkedAt: 2 },
    ],
    state: { kind: "verified", green: 2, total: 2, accepts: true, line: "proof: 2 of 2 green" },
  };

  it("a full proof view parses", () => {
    expect(parseBody(ProofViewSchema, full)).toEqual(full);
  });

  it("a view with an unknown ref state or proof kind does not parse", () => {
    expect(parseBody(ProofViewSchema, { ...full, results: [{ ref: PR, state: "purple", detail: null, checkedAt: 1 }] })).toBeNull();
    expect(parseBody(ProofViewSchema, { ...full, state: { ...full.state, kind: "maybe" } })).toBeNull();
  });

  it("rev null and brief null parse (a task with no brief yet)", () => {
    expect(parseBody(ProofViewSchema, {
      rev: null, brief: null, results: [],
      state: { kind: "no_brief", green: 0, total: 0, accepts: false, line: "proof: no brief" },
    })).toEqual({
      rev: null, brief: null, results: [],
      state: { kind: "no_brief", green: 0, total: 0, accepts: false, line: "proof: no brief" },
    });
  });
});
