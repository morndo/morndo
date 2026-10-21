// The board on the wire, B11: a merged action's body (and an unmerged one's), the notLive a move to done may carry, a
// merged change in the events, and the MergedView the board frame carries (decoded one by one by whoever reads it).
import { describe, expect, it } from "vitest";
import { BoardActionBody, BoardFrameSchema, MergedViewSchema, TaskChangeSchema, parseBody } from "../src/index.ts";

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
