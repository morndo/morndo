// Proof of work (ADR-0035; B13 to B16 in docs/domain.md): a reference the board can fetch itself (a pull request, one
// commit's checks), the brief that carries it and the lane's attested checks, the one-line state the card shows, and
// the brief that still counts once the task has been back in progress. Pure: results are the caller's, never fetched.
import { describe, expect, it } from "vitest";
import {
  ATTESTED_KINDS, BRIEF_LIMITS, checkBrief, currentBrief, judgeCi, judgePr, parseProofRef, proofOf, refString, taskKey, YOUNG_MS,
  type BriefInput, type PrFacts, type ProofBrief, type RefResult, type RefState, type CheckRunFacts, type TaskChange, type TaskEvent,
} from "../src/index.ts";

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

  it("checkBrief: a repository outside the allowed list is refused as ref_repo, one in a merge record is accepted", () => {
    expect(refusal(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: ["other/repo"] })))).toEqual({ problem: "ref_repo", detail: "acme/shop" });
    // the list and the merge records match without regard to case, and the stored ref is the canonical form
    expect(value(checkBrief(input({ refs: ["ACME/SHOP#42@3E9D1A7"] }), ctx())).refs).toEqual(["ACME/SHOP#42@3e9d1a7"]);
    expect(value(checkBrief(input({ refs: [PR] }), ctx({ allowedRepos: [], merges: [{ repo: "Acme/Shop", sha: "9999999" }] }))).refs).toEqual([PR]);
    // a ref written twice is kept once
    expect(value(checkBrief(input({ refs: [PR, PR, CI] }), ctx())).refs).toEqual([PR, CI]);
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
    expect(proofOf(brief({ refs: [], attested: [{ kind: "manual", how: "read the diff" }], noCode: "an analysis, no code changed" }), []))
      .toEqual({ kind: "attested_only", green: 0, total: 0, accepts: true, line: "proof: attested only (no code change)" });
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

  it("a brief older than the last review to doing move is stale", () => {
    expect(currentBrief([filed(3), backToDoing(5)])).toBeNull();
    expect(currentBrief([filed(2), filed(3), backToDoing(5)])).toBeNull();      // the newest brief is the one judged
    // any order; a brief after the move counts again, and only a move back from review to doing stales one
    expect(currentBrief([backToDoing(2), filed(7), filed(3)])).toEqual({ brief: brief(), rev: 7 });
    expect(currentBrief([filed(3), event(4, { kind: "moved", from: "doing", to: "review", reason: null })])).toEqual({ brief: brief(), rev: 3 });
    expect(currentBrief([])).toBeNull();
    expect(currentBrief([backToDoing(5)])).toBeNull();
  });
});

describe("judging a reference against what the forge said (B14)", () => {
  // Facts as the hub read them, never fetched here: a pull request as the adapter answered it, and one check run by its
  // id, name, status, conclusion and address.
  const MOVED = "9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
  const prFacts = (o: Partial<PrFacts> = {}): PrFacts => ({ state: "open", merged: false, headSha: FULL, mergeSha: null, ...o });
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
