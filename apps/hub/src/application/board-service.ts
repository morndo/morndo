// Application service for the Board context (ADR-0015): the team's tasks, changed by the principal (a Command, AC7),
// by the manager or by a worker lane (agent tokens, agent-access.ts), each change judged by the domain (board.ts),
// written with its event in one transaction, recorded in the audit log (B6), and pushed whole to every listener
// (the live feed), as the decisions are. The board grants nothing (B8): nothing here touches an Escalation, a Mandate
// or a Decision.
// ADR-0032: the board's own moves (B10, D1 to D4) come through `follow`, as actor { kind: "board", rule, lane }, and the
// console's (`morndo lanes start --task`) as { kind: "console" }: the same transaction, record and push as any change.
// The view carries each lane's Run as the Fleet derived it and the to do tasks whose lane the fleet no longer lists
// (orphans; the projector's, board-projector.ts), and a change of runs is pushed too, at most about once a second.
// B11: each task's merges are kept with their liveness (merge-liveness.ts over the fleet's node builds), Done is judged
// against them, and the view says for each task with merges where they stand ("merged, not live: pc on abc1234").
// B18 (ADR-0038): a block's waits are judged against the repositories the hub reads (`repos`), the view carries what
// the wait watch last read for each (wait-watch.ts), and a block of words only that sat too long is flagged.
import { DONE_SHOWN_MS, MORNDO_REPO, applyAction, boardChanged, boardOrder, createTask, isMorndoRepo, isStaleBlock, mayCommand, mergedView, type AccessPolicy, type BoardActor, type BoardRefusal, type BoardRule, type JudgedWait, type Liveness, type MergedView, type NewTask, type ProofGate, type Task, type TaskAction, type TaskActor, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { redactKeyMaterial, type RunView } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";

// `runs` (ADR-0032 §6, BoardFrameSchema.runs): each lane's latest Run; empty without a fleet. `orphans`: the to do tasks
// whose lane the fleet no longer lists (BoardProjector.orphans); empty without a fleet. `merged` (B11): one view per
// shown task that has merges.
// `standIn`: set only when the hub reads its proof references from a stand-in forge, so every screen can say so (ADR-0035).
// `waits` (B18): for each blocked task that names waits, what the wait watch last read of them; `staleBlocks`: the blocked
// tasks of words only that nobody changed for STALE_BLOCK_MS. Both absent when there are none.
export type BoardView = { tasks: Task[]; lanes: string[]; at: number; runs: RunView[]; orphans: string[]; merged: MergedView[]; standIn?: true; waits?: { key: string; readings: JudgedWait[] }[]; staleBlocks?: string[] };
// A change of runs alone is pushed at most this often: runs change with every hook, a board frame is the whole board.
export const RUNS_EVERY_MS = 1000;
export type BoardResult = { ok: true; task: Task; event: TaskEvent } | { ok: false; problem: BoardRefusal["problem"] | "unknown" | "step_up"; other?: string; from?: TaskStatus; detail?: string };

// Who recorded a merge (B11): the manager's or the lane's name, or the kind for the principal and the console. The board
// itself records none (D5).
const actorName = (a: TaskEvent["actor"]): string => a.kind === "manager" || a.kind === "worker" ? a.name : a.kind;

export const PROOF_LIST_CHANGES_MAX = 100;

export class BoardService {
  #store: Store;
  #now: () => number;
  #policy: () => AccessPolicy;
  #lanes: () => string[];
  #runs: () => RunView[];
  #liveness: (sha: string) => Liveness;
  #knows: ((sha: string) => Promise<"yes" | "no" | "unknown">) | null;
  #standIn: boolean;
  #orphans: (tasks: readonly Task[], now: number) => string[];
  #runsEveryMs: number;
  #runsTimer: NodeJS.Timeout | null = null;
  #toldAt = -Infinity;                                   // performance.now() of the last push, for the runs' throttle
  #listeners = new Set<(b: BoardView) => void>();
  // ADR-0035 (B14 to B16): the proof service's two hooks on the board. The board itself knows nothing of a forge: the
  // gate it hands the domain is whatever the proof service says the task's proof is, and the refresh is the hub's own
  // re-reading of a brief's references before a Done is judged.
  #proof: { gate(key: string): ProofGate | undefined; refresh(key: string): Promise<void> } | null = null;
  #eventListeners = new Set<(e: TaskEvent) => void>();
  #repos: () => readonly string[];
  #cards: boolean;
  #waits: { readings(key: string, rev?: number): JudgedWait[] | null } | null = null;

  // `lanes`: the lane names the hub lists now, sent with the board so the app can mark an assignee that isn't running.
  // `runs`: each lane's latest Run (BoardProjector.runs; none without a fleet). `orphans`: the to do tasks whose lane the
  // fleet no longer lists (BoardProjector.orphans; none without a fleet). `runsEveryMs`: the runs' throttle.
  // `liveness` (B11): a merge's liveness over the nodes' builds; without one nothing is ever live, so Done waits. `knows`:
  // whether the hub's checkout holds a commit, asked once for a lane's merge record (actChecked); without one none is asked.
  // `repos` (B18): the repositories whose pull requests the hub reads (MORNDO_PROOF_REPOS); morndo/morndo when absent.
  // `cards`: whether the hub reads the owner's list (MORNDO_LEDGER); without it a card wait is refused at the block.
  constructor(p: { store: Store; now?: () => number; policy: () => AccessPolicy; lanes?: () => string[]; runs?: () => RunView[]; orphans?: (tasks: readonly Task[], now: number) => string[]; runsEveryMs?: number; liveness?: (sha: string) => Liveness; knows?: (sha: string) => Promise<"yes" | "no" | "unknown">; standIn?: boolean; repos?: () => readonly string[]; cards?: boolean }) {
    this.#store = p.store; this.#now = p.now ?? Date.now; this.#policy = p.policy; this.#lanes = p.lanes ?? (() => []);
    this.#runs = p.runs ?? (() => []); this.#orphans = p.orphans ?? (() => []); this.#runsEveryMs = p.runsEveryMs ?? RUNS_EVERY_MS;
    this.#liveness = p.liveness ?? (() => ({ live: false, blockers: [] }));
    this.#knows = p.knows ?? null;
    this.#standIn = p.standIn ?? false;
    this.#repos = p.repos ?? (() => [MORNDO_REPO]);
    this.#cards = p.cards ?? false;
  }

  subscribe(fn: (b: BoardView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  // Each task event as it was written (B14: the proof triggers ride on the board's own events, never on a Run). Called
  // after the transaction has committed and the board has been told, by whoever wrote the event (`act`, `create`,
  // `follow` through `act`); one call per event.
  onEvent(fn: (e: TaskEvent) => void): () => void {
    this.#eventListeners.add(fn);
    return () => { this.#eventListeners.delete(fn); };
  }
  // The proof service's hooks (ADR-0035): the gate the domain judges a Done and a brief against, and the refresh a
  // Done attempt waits for first. null: none attached, Done is not held for proof.
  attachProof(p: { gate(key: string): ProofGate | undefined; refresh(key: string): Promise<void> } | null): void { this.#proof = p; }
  // The wait watch's readings (B18, wait-watch.ts), shown in the view. null: none attached, the view says nothing of them.
  attachWaits(w: { readings(key: string, rev?: number): JudgedWait[] | null } | null): void { this.#waits = w; }
  #said(e: TaskEvent) { for (const l of this.#eventListeners) l(e); }
  // Every push carries the runs as they are then, so one due for the runs alone is dropped.
  #tell() {
    if (this.#runsTimer) { clearTimeout(this.#runsTimer); this.#runsTimer = null; }
    this.#toldAt = performance.now();
    const b = this.view();
    for (const l of this.#listeners) l(b);
  }
  // The runs changed (the projector says so on every run it takes in): pushed now if the last push is a second old,
  // else once, when it is (a trailing push, so the last change is never left unsaid). Monotonic time: a clock that
  // jumps never holds a push back.
  runsChanged() {
    if (this.#runsTimer) return;
    const wait = this.#toldAt + this.#runsEveryMs - performance.now();
    if (wait <= 0) { this.#tell(); return; }
    this.#runsTimer = setTimeout(() => { this.#runsTimer = null; this.#tell(); }, wait);
    this.#runsTimer.unref?.();
  }
  stop() { if (this.#runsTimer) clearTimeout(this.#runsTimer); this.#runsTimer = null; }

  // The open tasks and Done for a week, read as such: never the whole table of done tasks.
  view(): BoardView {
    const now = this.#now();
    const tasks = boardOrder(this.#store.shownTasks(now - DONE_SHOWN_MS), now);
    const waits = this.#waits === null ? [] : tasks.flatMap(t => {
      const readings = t.status === "blocked" && (t.waits ?? []).length > 0 ? this.#waits?.readings(t.key, t.rev) ?? null : null;
      return readings === null ? [] : [{ key: t.key, readings }];
    });
    const staleBlocks = tasks.filter(t => isStaleBlock(t, now)).map(t => t.key);
    return {
      tasks, lanes: [...new Set(this.#lanes())].sort(), at: now, runs: this.#runs(), orphans: this.#orphans(tasks, now), merged: this.#merged(tasks),
      ...(this.#standIn ? { standIn: true as const } : {}), ...(waits.length > 0 ? { waits } : {}), ...(staleBlocks.length > 0 ? { staleBlocks } : {}),
    };
  }
  // `waitsRead` (B18): for a blocked task that names waits, what the wait watch last read of them.
  task(key: string): { task: Task; events: TaskEvent[]; merged: MergedView | null; waitsRead?: JudgedWait[] } | null {
    const task = this.#store.task(key);
    if (!task) return null;
    const merges = this.#store.mergesOf(key);
    const read = task.status === "blocked" && (task.waits ?? []).length > 0 ? this.#waits?.readings(key, task.rev) ?? null : null;
    return { task, events: this.#store.taskEvents(key), merged: merges.length > 0 ? mergedView(task.key, merges, this.#liveness) : null, ...(read ? { waitsRead: read } : {}) };
  }
  workingOn(lane: string): Task | null { return this.#store.taskInProgressOf(lane); }
  openTasksOf(lane: string): Task[] { return this.#store.openTasksOf(lane); }
  tasksInProgress(): Task[] { return this.#store.tasksInProgress(); }
  // The blocked tasks, each with the waits its block named (B18): what the wait watch reads.
  blockedTasks(): Task[] { return this.#store.tasksIn("blocked"); }

  // The principal's own changes are Commands (AC7): past the step-up window they are refused until he verifies again.
  principal(a: Authenticated): BoardActor | { problem: "step_up" } {
    if (!mayCommand(a.session, this.#now(), this.#policy())) return { problem: "step_up" };
    return { kind: "principal", endpointId: a.endpoint.id, sessionId: a.session.id };
  }

  create(input: NewTask, actor: BoardActor): BoardResult {
    // The number is taken only once the task is accepted, so a refused filing burns none (B7 is about reuse, not gaps).
    const r = this.#store.transaction(() => {
      const n = this.#store.peekTaskNumber();
      const made = createTask(input, actor, n, this.#now(), this.#store.tasksInProgress());
      if (!made.ok) return made;
      this.#store.takeTaskNumber(n);
      this.#write(made.value.task, made.value.event);
      return made;
    });
    if (!r.ok) return { ok: false, ...r.error };
    this.#tell();
    this.#said(r.value.event);
    return { ok: true, ...r.value };
  }

  // `actor`: an agents' door actor, the console, or the board itself (follow, below); the domain judges each (B2 to B5,
  // B10).
  act(key: string, action: TaskAction, actor: TaskActor): BoardResult {
    const r = this.#store.transaction(() => {
      const task = this.#store.task(key);
      if (!task) return null;
      // A client that saved the redacted text back is sending the same field. Keep the stored words.
      const kept = action.action === "edit" ? {
        ...action,
        ...(action.title !== undefined ? { title: action.title === redactKeyMaterial(task.title) ? task.title : action.title } : {}),
        ...(action.description !== undefined ? { description: action.description === redactKeyMaterial(task.description) ? task.description : action.description } : {}),
      } : action.action === "proof_list" ? {
        // B17: an item's words lose key material before they are judged and stored, as a brief's do (a drop is redacted the
        // same way, so it finds the stored item).
        ...action,
        ...(action.add !== undefined ? { add: action.add.map(redactKeyMaterial) } : {}),
        ...(action.drop !== undefined ? { drop: action.drop.map(redactKeyMaterial) } : {}),
      } : action;
      // B5 needs only the tasks in progress, not the whole board. B11: Done is judged against the task's merges. B16:
      // the proof is in the gate only where the domain reads it — a brief (its repositories) and a move to Done.
      const proof = this.#proof !== null && (action.action === "brief" || action.action === "proof_list" || (action.action === "move" && action.to === "done"))
        ? this.#proof.gate(key) : undefined;
      // Bounded: each change of a proof list is an event, so a lane takes at most PROOF_LIST_CHANGES_MAX of them on a task.
      // Only the lane's own changes count and only the lane is held to it: it cannot spend a limit that locks the assigner out.
      if (action.action === "proof_list" && actor.kind === "worker"
        && this.#store.taskEvents(key).filter(e => e.change.kind === "proof_listed" && e.actor.kind === "worker").length >= PROOF_LIST_CHANGES_MAX)
        return { ok: false as const, error: { problem: "too_many" as const, detail: "proof list changes" } };
      const applied = applyAction(task, kept, actor, this.#now(), this.#store.tasksInProgress(),
        { merges: this.#store.mergesOf(key), liveness: this.#liveness, ...(proof !== undefined ? { proof } : {}), repos: this.#repos(), cards: this.#cards });
      if (!applied.ok) return applied;
      this.#write(applied.value.task, applied.value.event);
      return applied;
    });
    if (r === null) return { ok: false, problem: "unknown" };
    if (!r.ok) return { ok: false, ...r.error };
    this.#tell();
    this.#said(r.value.event);
    return { ok: true, ...r.value };
  }

  // `act`, for the agents' door (B11): a lane's merge record is first checked against the hub's checkout, once, and turned
  // away (`no_commit`) when the checkout says it has no such commit, so a lane cannot make the hub run git for any sha it
  // invents (a morndo/morndo record only). The manager's, the principal's and the console's records are not asked: they may come before the operator
  // brings the checkout up to date, and a refused record would leave the task with no merge to hold done for. "unknown"
  // (no checkout, git failing) takes the record.
  // B16 (ADR-0035): a move to Done first re-reads the brief's references that have gone stale, so the Done is judged
  // against what the forge says now, not what it said half an hour ago.
  async actChecked(key: string, action: TaskAction, actor: TaskActor): Promise<BoardResult> {
    if (action.action === "move" && action.to === "done" && this.#proof) await this.#proof.refresh(key);
    if (action.action === "merged" && actor.kind === "worker" && this.#knows) {
      const sha = action.sha.trim().toLowerCase();
      // Only morndo/morndo: the checkout is a Morndo one and says nothing of another repo's commits.
      if (isMorndoRepo((action.repo ?? MORNDO_REPO).trim()) && /^[0-9a-f]{7,40}$/.test(sha) && await this.#knows(sha) === "no") return { ok: false, problem: "no_commit" };
    }
    return this.act(key, action, actor);
  }

  // B10: the board's own move of `key`, following `lane`'s Run (derivedMove's answer: D1 to D4), as that rule. `rev`: the
  // task's revision the move was judged on, so a task changed meanwhile is refused (`changed`), never moved on a stale
  // reading (B6).
  follow(key: string, move: { to: TaskStatus; reason: string | null; rule: BoardRule }, lane: string, rev: number): BoardResult {
    const action: TaskAction = { action: "move", to: move.to, ...(move.reason === null ? {} : { reason: move.reason }), ifRev: rev };
    return this.act(key, action, { kind: "board", rule: move.rule, lane });
  }

  #write(task: Task, event: TaskEvent) {
    this.#store.saveTask(task);
    this.#store.saveTaskEvent(event);
    // B11: a merge is kept as a record with its event, an unmerged one drops that record, and an accepted not-live Done
    // sets the override on the task's morndo/morndo merges — all in the same transaction as the change itself.
    const change = event.change;
    if (change.kind === "merged") this.#store.saveMerge(task.key, { repo: change.repo, sha: change.sha, at: event.at, by: actorName(event.actor), override: null });
    if (change.kind === "unmerged") this.#store.deleteMerge(task.key, change.repo, change.sha);
    if (change.kind === "moved" && change.to === "done" && change.notLive !== undefined) this.#store.overrideMerges(task.key, change.notLive);
    this.#store.record([boardChanged(event)]);
  }

  // One merged view per shown task that has merges (B11): every task's merges in one read, not one per task.
  #merged(tasks: readonly Task[]): MergedView[] {
    const all = this.#store.allMerges();
    const views: MergedView[] = [];
    for (const t of tasks) {
      const merges = all.get(t.key);
      if (merges !== undefined) views.push(mergedView(t.key, merges, this.#liveness));
    }
    return views;
  }
}
