// Horizon, the phone's dashboard (ADR-0009, the design's dashboard A): when is he next needed? Pure: it reads the board
// (Escalation), the roster (Observation) and the decisions he kept for later on this device, and places each item in
// time. Its rules, the design's done criteria 22 to 24:
// - every time shown comes from a record (a deadline on the board); an item without one sits under "when ready";
// - every row is either "needs you" or "happens without you";
// - the headline is the earliest open item that needs him, or, with something waiting now, how many wait.
// It never guesses when an agent will finish.
// From 2026-10-04 (the owner's feedback) a row reads short: its title is the list's own or its text's first clause
// (@morndo/domain, the compact card's own rule, ADR-0023 §4.4), and the row carries its item for the rest (sentence,
// meta, More, buttons). A task he kept for later on this device (its row's Later, quick.ts) is off today: under its
// own heading at the end, never waiting, never the headline.
import { clause, type RosterEntry } from "@morndo/domain";
import { deliveryLine, type DecisionItem } from "../desktop/decisions.ts";
import { MAY_HAVE_BEEN, QUEUED } from "../queue-words.ts";

export type Row = {
  key: string;
  needsYou: boolean;
  at: number | null;                 // a deadline from the board; null: "when ready"
  title: string;
  detail: string;
  decisionId: string | null;         // "Decide now" opens this decision's card
  item: DecisionItem | null;         // the board's item behind it; null for a working agent
};
// waitingNow = waitingDecisions + waitingTasks (tasks past their time), so the headline can say which. anytimeTasks: the
// open tasks without a time, for "N tasks you can do anytime" (a decision kept for later is no task).
export type Horizon = { waitingNow: number; waitingDecisions: number; waitingTasks: number; anytimeTasks: number; next: Row | null; past: Row[]; whenReady: Row[]; coming: Row[]; kept: Row[] };

const hm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const asker = (d: DecisionItem) => (d.asker.kind === "manager" ? "The manager" : d.asker.name);

export const SAID_SKEW_MS = 2 * 60_000;
const short = (d: DecisionItem) => d.shortTitle?.trim() || clause(d.title).title;

export function horizon(p: {
  decisions: readonly DecisionItem[]; workers: readonly RosterEntry[]; later: ReadonlySet<string>; now: number;
  kept?: ReadonlySet<string>;                                     // tasks kept off today on this device (quick.ts)
  said?: Readonly<Record<string, { label: string; at: number }>>; // what he said from a task's row
}): Horizon {
  const rows: Row[] = [];
  const kept: Row[] = [];
  const waiting = new Set<string>();
  for (const d of p.decisions) {
    if (d.status === "open" && d.need === "time" && p.kept?.has(d.id)) {
      kept.push({ key: `d:${d.id}`, needsYou: true, at: d.deadline, title: short(d), detail: "You kept this for later today.", decisionId: null, item: d });
      continue;
    }
    if (d.status === "open") {
      const later = p.later.has(d.id);
      const overdue = d.deadline !== null && d.deadline <= p.now;
      // Kept for later, it waits for its time, unless it blocks work: then it still waits now, so the headline never
      // says nothing needs him while an agent is held up (the product lane's cycle, 2026-10-04).
      if ((d.need === "decision" && (!later || d.blocking)) || overdue) waiting.add(d.id);
      const otherwise = d.ifNoAnswer ? ` If you don't answer: ${d.ifNoAnswer}.` : "";
      rows.push({
        key: `d:${d.id}`, needsYou: true, at: d.deadline, title: short(d), decisionId: d.need === "decision" ? d.id : null, item: d,
        detail: d.need === "time" ? `Only you can do this.${otherwise}`
          : later && d.blocking ? `You kept this for later, but it blocks work until you answer.${otherwise}`
          : later ? `You kept this for later.${otherwise}`
          : d.answerBy === "screen" ? `${asker(d)} waits at its screen.` : `${asker(d)} asks.${otherwise}`,
      });
    } else if (d.status === "answered" && (d.deadline === null || d.deadline > p.now)) {
      const dec = d.decision;
      // What he said from this phone, only for this same answer: taken at about the hub's time of it (the phone's clock
      // within SAID_SKEW_MS), never an earlier answer to an ask that was asked again since (E11).
      const mine = p.said?.[d.id];
      const here = mine && dec && mine.at >= dec.at - SAID_SKEW_MS ? mine : undefined;
      const said = !dec ? "Answered." : dec.via === "elsewhere" ? "Answered on another device."
        : dec.via !== "here" ? `Answered: ${dec.choice.kind === "option" ? dec.choice.label : "in words"}.`
        : dec.choice.kind === "option" ? `You said “${dec.choice.label}” at ${hm(dec.at)}.`
        : here?.label === "your own words" ? `You answered in your own words at ${hm(dec.at)}.`
        : here ? `You said “${here.label}” at ${hm(dec.at)}.` : `You answered in words at ${hm(dec.at)}.`;
      // In the manager's queue (fleet-clients §9.1): not there yet, or may have been.
      const dl = deliveryLine(d);
      const then = dl?.state === "queued" ? `${QUEUED}.` : dl?.state === "uncertain" ? `${MAY_HAVE_BEEN}.` : `${asker(d)} takes it from here.`;
      rows.push({ key: `d:${d.id}`, needsYou: false, at: d.deadline, title: short(d), detail: `${said} ${then}`, decisionId: null, item: d });
    }
  }
  for (const w of p.workers) {
    if (w.state !== "active") continue;
    rows.push({ key: `w:${w.id}`, needsYou: false, at: null, title: `${w.name === "manager" ? "The manager" : w.name} is working`, detail: `${w.title ?? w.location}. No set time.`, decisionId: null, item: null });
  }
  const timed = rows.filter(r => r.at !== null).sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.key.localeCompare(b.key));
  const coming = timed.filter(r => (r.at ?? 0) > p.now);
  const decisionWaits = p.decisions.filter(d => waiting.has(d.id) && d.need === "decision").length;
  const whenReady = rows.filter(r => r.at === null).sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || a.title.localeCompare(b.title));
  return {
    waitingNow: waiting.size,
    waitingDecisions: decisionWaits,
    waitingTasks: waiting.size - decisionWaits,
    next: coming.find(r => r.needsYou) ?? null,
    past: timed.filter(r => (r.at ?? 0) <= p.now && r.needsYou),
    anytimeTasks: whenReady.filter(r => r.needsYou && r.item?.need === "time").length,
    whenReady,
    coming,
    kept,
  };
}

// The decisions he kept for later that still stand: the same ask (its version) still open. A prompt reopened under the
// same id, or an ask restated, isn't "kept" (review of PR #7, finding 7).
export function keptForLater(later: Readonly<Record<string, string>>, decisions: readonly DecisionItem[]): Set<string> {
  return new Set(decisions.filter(d => d.status === "open" && later[d.id] !== undefined && later[d.id] === d.version).map(d => d.id));
}

// How a time from a record reads: "16:00" today; "Mon" over "09:00" on another day; a whole-day deadline (23:59, as a
// list item dated without a time) as "today", "tomorrow" or the weekday, over "end of day".
export function timeLabel(at: number, now: number): { big: string; small: string | null } {
  const d = new Date(at), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(n)) / 86_400_000);
  const wholeDay = d.getHours() === 23 && d.getMinutes() === 59;
  // The column is narrow: a weekday from tomorrow on ("Sun"), a date beyond a week.
  const name = days === 0 ? "Today" : Math.abs(days) < 7 ? d.toLocaleDateString("en-GB", { weekday: "short" }) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (wholeDay) return { big: name, small: "end of day" };
  return days === 0 ? { big: hm(at), small: null } : { big: name, small: hm(at) };
}

// The headline's time: "16:00" today, "Mon 09:00" on another day, or the day for a whole-day deadline ("Tomorrow").
export function heroTime(at: number, now: number): string {
  const l = timeLabel(at, now);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day = days === 1 ? "Tomorrow" : l.big;
  return l.small === null ? l.big : l.small === "end of day" ? day : `${day} ${l.small}`;
}

// "by 18:00", "by Mon 09:00", "by the end of today": when an answer is due, in a sentence.
export function byLabel(at: number, now: number): string {
  const l = timeLabel(at, now);
  if (l.small === "end of day") return l.big === "Today" ? "by the end of today" : `by the end of ${heroTime(at, now).replace(/^Tomorrow$/, "tomorrow")}`;
  return `by ${heroTime(at, now)}`;
}

// "in 6 h 16 min", "in 4 min", "in 2 days".
export function untilLabel(at: number, now: number): string {
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min < 60) return `in ${min} min`;
  if (min < 48 * 60) { const h = Math.floor(min / 60), m = min % 60; return m ? `in ${h} h ${m} min` : `in ${h} h`; }
  return `in ${Math.round(min / 1440)} days`;
}
