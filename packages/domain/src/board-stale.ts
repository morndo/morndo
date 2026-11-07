// Board context, B19 and B20 (ADR-0040): a board that cannot go stale silently. A block that is a decision — a lane
// asking its manager which way to go, or the manager's own checkpoint — carries a deadline 24 h on (board.ts), and
// what passed it without an answer is the decision inbox's, listed for the manager with how late it is. An answer is
// a comment after the ask by the manager, the principal or the console (`isDecisionAnswered`): the hub's sweep and
// the CLI read that one rule, and for a decision from before the rule the ask is its last move into blocked from
// another status, or its creation when it never moved there. What nobody changed for 48 h, in blocked or review,
// with nothing the board itself watches (an open wait, a merge not live yet, a decision still waiting), is the stale
// sweep's; a decision that was answered is swept like any block that sits. Both are pure: the hub reads the tasks
// and says who it watches, these say what waits, and the messages are plain text, one line per task, cut where a
// line stops being readable.
import { STALE_BLOCK_MS, type JudgedWait } from "./board-waits.ts";
import { cutText } from "./shared.ts";
import type { MergedView, Task, TaskEvent, TaskKey } from "./board.ts";

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

// T-863: the one rule for "answered", shared by the hub's sweep and the CLI's inbox and stale views. True when some
// event after `since` is a comment by the manager, the principal or the console. The lane's own comment, a comment at
// or before the ask, and any change that is not a comment do not answer it.
export function isAnswered(events: readonly TaskEvent[], since: number): boolean {
  return events.some(e => e.at > since && e.change.kind === "commented" && (e.actor.kind === "manager" || e.actor.kind === "principal" || e.actor.kind === "console"));
}

// T-863: whether this decision has been answered, the one rule the hub's sweep and the CLI both use. A task with a
// deadline is answered by a comment after `since` (when it was asked). Any other task, a decision from before the
// rule, is answered by a comment after its last move into blocked from another status. A restatement that stays
// blocked (blocked to blocked) does not move the cutoff. With no such move the cutoff is the task's creation, never
// `since` and never the hub's start. The cutoff is the same on both sides and does not move on a reassign or a
// description edit.
export function isDecisionAnswered(task: Task, events: readonly TaskEvent[], since: number): boolean {
  if (task.decisionDue !== undefined) return isAnswered(events, since);
  let cutoff = task.createdAt;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event !== undefined && event.change.kind === "moved" && event.change.to === "blocked" && event.change.from !== "blocked") {
      cutoff = event.at;
      break;
    }
  }
  return isAnswered(events, cutoff);
}

// T-863: one ask of the rule per task and ask time. The sweep hands the same predicate to the watched set and to the
// stale list, so a decision is judged once in a pass and both places hear the same answer.
export function answeredOnce(answered: (key: TaskKey, since: number) => boolean): (key: TaskKey, since: number) => boolean {
  const seen = new Map<string, boolean>();
  return (key, since) => {
    const id = `${key}@${since}`;
    const hit = seen.get(id);
    if (hit !== undefined) return hit;
    const answer = answered(key, since);
    seen.set(id, answer);
    return answer;
  };
}

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

// B20: the keys the board itself watches, so the sweep leaves them out: a blocked task whose waits the hub has read
// something of (an open wait may end any moment, and D7 moves the task), a review task whose merge is not live on
// every node yet, and every decision the inbox has (B19), a legacy one included — an answered one excluded, for the
// sweep has it again (the inbox let it go). `view` is what the board holds: the shown tasks, the wait watch's readings,
// the merged views. The hub's sweep and the CLI's stale view both call this.
export function watchedKeys(view: { tasks: readonly Task[]; waits?: readonly { key: string; readings: JudgedWait[] }[]; merged: readonly MergedView[] }, now: number, legacySince: number, answered?: (key: TaskKey, since: number) => boolean): Set<string> {
  const keys = new Set<string>();
  for (const w of view.waits ?? []) if (w.readings.some(r => r.state !== "unknown")) keys.add(w.key);
  const status = new Map(view.tasks.map(t => [t.key as string, t.status]));
  for (const m of view.merged) if (m.live === false && status.get(m.key) === "review") keys.add(m.key);
  for (const i of inboxItems(view.tasks, now, { legacySince, ...(answered !== undefined ? { answered } : {}) })) keys.add(i.key);
  return keys;
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

// B20: a task has sat long enough to be stale. The sweep, the CLI and `staleTasks` share this one test.
export function isIdleForStale(task: Task, now: number): boolean {
  return now - task.updatedAt >= STALE_BLOCK_MS;
}

// B20: the tasks in blocked or review that nobody changed for STALE_BLOCK_MS, the longest idle first, leaving out what
// the hub says it watches (`watched`: an open wait, a merge not live yet) and every decision still waiting on an
// answer (the inbox has those, B19). A task with a decisionDue is one of those unless `answered(key, decisionDue -
// DECISION_DUE_MS)` is true: the inbox has let it go, and it is swept like any block that sits. A task that is not
// idle is skipped first, and a key the watched set already holds is skipped before `answered` is asked. The idle time
// counts from the task's last event of any kind (updatedAt), not its last move: a comment, a brief or a merge record
// is a change somebody made.
export function staleTasks(tasks: readonly Task[], now: number, o: { watched?: ReadonlySet<string>; answered?: (key: TaskKey, since: number) => boolean } = {}): StaleItem[] {
  const items: StaleItem[] = [];
  for (const t of tasks) {
    if (t.status !== "blocked" && t.status !== "review") continue;
    if (!isIdleForStale(t, now)) continue;
    if (o.watched?.has(t.key)) continue;
    if (t.decisionDue !== undefined && o.answered?.(t.key, t.decisionDue - DECISION_DUE_MS) !== true) continue;
    items.push({ key: t.key, status: t.status, title: t.title, assignee: t.assignee, idleMs: now - t.updatedAt });
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
