// How the board is shown (ADR-0015): the columns in work order, the words for each status and refusal, and what the
// app may do from where. The rules live in the domain and the hub; this presents their results and asks the hub.
import { workingOn, type AuthorKind, type BoardRule, type Run, type Task, type TaskActor, type TaskEvent, type TaskPriority, type TaskStatus } from "@morndo/domain";
import { BoardTaskSchema, RunViewSchema, parseBody } from "@morndo/protocol";
import { saidOf } from "./run-words.ts";

export type { Run, Task, TaskEvent, TaskPriority, TaskStatus };
export { workingOn };                                   // the domain's B5 lookup, one definition

export const COLUMNS: { status: TaskStatus; label: string; hint: string }[] = [
  { status: "backlog", label: "Backlog", hint: "Filed, nobody's yet" },
  { status: "todo", label: "To do", hint: "Handed to a lane" },
  { status: "doing", label: "In progress", hint: "One per lane" },
  { status: "blocked", label: "Blocked", hint: "Needs someone" },
  { status: "review", label: "In review", hint: "The lane says done" },
  { status: "done", label: "Done", hint: "Accepted, this week" },
];
export const STATUS_WORDS: Record<TaskStatus, string> = Object.fromEntries(COLUMNS.map(c => [c.status, c.label])) as Record<TaskStatus, string>;
// Where a task may be filed (the domain's createTask, B2): not Blocked, not Done. The column + buttons and the
// dialog's Column pick offer these and nothing else.
export const FILEABLE: readonly TaskStatus[] = ["backlog", "todo", "doing", "review"];
export const PRIORITY_WORDS: Record<TaskPriority, string> = { high: "High", normal: "Normal", low: "Low" };
// The priority as a picker offers it, when filing and when editing: the word, and where it puts the task.
export const PRIORITY_OPTIONS: { value: TaskPriority; label: string; hint?: string }[] = [
  { value: "high", label: "High", hint: "first in its column" }, { value: "normal", label: "Normal" }, { value: "low", label: "Low", hint: "last in its column" },
];

// Each task of a `board` frame decoded on its own: one this build can't read is dropped, the rest kept.
export function decodeTasks(raw: unknown[]): { tasks: Task[]; dropped: number } {
  const tasks: Task[] = [];
  let dropped = 0;
  for (const x of raw) {
    const t = parseBody(BoardTaskSchema, x);
    if (t) tasks.push(t);
    else dropped++;
  }
  return { tasks, dropped };
}

// The Runs of a `board` frame (ADR-0032, BoardFrameSchema.runs), keyed by lane: each decoded on its own with RunViewSchema,
// and one this build can't read dropped, as a task is. `runs` is null when the frame has none (a hub from before), so the
// board shows no rings and no run counts rather than "0 working now". Two Runs of one lane name (a window of that name on
// two nodes): the one whose lane is there (not gone, not on a node that is offline) wins, else the one whose phase began
// later, so a stopped window elsewhere never hides the one at work.
export function decodeRuns(raw: readonly unknown[] | undefined): { runs: ReadonlyMap<string, Run> | null; dropped: number } {
  if (raw === undefined) return { runs: null, dropped: 0 };
  const runs = new Map<string, Run>();
  let dropped = 0;
  const there = (r: Run) => r.phase !== "gone" && r.phase !== "unknown";
  for (const x of raw) {
    const r = parseBody(RunViewSchema, x);
    if (!r) { dropped++; continue; }
    const had = runs.get(r.lane);
    if (!had || (there(r) !== there(had) ? there(r) : r.since > had.since)) runs.set(r.lane, r);
  }
  return { runs, dropped };
}

export const byStatus = (tasks: readonly Task[]) => {
  const m = new Map<TaskStatus, Task[]>(COLUMNS.map(c => [c.status, []]));
  for (const t of tasks) m.get(t.status)?.push(t);
  return m;
};

export const REFUSALS: Record<string, string> = {
  not_allowed: "Only the manager or you may do that.",
  not_yours: "That task is assigned to someone else.",
  bad_transition: "A task can't move there from where it is.",
  needs_assignee: "Assign it to a lane first: nobody works on an unassigned task.",
  reason_needed: "Say why it is blocked.",
  one_doing: "That lane already has a task in progress. Move that one first.",
  changed: "The task changed meanwhile. It was reloaded; try again.",
  same: "It already is.",
  empty: "Write something first.",
  too_long: "That's too long.",
  bad_name: "A lane name is letters, digits, dots, dashes and underscores.",
  bad_text: "The text holds a character that can't be typed.",
  unknown: "The hub doesn't know this task any more.",
  step_up: "Verify with your passkey first.",
  board_off: "The hub has no board.",
};

// Who made a change, in the record's words: you, a lane or the manager by its name, the control plane's console
// (`lanes start --task`, ADR-0032), or the board itself following a Run (B10).
export const whoOf = (a: TaskActor): string =>
  a.kind === "principal" ? "You" : a.kind === "console" ? "console" : a.kind === "board" ? "board" : a.name;
// Its avatar: the principal's own tile, the manager's, a lane's; the console and the board are no agent, so the system's.
export const avatarOf = (a: TaskActor): AuthorKind =>
  a.kind === "principal" ? "principal" : a.kind === "manager" ? "peer" : a.kind === "worker" ? "agent" : "system";
// A board move in words (B10): what the lane's Run did that made it, by the rule (D1 to D4).
const BOARD_WHY: Record<BoardRule, (lane: string) => string> = {
  D1: l => `when ${l} said DONE`,
  D2: l => `when ${l} said it is blocked or needs a decision`,
  D3: l => `when ${l} stopped`,
  D4: l => `when ${l} started on it`,
};
// The reason D1 and D2 carry is the lane's status line (derivedMove, or the outcome's name when it had none): the record
// keeps what the lane said after the status word, never the word again.
const boardSaid = (rule: BoardRule, reason: string | null) => {
  if ((rule !== "D1" && rule !== "D2") || !reason || reason === "blocked" || reason === "needs_decision") return "";
  return saidOf(reason).rest;
};
// One line per event, for the task's history.
export function eventLine(e: TaskEvent): { who: string; text: string; comment: string | null } {
  const c = e.change;
  const w = whoOf(e.actor);
  switch (c.kind) {
    case "created": return { who: w, text: `filed it${c.assignee ? ` for ${c.assignee}` : ""} in ${STATUS_WORDS[c.status]}`, comment: null };
    case "moved": {
      if (e.actor.kind === "board") {
        const said = boardSaid(e.actor.rule, c.reason);
        return { who: w, text: `moved it to ${STATUS_WORDS[c.to]} ${BOARD_WHY[e.actor.rule](e.actor.lane)}${said ? `: ${said}` : ""}`, comment: null };
      }
      return { who: w, text: `moved it from ${STATUS_WORDS[c.from]} to ${STATUS_WORDS[c.to]}${c.reason ? `: ${c.reason}` : ""}`, comment: null };
    }
    case "assigned": return { who: w, text: c.to ? `assigned it to ${c.to}` : "unassigned it", comment: null };
    case "edited": return { who: w, text: `edited the ${Object.keys(c).filter(k => k !== "kind").join(", ")}`, comment: null };
    case "commented": return { who: w, text: "commented", comment: c.text };
  }
}
export const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return d === 1 ? "yesterday" : `${d} days ago`;
};
