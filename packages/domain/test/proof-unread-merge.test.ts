// A task whose merge record is in a repository the hub does not read can still be briefed (T-805, B23): B14 asks a task
// with a merge record for a reference in that repository, but the hub fetches nothing outside the repositories its
// settings list, so for an unread one the rule could never be met and the brief could never be filed. Pure.
import { describe, expect, it } from "vitest";
import { checkBrief, type BriefInput } from "../src/index.ts";

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

  it("with two records, one read and one not, asks for a reference in the read one only, and names it", () => {
    const both = { allowedRepos: ["acme/shop", "acme/vault"], merges: [{ repo: "acme/elsewhere", sha: "2222222" }, { repo: "acme/vault", sha: "1111111" }] };
    expect(refusal(checkBrief(input({ refs: [PR_SHOP] }), ctx(both))))
      .toEqual({ problem: "ref_unrelated", detail: "the task records a merge in acme/vault; a reference to that repository is needed" });
    expect(checkBrief(input({ refs: [PR_VAULT] }), ctx(both)).ok).toBe(true);
  });
});
