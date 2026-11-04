// A task whose merge record is in a repository the hub does not read can still be briefed (T-805, B23): B14 asks a task
// with a merge record for a reference in that repository, but the hub fetches nothing outside the repositories its
// settings list, so for an unread one the rule could never be met and the brief could never be filed. Pure.
import { describe, expect, it } from "vitest";
import { checkBrief, proofOf, type BriefInput, type ProofBrief, type RefResult } from "../src/index.ts";

const SHA = "3e9d1a7";
const PR_SHOP = `acme/shop#42@${SHA}`;
const PR_VAULT = `acme/vault#9@${SHA}`;
const input = (o: Partial<BriefInput> = {}): BriefInput => ({ summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known", ...o });
const ctx = (o: Partial<Parameters<typeof checkBrief>[1]> = {}) => ({ allowedRepos: ["acme/shop"], merges: [] as { repo: string; sha: string }[], ...o });
const refusal = (r: { ok: boolean; error?: unknown }) => (r.ok ? null : (r.error as { problem: string; detail?: string }));

describe("a merge record in a repository the hub does not read (B14, B23)", () => {
  const unread = [{ repo: "acme/vault", sha: "1111111" }];

  it("needs no reference there: a brief with a reference in a repository the hub reads is taken", () => {
    expect(checkBrief(input({ refs: [PR_SHOP] }), ctx({ merges: unread })).ok).toBe(true);
  });

  it("needs none at all: a brief with attested checks only is taken", () => {
    expect(checkBrief(input({ attested: [{ kind: "tests", how: "npm test: 14 passed" }] }), ctx({ merges: unread })).ok).toBe(true);
  });

  it("is matched without regard to the case of the repository", () => {
    expect(checkBrief(input({ refs: [PR_SHOP] }), ctx({ merges: [{ repo: "ACME/Vault", sha: "1111111" }] })).ok).toBe(true);
  });

  it("still cannot be stood in for by a brief with no code change", () => {
    expect(refusal(checkBrief(input({ noCode: "an analysis, no code changed" }), ctx({ merges: unread }))))
      .toEqual({ problem: "bad_ref", detail: "this task has a merge record; a brief with no code change cannot stand for it" });
  });

  it("does not make a reference to an unread repository acceptable", () => {
    expect(refusal(checkBrief(input({ refs: [PR_VAULT] }), ctx({ merges: unread })))).toEqual({ problem: "ref_repo", detail: "acme/vault" });
  });
});

describe("a merge record in a repository the hub reads still needs a reference there (B14)", () => {
  it("is refused without one, naming that repository", () => {
    const read = { allowedRepos: ["acme/shop", "acme/vault"], merges: [{ repo: "acme/vault", sha: "1111111" }] };
    expect(refusal(checkBrief(input({ refs: [PR_SHOP] }), ctx(read))))
      .toEqual({ problem: "ref_unrelated", detail: "the task records a merge in acme/vault; a reference to that repository is needed" });
    expect(checkBrief(input({ refs: [PR_VAULT, PR_SHOP] }), ctx(read)).ok).toBe(true);
  });

  it("with records in two repositories the hub reads, a reference in either one is enough (as it was), and none names the first", () => {
    const two = { allowedRepos: ["acme/shop", "acme/vault", "acme/other"], merges: [{ repo: "acme/vault", sha: "1111111" }, { repo: "acme/shop", sha: "2222222" }] };
    expect(checkBrief(input({ refs: [PR_SHOP] }), ctx(two)).ok).toBe(true);
    expect(checkBrief(input({ refs: [PR_VAULT] }), ctx(two)).ok).toBe(true);
    expect(refusal(checkBrief(input({ refs: [`acme/other#3@${SHA}`] }), ctx(two))))
      .toEqual({ problem: "ref_unrelated", detail: "the task records a merge in acme/vault; a reference to that repository is needed" });
  });

  it("with two records, one read and one not, asks for a reference in the read one only, and names it", () => {
    const both = { allowedRepos: ["acme/shop", "acme/vault"], merges: [{ repo: "acme/elsewhere", sha: "2222222" }, { repo: "acme/vault", sha: "1111111" }] };
    expect(refusal(checkBrief(input({ refs: [PR_SHOP] }), ctx(both))))
      .toEqual({ problem: "ref_unrelated", detail: "the task records a merge in acme/vault; a reference to that repository is needed" });
    expect(checkBrief(input({ refs: [PR_VAULT] }), ctx(both)).ok).toBe(true);
  });
});

// The same rule at every reading (B14): proofOf judges a brief against the merge records at the done gate and in the view,
// and a record in a repository the hub does not read must owe it nothing there either, or the dead end only moves from
// filing the brief to finishing the task.
describe("proofOf with a merge record in a repository the hub does not read (B14, B23)", () => {
  const brief = (refs: string[]): ProofBrief => ({ summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "none known", refs, attested: [], noCode: "" });
  const green = (ref: string): RefResult => ({ ref, state: "green", detail: null, checkedAt: 5 });
  const unread = [{ repo: "acme/vault", sha: "1111111" }];

  it("owes no reference there: green references elsewhere verify, and the done is accepted", () => {
    const s = proofOf(brief([PR_SHOP]), [green(PR_SHOP)], unread, [], ["acme/shop"]);
    expect(s.kind).toBe("verified");
    expect(s.accepts).toBe(true);
  });

  it("is matched without regard to case, and a repository the hub reads still owes one", () => {
    expect(proofOf(brief([PR_SHOP]), [green(PR_SHOP)], [{ repo: "ACME/Vault", sha: "1111111" }], [], ["acme/shop"]).kind).toBe("verified");
    const read = proofOf(brief([PR_SHOP]), [green(PR_SHOP)], unread, [], ["acme/shop", "ACME/VAULT"]);
    expect(read.kind).toBe("unchecked");
    expect(read.line).toBe("proof: the task records a merge in acme/vault; no reference in that repository");
  });

  it("a reference in the repository of any merge record the hub reads is enough", () => {
    const both = [{ repo: "acme/vault", sha: "1111111" }, { repo: "acme/shop", sha: "2222222" }];
    expect(proofOf(brief([PR_SHOP]), [green(PR_SHOP)], both, [], ["acme/shop", "acme/vault"]).kind).toBe("verified");
    expect(proofOf(brief([PR_VAULT]), [green(PR_VAULT)], both, [], ["acme/shop", "acme/vault"]).kind).toBe("verified");
  });

  it("without the list of repositories the hub reads, as before: every merge record owes a reference", () => {
    expect(proofOf(brief([PR_SHOP]), [green(PR_SHOP)], unread).kind).toBe("unchecked");
  });
});
