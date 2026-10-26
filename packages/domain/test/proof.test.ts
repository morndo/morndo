// Proof of work (ADR-0035; B13 to B16 in docs/domain.md): a reference the board can fetch itself (a pull request, one
// commit's checks), the brief that carries it and the lane's attested checks, the one-line state the card shows, and
// the brief that still counts once the task has been back in progress. Pure: results are the caller's, never fetched.
import { describe, expect, it } from "vitest";
import {
  ATTESTED_KINDS, BRIEF_LIMITS, checkBrief, coverageOf, currentBrief, currentList, ITEM_TEXT_MAX, judgeCi, judgePr, NO_BRIEF_LINE, parseItemSpec, parseProofRef, proofOf, refString, taskKey, YOUNG_MS,
  type BriefInput, type PrFacts, type ProofBrief, type RefResult, type RefState, type CheckRunFacts, type TaskActor, type TaskChange, type TaskEvent,
} from "../src/index.ts";

const ITEM_GRAMMAR = "an item is <kind>[@owner/repo]: <text>, kind one of pr, ci, tests, manual, ui, data, infra";

const NOW = 1_700_000_000_000;
const SHA = "3e9d1a7";
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const PR = `acme/shop#42@${SHA}`;
const CI = `acme/shop@${SHA}:ci,lint`;

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
const refusal = (r: { ok: boolean; error?: unknown }) => (r.ok ? null : (r.error as { problem: string; detail?: string }));

// The shapes around one brief that breaks no rule: what a lane sends, what is stored, one fetched result.
const input = (o: Partial<BriefInput> = {}): BriefInput => ({ summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known", ...o });
const ctx = (o: Partial<Parameters<typeof checkBrief>[1]> = {}) => ({ allowedRepos: ["acme/shop"], merges: [] as { repo: string; sha: string }[], ...o });
const brief = (o: Partial<ProofBrief> = {}): ProofBrief => ({ summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "none known", refs: [PR], attested: [], noCode: "", ...o });
const seen = (ref: string, state: RefState, detail: string | null = null, checkedAt = NOW + 5): RefResult => ({ ref, state, detail, checkedAt });

describe("a proof reference (B14)", () => {
  it("parseProofRef and refString round-trip pr and ci refs, ids and the star", () => {
    const cases: [string, string][] = [
      ["acme/shop#42@3e9d1a7", "acme/shop#42@3e9d1a7"],
      ["Acme/Shop#42@3E9D1A7", "Acme/Shop#42@3e9d1a7"],                       // the repo keeps its case, the sha is stored lower case
      [`acme/shop#42@${FULL}`, `acme/shop#42@${FULL}`],
      ["acme/shop@3e9d1a7:ci,lint", "acme/shop@3e9d1a7:ci,lint"],
      ["acme/shop@3e9d1a7:ci,id=123", "acme/shop@3e9d1a7:ci,id=123"],
      ["acme/shop@3e9d1a7:*", "acme/shop@3e9d1a7:*"],
      ["acme/shop@3e9d1a7:lint,ci,lint", "acme/shop@3e9d1a7:lint,ci"],        // duplicates dropped, order kept
      ["  acme/shop@3e9d1a7:ci, lint  ", "acme/shop@3e9d1a7:ci,lint"],        // the whole ref and each check name are trimmed
    ];
    for (const [given, canonical] of cases) {
      const r = value(parseProofRef(given));
      expect(refString(r), given).toBe(canonical);
      expect(parseProofRef(refString(r)), given).toEqual({ ok: true, value: r });   // the canonical form parses back to the same ref
    }
    expect(value(parseProofRef("acme/shop@3e9d1a7:ci,id=123"))).toEqual({ kind: "ci", repo: "acme/shop", sha: "3e9d1a7", checks: [{ name: "ci" }, { id: 123 }] });
    expect(value(parseProofRef("acme/shop@3e9d1a7:*"))).toEqual({ kind: "ci", repo: "acme/shop", sha: "3e9d1a7", checks: "*" });
    expect(value(parseProofRef(" acme/shop#42@3e9d1a7 "))).toEqual({ kind: "pr", repo: "acme/shop", number: 42, sha: "3e9d1a7" });
    // whitespace or a control character inside the ref itself (outside a check name) is refused
    expect(refusal(parseProofRef("acme/shop #42@3e9d1a7"))?.problem).toBe("bad_ref");
    expect(refusal(parseProofRef("acme/shop#42\t@3e9d1a7"))?.problem).toBe("bad_ref");
  });

  it("a check name with a C1 control character is refused like one with a C0 control", () => {
    for (const c of ["\u0007", "\u007f", "\u0085", "\u009f"])
      expect(refusal(parseProofRef(`acme/shop@3e9d1a7:ci${c}x`))?.problem, JSON.stringify(c)).toBe("bad_ref");
    expect(parseProofRef("acme/shop@3e9d1a7:ci (linux),lint").ok).toBe(true);        // spaces and punctuation in a name are fine
  });

  it("a ref without its repository is refused", () => {
    for (const bad of ["#119", "#119@3e9d1a7", "3e9d1a7:ci,lint"]) {
      expect(refusal(parseProofRef(bad))?.problem, bad).toBe("bad_ref");
      expect(refusal(parseProofRef(bad))?.detail, bad).toContain("owner/repo");   // it says the grammar, not a url complaint
    }
  });

  it("a bare sha and a bare pull request number are refused", () => {
    for (const bad of ["3e9d1a7", "#119"]) {
      expect(refusal(parseProofRef(bad))?.problem, bad).toBe("bad_ref");
      expect(refusal(parseProofRef(bad))?.detail, bad).toContain("owner/repo");
    }
    expect(refusal(parseProofRef("3e9d1a7"))?.detail).not.toContain("url");   // a bare sha is not a url either
  });

  it("a 7-character sha is accepted and a 6-character one is not", () => {
    expect(parseProofRef("acme/shop#42@3e9d1a7")).toEqual({ ok: true, value: { kind: "pr", repo: "acme/shop", number: 42, sha: "3e9d1a7" } });
    expect(parseProofRef("acme/shop#42@3E9D1A7")).toEqual({ ok: true, value: { kind: "pr", repo: "acme/shop", number: 42, sha: "3e9d1a7" } });   // case-insensitive in
    expect(refusal(parseProofRef("acme/shop#42@3e9d1a"))?.problem).toBe("bad_ref");   // 6 hex
    expect(refusal(parseProofRef("acme/shop@3e9d1a:ci"))?.problem).toBe("bad_ref");
  });

  it("a url in a ref field is refused", () => {
    expect(refusal(parseProofRef("https://acme.example/shop/pull/42"))).toEqual({ problem: "bad_ref", detail: "a url is not a reference" });
    const r = checkBrief(input({ refs: ["https://acme.example/shop/pull/42"] }), ctx());
    expect(refusal(r)?.problem).toBe("bad_ref");
    expect(refusal(r)?.detail).toContain("https://acme.example/shop/pull/42");   // the offending input is named
    expect(refusal(r)?.detail).toContain("a url is not a reference");
  });
});

describe("the brief (B13, B14)", () => {
  it("a ci ref whose sha is not its pr ref's sha or a merge record is refused as ref_unrelated", () => {
    expect(refusal(checkBrief(input({ refs: [PR, "acme/shop@9f8e7d6:ci,lint"] }), ctx())))
      .toEqual({ problem: "ref_unrelated", detail: "acme/shop@9f8e7d6:ci,lint" });
    // related: the pr ref's own sha, the 7-character form of its full one, the same repo whatever its case, a merge record of the task
    expect(checkBrief(input({ refs: [PR, CI] }), ctx()).ok).toBe(true);
    expect(checkBrief(input({ refs: [PR, `acme/shop@${FULL}:ci`] }), ctx()).ok).toBe(true);
    expect(checkBrief(input({ refs: ["Acme/Shop#42@3e9d1a7", "acme/shop@3e9d1a7:ci"] }), ctx()).ok).toBe(true);
    expect(checkBrief(input({ refs: ["acme/shop@9f8e7d6:ci"] }), ctx({ merges: [{ repo: "acme/shop", sha: "9f8e7d6" }] })).ok).toBe(true);
  });

  it("checkBrief: a repository outside the allowed list is refused as ref_repo, and a merge record does not add one", () => {
    expect(refusal(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: ["other/repo"] })))).toEqual({ problem: "ref_repo", detail: "acme/shop" });
    // the list matches without regard to case, and the stored ref is the canonical form
    expect(value(checkBrief(input({ refs: ["ACME/SHOP#42@3E9D1A7"] }), ctx())).refs).toEqual(["ACME/SHOP#42@3e9d1a7"]);
    expect(refusal(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: [], merges: [{ repo: "Acme/Shop", sha: "9999999" }] }))))
      .toEqual({ problem: "ref_repo", detail: "acme/shop" });
    // a ref written twice is kept once
    expect(value(checkBrief(input({ refs: [PR, PR, CI] }), ctx())).refs).toEqual([PR, CI]);
  });

  it("checkBrief: a brief with no code change is refused when the task has a merge record", () => {
    expect(refusal(checkBrief(input({ noCode: "an analysis, no code changed" }), ctx({ merges: [{ repo: "acme/shop", sha: SHA }] }))))
      .toEqual({ problem: "bad_ref", detail: "this task has a merge record; a brief with no code change cannot stand for it" });
  });

  it("checkBrief: a task with a merge record needs a reference in that repository", () => {
    expect(refusal(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: ["acme/shop", "acme/vault"], merges: [{ repo: "acme/vault", sha: "1111111" }] }))))
      .toEqual({ problem: "ref_unrelated", detail: "the task records a merge in acme/vault; a reference to that repository is needed" });
    expect(checkBrief(input({ refs: [`acme/vault#9@${SHA}`, PR] }), ctx({ allowedRepos: ["acme/vault", "acme/shop"], merges: [{ repo: "acme/vault", sha: "1111111" }] })).ok).toBe(true);
    // a repository outside the list is refused as such first, whatever the merge records say
    expect(refusal(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: ["other/repo"], merges: [{ repo: "acme/vault", sha: "1111111" }] })))).toEqual({ problem: "ref_repo", detail: "acme/shop" });
  });

  it("checkBrief: C1 control characters are refused", () => {
    expect(refusal(checkBrief(input({ summary: "a\u0080b" }), ctx()))).toEqual({ problem: "bad_text", detail: "summary" });
    expect(refusal(checkBrief(input({ summary: "a\u009fb" }), ctx()))).toEqual({ problem: "bad_text", detail: "summary" });
  });

  it("checkBrief: limits (empty leftOut, 9 refs, 7 attested items, a control character, the 8 KiB bound)", () => {
    expect(refusal(checkBrief(input({ leftOut: " " }), ctx()))?.problem).toBe("empty");
    expect(refusal(checkBrief(input({ leftOut: "x".repeat(BRIEF_LIMITS.leftOut + 1) }), ctx()))?.problem).toBe("too_long");
    expect(refusal(checkBrief(input({ refs: Array.from({ length: BRIEF_LIMITS.refs + 1 }, (_, i) => `acme/shop#4${i + 1}@${SHA}`) }), ctx()))?.problem).toBe("too_many");
    expect(refusal(checkBrief(input({ attested: Array.from({ length: BRIEF_LIMITS.attested + 1 }, () => ({ kind: "tests", how: "npm test: 14 passed" })) }), ctx()))?.problem).toBe("too_many");
    expect(refusal(checkBrief(input({ summary: "a\u0007b" }), ctx()))?.problem).toBe("bad_text");
    expect(ATTESTED_KINDS).toEqual(["tests", "manual", "ui", "data", "infra"]);
    expect(refusal(checkBrief(input({ attested: [{ kind: "quick", how: "had a look" }] }), ctx()))).toEqual({ problem: "bad_text", detail: "attested kind" });
    expect(refusal(checkBrief(input({ refs: [PR], noCode: "an analysis, no code changed" }), ctx())))
      .toEqual({ problem: "bad_ref", detail: "noCode stands in for refs; give one or the other" });
    expect(value(checkBrief(input({ decisions: "round\r\nat display" }), ctx())).decisions).toBe("round\nat display");
    // the whole brief as JSON, in bytes: every field at its cap with three-byte characters passes the field rules and not the bound
    const wide = (n: number) => "€".repeat(n);
    const heavy = input({
      summary: wide(BRIEF_LIMITS.summary), decisions: wide(BRIEF_LIMITS.decisions),
      leftOut: wide(BRIEF_LIMITS.leftOut), limits: wide(BRIEF_LIMITS.limits), refs: [PR],
      attested: Array.from({ length: BRIEF_LIMITS.attested }, () => ({ kind: "tests", how: wide(BRIEF_LIMITS.how) })),
    });
    expect(refusal(checkBrief(heavy, ctx()))?.problem).toBe("too_long");
    // a brief within the rules is stored whole, the optionals as empty text
    expect(checkBrief(input({ refs: [PR, CI], attested: [{ kind: "tests", how: "npm test: 14 passed" }] }), ctx())).toEqual({
      ok: true,
      value: { summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "none known", refs: [PR, CI], attested: [{ kind: "tests", how: "npm test: 14 passed" }], noCode: "" },
    });
  });

  it("checkBrief: a refusal names the field", () => {
    const cases: [BriefInput, { problem: string; detail: string }][] = [
      [input({ summary: " " }), { problem: "empty", detail: "summary" }],
      [input({ summary: "a\u0007b" }), { problem: "bad_text", detail: "summary" }],
      [input({ summary: "x".repeat(BRIEF_LIMITS.summary + 1) }), { problem: "too_long", detail: "summary" }],
      [input({ decisions: "a\u0007b" }), { problem: "bad_text", detail: "decisions" }],
      [input({ decisions: "x".repeat(BRIEF_LIMITS.decisions + 1) }), { problem: "too_long", detail: "decisions" }],
      [input({ leftOut: " " }), { problem: "empty", detail: "leftOut" }],
      [input({ limits: " " }), { problem: "empty", detail: "limits" }],
      [input({ noCode: "a\u0007b" }), { problem: "bad_text", detail: "noCode" }],
      [input({ noCode: "x".repeat(BRIEF_LIMITS.noCode + 1) }), { problem: "too_long", detail: "noCode" }],
      [input({ attested: [{ kind: "tests", how: " " }] }), { problem: "empty", detail: "attested.how" }],
      [input({ attested: [{ kind: "tests", how: "a\u0007b" }] }), { problem: "bad_text", detail: "attested.how" }],
      [input({ attested: [{ kind: "tests", how: "x".repeat(BRIEF_LIMITS.how + 1) }] }), { problem: "too_long", detail: "attested.how" }],
      [input({ attested: Array.from({ length: BRIEF_LIMITS.attested + 1 }, () => ({ kind: "tests", how: "npm test: 14 passed" })) }), { problem: "too_many", detail: "attested" }],
      [input({ refs: Array.from({ length: BRIEF_LIMITS.refs + 1 }, (_, i) => `acme/shop#4${i + 1}@${SHA}`) }), { problem: "too_many", detail: "refs" }],
      // and the one refusal that already had its detail keeps it
      [input({ attested: [{ kind: "quick", how: "had a look" }] }), { problem: "bad_text", detail: "attested kind" }],
    ];
    for (const [given, want] of cases) expect(refusal(checkBrief(given, ctx())), JSON.stringify(given)).toEqual(want);
  });
});

describe("the proof state (B14, B15)", () => {
  it("proofOf: one red ref makes the task failing whatever else is green", () => {
    expect(proofOf(brief({ refs: [PR, CI] }), [seen(PR, "green"), seen(CI, "red", "lint")]))
      .toEqual({ kind: "failing", green: 1, total: 2, accepts: false, line: `proof: 1 of 2 green · ✗ ${CI} lint` });
  });

  it("proofOf: attested items never make a task verified", () => {
    const attested = [{ kind: "tests" as const, how: "npm test: 14 passed" }];
    expect(proofOf(brief({ refs: [], attested }), [])).toEqual({ kind: "unchecked", green: 0, total: 0, accepts: false, line: "proof: unchecked (no reference to verify)" });
    expect(proofOf(brief({ attested }), [seen(PR, "pending")]).kind).toBe("pending");   // attested text sweetens nothing
  });

  it("proofOf: noCode alone is attested only, and the gate accepts it", () => {
    const b = brief({ refs: [], attested: [{ kind: "manual", how: "read the diff" }], noCode: "an analysis, no code changed" });
    const item = { spec: "manual: read the diff", kind: "manual" as const, repo: null, text: "read the diff", by: "assigner" as const };
    expect(proofOf(b, [], [], [item]))
      .toEqual({ kind: "attested_only", green: 0, total: 0, accepts: true, line: "proof: attested only (no code change)" });
  });

  // T-450 case 3: a claim of no code change is the lane's word, so it is accepted only against a proof list the assigner
  // filed (a lane's own items are its word too); with none, nothing but the lane vouches for it.
  it("proofOf: noCode is not accepted without a proof list from the assigner (T-450)", () => {
    const b = brief({ refs: [], attested: [{ kind: "manual", how: "read the memo" }], noCode: "an analysis, no code changed" });
    const item = (by: "assigner" | "lane") => ({ spec: "manual: read the memo", kind: "manual" as const, repo: null, text: "read the memo", by });
    const none = proofOf(b, [], [], []);
    expect(none).toEqual({ kind: "unchecked", green: 0, total: 0, accepts: false, line: "proof: no code change claimed, and the assigner listed no proof to check it against" });
    expect(proofOf(b, [], [], [item("lane")])).toEqual(none);                                     // the lane's own list does not vouch for itself
    expect(proofOf(b, [], [], [item("assigner")])).toEqual({ kind: "attested_only", green: 0, total: 0, accepts: true, line: "proof: attested only (no code change)" });
    // and a no-code brief with no attested item for the assigner's item is still not covered, as before
    expect(proofOf(brief({ refs: [], noCode: "an analysis" }), [], [], [item("assigner")]).accepts).toBe(false);
  });

  it("proofOf: no code change does not stand for a task that has a merge record", () => {
    const b = brief({ refs: [], attested: [{ kind: "manual", how: "read the diff" }], noCode: "an analysis, no code changed" });
    const proofOfMerges = proofOf as (brief: ProofBrief | null, results: readonly RefResult[], merges?: readonly { repo: string; sha: string }[]) => ReturnType<typeof proofOf>;
    expect(proofOfMerges(b, [], [{ repo: "acme/shop", sha: SHA }]))
      .toEqual({ kind: "unchecked", green: 0, total: 0, accepts: false, line: "proof: no code change claimed, but the task has a merge record (acme/shop)" });
    const item = { spec: "manual: read the diff", kind: "manual" as const, repo: null, text: "read the diff", by: "assigner" as const };
    expect(proofOf(b, [], [], [item])).toEqual({ kind: "attested_only", green: 0, total: 0, accepts: true, line: "proof: attested only (no code change)" });
  });

  it("proofOf: a ref with no result is pending, a stale row for a ref not in the brief is ignored, unfetchable beats pending, failing beats unfetchable", () => {
    expect(proofOf(brief(), [])).toEqual({ kind: "pending", green: 0, total: 1, accepts: false, line: `proof: 0 of 1 green · … ${PR} pending` });
    expect(proofOf(brief(), [seen("acme/shop#43@9999999", "green")]).kind).toBe("pending");   // the row names a ref the brief does not
    // several rows for one ref: the latest check wins, whatever the order of the rows
    expect(proofOf(brief(), [seen(PR, "green", null, 10), seen(PR, "red", "lint", 20)]).kind).toBe("failing");
    expect(proofOf(brief(), [seen(PR, "red", "lint", 20), seen(PR, "green", null, 10)]).kind).toBe("failing");
    expect(proofOf(brief({ refs: [PR, CI] }), [seen(PR, "unfetchable", "rate limit")]).kind).toBe("unfetchable");   // beats the ci ref's pending
    expect(proofOf(brief({ refs: [PR, CI] }), [seen(PR, "unfetchable", "rate limit"), seen(CI, "red", "lint")]).kind).toBe("failing");
  });

  it("proofOf: the line names every ref that is not green", () => {
    const refs = ["acme/shop#42@3e9d1a7", "acme/shop#43@1111111", "acme/shop@2222222:ci", "acme/shop#44@3333333"];
    expect(proofOf(brief({ refs }), [seen(refs[0]!, "green"), seen(refs[1]!, "mismatch"), seen(refs[2]!, "missing", "ci not found"), seen(refs[3]!, "unfetchable", "rate limit")]).line)
      .toBe("proof: 1 of 4 green · ≠ acme/shop#43@1111111 mismatch · ? acme/shop@2222222:ci ci not found · ! acme/shop#44@3333333 rate limit");
    // a line that would run long is cut at 600 characters
    const many = Array.from({ length: 8 }, (_, i) => `acme/shop#4${i}@${SHA}`);
    const long = proofOf(brief({ refs: many }), many.map((ref, i) => seen(ref, "unfetchable", `${"x".repeat(100)}${i}`)));
    expect(long.line.length).toBeLessThanOrEqual(600);
    expect(long.line.endsWith("…")).toBe(true);
  });
});

describe("the brief that counts (B13)", () => {
  const worker = { kind: "worker", name: "builder", token: "tok-w" } as const;
  const event = (rev: number, change: TaskChange): TaskEvent => ({ key: taskKey(12), rev, at: NOW + rev, actor: worker, change });
  const filed = (rev: number) => event(rev, { kind: "briefed", brief: brief() });
  const backToDoing = (rev: number) => event(rev, { kind: "moved", from: "review", to: "doing", reason: null });

  it("a brief stays current when the task is accepted as done: the proof it was accepted on", () => {
    const toDone = event(5, { kind: "moved", from: "review", to: "done", reason: "read the diff" });
    expect(currentBrief([filed(3), toDone])).toEqual({ brief: brief(), rev: 3 });
  });

  it("a Done ends the round: a task reopened and offered again needs a new brief", () => {
    const toDone = event(5, { kind: "moved", from: "review", to: "done", reason: "read the diff" });
    // any move out of done stales the brief the Done was accepted on, so a second Done cannot pass on the first round's proof
    expect(currentBrief([filed(3), toDone, event(6, { kind: "moved", from: "done", to: "doing", reason: null })])).toBeNull();
    expect(currentBrief([filed(3), toDone, event(6, { kind: "moved", from: "done", to: "doing", reason: null }), event(7, { kind: "moved", from: "doing", to: "review", reason: null })])).toBeNull();
    expect(currentBrief([filed(3), toDone, event(6, { kind: "moved", from: "done", to: "review", reason: null })])).toBeNull();
    // a brief of the new round counts
    expect(currentBrief([filed(3), toDone, event(6, { kind: "moved", from: "done", to: "doing", reason: null }), filed(8)])).toEqual({ brief: brief(), rev: 8 });
  });

  it("a brief older than the last review to doing move is stale", () => {
    expect(currentBrief([filed(3), backToDoing(5)])).toBeNull();
    expect(currentBrief([filed(2), filed(3), backToDoing(5)])).toBeNull();      // the newest brief is the one judged
    expect(currentBrief([filed(3), event(5, { kind: "moved", from: "review", to: "blocked", reason: "waiting on design" })])).toBeNull();
    // any order; a brief after the move counts again, and any move out of review stales one
    expect(currentBrief([backToDoing(2), filed(7), filed(3)])).toEqual({ brief: brief(), rev: 7 });
    expect(currentBrief([filed(3), event(4, { kind: "moved", from: "doing", to: "review", reason: null })])).toEqual({ brief: brief(), rev: 3 });
    expect(currentBrief([])).toBeNull();
    expect(currentBrief([backToDoing(5)])).toBeNull();
  });

  it("a brief filed in progress survives its move to review", () => {
    expect(currentBrief([filed(3), event(4, { kind: "moved", from: "doing", to: "review", reason: null })])).toEqual({ brief: brief(), rev: 3 });
  });
});

describe("judging a reference against what the forge said (B14)", () => {
  // Facts as the hub read them, never fetched here: a pull request as the adapter answered it, and one check run by its
  // id, name, status, conclusion and address.
  const MOVED = "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
  const prFacts = (o: Partial<PrFacts> = {}): PrFacts => ({ state: "open", merged: false, headSha: FULL, mergeSha: null, baseRef: null, ...o });
  const run = (o: Partial<CheckRunFacts> = {}): CheckRunFacts => ({ id: 1, name: "ci", status: "completed", conclusion: "success", url: null, ...o });
  const RUN_URL = "https://github.com/acme/shop/actions/runs/99";

  it("judgePr: green at the head or at the merge commit, mismatch with both shas when the head moved, red when closed without merge", () => {
    const ref = value(parseProofRef(PR));
    if (ref.kind !== "pr") throw new Error("not a pr ref");
    expect(judgePr(ref, prFacts())).toEqual({ state: "green", detail: null });                              // the head is the ref's commit
    expect(judgePr(ref, prFacts({ headSha: FULL.toUpperCase() }))).toEqual({ state: "green", detail: null });   // shas meet lower case
    expect(judgePr(ref, prFacts({ merged: true, headSha: MOVED, mergeSha: FULL }))).toEqual({ state: "green", detail: null });   // so is the merge's
    expect(judgePr(ref, prFacts({ headSha: MOVED }))).toEqual({ state: "mismatch", detail: `head is ${MOVED.slice(0, 7)}, ref says ${SHA}` });
    expect(judgePr(ref, prFacts({ state: "closed", merged: false, headSha: FULL }))).toEqual({ state: "red", detail: "closed without merge" });
  });

  it("judgePr: a merged pull request whose merge commit is not the task's recorded merge is a mismatch", () => {
    const ref = value(parseProofRef(PR));
    if (ref.kind !== "pr") throw new Error("not a pr ref");
    const recorded = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const otherMerge = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(judgePr(ref, prFacts({ merged: true, headSha: MOVED, mergeSha: otherMerge }), [{ repo: "acme/shop", sha: recorded }]))
      .toEqual({ state: "mismatch", detail: `merged as ${otherMerge.slice(0, 7)}, the task records ${recorded.slice(0, 7)}` });
    expect(judgePr(ref, prFacts({ merged: true, headSha: MOVED, mergeSha: FULL }), [{ repo: "acme/shop", sha: FULL }]))
      .toEqual({ state: "green", detail: null });
    expect(judgePr(ref, prFacts())).toEqual({ state: "green", detail: null });
    // a merge record in another repository says nothing about this pull request: its sha is compared all the same
    expect(judgePr(ref, prFacts({ merged: true, headSha: MOVED, mergeSha: otherMerge }), [{ repo: "acme/vault", sha: recorded }]))
      .toEqual({ state: "mismatch", detail: `head is ${MOVED.slice(0, 7)}, ref says ${SHA}` });
    const made = value(parseProofRef("acme/shop#5@0000000"));        // a made-up sha on a real, merged pull request
    if (made.kind !== "pr") throw new Error("not a pr ref");
    for (const merges of [undefined, [], [{ repo: "acme/vault", sha: recorded }], [{ repo: "acme/shop", sha: otherMerge }]])
      expect(judgePr(made, prFacts({ merged: true, headSha: MOVED, mergeSha: otherMerge }), merges).state, JSON.stringify(merges)).toBe("mismatch");
  });

  it("judgeCi: control characters in a check name are replaced and the detail is cut", () => {
    const ci = value(parseProofRef(`acme/shop@${SHA}:*`));
    if (ci.kind !== "ci") throw new Error("not a ci ref");
    const evilName = `c${"\u0007"}${"x".repeat(120)}`;
    const judged = judgeCi(ci, [run({ name: evilName, conclusion: "failure" })], false);
    expect(judged.state).toBe("red");
    expect(judged.detail!.length).toBeLessThanOrEqual(100);
    const codes = Array.from({ length: judged.detail!.length }, (_, i) => judged.detail!.charCodeAt(i));
    expect(codes.every(c => c > 0x1f && (c < 0x7f || c > 0x9f))).toBe(true);   // no control character survives
  });

  it("judgeCi: all named runs green is green; one failure is red and names the run; an unfinished run is pending", () => {
    const ci = value(parseProofRef(CI));
    if (ci.kind !== "ci") throw new Error("not a ci ref");
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint" })], false)).toEqual({ state: "green", detail: null });
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: "failure", url: RUN_URL })], false))
      .toEqual({ state: "red", detail: `"lint" failed ${RUN_URL}` });
    // a selector by number names its run the same way
    const byId = value(parseProofRef(`acme/shop@${SHA}:id=2`));
    if (byId.kind !== "ci") throw new Error("not a ci ref");
    expect(judgeCi(byId, [run({ id: 2, name: "lint", conclusion: "failure", url: RUN_URL })], false))
      .toEqual({ state: "red", detail: `id 2 failed ${RUN_URL}` });
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint", status: "in_progress", conclusion: null })], false))
      .toEqual({ state: "pending", detail: `"lint" in progress` });
  });

  it("judgeCi: a skipped or neutral named run is missing, not green", () => {
    const ci = value(parseProofRef(CI));
    if (ci.kind !== "ci") throw new Error("not a ci ref");
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: "skipped" })], false)).toEqual({ state: "missing", detail: `"lint" skipped` });
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: "neutral" })], false)).toEqual({ state: "missing", detail: `"lint" neutral` });
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: null })], false)).toEqual({ state: "missing", detail: `"lint" skipped` });   // no conclusion read as skipped
  });

  it("judgeCi: a named run that has not appeared is pending while the brief is young and missing after", () => {
    const ci = value(parseProofRef(CI));
    if (ci.kind !== "ci") throw new Error("not a ci ref");
    expect(YOUNG_MS).toBe(15 * 60_000);
    expect(judgeCi(ci, [run({ name: "ci" })], true)).toEqual({ state: "pending", detail: `"lint" not reported yet` });
    expect(judgeCi(ci, [run({ name: "ci" })], false)).toEqual({ state: "missing", detail: `"lint" not found` });
  });

  it("judgeCi: the star needs one green run and none red or pending", () => {
    const star = value(parseProofRef(`acme/shop@${SHA}:*`));
    if (star.kind !== "ci") throw new Error("not a ci ref");
    expect(judgeCi(star, [run({ name: "ci" }), run({ id: 2, name: "lint" })], false)).toEqual({ state: "green", detail: null });
    expect(judgeCi(star, [run({ name: "ci" }), run({ id: 2, name: "lint", status: "queued", conclusion: null })], false)).toEqual({ state: "pending", detail: `"lint" queued` });
    expect(judgeCi(star, [run({ id: 2, name: "lint", conclusion: "failure", url: RUN_URL })], false)).toEqual({ state: "red", detail: `"lint" failed ${RUN_URL}` });
    expect(judgeCi(star, [], true)).toEqual({ state: "pending", detail: "no checks reported yet" });
    expect(judgeCi(star, [], false)).toEqual({ state: "missing", detail: "no checks found" });
    expect(judgeCi(star, [run({ conclusion: "skipped" }), run({ id: 2, name: "lint", conclusion: "neutral" })], false)).toEqual({ state: "missing", detail: "no check ran" });
  });

  // T-450 case 2: a ci reference that names some checks is judged on those, and a commit that has another check failing
  // or still running is not green either (the named list narrows what must exist, never what may be red).
  it("judgeCi: named checks all green but another check at the commit failed or is running is not green (T-450)", () => {
    const ci = value(parseProofRef(`acme/shop@${SHA}:ci`)) as Parameters<typeof judgeCi>[0];
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "e2e", conclusion: "failure", url: RUN_URL })], false))
      .toEqual({ state: "red", detail: `another check "e2e" failed ${RUN_URL}` });
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "e2e", status: "in_progress", conclusion: null })], false))
      .toEqual({ state: "pending", detail: `another check "e2e" in progress` });
    // red beats pending among the others; a skipped other is no evidence either way; named-check failures keep their own word
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "a", status: "queued", conclusion: null }), run({ id: 3, name: "b", conclusion: "timed_out" })], false).state).toBe("red");
    expect(judgeCi(ci, [run({ name: "ci" }), run({ id: 2, name: "e2e", conclusion: "skipped" }), run({ id: 3, name: "x", conclusion: "success" })], false)).toEqual({ state: "green", detail: null });
    expect(judgeCi(ci, [run({ name: "ci", conclusion: "failure" }), run({ id: 2, name: "e2e", status: "in_progress", conclusion: null })], false).detail).toBe(`"ci" failed`);
    // a selector by id names its run too: the other checks are the rest
    const byId = value(parseProofRef(`acme/shop@${SHA}:id=1`)) as Parameters<typeof judgeCi>[0];
    expect(judgeCi(byId, [run({ id: 1 }), run({ id: 2, name: "e2e", conclusion: "failure" })], false).state).toBe("red");
  });

  // T-450 case 1: a pull request reference is green only at the commit it names, and that commit's checks must not be
  // failing or still running. A commit no check has reported on is pending while the brief is young, and after that a
  // repository with no checks, which the pull request reference does not ask to have any.
  it("judgePr: green pull request whose commit has a check running or failed is pending or red (T-450)", () => {
    const ref = value(parseProofRef(`acme/shop#42@${SHA}`)) as Parameters<typeof judgePr>[0];
    const checks = (runs: CheckRunFacts[], young = false, required: string[] | null = runs.length === 0 ? ["ci"] : runs.map(r => r.name)) => ({ runs, young, required });
    expect(judgePr(ref, prFacts(), [], checks([run({ name: "ci", status: "in_progress", conclusion: null })])))
      .toEqual({ state: "pending", detail: `checks: "ci" in progress` });
    expect(judgePr(ref, prFacts(), [], checks([run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: "failure", url: RUN_URL })])))
      .toEqual({ state: "red", detail: `checks: "lint" failed ${RUN_URL}` });
    expect(judgePr(ref, prFacts(), [], checks([run({ name: "ci" })]))).toEqual({ state: "green", detail: null });
    expect(judgePr(ref, prFacts(), [], checks([], true))).toEqual({ state: "pending", detail: `checks: required "ci" not reported yet` });
    expect(judgePr(ref, prFacts(), [], checks([], false))).toEqual({ state: "pending", detail: `checks: required "ci" not reported yet` });   // a required check never drops out
    expect(judgePr(ref, prFacts(), [], checks([], false, []))).toEqual({ state: "green", detail: null });      // no checks required, none exist
    expect(judgePr(ref, prFacts(), [], checks([run({ conclusion: "skipped" })]))).toEqual({ state: "green", detail: null });
    // the pull request's own verdicts come first: a moved head is a mismatch whatever the checks say
    expect(judgePr(ref, prFacts({ headSha: MOVED }), [], checks([run({ conclusion: "failure" })])).state).toBe("mismatch");
    expect(judgePr(ref, prFacts({ state: "closed", merged: false }), [], checks([])).state).toBe("red");
  });

  // T-450 (manager's narrowing): a pull request reference is red or pending only for checks its base branch requires
  // (branch protection or a ruleset). A failing or running optional check is a warning on the reference and holds nothing.
  // When the required set cannot be read, every check counts and the line says so (fail closed).
  describe("judgePr: required and optional checks (T-450)", () => {
    const ref = value(parseProofRef(`acme/shop#42@${SHA}`)) as Parameters<typeof judgePr>[0];
    const judge = (runs: CheckRunFacts[], required: string[] | null, young = false) => judgePr(ref, prFacts(), [], { runs, young, required });
    const E2E_FAILED = run({ id: 2, name: "e2e", conclusion: "failure", url: RUN_URL });
    const NOT_READ = "(required checks not readable; every check counted)";

    it("an optional red check with the required one green is green with a warning", () => {
      expect(judge([run({ name: "ci" }), E2E_FAILED], ["ci"])).toEqual({ state: "green", detail: `warning: optional check "e2e" failed ${RUN_URL}` });
      expect(judge([run({ name: "ci" }), run({ id: 2, name: "e2e", status: "in_progress", conclusion: null })], ["ci"]))
        .toEqual({ state: "green", detail: `warning: optional check "e2e" in progress` });
      expect(judge([run({ name: "ci" }), run({ id: 2, name: "a", status: "queued", conclusion: null }), run({ id: 3, name: "b", conclusion: "timed_out" })], ["ci"]).detail)
        .toBe(`warning: optional check "b" timed out`);                                 // red is the warning when both are
      expect(judge([run({ name: "ci" }), run({ id: 2, name: "e2e", conclusion: "skipped" })], ["ci"])).toEqual({ state: "green", detail: null });
      expect(judge([run({ name: "ci" })], ["ci"], false)).toEqual({ state: "green", detail: null });
    });

    it("a required check that is running or failed holds, whatever the optional ones say", () => {
      expect(judge([run({ name: "ci", status: "in_progress", conclusion: null }), E2E_FAILED], ["ci"]))
        .toEqual({ state: "pending", detail: `checks: "ci" in progress` });
      expect(judge([run({ name: "ci", conclusion: "failure", url: RUN_URL }), run({ id: 2, name: "e2e" })], ["ci", "e2e"]))
        .toEqual({ state: "red", detail: `checks: "ci" failed ${RUN_URL}` });
    });

    // T-450 fix round: a required check with no result holds the reference however long, and never drops out.
    it("a required check with no result is pending, however old the brief", () => {
      for (const young of [true, false]) {
        expect(judge([run({ id: 2, name: "e2e" })], ["ci"], young), `young ${young}`).toEqual({ state: "pending", detail: `checks: required "ci" not reported yet` });
        expect(judge([], ["ci"], young), `young ${young}`).toEqual({ state: "pending", detail: `checks: required "ci" not reported yet` });
        // one required check reported and another not: the missing one is awaited by name
        expect(judge([run({ name: "ci" })], ["ci", "fleet"], young), `young ${young}`).toEqual({ state: "pending", detail: `checks: required "fleet" not reported yet` });
      }
    });

    // T-450 fix round: no required set (no protection, or an empty one) means every check counts as required.
    it("an empty required set counts every check, and the line says so", () => {
      const NONE = "(no required checks on the base branch; every check counted)";
      expect(judge([run({ name: "ci" }), E2E_FAILED], [])).toEqual({ state: "red", detail: `checks: "e2e" failed ${RUN_URL} ${NONE}` });
      expect(judge([run({ id: 2, name: "e2e", status: "in_progress", conclusion: null })], [])).toEqual({ state: "pending", detail: `checks: "e2e" in progress ${NONE}` });
      expect(judge([run({ name: "ci" }), run({ id: 2, name: "e2e", conclusion: "skipped" })], [])).toEqual({ state: "green", detail: null });
      expect(judge([], [], true)).toEqual({ state: "pending", detail: `checks: no checks reported yet ${NONE}` });
      expect(judge([], [], false)).toEqual({ state: "green", detail: null });             // a repository with no checks at all is not asked to have any
    });

    it("an unreadable required set counts every check and says so (fail closed)", () => {
      expect(judge([run({ name: "ci" }), E2E_FAILED], null)).toEqual({ state: "red", detail: `checks: "e2e" failed ${RUN_URL} ${NOT_READ}` });
      expect(judge([run({ id: 2, name: "e2e", status: "in_progress", conclusion: null })], null)).toEqual({ state: "pending", detail: `checks: "e2e" in progress ${NOT_READ}` });
      expect(judge([run({ name: "ci" })], null)).toEqual({ state: "green", detail: null });
      expect(judge([], null, true)).toEqual({ state: "pending", detail: `checks: no checks reported yet ${NOT_READ}` });
    });

    it("the pull request's own verdicts still come first", () => {
      expect(judgePr(ref, prFacts({ headSha: MOVED }), [], { runs: [E2E_FAILED], young: false, required: ["ci"] }).state).toBe("mismatch");
    });
  });

  it("proofOf: a green reference with a warning stays accepted and the line names the warning (T-450)", () => {
    const warning = `warning: optional check "e2e" failed`;
    expect(proofOf(brief({ refs: [PR] }), [seen(PR, "green", warning)]))
      .toEqual({ kind: "verified", green: 1, total: 1, accepts: true, line: `proof: 1 of 1 green · ⚠ ${PR} ${warning}` });
    // a held-green row's own detail (the forge could not be reached) is not a warning and stays out of the line
    expect(proofOf(brief({ refs: [PR] }), [seen(PR, "green", "last read 10:00 UTC; the forge could not be reached since")]).line).toBe("proof: 1 of 1 green");
  });

  it("judgeCi: a run address is kept only when it is a github.com one", () => {
    const ci = value(parseProofRef(CI));
    if (ci.kind !== "ci") throw new Error("not a ci ref");
    const failed = (url: string | null) => [run({ name: "ci" }), run({ id: 2, name: "lint", conclusion: "failure", url })];
    expect(judgeCi(ci, failed(RUN_URL), false).detail).toBe(`"lint" failed ${RUN_URL}`);
    expect(judgeCi(ci, failed("https://example.test/builds/9"), false).detail).toBe(`"lint" failed`);              // not github.com: dropped
    expect(judgeCi(ci, failed("https://evil.example/github.com/acme"), false).detail).toBe(`"lint" failed`);       // github.com only at the start
    expect(judgeCi(ci, failed(`${RUN_URL}?check=1&x=2`), false).detail).toBe(`"lint" failed`);                     // characters outside the safe set: dropped
    expect(judgeCi(ci, failed(null), false).detail).toBe(`"lint" failed`);                                        // no address: nothing to keep
  });
});

describe("a reference the hub could not check (B14, private repositories)", () => {
  const NOTE = "private repo: not checked (404 without a token)";

  it("proofOf: a ref that was not checked is neither failing nor verified, and the line says so", () => {
    expect(proofOf(brief({ refs: [PR, CI] }), [seen(PR, "green"), seen(CI, "not_checked", NOTE)]))
      .toEqual({ kind: "not_checked", green: 1, total: 2, accepts: false, line: `proof: 1 of 2 green · ○ ${CI} ${NOTE}` });
    // with no detail the line still says what it is
    expect(proofOf(brief({ refs: [PR] }), [seen(PR, "not_checked")]).line).toBe(`proof: 0 of 1 green · ○ ${PR} not checked`);
  });

  it("proofOf: a failing, unfetchable or pending ref outranks a ref that was not checked", () => {
    const refs = [PR, CI];
    expect(proofOf(brief({ refs }), [seen(PR, "red", "lint"), seen(CI, "not_checked", NOTE)]).kind).toBe("failing");
    expect(proofOf(brief({ refs }), [seen(PR, "unfetchable", "rate limit"), seen(CI, "not_checked", NOTE)]).kind).toBe("unfetchable");
    expect(proofOf(brief({ refs }), [seen(PR, "pending"), seen(CI, "not_checked", NOTE)]).kind).toBe("pending");
    expect(proofOf(brief({ refs }), [seen(PR, "green"), seen(CI, "not_checked", NOTE)]).accepts).toBe(false);
  });
});

describe("the merge record's repository, re-applied at every reading (B14)", () => {
  const VAULT = "acme/vault#9@3e9d1a7";
  const merges = [{ repo: "acme/vault", sha: "1111111" }];

  it("proofOf: a brief filed before a merge record, with no reference in its repository, is not accepted however green it is", () => {
    const stale = proofOf(brief({ refs: [PR] }), [seen(PR, "green")], merges);
    expect(stale).toEqual({ kind: "unchecked", green: 1, total: 1, accepts: false, line: "proof: the task records a merge in acme/vault; no reference in that repository" });
    // without a merge record, or with a reference in the recorded repository (any case), it reads as before
    expect(proofOf(brief({ refs: [PR] }), [seen(PR, "green")]).kind).toBe("verified");
    expect(proofOf(brief({ refs: [PR, VAULT] }), [seen(PR, "green"), seen(VAULT, "green")], merges).kind).toBe("verified");
    expect(proofOf(brief({ refs: [PR, "Acme/Vault#9@3e9d1a7"] }), [seen(PR, "green"), seen("Acme/Vault#9@3e9d1a7", "green")], merges).accepts).toBe(true);
    // a red reference in the right repository is still failing, not hidden by the rule
    expect(proofOf(brief({ refs: [PR, VAULT] }), [seen(PR, "green"), seen(VAULT, "red", "lint")], merges).kind).toBe("failing");
  });
});

describe("the assigner's proof list (B17)", () => {
  const manager = { kind: "manager", name: "manager", token: "tok-m" } as const;
  const builder = { kind: "worker", name: "builder", token: "tok-w" } as const;
  const ev = (rev: number, actor: TaskActor, change: TaskChange): TaskEvent => ({ key: taskKey(12), rev, at: NOW + rev, actor, change });
  const listed = (rev: number, actor: TaskActor, add: string[], drop: string[] = []) =>
    ev(rev, actor, { kind: "proof_listed", add, drop });
  const DATA_SPEC = "data: a sample of 30 rows";
  const PR_SPEC = "pr@acme/shop: the pull request";
  const CI_SPEC = "ci@acme/shop: CI green";

  it("parseItemSpec reads kind, optional repository and text, and refuses the rest", () => {
    expect(parseItemSpec("pr@acme/shop: the pull request")).toEqual({
      ok: true,
      value: { spec: PR_SPEC, kind: "pr", repo: "acme/shop", text: "the pull request" },
    });
    expect(parseItemSpec("  data:   a   sample  of 30 rows  ")).toEqual({
      ok: true,
      value: { spec: DATA_SPEC, kind: "data", repo: null, text: "a sample of 30 rows" },
    });
    expect(parseItemSpec("ui: a screenshot of the totals row")).toEqual({
      ok: true,
      value: { spec: "ui: a screenshot of the totals row", kind: "ui", repo: null, text: "a screenshot of the totals row" },
    });
    expect(refusal(parseItemSpec("data@acme/shop: rows"))?.problem).toBe("bad_item");
    expect(refusal(parseItemSpec("pr: no repo"))?.problem).toBe("bad_item");
    expect(refusal(parseItemSpec("quick: had a look"))?.detail).toContain(ITEM_GRAMMAR);
    expect(refusal(parseItemSpec("data: "))?.problem).toBe("bad_item");
    expect(refusal(parseItemSpec(`data: ${"x".repeat(ITEM_TEXT_MAX + 1)}`))?.problem).toBe("bad_item");
    expect(refusal(parseItemSpec("data: a\u0007b"))?.problem).toBe("bad_item");
  });

  it("currentList folds events in order: adds, drops, repeats and who added each", () => {
    const events = [
      listed(2, manager, [PR_SPEC, DATA_SPEC]),
      listed(4, builder, ["ui: the totals row"], []),
      listed(3, manager, [CI_SPEC], []),                                              // out of rev order in the array
      listed(5, builder, [], [DATA_SPEC]),
      listed(6, manager, [DATA_SPEC], []),                                             // add again after drop
      listed(7, manager, [PR_SPEC], []),                                               // duplicate add ignored
    ];
    expect(currentList(events)).toEqual([
      { ...value(parseItemSpec(PR_SPEC)), by: "assigner" },
      { ...value(parseItemSpec(CI_SPEC)), by: "assigner" },
      { ...value(parseItemSpec("ui: the totals row")), by: "lane" },
      { ...value(parseItemSpec(DATA_SPEC)), by: "assigner" },
    ]);
  });

  it("currentList: the assigner's later add of an item the lane listed first re-owns it", () => {
    const laneActor = { kind: "worker" as const, name: "builder", token: "t" };
    const managerActor = { kind: "manager" as const, name: "manager", token: "t" };
    const listed = (rev: number, actor: typeof laneActor | typeof managerActor, add: string[], drop: string[] = []): TaskEvent => ({ key: taskKey(12), rev, at: NOW + rev, actor, change: { kind: "proof_listed", add, drop } });
    const spec = "data: a sample of 30 rows";
    expect(currentList([listed(2, laneActor, [spec])]).map(i => i.by)).toEqual(["lane"]);
    expect(currentList([listed(2, laneActor, [spec]), listed(3, managerActor, [spec])]).map(i => i.by)).toEqual(["assigner"]);
    // the other way round the assigner keeps it
    expect(currentList([listed(2, managerActor, [spec]), listed(3, laneActor, [spec])]).map(i => i.by)).toEqual(["assigner"]);
  });

  it("currentList stands across rounds: a brief going stale does not drop the list", () => {
    const worker = builder;
    const events = [
      listed(1, manager, [PR_SPEC]),
      ev(2, worker, { kind: "briefed", brief: brief() }),
      ev(3, worker, { kind: "moved", from: "review", to: "doing", reason: null }),
      listed(4, manager, [DATA_SPEC]),
    ];
    expect(currentList(events).map(i => i.spec)).toEqual([PR_SPEC, DATA_SPEC]);
    expect(currentBrief(events)).toBeNull();
  });

  it("coverageOf: a pr item is covered by a green pr reference in its repository, open while that reference is not green, not covered with none", () => {
    const item = value(parseItemSpec(PR_SPEC));
    const list = [{ ...item, by: "assigner" as const }];
    const none = coverageOf(list, null, []);
    expect(none).toEqual([{ ...item, by: "assigner", status: "not_covered" }]);
    const open = coverageOf(list, brief({ refs: [PR] }), [seen(PR, "red", "lint")]);
    expect(open[0]?.status).toBe("open");
    const covered = coverageOf(list, brief({ refs: [PR] }), [seen(PR, "green")]);
    expect(covered[0]?.status).toBe("covered");
    expect(coverageOf(list, brief({ refs: [PR] }), [])).toEqual([{ ...item, by: "assigner", status: "open", via: PR }]);
  });

  it("coverageOf: a ci item the same way, and an attested kind is told by an attested item of that kind", () => {
    const ciItem = { ...value(parseItemSpec(CI_SPEC)), by: "assigner" as const };
    expect(coverageOf([ciItem], brief({ refs: [CI] }), [seen(CI, "green")])[0]?.status).toBe("covered");
    expect(coverageOf([ciItem], brief({ refs: [CI] }), [seen(CI, "pending")])[0]?.status).toBe("open");
    const dataItem = { ...value(parseItemSpec(DATA_SPEC)), by: "assigner" as const };
    expect(coverageOf([dataItem], brief({ attested: [{ kind: "data", how: "30 rows read by hand" }] }), [])[0]?.status).toBe("told");
    expect(coverageOf([dataItem], brief(), [])[0]?.status).toBe("not_covered");
  });

  it("coverageOf names the reference behind a covered or open pr or ci item, and nothing else carries one", () => {
    const CIREF = "acme/shop@3e9d1a7:ci,lint";
    const ciItem = value(parseItemSpec("ci@acme/shop: the full suite is green"));
    const items = [{ ...ciItem, by: "assigner" as const }, { ...value(parseItemSpec("data: rows")), by: "assigner" as const }];
    const green = coverageOf(items, brief({ refs: [CIREF], attested: [{ kind: "data", how: "30 rows" }] }), [seen(CIREF, "green")]);
    expect(green.map(i => [i.status, i.via])).toEqual([["covered", CIREF], ["told", undefined]]);
    expect(coverageOf(items, brief({ refs: [CIREF] }), [seen(CIREF, "red", "lint")]).map(i => [i.status, i.via])).toEqual([["open", CIREF], ["not_covered", undefined]]);
    expect(coverageOf(items, null, []).every(i => i.via === undefined)).toBe(true);
  });

  it("coverageOf: an item with a repository is not covered by a reference in another repository", () => {
    const vaultPr = "acme/vault#9@3e9d1a7";
    const item = { ...value(parseItemSpec(PR_SPEC)), by: "assigner" as const };
    expect(coverageOf([item], brief({ refs: [vaultPr] }), [seen(vaultPr, "green")])[0]?.status).toBe("not_covered");
  });

  it("proofOf: a verified brief with an item not covered is not accepted, and its line names the item", () => {
    const list = [{ ...value(parseItemSpec(DATA_SPEC)), by: "assigner" as const }];
    const base = proofOf(brief({ refs: [PR] }), [seen(PR, "green")]);
    expect(base.kind).toBe("verified");
    const withList = proofOf(brief({ refs: [PR] }), [seen(PR, "green")], [], list);
    expect(withList.accepts).toBe(false);
    expect(withList.kind).toBe("not_covered");
    expect(withList.line).toBe(`proof: 1 of 1 green · ◇ not covered: ${DATA_SPEC}`);
  });

  it("proofOf: no brief with a list names the items too", () => {
    const list = [{ ...value(parseItemSpec(DATA_SPEC)), by: "assigner" as const }];
    const s = proofOf(null, [], [], list);
    expect(s.accepts).toBe(false);
    expect(s.line).toBe(`${NO_BRIEF_LINE} · ◇ not covered: ${DATA_SPEC}`);
  });

  it("proofOf: a list that is all covered changes nothing, and no code change does not cover a pr item", () => {
    const list = [{ ...value(parseItemSpec(PR_SPEC)), by: "assigner" as const }];
    const without = proofOf(brief({ refs: [PR] }), [seen(PR, "green")]);
    const withList = proofOf(brief({ refs: [PR] }), [seen(PR, "green")], [], list);
    expect(withList).toEqual(without);
    const noCode = brief({ refs: [], noCode: "an analysis, no code changed" });
    expect(coverageOf(list, noCode, [])[0]?.status).toBe("not_covered");
    expect(proofOf(noCode, [], [], list).accepts).toBe(false);
  });
});

