// Verification, the digest's records (docs/design/home-digest/README.md §3.3; ADR-0025; V1 and V2 in docs/domain.md):
// a claim is a lane's statement that an outcome holds on a revision, evidence is one check's result on one revision,
// and only a producer other than the claimants' counts toward verifying. Synthetic data: every name, sha and link is made up.
import { describe, expect, it } from "vitest";
import {
  checkClaim, checkEvidence, claimantsOf, claimVerdict, independentOf, revisionCovers, taskKey,
  type Assignment, type Claim, type Evidence, type LinkRecord, type Producer, type Revision,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const rev = (sha: string, patchId: string | null = null): Revision => ({ sha, patchId });
const change = (repo: string, n: number) => ({ kind: "change" as const, repo, n });
const FORGE: Producer = { kind: "forge", name: "forge-1" };
const PRINCIPAL: Producer = { kind: "principal", name: "owner" };
const lane = (name: string): Producer => ({ kind: "lane", name });
const problem = (r: { ok: boolean; error?: unknown }) => (r.ok ? "ok" : r.error);

const ev = (o: Partial<Evidence> & { subject: Evidence["subject"] }): Evidence => ({
  id: "e", seq: 1, at: NOW, revision: null, kind: "ci", result: "pass", producer: FORGE, ...o,
});

describe("the claimants of a subject (V1)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("every lane that claimed it, linked it, or was ever assigned a linked task", () => {
    const claims: Claim[] = [{ id: "cl-1", seq: 1, at: NOW, subject: c7, revision: a1, outcome: "done", lane: "builder" }];
    const links: LinkRecord[] = [{ task: taskKey(3), target: c7, by: "reviewer", at: NOW }];
    const assignments: Assignment[] = [{ task: taskKey(3), lane: "builder" }, { task: taskKey(3), lane: "tester" }];
    expect([...claimantsOf(c7, claims, links, assignments)].sort()).toEqual(["builder", "reviewer", "tester"]);
  });
  it("a claim naming a task is itself the link: the task's ever-assignees are claimants", () => {
    const claims: Claim[] = [{ id: "cl-1", seq: 1, at: NOW, subject: c7, revision: a1, outcome: "done", lane: "builder", task: taskKey(4) }];
    const assignments: Assignment[] = [{ task: taskKey(4), lane: "tester" }];
    expect([...claimantsOf(c7, claims, [], assignments)].sort()).toEqual(["builder", "tester"]);
  });
  it("a reassignment does not make the old assignee independent", () => {
    // builder linked the change to T-3 and was assigned it, then it went to tester: both stay claimants.
    const links: LinkRecord[] = [{ task: taskKey(3), target: c7, by: "builder", at: NOW }];
    const assignments: Assignment[] = [{ task: taskKey(3), lane: "builder" }, { task: taskKey(3), lane: "tester" }];
    expect([...claimantsOf(c7, [], links, assignments)].sort()).toEqual(["builder", "tester"]);
  });
  it("the task itself counts as linked to it: its own ever-assignees are claimants of the task (V1)", () => {
    // T-12 was reviewer's, then builder's; builder claims the task: reviewer's own review of it raises nothing.
    const t12 = { kind: "task" as const, key: taskKey(12) };
    const claims: Claim[] = [{ id: "cl-1", seq: 1, at: NOW, subject: t12, revision: null, outcome: "done", lane: "builder" }];
    const assignments: Assignment[] = [{ task: taskKey(12), lane: "reviewer" }, { task: taskKey(12), lane: "builder" }];
    expect([...claimantsOf(t12, claims, [], assignments)].sort()).toEqual(["builder", "reviewer"]);
  });
});

describe("independent producers (V1)", () => {
  const claimants = new Set(["builder"]);
  it("the forge, the manager and the principal are never the author; another lane is, when it claimed", () => {
    expect(independentOf(FORGE, claimants)).toBe(true);
    expect(independentOf({ kind: "manager", name: "manager" }, claimants)).toBe(true);
    expect(independentOf(PRINCIPAL, claimants)).toBe(true);
    expect(independentOf(lane("builder"), claimants)).toBe(false);
    expect(independentOf(lane("tester"), claimants)).toBe(true);
  });
  it("on a subject nobody claimed, no lane is independent: the forge account is shared by every lane", () => {
    expect(independentOf(lane("builder"), new Set())).toBe(false);
    expect(independentOf(lane("tester"), new Set())).toBe(false);
    expect(independentOf(FORGE, new Set())).toBe(true);
  });
});

describe("revisions (V1)", () => {
  it("evidence is on the claimed revision when it names the same commit, or a rebase of it: the same patch id", () => {
    expect(revisionCovers(rev("sha-a1", "patch-1"), rev("sha-a1", "patch-2"))).toBe(true);
    expect(revisionCovers(rev("sha-b2", "patch-9"), rev("sha-a1", "patch-9"))).toBe(true);
    expect(revisionCovers(rev("sha-b2", "patch-2"), rev("sha-a1", "patch-1"))).toBe(false);
    expect(revisionCovers(rev("sha-a1", null), rev("sha-a1", null))).toBe(true);
    expect(revisionCovers(rev("sha-a1", null), rev("sha-b2", null))).toBe(false);
  });
});

describe("the verdict on a claim (V1, V2)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  const passing: Evidence[] = [
    ev({ subject: c7, revision: a1, kind: "ci", result: "pass", producer: FORGE }),
    ev({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") }),
  ];
  it("everything may pass and it still is not Verified: the Done-means does not exist yet (V1)", () => {
    expect(claimVerdict({ subject: c7, revision: a1 }, passing, new Set(["builder"]))).toBe("unverified");
    expect(claimVerdict({ subject: c7, revision: a1 }, [], new Set())).toBe("unverified");
  });
  it("any failing evidence on the claimed revision refutes it, whatever else passed (V2)", () => {
    const failed = [...passing, ev({ subject: c7, revision: a1, kind: "ci", result: "fail", producer: FORGE })];
    expect(claimVerdict({ subject: c7, revision: a1 }, failed, new Set(["builder"]))).toBe("refuted");
  });
  it("a failure on another revision refutes nothing: work in progress on a newer push is not the claim's", () => {
    const other = [...passing, ev({ subject: c7, revision: rev("sha-b2", "patch-2"), kind: "ci", result: "fail", producer: FORGE })];
    expect(claimVerdict({ subject: c7, revision: a1 }, other, new Set(["builder"]))).toBe("unverified");
    const rebased = [...passing, ev({ subject: c7, revision: rev("sha-b2", "patch-1"), kind: "ci", result: "fail", producer: FORGE })];
    expect(claimVerdict({ subject: c7, revision: a1 }, rebased, new Set(["builder"]))).toBe("refuted");
  });
});

describe("the records' own guards", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  const claim: Claim = { id: "cl-1", seq: 1, at: NOW, subject: c7, revision: a1, outcome: "done", lane: "builder" };
  it("a claim's words are capped at 140, and its lane is a lane name", () => {
    expect(checkClaim(claim)).toEqual({ ok: true, value: claim });
    expect(problem(checkClaim({ ...claim, note: "x".repeat(141) }))).toBe("too_long");
    expect(problem(checkClaim({ ...claim, note: "x".repeat(140) }))).toBe("ok");
    expect(problem(checkClaim({ ...claim, lane: "" }))).toBe("empty");
    expect(problem(checkClaim({ ...claim, lane: "api lane" }))).toBe("bad_name");
  });
  it("a link is https or an attachment id; counts belong to the tests kind alone; a note is capped", () => {
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, link: "https://ci.acme.test/runs/9" })))).toBe("ok");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, link: "att-1" })))).toBe("ok");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, link: "http://ci.acme.test/runs/9" })))).toBe("bad_link");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, link: "see the terminal" })))).toBe("bad_link");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, kind: "ci", counts: { passed: 1, failed: 0, skipped: 0 } })))).toBe("bad_counts");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, kind: "tests", counts: { passed: 14, failed: 0, skipped: 2 } })))).toBe("ok");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, note: "x".repeat(141) })))).toBe("too_long");
    expect(problem(checkEvidence(ev({ subject: c7, revision: a1, producer: lane("") })))).toBe("bad_name");
  });
});
