// Application service for B18 and D7 (ADR-0038): the hub reads, itself, what each blocked task waits on, and when every
// wait a block names is over, the board moves the task to do. Facts come from where they live: the board for another
// task, the forge for a pull request (the same adapter and rate-limit wall as the proof of work, ADR-0035), the owner's
// list for a card (the manager's ledger, as the decision cards read it), the clock for a time. The domain judges each
// fact (judgeWait) and decides the move (waitMove); this service only reads and asks.
// What it may ask the forge is bounded three ways (review of #161): a pull request is read again at most every
// PR_EVERY_MS whether its last read worked or not; all reads together spend at most `prReadsPerHour` (a budget that
// refills over the hour, so the proof checks behind the same wall keep theirs); and a repository the hub no longer reads
// (MORNDO_PROOF_REPOS) is never asked, whatever an older block named (B14). A pass never overlaps another. The pull
// requests are read first and everything else after, right before the judgement, so a task that changed while the
// forge answered is judged as it is now; the move names the revision the waits were read at, so a block restated
// meanwhile is judged again on the next pass, never moved on a stale reading (B6). It grants nothing (B8) and never moves
// a task further than to do, nor to Done (D5).
import { judgeWait, waitMove, type JudgedWait, type Task, type TaskAction, type TaskActor, type TaskEvent, type Wait, type WaitFact } from "@morndo/domain";
import type { LedgerRead } from "../adapters/ledger.ts";
import { log as defaultLog } from "../adapters/log.ts";
import type { BoardResult } from "./board-service.ts";
import type { ForgeChecks } from "./ports.ts";

export const PR_EVERY_MS = 5 * 60_000;
// How often main.ts runs a pass.
export const WAIT_PASS_MS = 120_000;
// A block that names waits starts a pass at once; more blocks within this gap share one pass at its end.
export const WAIT_GAP_MS = 30_000;
// The forge reads all waits together may spend in an hour, with and without a token (GitHub allows 5000 and 60).
export const PR_READS_PER_HOUR = 120;
export const PR_READS_PER_HOUR_ANONYMOUS = 10;
const HOUR_MS = 3_600_000;

export type WaitBoard = {
  blockedTasks(): Task[];
  task(key: string): { task: Task } | null;
  act(key: string, action: TaskAction, actor: TaskActor): BoardResult;
};

export class WaitWatch {
  #board: WaitBoard;
  #forge: ForgeChecks | null;
  #ledger: (() => LedgerRead) | null;
  #repos: () => readonly string[];
  #now: () => number;
  #log: Pick<typeof defaultLog, "warn">;
  #perHour: number;
  #gapMs: number;
  #tokens: number;
  #filledAt: number;
  #readings = new Map<string, { rev: number; judged: JudgedWait[] }>();
  #prs = new Map<string, { at: number; fact: WaitFact | null }>();
  #firstSeen = new Map<string, number>();                 // when a pull request was first waited on: the order of the unread
  #running: Promise<{ judged: number; moved: string[] }> | null = null;
  #again = false;
  #lastSoon = Number.NEGATIVE_INFINITY;
  #soonTimer: ReturnType<typeof setTimeout> | null = null;
  #unfollow: (() => void) | null = null;

  // `forge`: null when the hub reads no forge; a pull request wait is then unknown. `ledger`: null without
  // MORNDO_LEDGER; a card wait is then unknown (and refused at the block, BoardService `cards`). `repos`: the
  // repositories the hub reads now. `prReadsPerHour`: the forge budget (PR_READS_PER_HOUR). `gapMs`: WAIT_GAP_MS.
  constructor(p: {
    board: WaitBoard; forge: ForgeChecks | null; ledger: (() => LedgerRead) | null; repos: () => readonly string[];
    now?: () => number; log?: Pick<typeof defaultLog, "warn">; prReadsPerHour?: number; gapMs?: number;
  }) {
    this.#board = p.board; this.#forge = p.forge; this.#ledger = p.ledger; this.#repos = p.repos; this.#now = p.now ?? Date.now;
    this.#log = p.log ?? defaultLog; this.#perHour = p.prReadsPerHour ?? PR_READS_PER_HOUR; this.#gapMs = p.gapMs ?? WAIT_GAP_MS;
    this.#tokens = this.#perHour; this.#filledAt = this.#now();
  }

  // What the last pass read of a blocked task's waits, in the order the block named them; null before any pass, and for a
  // block restated since (`rev`: the task's revision now), whose readings were of other waits.
  readings(key: string, rev?: number): JudgedWait[] | null {
    const r = this.#readings.get(key);
    return r && (rev === undefined || r.rev === rev) ? r.judged : null;
  }

  // A pass soon after every block that names waits: at once, or at the end of the gap since the last such pass.
  follow(board: { onEvent(fn: (e: TaskEvent) => void): () => void }): void {
    this.#unfollow?.();
    this.#unfollow = board.onEvent(e => { if (e.change.kind === "moved" && e.change.to === "blocked" && (e.change.waits ?? []).length > 0) this.#soon(); });
  }
  stop(): void {
    this.#unfollow?.(); this.#unfollow = null;
    if (this.#soonTimer) clearTimeout(this.#soonTimer);
    this.#soonTimer = null;
  }
  #soon(): void {
    if (this.#soonTimer) return;
    const wait = this.#lastSoon + this.#gapMs - performance.now();
    const go = () => {
      this.#soonTimer = null; this.#lastSoon = performance.now();
      void this.tick().catch((e: unknown) => this.#log.warn(`waits: the pass failed: ${String(e)}`));
    };
    if (wait <= 0) { go(); return; }
    this.#soonTimer = setTimeout(go, wait);
    this.#soonTimer.unref?.();
  }

  // One pass. A pass asked for while one runs is run once more after it, so a block named meanwhile is not left out.
  tick(): Promise<{ judged: number; moved: string[] }> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      try {
        let r = await this.#pass();
        while (this.#again) { this.#again = false; const more = await this.#pass(); r = { judged: r.judged + more.judged, moved: [...r.moved, ...more.moved] }; }
        return r;
      } finally { this.#running = null; }
    })();
    return this.#running;
  }
  async idle(): Promise<void> { await this.#running?.catch(() => undefined); }

  async #pass(): Promise<{ judged: number; moved: string[] }> {
    const blocked = this.#board.blockedTasks().filter(t => (t.waits ?? []).length > 0);
    for (const key of [...this.#readings.keys()]) if (!blocked.some(t => t.key === key)) this.#readings.delete(key);
    // 1. The pull requests, the only reads that wait on another machine: each once, the longest unread first and, among the
    //    never read, the one waited on longest first, so a budget smaller than the list starves none of them (a lane that
    //    keeps naming new ones queues behind the older).
    const prs = new Map<string, Extract<Wait, { kind: "pr" }>>();
    for (const t of blocked) for (const w of t.waits ?? []) if (w.kind === "pr") prs.set(prId(w), w);
    for (const id of [...this.#prs.keys()]) if (!prs.has(id)) this.#prs.delete(id);   // kept only while something waits on it
    for (const id of [...this.#firstSeen.keys()]) if (!prs.has(id)) this.#firstSeen.delete(id);
    for (const id of prs.keys()) if (!this.#firstSeen.has(id)) this.#firstSeen.set(id, this.#now());
    const lastRead = (id: string) => this.#prs.get(id)?.at ?? Number.NEGATIVE_INFINITY;
    const order = [...prs.entries()].sort(([a], [b]) => (lastRead(a) - lastRead(b)) || ((this.#firstSeen.get(a) ?? 0) - (this.#firstSeen.get(b) ?? 0)));
    const prFacts = new Map<string, WaitFact | null>();
    for (const [id, w] of order) prFacts.set(id, await this.#pr(w));
    // 2. The rest, now, so what the board and the owner's list say is what they say at the judgement.
    const read = this.#ledger?.() ?? null;
    const cards = read?.ok ? new Map(read.items.map(i => [i.id, i.open ? "open" as const : "closed" as const])) : null;
    const moved: string[] = [];
    let judged = 0;
    for (const t of blocked) {
      const now = this.#now();
      const readings = (t.waits ?? []).map(w => judgeWait(w, this.#fact(w, cards, prFacts), now));
      judged += readings.length;
      this.#readings.set(t.key, { rev: t.rev, judged: readings });
      const move = waitMove(t, readings);
      if (move === null) continue;
      const r = this.#board.act(t.key, { action: "move", to: move.to, reason: move.reason, ifRev: t.rev }, { kind: "board", rule: move.rule, lane: t.assignee ?? "-" });
      if (r.ok) { moved.push(t.key); this.#readings.delete(t.key); }
      else if (r.problem !== "changed") this.#log.warn(`waits: ${t.key} is over but the board refused D7 (${r.problem})`);
    }
    return { judged, moved };
  }

  #fact(w: Wait, cards: Map<string, "open" | "closed"> | null, prFacts: Map<string, WaitFact | null>): WaitFact | null {
    switch (w.kind) {
      case "time": return null;
      case "task": { const t = this.#board.task(w.key); return t ? { kind: "task", status: t.task.status } : null; }
      case "card": return cards === null ? null : { kind: "card", state: cards.get(w.id) ?? "absent" };
      case "pr": return prFacts.get(prId(w)) ?? null;
    }
  }

  // A pull request's state, within the budget: a repository the hub reads, read again only once its last reading
  // (worked or not) is PR_EVERY_MS old, and only while the hour's budget lasts. null: unknown.
  async #pr(w: Extract<Wait, { kind: "pr" }>): Promise<WaitFact | null> {
    if (!this.#repos().some(r => r.toLowerCase() === w.repo.toLowerCase())) return { kind: "pr", state: "outside" };
    if (!this.#forge) return null;
    const id = prId(w);
    const now = this.#now();
    const kept = this.#prs.get(id);
    if (kept && now - kept.at < PR_EVERY_MS) return kept.fact;
    this.#tokens = Math.min(this.#perHour, this.#tokens + ((now - this.#filledAt) / HOUR_MS) * this.#perHour);
    this.#filledAt = now;
    if (this.#tokens < 1) return null;                 // over budget: unknown, asked again when the budget allows
    this.#tokens -= 1;
    const a = await this.#forge.pullRequest(w.repo, w.n);
    const fact: WaitFact | null = a.ok ? { kind: "pr", state: a.value.merged ? "merged" : a.value.state === "closed" ? "closed" : "open" } : null;
    this.#prs.set(id, { at: this.#now(), fact });
    return fact;
  }
}

const prId = (w: { repo: string; n: number }) => `${w.repo.toLowerCase()}#${w.n}`;
