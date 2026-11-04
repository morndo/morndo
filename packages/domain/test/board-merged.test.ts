// A pull request a task's brief names that merged while the task is still open, and the task knows nothing of it
// (T-805, B23): the board flags it and lists it for the manager; it moves nothing and records nothing. Pure: what the
// forge said is the caller's.
import { describe, expect, it } from "vitest";
import { createTask, mergedFlags, mergedMessage, namedPrs, prKey, type BoardActor, type MergedPrFact, type Task, type TaskStatus } from "../src/index.ts";

const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const FULL = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";
const OTHER = "9999999c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";

const task = (n: number, status: TaskStatus = "review"): Task => {
  const r = createTask({ title: `Task ${n}`, assignee: "builder" }, manager, n, 1_800_000_000_000);
  if (!r.ok) throw new Error(r.error.problem);
  return { ...r.value.task, status };
};
const facts = (...rows: [string, number, MergedPrFact][]) => new Map(rows.map(([repo, n, f]) => [prKey(repo, n), f] as const));
const merged = (sha: string | null = FULL): MergedPrFact => ({ merged: true, mergeSha: sha });
const open: MergedPrFact = { merged: false, mergeSha: null };
const item = (t: Task, refs: string[], merges: { repo: string; sha: string }[] = []) => ({ task: t, refs, merges });
const SHOP42 = "acme/shop#42@3e9d1a7";

describe("namedPrs: the pull requests a brief's references name", () => {
  it("lists the pull request references once, in order, and skips checks and what is no reference", () => {
    expect(namedPrs([SHOP42, "acme/shop@3e9d1a7:ci,lint", "ACME/SHOP#42@3e9d1a7", "acme/vault#9@1111111", "garbage", "acme/shop#42"]))
      .toEqual([{ repo: "acme/shop", n: 42 }, { repo: "acme/vault", n: 9 }]);
    expect(namedPrs([])).toEqual([]);
  });
  it("prKey is the repository in lower case and the number", () => {
    expect(prKey("Acme/Shop", 42)).toBe("acme/shop#42");
  });
});

describe("mergedFlags: a merged pull request the task does not record", () => {
  it("flags it, with the merge commit the forge gave", () => {
    expect(mergedFlags([item(task(1), [SHOP42])], facts(["acme/shop", 42, merged()])))
      .toEqual([{ key: "T-1", status: "review", prs: [{ repo: "acme/shop", n: 42, mergeSha: FULL }] }]);
  });

  it("flags a task in to do, in progress, blocked or in review, and none in the backlog or done", () => {
    const all = (["todo", "doing", "blocked", "review", "backlog", "done"] as const).map((s, i) => item(task(i + 1, s), [SHOP42]));
    expect(mergedFlags(all, facts(["acme/shop", 42, merged()])).map(f => `${f.key} ${f.status}`))
      .toEqual(["T-1 todo", "T-2 doing", "T-3 blocked", "T-4 review"]);
  });

  it("flags nothing for a pull request that is open, one the forge said nothing of, or a task naming none", () => {
    expect(mergedFlags([item(task(1), [SHOP42])], facts(["acme/shop", 42, open]))).toEqual([]);
    expect(mergedFlags([item(task(1), [SHOP42])], facts())).toEqual([]);
    expect(mergedFlags([item(task(1), ["acme/shop@3e9d1a7:ci"])], facts(["acme/shop", 42, merged()]))).toEqual([]);
    expect(mergedFlags([item(task(1), [])], facts(["acme/shop", 42, merged()]))).toEqual([]);
  });

  it("is quiet when the task already records that merge: the same commit, whichever length, and the repository in any case", () => {
    for (const sha of [FULL, "3e9d1a7", FULL.toUpperCase()]) {
      expect(mergedFlags([item(task(1), [SHOP42], [{ repo: "Acme/Shop", sha }])], facts(["acme/shop", 42, merged()])), sha).toEqual([]);
    }
  });

  it("still flags it when the record is another commit, or another repository", () => {
    expect(mergedFlags([item(task(1), [SHOP42], [{ repo: "acme/shop", sha: OTHER }])], facts(["acme/shop", 42, merged()]))).toHaveLength(1);
    expect(mergedFlags([item(task(1), [SHOP42], [{ repo: "acme/vault", sha: FULL }])], facts(["acme/shop", 42, merged()]))).toHaveLength(1);
  });

  it("when the forge gave no merge commit, any record in that repository stands for it, and one in another does not", () => {
    expect(mergedFlags([item(task(1), [SHOP42], [{ repo: "acme/shop", sha: OTHER }])], facts(["acme/shop", 42, merged(null)]))).toEqual([]);
    expect(mergedFlags([item(task(1), [SHOP42], [{ repo: "acme/vault", sha: OTHER }])], facts(["acme/shop", 42, merged(null)])))
      .toEqual([{ key: "T-1", status: "review", prs: [{ repo: "acme/shop", n: 42, mergeSha: null }] }]);
  });

  it("flags only the pull request that is not recorded, when a task names two", () => {
    const refs = [SHOP42, "acme/vault#9@1111111"];
    const flags = mergedFlags([item(task(1), refs, [{ repo: "acme/shop", sha: FULL }])], facts(["acme/shop", 42, merged()], ["acme/vault", 9, merged(OTHER)]));
    expect(flags).toEqual([{ key: "T-1", status: "review", prs: [{ repo: "acme/vault", n: 9, mergeSha: OTHER }] }]);
  });

  it("sorts by task number, and keeps each task's pull requests in the order of its references", () => {
    const f = facts(["acme/shop", 42, merged()], ["acme/vault", 9, merged(OTHER)]);
    const flags = mergedFlags([item(task(10), [SHOP42]), item(task(2), ["acme/vault#9@1111111", SHOP42])], f);
    expect(flags.map(x => x.key)).toEqual(["T-2", "T-10"]);
    expect(flags[0]?.prs.map(p => `${p.repo}#${p.n}`)).toEqual(["acme/vault#9", "acme/shop#42"]);
  });
});

describe("mergedMessage: what the manager's lane is told", () => {
  it("one task: a header, the line, and what was not done", () => {
    const flags = mergedFlags([item(task(12), [SHOP42])], facts(["acme/shop", 42, merged()]));
    expect(mergedMessage(flags).split("\n")).toEqual([
      "[board-merged] 1 task has a merged pull request without a merge record:",
      "T-12 (review): acme/shop#42 merged 3e9d1a7",
      "Nothing was moved or recorded: record the merge, or finish the task, when it is time.",
    ]);
  });
  it("several tasks and pull requests: one line per task, the pull requests joined, merged alone when the commit is unknown", () => {
    const f = facts(["acme/shop", 42, merged()], ["acme/vault", 9, merged(null)]);
    const flags = mergedFlags([item(task(3, "doing"), [SHOP42, "acme/vault#9@1111111"]), item(task(7, "blocked"), [SHOP42])], f);
    expect(mergedMessage(flags).split("\n")).toEqual([
      "[board-merged] 2 tasks have a merged pull request without a merge record:",
      "T-3 (doing): acme/shop#42 merged 3e9d1a7 · acme/vault#9 merged",
      "T-7 (blocked): acme/shop#42 merged 3e9d1a7",
      "Nothing was moved or recorded: record the merge, or finish the task, when it is time.",
    ]);
  });
});
