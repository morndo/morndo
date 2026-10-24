// The proof block and the --why lint (ADR-0035 step 4, B14 to B16), as pure functions of what the hub answers: the
// lines `show` and `brief --show` print of a proof view, and the one warning a done's reason earns for each commit or
// pull request it names that the board did not verify. Table-tested without a hub; the states' words are the domain's.
import { describe, expect, it } from "vitest";
import { proofOf, type MergeRecord, type ProofBrief, type RefResult, type RefState } from "@morndo/domain";
import { lintWhy, proofBlock } from "../src/proof-text.ts";

const NOW = 1_700_000_000_000;
const PR = "morndo/morndo#42@3e9d1a7";
const CI = "morndo/morndo@3e9d1a7:ci,lint";
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";

const brief = (o: Partial<ProofBrief> = {}): ProofBrief => ({ summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "none known", refs: [], attested: [], noCode: "", ...o });
const seen = (ref: string, state: RefState, detail: string | null = null): RefResult => ({ ref, state, detail, checkedAt: NOW });
// A proof view as the hub sends it (proof-service's ProofView), its state computed by the domain from the same rows.
const view = (o: { brief?: ProofBrief | null; results?: RefResult[] } = {}) => {
  const b = o.brief === undefined ? brief() : o.brief;
  const results = o.results ?? [];
  return { rev: b === null ? null : 4, brief: b, results, state: proofOf(b, results) };
};
const merge = (sha: string): MergeRecord => ({ repo: "morndo/morndo", sha, at: NOW, by: "manager", override: null });

describe("proofBlock", () => {
  it("one line per reference, each state's mark, its detail or its word", () => {
    const cases: [RefState, string, string | null, string][] = [
      ["green", "✓", null, "green"],
      ["red", "✗", '"lint" failed', '"lint" failed'],
      ["mismatch", "≠", "head is 9c8b7a6, ref says 3e9d1a7", "head is 9c8b7a6, ref says 3e9d1a7"],
      ["missing", "?", null, "missing"],
      ["unfetchable", "!", "rate limit, retry 14:10 UTC", "rate limit, retry 14:10 UTC"],
      ["pending", "…", null, "pending"],
      ["not_checked", "○", null, "not checked"],
    ];
    for (const [state, mark, detail, tail] of cases) {
      const lines = proofBlock(view({ brief: brief({ refs: [PR] }), results: [seen(PR, state, detail)] }));
      expect(lines, state).toContain(`    ${mark} ${PR} ${tail}`);
    }
    // a reference with no row reads as pending, and the line over them all is the state's own
    expect(proofBlock(view({ brief: brief({ refs: [PR] }), results: [seen(PR, "red", '"lint" failed')] }))[0])
      .toBe(`  Proof: proof: 0 of 1 green · ✗ ${PR} "lint" failed`);
    expect(proofBlock(view({ brief: brief({ refs: ["morndo/morndo#43@1111111"] }) }))).toContain("    … morndo/morndo#43@1111111 pending");
  });

  it("the brief's lines, attested as the lane's word, noCode when set, and no brief at all", () => {
    expect(proofBlock(view({ brief: brief({
      decisions: "round at display, not at sum",
      attested: [{ kind: "tests", how: "npm test: 48 passed, 0 failed" }, { kind: "ui", how: "the totals row renders" }],
    }) }))).toEqual([
      "  Proof: proof: unchecked (no reference to verify)",
      "    Brief (rev 4): Totals row rounds to cents",
      "    Decisions: round at display, not at sum",
      "    Left out: nothing",
      "    Limits: none known",
      "    Attested (tests): npm test: 48 passed, 0 failed  (the lane's word, not checked)",
      "    Attested (ui): the totals row renders  (the lane's word, not checked)",
    ]);
    // each of the brief's own lines only when it says something
    expect(proofBlock(view())).toEqual([
      "  Proof: proof: unchecked (no reference to verify)",
      "    Brief (rev 4): Totals row rounds to cents",
      "    Left out: nothing",
      "    Limits: none known",
    ]);
    expect(proofBlock(view({ brief: brief({ noCode: "an analysis, no code changed" }) }))).toEqual([
      "  Proof: proof: attested only (no code change)",
      "    Brief (rev 4): Totals row rounds to cents",
      "    Left out: nothing",
      "    Limits: none known",
      "    No code change: an analysis, no code changed",
    ]);
    expect(proofBlock(view({ brief: null }))).toEqual(["  Proof: proof: no brief"]);
  });

  it("proofBlock: a newline in a brief's text cannot start a line of its own", () => {
    const forged = "x\n    ✓ acme/shop#9@1111111 green";
    const lines = proofBlock(view({ brief: brief({ summary: forged, refs: [] }), results: [] }));
    const briefLines = lines.filter(l => l.startsWith("    Brief (rev "));
    expect(briefLines).toHaveLength(1);
    expect(briefLines[0]).toContain(forged.replace(/\s+/g, " ").trim());
    expect(lines.some(l => /^\s+✓/.test(l) && !l.includes("Proof:"))).toBe(false);
  });
});

describe("a stand-in forge", () => {
  it("proofBlock says so when the hub read the references from a stand-in forge", () => {
    const v = view({ brief: null });
    expect(proofBlock({ ...v, standIn: true })[0]).toBe("  (read from a stand-in forge, not GitHub)");
    expect(proofBlock({ ...v, standIn: false }).join("\n")).not.toContain("stand-in");
    expect(proofBlock(v).join("\n")).not.toContain("stand-in");
  });
});

describe("lintWhy", () => {
  it("nothing to warn about with no tokens; a word like defaced is not one, and a token needs a digit", () => {
    expect(lintWhy("read the diff and the tests", view({ brief: null }), [])).toEqual([]);
    expect(lintWhy("the row defaced nothing", view({ brief: null }), [])).toEqual([]);          // 7 letters of hex, no digit
    expect(lintWhy("at 3e9d1a: too short for a sha", view({ brief: null }), [])).toEqual([]);
    expect(lintWhy(`at ${"a".repeat(40)}1: too long for a sha`, view({ brief: null }), [])).toEqual([]);
    // digits make it a token: all digits is a sha shape, and one digit inside letters is too
    expect(lintWhy("at 1234567: all digits", view({ brief: null }), [])).toEqual(["warning: --why names 1234567, which the board did not verify; verified: none"]);
    expect(lintWhy("badc0de came up", view({ brief: null }), [])).toEqual(["warning: --why names badc0de, which the board did not verify; verified: none"]);
  });

  it("a sha the board verified warns nothing, the prefix matching running either way", () => {
    // the reference holds the short form; the reason names the full one, and the short one
    const short = view({ brief: brief({ refs: [PR, CI] }), results: [seen(PR, "green"), seen(CI, "green")] });
    expect(lintWhy(`ran the checks at ${FULL}: 48 passed`, short, [])).toEqual([]);
    expect(lintWhy("ran the checks at 3e9d1a7: 48 passed", short, [])).toEqual([]);
    // the reference holds the full form; the reason names the short one
    const full = view({ brief: brief({ refs: [`morndo/morndo#42@${FULL}`] }), results: [seen(`morndo/morndo#42@${FULL}`, "green")] });
    expect(lintWhy("ran the checks at 3e9d1a7", full, [])).toEqual([]);
  });

  it("an unverified sha or #n warns once, naming the green refs; only a green reference verifies anything", () => {
    const v = view({ brief: brief({ refs: [PR, CI] }), results: [seen(PR, "green"), seen(CI, "green")] });
    expect(lintWhy("ran the checks at 9f8e7d6: 48 passed", v, [])).toEqual([`warning: --why names 9f8e7d6, which the board did not verify; verified: ${PR}, ${CI}`]);
    expect(lintWhy("PR #42 is green", v, [])).toEqual([]);
    expect(lintWhy("PR #43 looked green", v, [])).toEqual([`warning: --why names #43, which the board did not verify; verified: ${PR}, ${CI}`]);
    // a #n is verified only by a green pull request: a green ci reference does not
    const ciOnly = view({ brief: brief({ refs: [CI] }), results: [seen(CI, "green")] });
    expect(lintWhy("PR #42 is green", ciOnly, [])).toEqual([`warning: --why names #42, which the board did not verify; verified: ${CI}`]);
    // a reference that is not green verifies nothing
    const failing = view({ brief: brief({ refs: [PR] }), results: [seen(PR, "red", '"lint" failed')] });
    expect(lintWhy("ran the checks at 3e9d1a7", failing, [])).toEqual([`warning: --why names 3e9d1a7, which the board did not verify; verified: none`]);
    // two unverified tokens: one line each
    expect(lintWhy("9f8e7d6 and #43", v, [])).toEqual([
      `warning: --why names 9f8e7d6, which the board did not verify; verified: ${PR}, ${CI}`,
      `warning: --why names #43, which the board did not verify; verified: ${PR}, ${CI}`,
    ]);
  });

  it("a merge record's sha counts as verified; the list names the green references, not the merges", () => {
    expect(lintWhy("ran the checks at 9f8e7d6", view({ brief: null }), [merge("9f8e7d6c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01")])).toEqual([]);
    const v = view({ brief: brief({ refs: [PR] }), results: [seen(PR, "green")] });
    expect(lintWhy("at 9f8e7d6 and abc1234", v, [merge("9f8e7d6")])).toEqual([
      `warning: --why names abc1234, which the board did not verify; verified: ${PR}`,
    ]);
  });
});
