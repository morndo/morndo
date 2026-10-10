// Board context (docs/domain.md "Board: who is doing what"; ADR-0015): the team's task board, as a real org runs one.
// The manager files tasks and hands each to a lane; the lane moves its own tasks as the work goes; the principal
// watches, and may do anything the manager may. Every change is an event with provenance (B1), only the manager or
// the principal assigns (B2), a lane moves only its own tasks and never to Done (B3), the moves are a fixed graph (B4),
// a lane has one task in progress at a time (B5), every change is recorded with who made it and the task's revision
// grows by one (B6), keys are never reused (B7), and the board grants nothing (B8): a status is never a Mandate, a
// Decision, Evidence or a Verdict. Done is the manager's (or the principal's) acceptance of a lane's word, not proof.
import { err, ok, type EndpointId, type Result, type SessionId } from "./shared.ts";

export type TaskKey = string & { readonly __brand: "TaskKey" };
export const taskKey = (n: number) => `T-${n}` as TaskKey;
export const parseTaskKey = (s: string): TaskKey | null => (/^T-[1-9]\d{0,8}$/.test(s) ? (s as TaskKey) : null);

export const TASK_STATUSES = ["backlog", "todo", "doing", "blocked", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// Who changed the board (B1): the principal from a signed-in Endpoint (a Command, AC7), or an agent holding an agent
// token: the manager's, or a worker's acting as the lane it names. `token` is the token's id, so a change can be
// traced to the credential that made it. Never a name taken from a conversation's text.
export type BoardActor =
  | { kind: "principal"; endpointId: EndpointId; sessionId: SessionId }
  | { kind: "manager"; name: string; token: string }
  | { kind: "worker"; name: string; token: string };

export type Task = {
  key: TaskKey;
  n: number;                              // the number in the key; the counter never goes back (B7)
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;                // a lane name; null: nobody's yet
  priority: TaskPriority;
  blockedReason: string | null;           // while blocked: why, in the mover's words
  createdAt: number;
  updatedAt: number;
  createdBy: BoardActor;
  rev: number;                            // one more per event (B6); a change may name the rev it saw
  doneAt: number | null;
  comments: number;
};

export type TaskChange =
  | { kind: "created"; status: TaskStatus; assignee: string | null }
  | { kind: "moved"; from: TaskStatus; to: TaskStatus; reason: string | null }
  | { kind: "assigned"; from: string | null; to: string | null }
  | { kind: "edited"; title?: string; description?: string; priority?: TaskPriority }
  | { kind: "commented"; text: string };
export type TaskEvent = { key: TaskKey; rev: number; at: number; actor: BoardActor; change: TaskChange };

export type NewTask = { title: string; description?: string; assignee?: string | null; priority?: TaskPriority; status?: TaskStatus };
export type TaskAction =
  | { action: "move"; to: TaskStatus; reason?: string; ifRev?: number }
  | { action: "assign"; to: string | null; ifRev?: number }
  | { action: "edit"; title?: string; description?: string; priority?: TaskPriority; ifRev?: number }
  | { action: "comment"; text: string };

export type BoardProblem =
  | "not_allowed"       // a worker tried what only the manager or the principal may (B2, B3)
  | "not_yours"         // a worker moved a task that isn't assigned to it (B3)
  | "bad_transition"    // not an edge of the graph for this actor (B4)
  | "needs_assignee"    // nobody works on an unassigned task (B4)
  | "reason_needed"     // blocked says why (B4)
  | "one_doing"         // the assignee already has a task in progress (B5); `other` names it
  | "changed"           // the task moved since the rev the change named (B6)
  | "same"              // the change changes nothing
  | "empty" | "too_long" | "bad_name" | "bad_text";
// `other`: the task in the way (one_doing); `from`: where the task is (bad_transition), so a refusal can say so.
export type BoardRefusal = { problem: BoardProblem; other?: TaskKey; from?: TaskStatus };

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const COMMENT_MAX = 4000;
export const REASON_MAX = 300;
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Done tasks stay on the board this long, then only in the record.
export const DONE_SHOWN_MS = 7 * 24 * 3_600_000;

const refuse = (problem: BoardProblem, other?: TaskKey, from?: TaskStatus): Result<never, BoardRefusal> =>
  err({ problem, ...(other ? { other } : {}), ...(from ? { from } : {}) });

// One line: a title or a reason never holds a line break (any kind, CRLF included: collapsed to a space) or a control
// character; a description or a comment keeps its lines and tabs. Each is trimmed and bounded.
function line(v: string, max: number): Result<string, BoardRefusal> {
  const v1 = v.replace(/\r\n?/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(v1)) return refuse("bad_text");
  const t = v1.replace(/\s+/g, " ").trim();
  if (!t) return refuse("empty");
  if (t.length > max) return refuse("too_long");
  return ok(t);
}
function text(v: string, max: number, allowEmpty = false): Result<string, BoardRefusal> {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return refuse("bad_text");
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (!t && !allowEmpty) return refuse("empty");
  if (t.length > max) return refuse("too_long");
  return ok(t);
}
function lane(v: string | null | undefined): Result<string | null, BoardRefusal> {
  if (v === null || v === undefined) return ok(null);
  const t = v.trim();
  return LANE_NAME.test(t) ? ok(t) : refuse("bad_name");
}

// B2: the manager and the principal run the board; a worker only works its tasks and files proposals.
export const runsTheBoard = (a: BoardActor) => a.kind === "principal" || a.kind === "manager";
// The lane an actor is, for B3 and for "my tasks": the manager is a lane too.
export const laneOf = (a: BoardActor) => (a.kind === "principal" ? null : a.name);

// B4: the moves. The manager and the principal may move a task anywhere but where it is; a lane moves its own task
// along the work: take it up, put it back, block it, offer it for review, take it up again. Never to Done (B3).
const WORKER_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ["todo", "doing"],
  todo: ["doing"],
  doing: ["blocked", "review", "todo"],
  blocked: ["doing", "todo"],
  review: ["doing"],
  done: [],
};
export const mayMove = (a: BoardActor, from: TaskStatus, to: TaskStatus) =>
  from !== to && (runsTheBoard(a) || WORKER_MOVES[from].includes(to));

// B5: the task a lane has in progress now, if any.
export const workingOn = (board: readonly Task[], laneName: string): Task | null =>
  board.find(t => t.status === "doing" && t.assignee === laneName) ?? null;

// `board`: the tasks in progress now, for B5 when a task is filed straight into progress.
export function createTask(input: NewTask, actor: BoardActor, n: number, now: number, board: readonly Task[] = []): Result<{ task: Task; event: TaskEvent }, BoardRefusal> {
  const title = line(input.title, TITLE_MAX);
  if (!title.ok) return title;
  const description = text(input.description ?? "", DESCRIPTION_MAX, true);
  if (!description.ok) return description;
  const who = lane(input.assignee);
  if (!who.ok) return who;
  // A worker's task is a proposal: it lands in the backlog, nobody's, for the manager to take up (B2).
  const assignee = runsTheBoard(actor) ? who.value : null;
  const status: TaskStatus = runsTheBoard(actor) ? (input.status ?? (assignee ? "todo" : "backlog")) : "backlog";
  if (status === "doing" && !assignee) return refuse("needs_assignee");
  if (status === "blocked" || status === "done") return refuse("bad_transition");
  if (status === "doing" && assignee) {
    const other = workingOn(board, assignee);
    if (other) return refuse("one_doing", other.key);
  }
  const key = taskKey(n);
  const task: Task = {
    key, n, title: title.value, description: description.value, status, assignee, priority: input.priority ?? "normal", blockedReason: null,
    createdAt: now, updatedAt: now, createdBy: actor, rev: 1, doneAt: null, comments: 0,
  };
  return ok({ task, event: { key, rev: 1, at: now, actor, change: { kind: "created", status, assignee } } });
}

// One change to one task, by one actor, judged against the board as it is (B5 needs the assignee's other tasks).
export function applyAction(task: Task, action: TaskAction, actor: BoardActor, now: number, board: readonly Task[]): Result<{ task: Task; event: TaskEvent }, BoardRefusal> {
  if ("ifRev" in action && action.ifRev !== undefined && action.ifRev !== task.rev) return refuse("changed");
  const mine = laneOf(actor) !== null && task.assignee === laneOf(actor);
  const next = (t: Task, change: TaskChange): Result<{ task: Task; event: TaskEvent }, BoardRefusal> => {
    const rev = task.rev + 1;
    return ok({ task: { ...t, rev, updatedAt: now }, event: { key: task.key, rev, at: now, actor, change } });
  };
  switch (action.action) {
    case "move": {
      if (!runsTheBoard(actor) && !mine) return refuse("not_yours");
      if (action.to === task.status) return refuse("same");
      if (!mayMove(actor, task.status, action.to)) return refuse("bad_transition", undefined, task.status);
      if (action.to === "doing" && !task.assignee) return refuse("needs_assignee");
      let reason: string | null = null;
      if (action.to === "blocked") {
        const r = line(action.reason ?? "", REASON_MAX);
        if (!r.ok) return r.error.problem === "empty" ? refuse("reason_needed") : r;
        reason = r.value;
      }
      if (action.to === "doing" && task.assignee) {
        const other = workingOn(board.filter(t => t.key !== task.key), task.assignee);
        if (other) return refuse("one_doing", other.key);
      }
      const moved: Task = { ...task, status: action.to, blockedReason: reason, doneAt: action.to === "done" ? now : null };
      return next(moved, { kind: "moved", from: task.status, to: action.to, reason });
    }
    case "assign": {
      if (!runsTheBoard(actor)) return refuse("not_allowed");
      const who = lane(action.to);
      if (!who.ok) return who;
      if (who.value === task.assignee) return refuse("same");
      if (task.status === "doing") {
        if (!who.value) return refuse("needs_assignee");
        const other = workingOn(board.filter(t => t.key !== task.key), who.value);
        if (other) return refuse("one_doing", other.key);
      }
      // Handing a backlog task to someone makes it theirs to do.
      const status: TaskStatus = task.status === "backlog" && who.value ? "todo" : task.status;
      return next({ ...task, assignee: who.value, status }, { kind: "assigned", from: task.assignee, to: who.value });
    }
    case "edit": {
      if (!runsTheBoard(actor)) return refuse("not_allowed");
      const change: TaskChange = { kind: "edited" };
      const t: Task = { ...task };
      if (action.title !== undefined) {
        const r = line(action.title, TITLE_MAX);
        if (!r.ok) return r;
        if (r.value !== task.title) { t.title = r.value; change.title = r.value; }
      }
      if (action.description !== undefined) {
        const r = text(action.description, DESCRIPTION_MAX, true);
        if (!r.ok) return r;
        if (r.value !== task.description) { t.description = r.value; change.description = r.value; }
      }
      if (action.priority !== undefined && action.priority !== task.priority) { t.priority = action.priority; change.priority = action.priority; }
      if (Object.keys(change).length === 1) return refuse("same");
      return next(t, change);
    }
    case "comment": {
      const r = text(action.text, COMMENT_MAX);
      if (!r.ok) return r;
      return next({ ...task, comments: task.comments + 1 }, { kind: "commented", text: r.value });
    }
  }
}

// The board as it is shown: every open task, and Done for a week (DONE_SHOWN_MS). Within a column, the urgent first
// (priority), then what is in motion newest first, and what waits oldest first, so nothing starves at the bottom.
const RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };
export function boardOrder(tasks: readonly Task[], now: number): Task[] {
  const shown = tasks.filter(t => t.status !== "done" || (t.doneAt !== null && now - t.doneAt < DONE_SHOWN_MS));
  return shown.sort((a, b) => {
    if (a.status !== b.status) return TASK_STATUSES.indexOf(a.status) - TASK_STATUSES.indexOf(b.status);
    if (a.status === "done") return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
    if (a.status === "backlog" || a.status === "todo") return a.createdAt - b.createdAt || a.n - b.n;
    return b.updatedAt - a.updatedAt || b.n - a.n;
  });
}

// What the record keeps of a change (B6): the task, the kind of change and who made it, never a comment's words.
export type BoardChanged = {
  type: "BoardChanged"; key: TaskKey; change: TaskChange["kind"]; at: number;
  actor: { kind: BoardActor["kind"]; name: string | null; endpointId: EndpointId | null; token: string | null };
};
export const boardChanged = (e: TaskEvent): BoardChanged => ({
  type: "BoardChanged", key: e.key, change: e.change.kind, at: e.at,
  actor: e.actor.kind === "principal"
    ? { kind: "principal", name: null, endpointId: e.actor.endpointId, token: null }
    : { kind: e.actor.kind, name: e.actor.name, endpointId: null, token: e.actor.token },
});
