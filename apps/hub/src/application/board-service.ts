// Application service for the Board context (ADR-0015): the team's tasks, changed by the principal (a Command, AC7),
// by the manager or by a worker lane (agent tokens, agent-access.ts), each change judged by the domain (board.ts),
// written with its event in one transaction, recorded in the audit log (B6), and pushed whole to every listener
// (the live feed), as the decisions are. The board grants nothing (B8): nothing here touches an Escalation, a Mandate
// or a Decision.
import { DONE_SHOWN_MS, applyAction, boardChanged, boardOrder, createTask, mayCommand, type AccessPolicy, type BoardActor, type BoardRefusal, type NewTask, type Task, type TaskAction, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { redactKeyMaterial } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";

export type BoardView = { tasks: Task[]; lanes: string[]; at: number };
export type BoardResult = { ok: true; task: Task; event: TaskEvent } | { ok: false; problem: BoardRefusal["problem"] | "unknown" | "step_up"; other?: string; from?: TaskStatus };

export class BoardService {
  #store: Store;
  #now: () => number;
  #policy: () => AccessPolicy;
  #lanes: () => string[];
  #listeners = new Set<(b: BoardView) => void>();

  // `lanes`: the lane names the hub lists now, sent with the board so the app can mark an assignee that isn't running.
  constructor(p: { store: Store; now?: () => number; policy: () => AccessPolicy; lanes?: () => string[] }) {
    this.#store = p.store; this.#now = p.now ?? Date.now; this.#policy = p.policy; this.#lanes = p.lanes ?? (() => []);
  }

  subscribe(fn: (b: BoardView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  #tell() { const b = this.view(); for (const l of this.#listeners) l(b); }

  // The open tasks and Done for a week, read as such: never the whole table of done tasks.
  view(): BoardView {
    const now = this.#now();
    return { tasks: boardOrder(this.#store.shownTasks(now - DONE_SHOWN_MS), now), lanes: [...new Set(this.#lanes())].sort(), at: now };
  }
  task(key: string): { task: Task; events: TaskEvent[] } | null {
    const task = this.#store.task(key);
    return task ? { task, events: this.#store.taskEvents(key) } : null;
  }
  workingOn(lane: string): Task | null { return this.#store.taskInProgressOf(lane); }

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

  act(key: string, action: TaskAction, actor: BoardActor): BoardResult {
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

  #write(task: Task, event: TaskEvent) {
    this.#store.saveTask(task);
    this.#store.saveTaskEvent(event);
    this.#store.record([boardChanged(event)]);
  }
}
