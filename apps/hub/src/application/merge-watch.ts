// Application service for B23 (ADR-0042): the hub reads, itself, the pull requests the open tasks' briefs name, and
// flags one that merged while its task did not hear of it. It moves nothing (D5) and records nothing (B11): the flag
// is a list for the manager — the board view carries it (`mergedPrs`) and the sweep tells the manager's lane
// (board-inbox.ts MergedSweep). The domain judges what a flag is (board-merged.ts); this service only reads and asks.
// What it may ask is bounded as the wait watch's (wait-watch.ts, review of #161): a pull request in a repository the
// hub does not read is never asked, whatever a brief names (B14 — task data never widens the list); a merged answer
// is final and never asked again; an open or failed one is asked again no sooner than MERGED_EVERY_MS after its last
// ask; and all reads together spend at most `prReadsPerHour` in a rolling hour, a bucket that refills over the hour,
// so the proof checks and the waits behind the same forge wall keep theirs. A pass never overlaps another.
import { mergedFlags, namedPrs, prKey, type MergedFlag, type MergedPrFact, type Task, type TaskStatus } from "@morndo/domain";
import { log as defaultLog } from "../adapters/log.ts";
import type { ProofService } from "./proof-service.ts";
import type { ForgeChecks } from "./ports.ts";

// An open or failed pull request is asked again no sooner than this after its last ask.
export const MERGED_EVERY_MS = 15 * 60_000;
// How often main.ts runs a pass.
export const MERGED_PASS_MS = 15 * 60_000;
// The forge reads the flag may spend in an hour, with and without a token (the anonymous wall is shared with the
// proof checks and the waits).
export const MERGED_READS_PER_HOUR = 60;
export const MERGED_READS_PER_HOUR_ANONYMOUS = 5;
const HOUR_MS = 3_600_000;

// What MergeWatch reads of the board: the tasks in one status, and one task's merge records.
export type MergedBoard = {
  tasksIn(status: TaskStatus): Task[];
  task(key: string): { task: Task; merged: { merges: { repo: string; sha: string }[] } | null } | null;
};

// One pull request's last ask: when it was made (`at`), what it answered (`fact`, null when it failed or was never
// made), and whether the answer is final (a merge never unmerges).
type Asked = { at: number; fact: MergedPrFact | null; final: boolean };

export class MergeWatch {
  #board: MergedBoard;
  #proof: Pick<ProofService, "view">;
  #forge: ForgeChecks | null;
  #repos: () => readonly string[];
  #now: () => number;
  #log: Pick<typeof defaultLog, "warn">;
  #perHour: number;
  #everyMs: number;
  #tokens: number;
  #filledAt: number;
  #asked = new Map<string, Asked>();
  #firstSeen = new Map<string, number>();                 // when a pull request was first named: the order of the unread
  #flags: MergedFlag[] = [];                              // the last pass's flags; empty before the first
  #running: Promise<{ read: number; flagged: number }> | null = null;
  #again = false;

  // `forge`: null when the hub reads no forge; nothing is read and nothing is flagged. `repos`: the repositories the
  // hub reads now (MORNDO_PROOF_REPOS). `prReadsPerHour`: the forge budget (MERGED_READS_PER_HOUR). `everyMs`:
  // MERGED_EVERY_MS.
  constructor(p: {
    board: MergedBoard; proof: Pick<ProofService, "view">; forge: ForgeChecks | null; repos: () => readonly string[];
    now?: () => number; prReadsPerHour?: number; everyMs?: number; log?: { warn(m: string): void };
  }) {
    this.#board = p.board; this.#proof = p.proof; this.#forge = p.forge; this.#repos = p.repos; this.#now = p.now ?? Date.now;
    this.#log = p.log ?? defaultLog; this.#perHour = p.prReadsPerHour ?? MERGED_READS_PER_HOUR; this.#everyMs = p.everyMs ?? MERGED_EVERY_MS;
    this.#tokens = this.#perHour; this.#filledAt = this.#now();
  }

  // The flags of the last pass, as the view and the sweep read them; empty before the first pass.
  flags(): MergedFlag[] { return this.#flags; }

  // One pass. A pass asked for while one runs is run once more after it, so a brief filed meanwhile is not left out.
  tick(): Promise<{ read: number; flagged: number }> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      try {
        let r = await this.#pass();
        while (this.#again) { this.#again = false; const more = await this.#pass(); r = { read: r.read + more.read, flagged: more.flagged }; }
        return r;
      } finally { this.#running = null; }
    })();
    return this.#running;
  }
  async idle(): Promise<void> { await this.#running?.catch(() => undefined); }

  async #pass(): Promise<{ read: number; flagged: number }> {
    // The open tasks with the brief that still counts and the merge records they already hold.
    const items = (["todo", "doing", "blocked", "review"] as const).flatMap(s => this.#board.tasksIn(s)).map(t => ({
      task: t,
      refs: this.#proof.view(t.key)?.brief?.refs ?? [],
      merges: this.#board.task(t.key)?.merged?.merges.map(m => ({ repo: m.repo, sha: m.sha })) ?? [],
    }));
    // The pull requests those briefs name. A merged answer is kept for the life of the process; the rest is kept
    // only while some brief names it.
    const prs = new Map<string, { repo: string; n: number }>();
    for (const i of items) for (const pr of namedPrs(i.refs)) prs.set(prKey(pr.repo, pr.n), pr);
    for (const id of [...this.#asked.keys()]) if (!prs.has(id) && !this.#asked.get(id)?.final) this.#asked.delete(id);
    for (const id of [...this.#firstSeen.keys()]) if (!prs.has(id)) this.#firstSeen.delete(id);
    for (const id of prs.keys()) if (!this.#firstSeen.has(id)) this.#firstSeen.set(id, this.#now());
    // The asks of this pass, the never-read first (the longest named first, so a budget smaller than the list starves
    // none of them), then those due by their oldest last ask; each within the hour's budget.
    const lastAsk = (id: string) => this.#asked.get(id)?.at ?? Number.NEGATIVE_INFINITY;
    const order = [...prs.entries()].sort(([a], [b]) => (lastAsk(a) - lastAsk(b)) || ((this.#firstSeen.get(a) ?? 0) - (this.#firstSeen.get(b) ?? 0)));
    let read = 0;
    const facts = new Map<string, MergedPrFact>();
    for (const [id, pr] of order) {
      const r = await this.#pr(pr);
      read += r.read;
      const fact = r.fact ?? this.#asked.get(id)?.fact ?? null;   // no budget left: its last word stands
      if (fact !== null) facts.set(id, fact);
    }
    this.#flags = mergedFlags(items, facts);
    return { read, flagged: this.#flags.length };
  }

  // One pull request, asked within the rules: only in a repository the hub reads, only with a forge, never again once
  // merged, again no sooner than `everyMs` after its last ask, and only while the hour's budget lasts. `read`: whether
  // the forge was asked (one call).
  async #pr(pr: { repo: string; n: number }): Promise<{ read: 0 | 1; fact: MergedPrFact | null }> {
    if (!this.#repos().some(r => r.toLowerCase() === pr.repo.toLowerCase())) return { read: 0, fact: null };
    const forge = this.#forge;
    if (forge === null) return { read: 0, fact: null };
    const id = prKey(pr.repo, pr.n);
    const now = this.#now();
    const kept = this.#asked.get(id);
    if (kept !== undefined && (kept.final || now - kept.at < this.#everyMs)) return { read: 0, fact: kept.fact };
    this.#tokens = Math.min(this.#perHour, this.#tokens + ((now - this.#filledAt) / HOUR_MS) * this.#perHour);
    this.#filledAt = now;
    if (this.#tokens < 1) return { read: 0, fact: null };       // over budget: its last word stands, asked again when it allows
    this.#tokens -= 1;
    const a = await forge.pullRequest(pr.repo, pr.n);
    let fact: MergedPrFact | null;
    let final = false;
    if (a.ok) {
      fact = { merged: a.value.merged, mergeSha: a.value.mergeSha };
      final = a.value.merged;                                   // a merge never unmerges: never asked again
    } else {
      fact = kept?.fact ?? null;                                // a failed ask keeps the last word it had
      this.#log.warn(`merged: reading ${pr.repo}#${pr.n} failed (${a.failure.reason}); the next pass tries again`);
    }
    this.#asked.set(id, { at: this.#now(), fact, final });
    return { read: 1, fact };
  }
}
