// How decisions are shown (ADR-0006 addendum "Decisions"): urgency, due labels, groups, and what each refusal means
// in plain words. The rules themselves live in the domain and the hub; this only presents their results.
import type { DecisionItem, LedgerState } from "@morndo/protocol";

export type { DecisionItem, LedgerState };
export type Board = { items: DecisionItem[]; ledger: LedgerState };

export type Urgency = "blocking" | "overdue" | "soon" | "normal" | "answered" | "done";

const HOUR = 3_600_000;

export function urgency(d: DecisionItem, now: number): Urgency {
  if (d.status === "settled" || d.status === "expired") return "done";
  if (d.status === "answered") return "answered";
  if (d.blocking) return "blocking";
  if (d.deadline !== null && d.deadline < now) return "overdue";
  if (d.deadline !== null && d.deadline - now < 24 * HOUR) return "soon";
  return "normal";
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const hm = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// "Due today", "Due tomorrow 3:00 PM", "Due Fri 3 Oct", "Overdue since yesterday". A deadline at 23:59 is a whole day.
export function dueLabel(deadline: number, now: number): string {
  const d = new Date(deadline), n = new Date(now);
  const wholeDay = d.getHours() === 23 && d.getMinutes() === 59;
  const at = wholeDay ? "" : ` ${hm(d)}`;
  const tomorrow = new Date(n); tomorrow.setDate(n.getDate() + 1);
  const yesterday = new Date(n); yesterday.setDate(n.getDate() - 1);
  if (deadline < now) {
    if (sameDay(d, n)) return wholeDay ? "Due today" : `Overdue since ${hm(d)}`;
    if (sameDay(d, yesterday)) return "Overdue since yesterday";
    return `Overdue since ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
  }
  if (sameDay(d, n)) return `Due today${at}`;
  if (sameDay(d, tomorrow)) return `Due tomorrow${at}`;
  return `Due ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}${at}`;
}

export function ago(t: number, now: number): string {
  const m = Math.round((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const days = Math.floor(m / 1440);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// ADR-0010: a Decision for the manager waits in the manager's inbox until it reached the manager. Why it waits, in
// words (the inbox's reasons; one this app doesn't know says nothing more than "queued").
const INBOX_WAITS: Record<string, string> = {
  menu: "a menu is open in the manager's terminal; it goes in once that's answered",
  foreign_text: "the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared",
  no_manager: "the manager isn't running right now; it goes in once it's back",
  busy: "the manager is busy; it takes it when it gets to it",
  lock: "another message is being typed into the manager right now",
  unseen: "the manager's screen can't be read right now",
  unconfirmed: "it was typed, but the manager hasn't shown it yet; the box owner has been told",
  lost_in_queue: "it fell out of the manager's own queue; the box owner has been told",
};
export type DeliveryLine = { state: "queued"; why: string | null } | { state: "delivered"; at: number | null };
export function deliveryLine(d: DecisionItem): DeliveryLine | null {
  const del = d.decision?.delivery;
  if (!del) return null;
  if (del.state === "delivered") return { state: "delivered", at: del.at };
  const reason = d.inbox?.reason ?? null;
  return { state: "queued", why: reason ? INBOX_WAITS[reason] ?? null : null };
}

export const REFUSALS: Record<string, string> = {
  unknown: "This decision isn't on the hub's list anymore.",
  // The hub's 404 "unknown" for an answer, as the app names it (catchup/answer.ts hubRefusal): never the app's own
  // "unknown" (no answer came). Nothing was typed.
  gone: "This decision isn't on the hub's list anymore.",
  already_answered: "This was already answered.",
  not_delivered: "That answer did not reach the manager. Answer again.",
  settled: "The manager has already settled this.",
  expired: "This question expired: it was asked more than a day ago.",
  not_filed_yet: "The manager is still filing this decision. Try again in a minute.",
  cant_check: "The manager's list can't be read right now, so answers are paused. Try again in a moment.",
  on_screen: "Answer this on the agent's screen.",
  not_a_choice: "This one is answered in words.",
  bad_option: "That option isn't on this decision anymore.",
  empty: "Write an answer first.",
  in_progress: "Your answer is already on its way.",
  too_long: "That answer is too long.",
  changed: "The question changed while your answer waited: read it again, then answer.",
  menu_open: "The manager has a menu open. Answer it in its Screen tab first, then try again.",
  draft_present: "The manager has unsent text in its input box. Look at its Screen tab, then try again.",
  no_input_box: "The manager isn't showing its input box, so the answer wasn't typed. Look at its Screen tab.",
  not_submitted: "The manager didn't take the answer. Check its Screen tab.",
  no_pane: "The manager isn't running right now.",
  busy: "Another message is being typed into the manager right now. Try again in a few seconds.",
  // A fleet (fleet core §4, §7): the manager's machine doesn't answer, or two windows claim its name. Nothing was typed.
  node_offline: "The manager's machine isn't answering right now, so the answer wasn't typed. Try again once it's back.",
  lane_conflict: "Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.",
  // The hub can't say whether it was typed: the manager's machine may have typed it before its answer was lost, or the
  // hub stopped while typing it. It answers 409 "uncertain" (fleet core §3.1, §7). Check again sends the same request id;
  // a fleet hub asks that machine, which may settle it, but it stays uncertain when nobody can say (the machine's store is
  // unknown, changed or behind), and always on the legacy hub, which has no machine to ask. So the words promise only
  // the asking (the residual round).
  uncertain: "May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the manager's screen before answering again.",
  // The node or the fleet refused it, saying nothing ran (fleet core §5.3; the fix wave's release of the row on any
  // refusal with executed "no"). Nothing was typed.
  denied: "The manager's machine doesn't let Morndo type into it (its node policy), so the answer wasn't typed.",
  bad_args: "The fleet refused the answer as malformed, so it wasn't typed. If the manager's window name has a tab or another control character in it, rename the window, then try again.",
  too_large: "That answer is too large for the manager's machine, so it wasn't typed.",
  unknown_op: "The manager's machine runs a Morndo agent too old to type answers, so the answer wasn't typed. Update Morndo on that machine.",
  internal: "The manager's machine couldn't record the answer before typing it (a full disk?), so it wasn't typed. Try again once it has room.",
  name_taken: "The fleet refused the answer over a lane name taken on another machine, so it wasn't typed. Rename one of the windows, then try again.",
  // Another answer to this decision may have reached the manager and its machine can't say (E8 while an answer is in
  // doubt): this one wasn't typed.
  answer_in_doubt: "An earlier answer to this may have reached the manager, and that can't be checked now, so this one wasn't sent. Look at the manager's screen.",
};

export type Group = { key: string; label: string; items: DecisionItem[]; open: boolean };

export function groups(items: DecisionItem[]): Group[] {
  const call = items.filter(d => d.status === "open" && d.need === "decision");
  const plate = items.filter(d => d.status === "open" && d.need === "time");
  const answered = items.filter(d => d.status === "answered");
  const done = items.filter(d => d.status === "settled" || d.status === "expired").slice(0, 25);   // the newest; the rest are in the list
  return [
    { key: "call", label: "Needs your call", items: call, open: true },
    { key: "plate", label: "On your plate", items: plate, open: true },
    { key: "answered", label: "Answered, the manager is on it", items: answered, open: true },
    { key: "done", label: "Decided", items: done, open: false },
  ].filter(g => g.items.length > 0);
}

// What counts on the badges: open decisions that wait for the principal's call.
export const waitingCount = (items: DecisionItem[]) => items.filter(d => d.status === "open" && d.need === "decision").length;
