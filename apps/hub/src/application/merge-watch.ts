// Application service for B23 (ADR-0042): the hub reads, itself, the pull requests the open tasks' briefs name, and
// flags one that merged while its task did not hear of it. It moves nothing (D5) and records nothing (B11): the flag
// is a list for the manager — the board view carries it (`mergedPrs`) and the sweep tells the manager's lane
// (board-inbox.ts MergedSweep). The domain judges what a flag is (board-merged.ts); this service only reads and asks.
// The facts are the last pass's, kept per pull request (a merged answer final for the life of the process); the flags
// are computed live, from those facts against the board as it stands — a task that left the open statuses, a merge
// just recorded, a brief that no longer names the pull request: gone at once, before any pass runs. What it may ask
// is bounded as the wait watch's (wait-watch.ts, review of #161): a pull request in a repository the hub does not
// read is never asked, whatever a brief names (B14 — task data never widens the list); an open or failed answer is
// asked again no sooner than MERGED_EVERY_MS after its last ask; and all reads together spend at most
// `prReadsPerHour` in a rolling hour, a bucket that refills over the hour, so the proof checks and the waits behind
// the same forge wall keep theirs. A pass never overlaps another, and the sweep that tells the manager follows the
// pass, never goes before it (mergedPass).
import { mergedFlags, namedPrs, prKey, type MergedFlag, type MergedPrFact, type Task, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { log as defaultLog } from "../adapters/log.ts";
import type { ProofService } from "./proof-service.ts";
import type { ForgeChecks } from "./ports.ts";

// An open or failed pull request is asked again no sooner than this after its last ask.
export const MERGED_EVERY_MS = 15 * 60_000;
// How often main.ts runs a pass (the sweep with it).
export const MERGED_PASS_MS = 15 * 60_000;
// The forge reads the flag may spend in an hour, with and without a token (the anonymous wall is shared with the
// proof checks and the waits).
export const MERGED_READS_PER_HOUR = 60;
export const MERGED_READS_PER_HOUR_ANONYMOUS = 5;
const HOUR_MS = 3_600_000;

// What MergeWatch reads of the board: the tasks in one status, and one task's events and merge records.
export type MergedBoard = {
  tasksIn(status: TaskStatus): Task[];
  task(key: string): { task: Task; events: readonly TaskEvent[]; merged: { merges: { repo: string; sha: string }[] } | null } | null;
};

// One pull request's last ask: when it was made (`at`), what it answered (`fact`, null when it failed or was never
// made), and whether the answer is final (a merge never unmerges).
type Asked = { at: number; fact: MergedPrFact | null; final: boolean };

// The references of the task's newest brief, whatever round filed it (the newest `briefed` event; none: empty). The
// flag watches a pull request, not a round of work, so it does not follow the proof gate's staling rule (B13): a
// lane back in progress keeps the pull request it named, and a newer brief that names other things drops it.
const lastBriefRefs = (events: readonly TaskEvent[]): readonly string[] => {
  let refs: readonly string[] = [];
  for (const e of events) if (e.change.kind === "briefed") refs = e.change.brief.refs;
  return refs;
};

export class MergeWatch {
  #board: MergedBoard;
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
  #running: Promise<{ read: number; flagged: number }> | null = null;
  #again = false;

  // `forge`: null when the hub reads no forge; nothing is read and nothing is flagged. `proof`: kept for the shape
  // the wiring gives every watcher over the board; the briefs are read from the board's own events (lastBriefRefs),
  // so the flag survives a round of work ending. `repos`: the repositories the hub reads now (MORNDO_PROOF_REPOS).
  // `prReadsPerHour`: the forge budget (MERGED_READS_PER_HOUR). `everyMs`: MERGED_EVERY_MS.
  constructor(p: {
    board: MergedBoard; proof: Pick<ProofService, "view">; forge: ForgeChecks | null; repos: () => readonly string[];
    now?: () => number; prReadsPerHour?: number; everyMs?: number; log?: { warn(m: string): void };
  }) {
    this.#board = p.board; this.#forge = p.forge; this.#repos = p.repos; this.#now = p.now ?? Date.now;
    this.#log = p.log ?? defaultLog; this.#perHour = p.prReadsPerHour ?? MERGED_READS_PER_HOUR; this.#everyMs = p.everyMs ?? MERGED_EVERY_MS;
    this.#tokens = this.#perHour; this.#filledAt = this.#now();
  }

  // The flags as they stand now: the facts the last pass read, judged against the board as it is at this call — the
  // tasks in the open statuses with the brief that still counts and the merge records they hold, each task's status
  // as it is now. No forge call. Empty before any pass read a fact.
  flags(): MergedFlag[] {
    const facts = new Map<string, MergedPrFact>();
    for (const [id, asked] of this.#asked) if (asked.fact !== null) facts.set(id, asked.fact);
    // The board view asks on every push: with no pull request known to have merged there is nothing to flag, and the
    // tasks' events are not read at all.
    if (![...facts.values()].some(f => f.merged)) return [];
    return mergedFlags(this.#items(), facts);
  }

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

  // The open tasks with the brief that named the pull requests and the merge records they hold, read as they are
  // now. The brief the flag reads is the task's newest, whatever round filed it: a lane that starts a new round
  // (which stales the brief for the proof gate, B13) does not take the pull request it named out of the world — the
  // flag is about a pull request, not a round of work — and a newer brief that names nothing else drops what it
  // dropped. `lastBriefRefs` finds it in the task's events.
  #items(): { task: Task; refs: readonly string[]; merges: readonly { repo: string; sha: string }[] }[] {
    return (["todo", "doing", "blocked", "review"] as const).flatMap(s => this.#board.tasksIn(s)).map(t => {
      const one = this.#board.task(t.key);
      return {
        task: t,
        refs: lastBriefRefs(one?.events ?? []),
        merges: one?.merged?.merges.map(m => ({ repo: m.repo, sha: m.sha })) ?? [],
      };
    });
  }

  async #pass(): Promise<{ read: number; flagged: number }> {
    // The pull requests the open tasks' briefs name. A merged answer is kept for the life of the process; the rest is
    // kept only while some brief names it.
    const prs = new Map<string, { repo: string; n: number }>();
    for (const i of this.#items()) for (const pr of namedPrs(i.refs)) prs.set(prKey(pr.repo, pr.n), pr);
    for (const id of [...this.#asked.keys()]) if (!prs.has(id) && !this.#asked.get(id)?.final) this.#asked.delete(id);
    for (const id of [...this.#firstSeen.keys()]) if (!prs.has(id)) this.#firstSeen.delete(id);
    for (const id of prs.keys()) if (!this.#firstSeen.has(id)) this.#firstSeen.set(id, this.#now());
    // The asks of this pass, the never-read first (the longest named first, so a budget smaller than the list starves
    // none of them), then those due by their oldest last ask; each within the hour's budget. What they answer is kept
    // per pull request; the flags are computed after, against the board as it stands then.
    const lastAsk = (id: string) => this.#asked.get(id)?.at ?? Number.NEGATIVE_INFINITY;
    const order = [...prs.entries()].sort(([a], [b]) => (lastAsk(a) - lastAsk(b)) || ((this.#firstSeen.get(a) ?? 0) - (this.#firstSeen.get(b) ?? 0)));
    let read = 0;
    for (const [, pr] of order) read += await this.#pr(pr);
    return { read, flagged: this.flags().length };
  }

  // One pull request, asked within the rules: only in a repository the hub reads, only with a forge, never again once
  // merged, again no sooner than `everyMs` after its last ask, and only while the hour's budget lasts — over budget,
  // its last word stands. Returns whether the forge was asked (one call).
  async #pr(pr: { repo: string; n: number }): Promise<0 | 1> {
    if (!this.#repos().some(r => r.toLowerCase() === pr.repo.toLowerCase())) return 0;
    const forge = this.#forge;
    if (forge === null) return 0;
    const id = prKey(pr.repo, pr.n);
    const now = this.#now();
    const kept = this.#asked.get(id);
    if (kept !== undefined && (kept.final || now - kept.at < this.#everyMs)) return 0;
    this.#tokens = Math.min(this.#perHour, this.#tokens + ((now - this.#filledAt) / HOUR_MS) * this.#perHour);
    this.#filledAt = now;
    if (this.#tokens < 1) return 0;                       // over budget: its last word stands, asked again when it allows
    this.#tokens -= 1;
    const a = await forge.pullRequest(pr.repo, pr.n);
    let fact: MergedPrFact | null;
    let final = false;
    if (a.ok) {
      fact = { merged: a.value.merged, mergeSha: a.value.mergeSha };
      final = a.value.merged;                             // a merge never unmerges: never asked again
    } else {
      fact = kept?.fact ?? null;                          // a failed ask keeps the last word it had
      this.#log.warn(`merged: reading ${pr.repo}#${pr.n} failed (${a.failure.reason}); the next pass tries again`);
    }
    this.#asked.set(id, { at: this.#now(), fact, final });
    return 1;
  }
}

// One pass of the flag, as main.ts runs it: the watch's pass first, then — only once it has finished — the sweep that
// tells the manager's lane, so the sweep always sends the list the pass just read, never the one before it. A watch
// pass that fails is not followed by a sweep and reaches the caller. `sweep` null (a hub with no fleet): only the
// watch runs, `sent` false.
export async function mergedPass(watch: { tick(): Promise<{ read: number; flagged: number }> }, sweep: { tick(): Promise<{ sent: boolean; items: number }> } | null): Promise<{ read: number; flagged: number; sent: boolean }> {
  const r = await watch.tick();
  if (sweep === null) return { read: r.read, flagged: r.flagged, sent: false };
  const s = await sweep.tick();
  return { read: r.read, flagged: r.flagged, sent: s.sent };
}
