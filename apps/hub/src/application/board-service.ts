// Application service for the Board context (ADR-0015): the team's tasks, changed by the principal (a Command, AC7),
// by the manager or by a worker lane (agent tokens, agent-access.ts), each change judged by the domain (board.ts),
// written with its event in one transaction, recorded in the audit log (B6), and pushed whole to every listener
// (the live feed), as the decisions are. The board grants nothing (B8): nothing here touches an Escalation, a Mandate
// or a Decision.
// ADR-0032: the board's own moves (B10, D1 to D4) come through `follow`, as actor { kind: "board", rule, lane }, and the
// console's (`morndo lanes start --task`) as { kind: "console" }: the same transaction, record and push as any change.
// The view carries each lane's Run as the Fleet derived it (the projector's, board-projector.ts), and a change of runs
// is pushed too, at most about once a second.
import { DONE_SHOWN_MS, applyAction, boardChanged, boardOrder, createTask, mayCommand, type AccessPolicy, type BoardActor, type BoardRefusal, type BoardRule, type NewTask, type Task, type TaskAction, type TaskActor, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { redactKeyMaterial, type RunView } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";

// `runs` (ADR-0032 §6, BoardFrameSchema.runs): each lane's latest Run; empty without a fleet.
export type BoardView = { tasks: Task[]; lanes: string[]; at: number; runs: RunView[] };
// A change of runs alone is pushed at most this often: runs change with every hook, a board frame is the whole board.
export const RUNS_EVERY_MS = 1000;
export type BoardResult = { ok: true; task: Task; event: TaskEvent } | { ok: false; problem: BoardRefusal["problem"] | "unknown" | "step_up"; other?: string; from?: TaskStatus };

export class BoardService {
  #store: Store;
  #now: () => number;
  #policy: () => AccessPolicy;
  #lanes: () => string[];
  #runs: () => RunView[];
  #runsEveryMs: number;
  #runsTimer: NodeJS.Timeout | null = null;
  #toldAt = -Infinity;                                   // performance.now() of the last push, for the runs' throttle
  #listeners = new Set<(b: BoardView) => void>();

  // `lanes`: the lane names the hub lists now, sent with the board so the app can mark an assignee that isn't running.
  // `runs`: each lane's latest Run (BoardProjector.runs; none without a fleet). `runsEveryMs`: the runs' throttle.
  constructor(p: { store: Store; now?: () => number; policy: () => AccessPolicy; lanes?: () => string[]; runs?: () => RunView[]; runsEveryMs?: number }) {
    this.#store = p.store; this.#now = p.now ?? Date.now; this.#policy = p.policy; this.#lanes = p.lanes ?? (() => []);
    this.#runs = p.runs ?? (() => []); this.#runsEveryMs = p.runsEveryMs ?? RUNS_EVERY_MS;
  }

  subscribe(fn: (b: BoardView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
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
    return { tasks: boardOrder(this.#store.shownTasks(now - DONE_SHOWN_MS), now), lanes: [...new Set(this.#lanes())].sort(), at: now, runs: this.#runs() };
  }
  task(key: string): { task: Task; events: TaskEvent[] } | null {
    const task = this.#store.task(key);
    return task ? { task, events: this.#store.taskEvents(key) } : null;
  }
  workingOn(lane: string): Task | null { return this.#store.taskInProgressOf(lane); }
  openTasksOf(lane: string): Task[] { return this.#store.openTasksOf(lane); }

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
      } : action;
      // B5 needs only the tasks in progress, not the whole board.
      const applied = applyAction(task, kept, actor, this.#now(), this.#store.tasksInProgress());
      if (!applied.ok) return applied;
      this.#write(applied.value.task, applied.value.event);
      return applied;
    });
    if (r === null) return { ok: false, problem: "unknown" };
    if (!r.ok) return { ok: false, ...r.error };
    this.#tell();
    return { ok: true, ...r.value };
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
    this.#store.record([boardChanged(event)]);
  }
}
