// Board context, B19 and B20 (ADR-0040): a board that cannot go stale silently. A block that is a decision — a lane
// asking its manager which way to go, or the manager's own checkpoint — carries a deadline 24 h on (board.ts), and
// what passed it without an answer is the decision inbox's, listed for the manager with how late it is. What nobody
// changed for 48 h, in blocked or review, with nothing the board itself watches (an open wait, a merge not live yet,
// a decision), is the stale sweep's. Both are pure: the hub reads the tasks and says who it watches, these say what
// waits, and the messages are plain text, one line per task, cut where a line stops being readable.
import { STALE_BLOCK_MS } from "./board-waits.ts";
import { cutText } from "./shared.ts";
import type { Task, TaskKey } from "./board.ts";

// B19: a decision is due an answer this long after it was asked; past it the manager has let it sit a day.
export const DECISION_DUE_MS = 24 * 3_600_000;
// B20: the stale list the manager gets holds at most this many tasks; the rest are counted, not listed.
export const STALE_LIST_MAX = 20;
// The hub's own cadence (ADR-0040): the inbox tells the manager at most this often while decisions wait, and the sweep
// repeats an unchanged list at most this often.
export const INBOX_EVERY_MS = 3_600_000;
export const STALE_REPEAT_MS = 12 * 3_600_000;

// B19: one decision the manager owes an answer to. `openedAt`: when the lane asked (the block that is the decision);
// `dueAt`: DECISION_DUE_MS later; `line`: the block's reason; `legacy`: a block from before the rule, read by its words.
export type InboxItem = { key: TaskKey; title: string; assignee: string | null; line: string; openedAt: number; dueAt: number; overdue: boolean; legacy: boolean };
// B20: one task nobody changed for STALE_BLOCK_MS that the board watches nothing on; `idleMs` counts from the task's
// last event of any kind, so a comment or a merge record keeps it alive.
export type StaleItem = { key: TaskKey; status: "blocked" | "review"; title: string; assignee: string | null; idleMs: number };

const HOUR = 3_600_000;
// A line of a message holds at most this much of a reason or a title; the rest is one ellipsis.
const LINE_MAX = 160;
// B19: a block from before decisionDue existed, whose reason says what it is by its words.
const LEGACY_WORDS = /needs decision|checkpoint/i;
const oneLine = (t: string) => (t.length > LINE_MAX ? `${cutText(t, LINE_MAX)}…` : t);
const hours = (ms: number) => Math.round(ms / HOUR);
const numberOf = (key: TaskKey) => Number(key.slice(2));
const byNumber = (a: { key: TaskKey }, b: { key: TaskKey }) => numberOf(a.key) - numberOf(b.key);

// B19: the decisions the manager owes an answer to, most overdue first. A blocked task with a decisionDue is one, asked
// when that deadline's 24 h began. A blocked task from before the rule whose reason says it needs a decision or is a
// checkpoint is one from `legacySince` (the hub's start: its clock begins there, once). `answered(key, since)`: an
// answer after it was asked closes it. Only a blocked task carries one: leaving blocked drops the deadline (board.ts).
export function inboxItems(tasks: readonly Task[], now: number, o: { legacySince: number; answered?: (key: TaskKey, since: number) => boolean }): InboxItem[] {
  const items: InboxItem[] = [];
  for (const t of tasks) {
    if (t.status !== "blocked") continue;
    const openedAt = t.decisionDue !== undefined ? t.decisionDue - DECISION_DUE_MS : LEGACY_WORDS.test(t.blockedReason ?? "") ? o.legacySince : null;
    if (openedAt === null) continue;
    if (o.answered !== undefined && o.answered(t.key, openedAt)) continue;
    const dueAt = openedAt + DECISION_DUE_MS;
    items.push({ key: t.key, title: t.title, assignee: t.assignee, line: t.blockedReason ?? "", openedAt, dueAt, overdue: now >= dueAt, legacy: t.decisionDue === undefined });
  }
  return items.sort((a, b) => a.dueAt - b.dueAt || byNumber(a, b));
}

// B19: what the manager gets: how many wait, how many are past their deadline, and one line per decision, the most
// overdue first. "" when nothing waits: the hub sends nothing then.
export function inboxMessage(items: readonly InboxItem[], now: number): string {
  if (items.length === 0) return "";
  const overdue = items.filter(i => i.overdue).length;
  const line = (i: InboxItem) => `- ${i.key}${i.assignee !== null ? ` (${i.assignee})` : ""} asked ${hours(now - i.openedAt)} h ago, ${i.overdue ? `OVERDUE ${hours(now - i.dueAt)} h` : `due in ${hours(i.dueAt - now)} h`}: ${oneLine(i.line)}`;
  return [
    `[board-inbox] ${items.length === 1 ? "1 decision waits" : `${items.length} decisions wait`} for the manager (${overdue} overdue)`,
    ...items.map(line),
  ].join("\n");
}

// B20: the tasks in blocked or review that nobody changed for STALE_BLOCK_MS, the longest idle first, leaving out what
// the hub says it watches (`watched`: an open wait, a merge not live yet) and every decision (the inbox has those, B19).
// The idle time counts from the task's last event of any kind (updatedAt), not its last move: a comment, a brief or a
// merge record is a change somebody made.
export function staleTasks(tasks: readonly Task[], now: number, o: { watched?: ReadonlySet<string> } = {}): StaleItem[] {
  const items: StaleItem[] = [];
  for (const t of tasks) {
    if (t.status !== "blocked" && t.status !== "review") continue;
    if (t.decisionDue !== undefined) continue;
    if (o.watched?.has(t.key)) continue;
    const idleMs = now - t.updatedAt;
    if (idleMs < STALE_BLOCK_MS) continue;
    items.push({ key: t.key, status: t.status, title: t.title, assignee: t.assignee, idleMs });
  }
  return items.sort((a, b) => b.idleMs - a.idleMs || byNumber(a, b));
}

// B20: what the manager gets: the header says how many, one line per task its status, its idle time, its lane and its
// title; STALE_LIST_MAX lines at most, the rest counted. "" when nothing is stale.
export function staleMessage(items: readonly StaleItem[]): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, STALE_LIST_MAX);
  const rest = items.length - shown.length;
  return [
    `[board-stale] ${items.length === 1 ? "1 task idle" : `${items.length} tasks idle`} 48 h or more with no wait the board watches:`,
    ...shown.map(i => `- ${i.key} ${i.status} ${hours(i.idleMs)} h${i.assignee !== null ? ` (${i.assignee})` : ""}: ${oneLine(i.title)}`),
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ].join("\n");
}
