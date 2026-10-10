// How the board is shown (ADR-0015): the columns in work order, the words for each status and refusal, and what the
// app may do from where. The rules live in the domain and the hub; this presents their results and asks the hub.
import { workingOn, type Task, type TaskEvent, type TaskPriority, type TaskStatus } from "@morndo/domain";
import { BoardTaskSchema, parseBody } from "@morndo/protocol";

export type { Task, TaskEvent, TaskPriority, TaskStatus };
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

const who = (e: TaskEvent) => (e.actor.kind === "principal" ? "You" : e.actor.name);
// One line per event, for the task's history.
export function eventLine(e: TaskEvent): { who: string; text: string; comment: string | null } {
  const c = e.change;
  const w = who(e);
  switch (c.kind) {
    case "created": return { who: w, text: `filed it${c.assignee ? ` for ${c.assignee}` : ""} in ${STATUS_WORDS[c.status]}`, comment: null };
    case "moved": return { who: w, text: `moved it from ${STATUS_WORDS[c.from]} to ${STATUS_WORDS[c.to]}${c.reason ? `: ${c.reason}` : ""}`, comment: null };
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
