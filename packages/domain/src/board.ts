// Board context (docs/domain.md "Board: who is doing what"; ADR-0015): the team's task board, as a real org runs one.
// The manager files tasks and hands each to a lane; the lane moves its own tasks as the work goes; the principal
// watches, and may do anything the manager may. Every change is an event with provenance (B1), only the manager or
// the principal assigns (B2), a lane moves only its own tasks and never to Done (B3), the moves are a fixed graph (B4),
// a lane has one task in progress at a time (B5), every change is recorded with who made it and the task's revision
// grows by one (B6), keys are never reused (B7), and the board grants nothing (B8): a status is never a Mandate, a
// Decision, Evidence or a Verdict. Done is the manager's (or the principal's) acceptance of a lane's word, not proof; the
// manager's says what it checked (B9). The board also moves a task by itself, following its assignee's Run, along the
// fixed edges of B10 (D1 to D6, ADR-0032): never to Done, never an assignment.
import type { Run } from "./run.ts";
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

// Who changed a task: an agents' door actor, the control plane's console (which acts for the principal there, as
// `memory approve` does), or the board itself following a Run (B10), naming the rule and the lane it read.
export type BoardRule = "D1" | "D2" | "D3" | "D4";
export type TaskActor = BoardActor | { kind: "console" } | { kind: "board"; rule: BoardRule; lane: string };

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
  stateChangedAt: number;                 // the last change of status, assignee or description; a comment or a title or priority edit leaves it (D6)
  createdBy: TaskActor;
  rev: number;                            // one more per event (B6); a change may name the rev it saw
  doneAt: number | null;
  comments: number;
};

export type TaskChange =
  | { kind: "created"; status: TaskStatus; assignee: string | null }
  | { kind: "moved"; from: TaskStatus; to: TaskStatus; reason: string | null; notLive?: string }
  | { kind: "assigned"; from: string | null; to: string | null }
  | { kind: "edited"; title?: string; description?: string; priority?: TaskPriority }
  | { kind: "commented"; text: string }
  | { kind: "merged"; repo: string; sha: string }
  | { kind: "unmerged"; repo: string; sha: string };
export type TaskEvent = { key: TaskKey; rev: number; at: number; actor: TaskActor; change: TaskChange };

export type NewTask = { title: string; description?: string; assignee?: string | null; priority?: TaskPriority; status?: TaskStatus };
export type TaskAction =
  | { action: "move"; to: TaskStatus; reason?: string; notLive?: string; ifRev?: number }
  | { action: "assign"; to: string | null; ifRev?: number }
  | { action: "edit"; title?: string; description?: string; priority?: TaskPriority; ifRev?: number }
  | { action: "comment"; text: string }
  | { action: "merged"; sha: string; repo?: string }
  | { action: "unmerged"; sha: string; repo?: string };

export type BoardProblem =
  | "not_allowed"       // a worker tried what only the manager or the principal may (B2, B3)
  | "not_yours"         // a worker moved a task that isn't assigned to it (B3)
  | "bad_transition"    // not an edge of the graph for this actor (B4)
  | "needs_assignee"    // nobody works on an unassigned task (B4)
  | "reason_needed"     // blocked says why (B4); the manager's done names its evidence (B9)
  | "one_doing"         // the assignee already has a task in progress (B5); `other` names it
  | "changed"           // the task moved since the rev the change named (B6)
  | "same"              // the change changes nothing
  | "not_live"          // done waits for the task's merges to be live on every node (B11)
  | "bad_sha" | "bad_repo"  // a merge record's commit or repository isn't one (B11)
  | "no_merge"          // the merge named to clear is not on the task (B11)
  | "too_many"          // the task already holds MAX_MERGES merge records (B11)
  | "no_commit"         // a lane named a commit the hub's checkout does not hold (B11; judged by the hub, which has the checkout)
  | "empty" | "too_long" | "bad_name" | "bad_text";
// `other`: the task in the way (one_doing); `from`: where the task is (bad_transition), so a refusal can say so;
// `detail`: the not_live label, so a refusal can say what the board sees (B11).
export type BoardRefusal = { problem: BoardProblem; other?: TaskKey; from?: TaskStatus; detail?: string };

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 4000;
export const COMMENT_MAX = 4000;
export const REASON_MAX = 300;
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Done tasks stay on the board this long, then only in the record.
export const DONE_SHOWN_MS = 7 * 24 * 3_600_000;

const refuse = (problem: BoardProblem, other?: TaskKey, from?: TaskStatus, detail?: string): Result<never, BoardRefusal> =>
  err({ problem, ...(other ? { other } : {}), ...(from ? { from } : {}), ...(detail !== undefined ? { detail } : {}) });

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

// B2: the manager, the principal and the console run the board; a worker only works its tasks and files proposals; the
// board itself only follows runs (B10).
export const runsTheBoard = (a: TaskActor) => a.kind === "principal" || a.kind === "manager" || a.kind === "console";
// The lane an actor is, for B3 and for "my tasks": the manager is a lane too.
export const laneOf = (a: TaskActor) => (a.kind === "manager" || a.kind === "worker" ? a.name : null);

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
// B10: the board's own moves, the edges D1 to D4 follow; never to Done (D5).
const BOARD_MOVES: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: [],
  todo: ["doing"],
  doing: ["review", "blocked", "todo"],
  blocked: ["doing"],
  review: ["doing"],
  done: [],
};
export const mayMove = (a: TaskActor, from: TaskStatus, to: TaskStatus) =>
  from !== to && (a.kind === "board" ? BOARD_MOVES[from].includes(to) : runsTheBoard(a) || WORKER_MOVES[from].includes(to));

// B5: the task a lane has in progress now, if any.
export const workingOn = (board: readonly Task[], laneName: string): Task | null =>
  board.find(t => t.status === "doing" && t.assignee === laneName) ?? null;

// B11: the repository whose merges the board follows onto the nodes, a task's merge record, and liveness: a merge is
// live when it is an ancestor of (or equal to) every enrolled node's build. Unknown is never live: nothing says it is.
export const MORNDO_REPO = "morndo/morndo";
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const MERGE_SHA = /^[0-9a-f]{7,40}$/;
export const PRINCIPAL_NOT_LIVE = "accepted by the principal";
// A task holds this many merge records at most: each one is a git check per node, and a lane can record any sha it likes.
export const MAX_MERGES = 5;
export const isMorndoRepo = (repo: string) => repo.toLowerCase() === MORNDO_REPO;

// One recorded merge of a task's PR. `by`: the name of who recorded it ("principal", "console", or the manager's/lane's
// name). `override`: set when the task was accepted as done while this merge was not live: the reason given.
export type MergeRecord = { repo: string; sha: string; at: number; by: string; override: string | null };
// What a node reports: its build's commit (40 hex) or null (never reported / agent too old).
export type NodeBuild = { node: string; commit: string | null };
export type AncestryAnswer = "ancestor" | "not_ancestor" | "unknown";
// A node that keeps a merge from being live: `on` is its build's commit when it is behind (not an ancestor), null when unknown.
export type Blocker = { node: string; on: string | null };
export type Liveness = { live: true } | { live: false; blockers: Blocker[] };

// The merge ancestor-or-equal of every node's build is live. No node listed => not live (nothing says it is). A node
// with a null commit, or whose answer is "unknown" => a blocker with on null; "not_ancestor" => a blocker with the node's commit.
export function livenessOf(sha: string, builds: readonly NodeBuild[], ancestry: (merge: string, build: string) => AncestryAnswer): Liveness {
  if (builds.length === 0) return { live: false, blockers: [] };
  const blockers: Blocker[] = [];
  for (const b of builds) {
    if (b.commit === null) { blockers.push({ node: b.node, on: null }); continue; }
    const answer = ancestry(sha, b.commit);
    if (answer === "ancestor") continue;
    blockers.push({ node: b.node, on: answer === "not_ancestor" ? b.commit : null });
  }
  return blockers.length === 0 ? { live: true } : { live: false, blockers };
}

// The one-line label. Live => "merged, live". Not live => "merged, not live: pc on abc1234, srv01 unknown" (blockers in
// input order, `on` shown as its first 7 chars; with no blockers and no nodes: "merged, not live: no node reports a
// build"). For several merges the union per node: a node blocks if it blocks any merge, the first blocker seen for a node wins.
export function mergeLabel(lives: readonly Liveness[]): string {
  const blockers = new Map<string, Blocker>();
  let live = true;
  for (const l of lives) {
    if (l.live) continue;
    live = false;
    for (const b of l.blockers) if (!blockers.has(b.node)) blockers.set(b.node, b);
  }
  if (live) return "merged, live";
  if (blockers.size === 0) return "merged, not live: no node reports a build";
  return `merged, not live: ${[...blockers.values()].map(b => `${b.node} ${b.on === null ? "unknown" : `on ${b.on.slice(0, 7)}`}`).join(", ")}`;
}

// What the board shows of a task's merges. `live`: null when none of the task's merges is in morndo/morndo (then
// `label` is `merged in <repo>` of the first non-morndo merge); otherwise true only when every morndo/morndo merge is live.
export type MergedView = { key: TaskKey; merges: MergeRecord[]; live: boolean | null; label: string };
export function mergedView(key: TaskKey, merges: readonly MergeRecord[], liveness: (sha: string) => Liveness): MergedView {
  const morndo = merges.filter(m => isMorndoRepo(m.repo));
  if (morndo.length === 0) return { key, merges: [...merges], live: null, label: merges.length > 0 ? `merged in ${merges[0]?.repo}` : "" };
  const lives = morndo.map(m => liveness(m.sha));
  return { key, merges: [...merges], live: lives.every(l => l.live), label: mergeLabel(lives) };
}

// What applyAction judges a move to done against (B11): the task's recorded merges, and liveness per sha. Absent: done
// is not held for any merge (a board without the fleet knows none).
export type DoneGate = { merges: readonly MergeRecord[]; liveness: (sha: string) => Liveness };

// `board`: the tasks in progress now, for B5 when a task is filed straight into progress.
export function createTask(input: NewTask, actor: BoardActor | { kind: "console" }, n: number, now: number, board: readonly Task[] = []): Result<{ task: Task; event: TaskEvent }, BoardRefusal> {
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
    createdAt: now, updatedAt: now, stateChangedAt: now, createdBy: actor, rev: 1, doneAt: null, comments: 0,
  };
  return ok({ task, event: { key, rev: 1, at: now, actor, change: { kind: "created", status, assignee } } });
}

// One change to one task, by one actor, judged against the board as it is (B5 needs the assignee's other tasks; B11
// needs the task's merges and their liveness for a move to done).
export function applyAction(task: Task, action: TaskAction, actor: TaskActor, now: number, board: readonly Task[], gate?: DoneGate): Result<{ task: Task; event: TaskEvent }, BoardRefusal> {
  if ("ifRev" in action && action.ifRev !== undefined && action.ifRev !== task.rev) return refuse("changed");
  const mine = laneOf(actor) !== null && task.assignee === laneOf(actor);
  const next = (t: Task, change: TaskChange, state = true): Result<{ task: Task; event: TaskEvent }, BoardRefusal> => {
    const rev = task.rev + 1;
    return ok({ task: { ...t, rev, updatedAt: now, stateChangedAt: state ? now : task.stateChangedAt }, event: { key: task.key, rev, at: now, actor, change } });
  };
  switch (action.action) {
    case "move": {
      // B10: the board moves only its assignee's task, the one whose Run it read.
      if (actor.kind === "board" && task.assignee !== actor.lane) return refuse("not_yours");
      if (actor.kind !== "board" && !runsTheBoard(actor) && !mine) return refuse("not_yours");
      if (action.to === task.status) return refuse("same");
      if (!mayMove(actor, task.status, action.to)) return refuse("bad_transition", undefined, task.status);
      if (action.to === "doing" && !task.assignee) return refuse("needs_assignee");
      // B4: blocked says why. B9: the manager's done says what was checked; the principal's may say, and need not.
      // B10: the board's own move keeps the reason it read on every edge (D1: the status line; D3: GONE_REASON).
      let reason: string | null = null;
      const given = (action.reason ?? "").trim() !== "";
      if (action.to === "blocked" || (action.to === "done" && (actor.kind === "manager" || given)) || (actor.kind === "board" && given)) {
        const r = line(action.reason ?? "", REASON_MAX);
        if (!r.ok) return r.error.problem === "empty" ? refuse("reason_needed") : r;
        reason = r.value;
      }
      if (action.to === "doing" && task.assignee) {
        const other = workingOn(board.filter(t => t.key !== task.key), task.assignee);
        if (other) return refuse("one_doing", other.key);
      }
      // B11: done waits for the task's morndo merges to be live on every node. The manager may accept one that is not,
      // saying why; that reason is the recorded override. Without a gate, or with nothing pending, notLive is ignored.
      let notLive: string | undefined;
      if (action.to === "done" && gate) {
        const pending = gate.merges.filter(m => isMorndoRepo(m.repo) && !gate.liveness(m.sha).live);
        if (pending.length > 0) {
          if ((action.notLive ?? "").trim() === "") {
            // The principal's own click (the app's "Accept as done") is the override: it has no field for a reason, and the
            // owner is never locked out of his board. It is recorded all the same.
            if (actor.kind !== "principal") return refuse("not_live", undefined, undefined, mergeLabel(pending.map(m => gate.liveness(m.sha))));
            notLive = PRINCIPAL_NOT_LIVE;
          } else {
            const why = line(action.notLive ?? "", REASON_MAX);
            if (!why.ok) return why;
            notLive = why.value;
          }
        }
      }
      const moved: Task = { ...task, status: action.to, blockedReason: action.to === "blocked" ? reason : null, doneAt: action.to === "done" ? now : null };
      return next(moved, { kind: "moved", from: task.status, to: action.to, reason, ...(notLive === undefined ? {} : { notLive }) });
    }
    case "assign": {
      if (!runsTheBoard(actor)) return refuse("not_allowed");                // D5: never the board
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
      return next(t, change, change.description !== undefined);
    }
    case "comment": {
      const r = text(action.text, COMMENT_MAX);
      if (!r.ok) return r;
      return next({ ...task, comments: task.comments + 1 }, { kind: "commented", text: r.value }, false);
    }
    case "merged": {
      // B11: a merge record is not a change of state. Who may record one is who may comment on the work: the board's
      // hands, or the lane the task is assigned to (never the board itself, D5).
      if (actor.kind === "board") return refuse("not_allowed");
      if (!runsTheBoard(actor) && !mine) return refuse("not_yours");
      const sha = action.sha.trim().toLowerCase();
      if (!MERGE_SHA.test(sha)) return refuse("bad_sha");
      const repo = (action.repo ?? MORNDO_REPO).trim();
      if (!REPO_NAME.test(repo)) return refuse("bad_repo");
      if (gate?.merges.some(m => m.repo.toLowerCase() === repo.toLowerCase() && m.sha === sha)) return refuse("same");
      if ((gate?.merges.length ?? 0) >= MAX_MERGES) return refuse("too_many");
      return next(task, { kind: "merged", repo, sha }, false);
    }
    case "unmerged": {
      // B11: clearing a merge record is the board's hands' alone (a lane may record one, never erase it): the record is
      // what done was held for, so who may drop it is who runs the board. Replacing a wrong sha is an unmerged of it
      // then a merged of the right one.
      if (!runsTheBoard(actor)) return refuse("not_allowed");
      const sha = action.sha.trim().toLowerCase();
      if (!MERGE_SHA.test(sha)) return refuse("bad_sha");
      const repo = (action.repo ?? MORNDO_REPO).trim();
      if (!REPO_NAME.test(repo)) return refuse("bad_repo");
      if (!gate?.merges.some(m => m.repo.toLowerCase() === repo.toLowerCase() && m.sha === sha)) return refuse("no_merge");
      return next(task, { kind: "unmerged", repo, sha }, false);
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
  actor: { kind: TaskActor["kind"]; name: string | null; endpointId: EndpointId | null; token: string | null; rule?: BoardRule };
};
export const boardChanged = (e: TaskEvent): BoardChanged => ({
  type: "BoardChanged", key: e.key, change: e.change.kind, at: e.at,
  actor: e.actor.kind === "principal" ? { kind: "principal", name: null, endpointId: e.actor.endpointId, token: null }
    : e.actor.kind === "console" ? { kind: "console", name: null, endpointId: null, token: null }
    : e.actor.kind === "board" ? { kind: "board", name: e.actor.lane, endpointId: null, token: null, rule: e.actor.rule }
    : { kind: e.actor.kind, name: e.actor.name, endpointId: null, token: e.actor.token },
});

// B12: the task a lane's status line names ("STATUS: DONE T-285 …"), as the hub read it from the Run's line (the protocol's
// parser; the domain imports no wire package). Only a turn's end, or a wait, is the line's word; a working Run's line is the last turn's.
export type NamedStatus = { key: TaskKey; status: "done" | "blocked" | "needs_decision" | "waiting" };

// B10, D1 to D6: the move the board makes by itself for `task`, following its assignee's Run, or null. D6: a Run whose
// phase began at or before the task's last change of state (status, assignee, description; a comment is not one) moves
// nothing, so the board never undoes what a person or a lane did after it. D5: never to Done, never an assignment (the board's actor can't: runsTheBoard is false for it).
export const GONE_REASON = "its lane stopped without DONE";
export const BACKGROUND_REASON = "background work still running";
export function derivedMove(task: Task, run: Run, board: readonly Task[], named: NamedStatus | null = null): { to: TaskStatus; reason: string | null; rule: BoardRule } | null {
  if (task.assignee === null || task.assignee !== run.lane || run.since <= task.stateChangedAt) return null;
  // B12: the key counts only when the line is the turn's word: a turn's end, or a wait.
  const keyed = run.phase === "ended" || run.phase === "waiting" ? named : null;
  // The reason is the run's status line as one clean line: a control character in it (a lane's odd output) is a space,
  // never a refused move (line(), bad_text).
  const said = (run.line ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX) || null;
  if (task.status === "doing") {
    // B12: a keyed line is about the task it names only (D1, D2); a gone run carries none (D3).
    if (keyed !== null && keyed.key !== task.key) return null;
    // D1: DONE is the turn's word even while its background work runs (the Run keeps the outcome; phase is waiting).
    if (run.phase === "ended" && run.outcome === "done") return { to: "review", reason: said, rule: "D1" };
    if (run.phase === "waiting" && run.wait?.on === "background" && run.outcome === "done") return { to: "review", reason: BACKGROUND_REASON, rule: "D1" };
    // The same for a wake-up scheduled or a job running: the turn ended DONE, and its line is the reason (T-398).
    if (run.phase === "waiting" && (run.wait?.on === "wakeup" || run.wait?.on === "job") && run.outcome === "done") return { to: "review", reason: said, rule: "D1" };
    if (run.phase === "ended" && (run.outcome === "blocked" || run.outcome === "needs_decision")) return { to: "blocked", reason: said ?? run.outcome, rule: "D2" };
    if (run.phase === "gone") return { to: "todo", reason: GONE_REASON, rule: "D3" };
    return null;
  }
  if (task.status === "todo" || task.status === "blocked" || task.status === "review") {
    if (run.phase !== "working" && run.phase !== "waiting") return null;
    const mine = board.filter(t => t.assignee === run.lane);
    if (keyed !== null) {
      // B12: a keyed WAITING that names this task takes it up again (D1). Any other keyed line naming a task not in
      // progress moves nothing, and no other task moves while the line is current.
      if (keyed.key !== task.key || keyed.status !== "waiting" || mine.some(t => t.status === "doing")) return null;
      return { to: "doing", reason: said, rule: "D1" };
    }
    // D4: the lane's one task to take up, when it has exactly one to do. B12: only to do → in progress; a task in review or
    // blocked leaves its column by an explicit move or a keyed WAITING that names it (D1). Two to dos, or a task already
    // in progress (B5), and the board moves nothing.
    if (mine.some(t => t.status === "doing")) return null;
    const todos = mine.filter(t => t.status === "todo");
    return todos.length === 1 && todos[0]?.key === task.key ? { to: "doing", reason: null, rule: "D4" } : null;
  }
  return null;
}

// B12: a keyed line naming a task that is not one of the lane's open tasks moves nothing (derivedMove); the board leaves one
// line about it, so it is never silent: in the history of the lane's own task in progress, else of the named task. D6: a run
// that began at or before that task in progress last changed state says nothing new (a stale ended run adds no note).
export function keyMismatch(run: Run, named: NamedStatus | null, board: readonly Task[]): { key: TaskKey; text: string } | null {
  if (named === null || (run.phase !== "ended" && run.phase !== "waiting")) return null;
  const mine = board.filter(t => t.assignee === run.lane);
  if (mine.some(t => t.key === named.key)) return null;
  const doing = mine.find(t => t.status === "doing");
  if (doing && run.since <= doing.stateChangedAt) return null;
  return { key: (doing ?? { key: named.key }).key, text: `${run.lane}'s status line at ${new Date(run.since).toISOString()} names ${named.key}, which is not its open task; the board moved nothing` };
}

// B10, D3 for a lane the fleet doesn't list at all (it ended before runs were kept, or its Run dropped): there is no Run to
// read, so its task in progress goes back to to do, once (the move leaves "doing", so the same reading moves nothing more).
// D5: never to Done, never an assignment.
export function unregisteredMove(task: Task, registered: ReadonlySet<string>): { to: TaskStatus; reason: string | null; rule: BoardRule } | null {
  if (task.status !== "doing" || task.assignee === null || registered.has(task.assignee)) return null;
  return { to: "todo", reason: GONE_REASON, rule: "D3" };
}
// A task to do whose assignee is not a registered lane is an orphan: it waits for a lane that will not come. It is only
// flagged, never moved or reassigned by the board (D5); the manager reassigns it.
export const isOrphan = (task: Task, registered: ReadonlySet<string>): boolean =>
  task.status === "todo" && task.assignee !== null && !registered.has(task.assignee);
