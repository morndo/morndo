// Application service for B18 and D7 (ADR-0040): the hub reads, itself, what each blocked task waits on, and when every
// wait a block names is over, the board moves the task to do. Facts come from where they live: the board for another
// task, the forge for a pull request (the same adapter and rate-limit wall as the proof of work, ADR-0035), the owner's
// list for a card (the manager's ledger, as the decision cards read it), the clock for a time. The domain judges each
// fact (judgeWait) and decides the move (waitMove); this service only reads and asks. A pass never overlaps another, a
// pull request is read again at most every PR_EVERY_MS however many tasks wait on it, and a move names the revision the
// waits were read at, so a task changed meanwhile is judged again on the next pass, never moved on a stale reading (B6).
// It grants nothing (B8) and never moves a task further than to do, nor to Done (D5).
import { judgeWait, waitMove, type JudgedWait, type Task, type TaskAction, type TaskActor, type Wait, type WaitFact } from "@morndo/domain";
import type { LedgerRead } from "../adapters/ledger.ts";
import { log as defaultLog } from "../adapters/log.ts";
import type { BoardResult } from "./board-service.ts";
import type { ForgeChecks } from "./ports.ts";

export const PR_EVERY_MS = 5 * 60_000;
// How often main.ts runs a pass; a block that names waits also starts one at once (main.ts, on its event).
export const WAIT_PASS_MS = 120_000;

export type WaitBoard = {
  blockedTasks(): Task[];
  task(key: string): { task: Task } | null;
  act(key: string, action: TaskAction, actor: TaskActor): BoardResult;
};

export class WaitWatch {
  #board: WaitBoard;
  #forge: ForgeChecks | null;
  #ledger: (() => LedgerRead) | null;
  #now: () => number;
  #log: Pick<typeof defaultLog, "warn">;
  #readings = new Map<string, JudgedWait[]>();
  #prs = new Map<string, { at: number; fact: WaitFact }>();
  #running: Promise<{ judged: number; moved: string[] }> | null = null;
  #again = false;

  // `forge`: null when the hub reads no forge; a pull request wait is then unknown. `ledger`: null without
  // MORNDO_LEDGER; a card wait is then unknown.
  constructor(p: { board: WaitBoard; forge: ForgeChecks | null; ledger: (() => LedgerRead) | null; now?: () => number; log?: Pick<typeof defaultLog, "warn"> }) {
    this.#board = p.board; this.#forge = p.forge; this.#ledger = p.ledger; this.#now = p.now ?? Date.now; this.#log = p.log ?? defaultLog;
  }

  // What the last pass read of a blocked task's waits, in the order the block named them; null before any pass.
  readings(key: string): JudgedWait[] | null { return this.#readings.get(key) ?? null; }

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
    const read = this.#ledger?.() ?? null;
    const cards = read?.ok ? new Map(read.items.map(i => [i.id, i.open ? "open" as const : "closed" as const])) : null;
    const moved: string[] = [];
    let judged = 0;
    const blocked = this.#board.blockedTasks();
    for (const key of [...this.#readings.keys()]) if (!blocked.some(t => t.key === key && (t.waits ?? []).length > 0)) this.#readings.delete(key);
    for (const t of blocked) {
      const waits = t.waits ?? [];
      if (waits.length === 0) continue;
      const readings: JudgedWait[] = [];
      for (const w of waits) readings.push(judgeWait(w, await this.#fact(w, cards), this.#now()));
      judged += readings.length;
      this.#readings.set(t.key, readings);
      const move = waitMove(t, readings);
      if (move === null) continue;
      const r = this.#board.act(t.key, { action: "move", to: move.to, reason: move.reason, ifRev: t.rev }, { kind: "board", rule: move.rule, lane: t.assignee ?? "-" });
      if (r.ok) { moved.push(t.key); this.#readings.delete(t.key); }
      else if (r.problem !== "changed") this.#log.warn(`waits: ${t.key} is over but the board refused D7 (${r.problem})`);
    }
    return { judged, moved };
  }

  async #fact(w: Wait, cards: Map<string, "open" | "closed"> | null): Promise<WaitFact | null> {
    switch (w.kind) {
      case "time": return null;
      case "task": { const t = this.#board.task(w.key); return t ? { kind: "task", status: t.task.status } : null; }
      case "card": { const state = cards?.get(w.id); return state ? { kind: "card", state } : null; }
      case "pr": {
        if (!this.#forge) return null;
        const id = `${w.repo.toLowerCase()}#${w.n}`;
        const kept = this.#prs.get(id);
        if (kept && this.#now() - kept.at < PR_EVERY_MS) return kept.fact;
        const a = await this.#forge.pullRequest(w.repo, w.n);
        if (!a.ok) return null;                        // unread is unknown; the next pass asks again
        const fact: WaitFact = { kind: "pr", state: a.value.merged ? "merged" : a.value.state === "closed" ? "closed" : "open" };
        this.#prs.set(id, { at: this.#now(), fact });
        return fact;
      }
    }
  }
}
