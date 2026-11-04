// Board context, B23 (ADR-0042): a pull request a task's brief names that merged while the task was still open, and
// the task knows nothing of it, is flagged — listed for the manager, never more. The board moves nothing (D5) and
// records nothing (B11): recording a merge stays the manager's, the principal's, the console's or the lane's own act.
// Pure: what the forge said of a pull request is the caller's, handed in as facts keyed by repository and number, so
// every rule below is testable whole. Only the repositories the hub reads are ever asked (B14); that rule lives in the
// hub, which holds the list.
import { parseProofRef, sameCommit } from "./proof.ts";
import type { Task, TaskKey, TaskStatus } from "./board.ts";

// B23: one pull request a brief names, as its reference wrote it (the repository keeps its case).
export type NamedPr = { repo: string; n: number };

// The pull request references among a brief's reference strings — the shapes parseProofRef reads, kind "pr" — each
// once (by repository in lower case and number), in order. A ci reference, a reference without its sha and anything
// unparseable is skipped: only what names a pull request can be one that merged.
export function namedPrs(refs: readonly string[]): NamedPr[] {
  const out: NamedPr[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const r = parseProofRef(raw);
    if (!r.ok || r.value.kind !== "pr") continue;
    const key = prKey(r.value.repo, r.value.number);
    if (seen.has(key)) continue;                           // named twice: kept once, the first writing's case
    seen.add(key);
    out.push({ repo: r.value.repo, n: r.value.number });
  }
  return out;
}

// A pull request's identity: the repository in lower case and the number, the key its fact is handed in under.
export const prKey = (repo: string, n: number): string => `${repo.toLowerCase()}#${n}`;

// What the forge said of one pull request, as the flag rule reads it: whether it merged, and as what commit (null
// when the forge did not say).
export type MergedPrFact = { merged: boolean; mergeSha: string | null };

// B23: one open task with at least one merged pull request it does not record. `prs` in reference order, the
// repository as the reference wrote it; `mergeSha` the commit the forge gave, null when it gave none.
export type MergedFlag = { key: TaskKey; status: TaskStatus; prs: { repo: string; n: number; mergeSha: string | null }[] };

// A merge record stands for the merge of a pull request in the same repository (either's case) when it is the same
// commit — the shorter sha a prefix of the longer, both whole hex forms — or, when the forge gave no commit, when it
// is in that repository at all.
const stands = (repo: string, mergeSha: string | null, merges: readonly { repo: string; sha: string }[]): boolean => {
  const inRepo = merges.filter(m => m.repo.toLowerCase() === repo.toLowerCase());
  if (mergeSha === null) return inRepo.length > 0;
  const merged = mergeSha.toLowerCase();
  return inRepo.some(m => SHA.test(m.sha.toLowerCase()) && SHA.test(merged) && sameCommit(m.sha.toLowerCase(), merged));
};
const SHA = /^[0-9a-f]{7,40}$/;

// The open statuses whose tasks are flagged: a pull request that merged while the task sat in the backlog is nobody's
// unfinished word yet, and one in a Done task is the record's business, not the flag's.
const OPEN: readonly TaskStatus[] = ["todo", "doing", "blocked", "review"];
const numberOf = (key: TaskKey) => Number(key.slice(2));

// B23: for each task in an open status, each pull request its brief names that the facts say merged and the task does
// not record. A pull request with no fact, or a fact that says not merged, is never flagged; a task with no flagged
// pull request is absent. Sorted by task number, each task's pull requests in the order its references named them.
export function mergedFlags(items: readonly { task: Task; refs: readonly string[]; merges: readonly { repo: string; sha: string }[] }[], facts: ReadonlyMap<string, MergedPrFact>): MergedFlag[] {
  const flags: MergedFlag[] = [];
  for (const { task, refs, merges } of items) {
    if (!OPEN.includes(task.status)) continue;
    const prs: MergedFlag["prs"] = [];
    for (const pr of namedPrs(refs)) {
      const fact = facts.get(prKey(pr.repo, pr.n));
      if (fact === undefined || !fact.merged) continue;
      if (stands(pr.repo, fact.mergeSha, merges)) continue;
      prs.push({ repo: pr.repo, n: pr.n, mergeSha: fact.mergeSha });
    }
    if (prs.length > 0) flags.push({ key: task.key, status: task.status, prs });
  }
  return flags.sort((a, b) => numberOf(a.key) - numberOf(b.key));
}

// B23: what the manager's lane is told: a header, one line per task (`T-3 (doing): acme/shop#42 merged 3e9d1a7 ·
// acme/vault#9 merged`, the first seven of the commit when the forge gave one, `merged` alone when it gave none), and
// the line that says what was not done. "" when nothing is flagged: the hub sends nothing then.
export function mergedMessage(flags: readonly MergedFlag[]): string {
  if (flags.length === 0) return "";
  const one = (f: MergedFlag) => `${f.key} (${f.status}): ${f.prs.map(p => `${p.repo}#${p.n}${p.mergeSha === null ? " merged" : ` merged ${p.mergeSha.slice(0, 7)}`}`).join(" · ")}`;
  return [
    `[board-merged] ${flags.length === 1 ? "1 task has a merged pull request without a merge record" : `${flags.length} tasks have a merged pull request without a merge record`}:`,
    ...flags.map(one),
    "Nothing was moved or recorded: record the merge, or finish the task, when it is time.",
  ].join("\n");
}
