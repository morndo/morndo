// One catch-up run (ADR-0009): the cards he works through from opening catch-up to "You're caught up", what he did with
// each, and the 5-second window in which an answer or a read mark can still be taken back. Pure and serializable: no
// Svelte, no timers, no clock of its own (callers pass `now`), so it is kept on the device between reloads and tested
// on its own (run.test.ts). The rules it keeps:
// - a decision is never marked read: only an answer, a settling or an expiry takes it out of the hub's stack (C1); here
//   "later" only takes it out of this run;
// - an answer goes, and a read mark moves, only after its window: Undo inside it sends nothing (marks only move forward);
// - "kept unread" and "later" are this device's memory of this run: the hub hears nothing of them (C6).
import { compareCards, type Card } from "@morndo/domain";

export const UNDO_MS = 5000;
// An answer whose window closed this long ago without being sent (the phone slept, the page was frozen) is not sent:
// an agent acts on what it is told, and he tapped it for then, not for whenever the phone wakes.
export const LATE_ANSWER_MS = 30_000;

// "gone": the card's Ask was answered, settled or expired elsewhere while it was on top; he moved past it.
export type Outcome = "answered" | "read" | "kept" | "later" | "gone";
export type Body = { key: string } | { text: string };
export type Mark = { key: string; conversation: string; at: number };
type Step = { keys: string[]; outcome: Outcome };

export type Run = {
  startedAt: number;
  endedAt: number | null;
  order: string[];                                   // every card of this run, in the order shown
  cards: Record<string, Card>;
  done: Record<string, Outcome>;
  steps: Step[];                                     // what he did, in order, for Undo
  marks: (Mark & { commitAt: number })[];            // read marks still inside their window
  gone?: string[];                                   // passed cards since seen off the board (closed, read elsewhere)
  // `seen`: the version of the Ask it was given for (askVersion): the hub refuses it if the Ask was restated meanwhile.
  // `requestId`: one for every attempt of this answer (S5's rule for Commands, which the hub keeps for answers too).
  answering: { key: string; id: string; body: Body; label: string; seen: string; requestId: string; commitAt: number; sending: boolean } | null;
  // An answer that was pending when the page closed (read back by parseRun): reported on its card, never dropped silently.
  lost?: { key: string; id: string; body: Body; label: string; seen: string; requestId: string; sending: boolean } | null;
};

export function newRun(cards: readonly Card[], now: number): Run {
  return { startedAt: now, endedAt: null, order: cards.map(c => c.key), cards: Object.fromEntries(cards.map(c => [c.key, c])), done: {}, steps: [], marks: [], answering: null };
}

// The card on top, or null at the end.
export function current(run: Run): Card | null {
  const key = run.order.find(k => !(k in run.done));
  return key === undefined ? null : run.cards[key] ?? null;
}

// A run's entry for a card is the card's own key, or, when the card came round again in the same run, that key with
// "~2", "~3"… (review of PR #7, finding 2).
export const baseKey = (k: string) => k.replace(/~\d+$/, "");
export const latestEntry = (run: Run, key: string) => run.order.findLast(k => baseKey(k) === key);

// A card passed in this run comes round again when it qualifies with something new: an update whose agent spoke since
// (a later last message); a decision asked again (a later ask), or open again after the board showed it closed.
function comesBack(was: Card | undefined, now: Card, closedSince: boolean): boolean {
  if (was?.kind === "update" && now.kind === "update") return now.lastAt > was.lastAt;
  if (was?.kind === "decision" && now.kind === "decision") return now.askedAt > was.askedAt || closedSince;
  return false;
}

// The cards that wait now (fresh from the hub) replace what is still to come: new ones join in their place by the
// order's rule (C3), ones answered, settled or read elsewhere drop out, and a passed one that qualifies again joins as
// a new entry. What he passed and the card on top stay as they are, so nothing moves under his thumb.
export function refresh(run: Run, cards: readonly Card[]): Run {
  const top = current(run);
  const passed = run.order.filter(k => k in run.done);
  const fresh = new Map(cards.map(c => [c.key, c]));
  const gone = new Set((run.gone ?? []).filter(k => passed.includes(k)));
  for (const k of passed) if (!fresh.has(baseKey(k))) gone.add(k);
  const coming: Card[] = [];
  for (const c of cards) {
    const k = latestEntry(run, c.key);
    if (k === undefined) { coming.push(c); continue; }                         // new to this run
    if (k === top?.key) continue;                                               // on top: it stays
    if (!(k in run.done)) { coming.push({ ...c, key: k }); continue; }          // still to come: placed again
    if (comesBack(run.cards[k], c, gone.has(k))) {
      const n = run.order.filter(x => baseKey(x) === c.key).length + 1;
      coming.push({ ...c, key: `${c.key}~${n}` });
    }
  }
  coming.sort(compareCards);
  const merged: Record<string, Card> = {};
  for (const k of passed) { const c = run.cards[k]; if (c) merged[k] = c; }     // as it was when he passed it
  if (top) { const f = fresh.get(baseKey(top.key)); merged[top.key] = f ? { ...f, key: top.key } : top; }
  for (const c of coming) merged[c.key] = c;
  return { ...run, order: [...passed, ...(top ? [top.key] : []), ...coming.map(c => c.key)], cards: merged, gone: [...gone] };
}

function did(run: Run, keys: string[], outcome: Outcome): Run {
  const done = { ...run.done };
  for (const k of keys) done[k] = outcome;
  return { ...run, done, steps: [...run.steps, { keys, outcome }] };
}

// Mark as read: the next card comes at once; the mark goes when its window closes (due).
export function markRead(run: Run, mark: Mark, now: number): Run {
  if (run.cards[mark.key]?.kind !== "update") return run;          // a decision is never marked read (C1)
  return { ...did(run, [mark.key], "read"), marks: [...run.marks, { ...mark, commitAt: now + UNDO_MS }] };
}

// Hold "Mark as read" (or its button): every update still to come in this run, the one on top included. Decisions stay.
export function markAllRead(run: Run, marks: readonly Mark[], now: number): Run {
  const left = new Set(run.order.filter(k => !(k in run.done) && run.cards[k]?.kind === "update"));
  const take = marks.filter(m => left.has(m.key));
  if (!take.length) return run;
  return { ...did(run, take.map(m => m.key), "read"), marks: [...run.marks, ...take.map(m => ({ ...m, commitAt: now + UNDO_MS }))] };
}

// Keep unread (an update) or Later (a decision): out of this run only. The hub hears nothing (C6).
export function setAside(run: Run, key: string): Run {
  const card = run.cards[key];
  if (!card || key in run.done || run.answering) return run;          // an answer in its window: Undo it first
  return did(run, [key], card.kind === "decision" ? "later" : "kept");
}

// Past a card whose Ask closed elsewhere while it was on top (its state stays shown until he moves on).
export function moveOn(run: Run, key: string): Run {
  return run.cards[key] && !(key in run.done) ? did(run, [key], "gone") : run;
}

// "Decide now" on the dashboard, or a push about decisions: this card on top, back from "later" if he set it aside in
// this run, or joining the run if it wasn't in it.
export function bringToTop(run: Run, card: Card): Run {
  const key = latestEntry(run, card.key) ?? card.key;                          // its latest entry in this run, if any
  const done = { ...run.done };
  delete done[key];
  const passed = run.order.filter(k => k in done && k !== key);
  const rest = run.order.filter(k => !(k in done) && k !== key);
  return { ...run, done, order: [...passed, key, ...rest], cards: { ...run.cards, [key]: { ...card, key } }, endedAt: null };
}

// A tap on an option: the card says "Answered: …" with Undo for 5 seconds, then the answer goes (dueAnswer).
export function startAnswer(run: Run, key: string, id: string, body: Body, label: string, now: number, seen = "", requestId = ""): Run {
  if (run.cards[key]?.kind !== "decision" || run.answering) return run;
  return { ...run, answering: { key, id, body, label, seen, requestId, commitAt: now + UNDO_MS, sending: false } };
}
// The answer whose window closed, to send now (once); or, past LATE_ANSWER_MS, dropped as too late (`late`).
export function dueAnswer(run: Run, now: number): { run: Run; send: NonNullable<Run["answering"]> | null; late?: NonNullable<Run["answering"]> } {
  const a = run.answering;
  if (!a || a.sending || a.commitAt > now) return { run, send: null };
  if (now - a.commitAt > LATE_ANSWER_MS) return { run: { ...run, answering: null }, send: null, late: a };
  const sending = { ...a, sending: true };
  return { run: { ...run, answering: sending }, send: sending };
}
// Still waiting to send, or the send is in flight. Both effects that return to Today use this one check.
export function inWindow(a: { sending: boolean; commitAt: number } | null | undefined, now: number): boolean {
  return !!a && (a.sending || a.commitAt > now);
}
// Leaving catch-up (Back, another tab, the page hidden): an answer in its window goes now, as he left it.
export function answerNow(run: Run, now: number): Run {
  const a = run.answering;
  return a && !a.sending && a.commitAt > now ? { ...run, answering: { ...a, commitAt: now } } : run;
}
// The hub took it: the card is done and the next one comes.
export const answered = (run: Run, key: string): Run => ({ ...did(run, [key], "answered"), answering: null });
// The hub refused it, or it couldn't be sent: the card stays, open, to show why.
export const answerFailed = (run: Run): Run => ({ ...run, answering: null });

// The read marks whose window closed, to send now; `all` sends every one (leaving catch-up, the page hidden).
export function dueMarks(run: Run, now: number, all = false): { run: Run; send: Mark[] } {
  const send = run.marks.filter(m => all || m.commitAt <= now);
  if (!send.length) return { run, send: [] };
  return { run: { ...run, marks: run.marks.filter(m => !send.includes(m)) }, send: send.map(({ key, conversation, at }) => ({ key, conversation, at })) };
}

// What Undo would take back: an answer in its window; else the last step, if it sent nothing yet (a read still in its
// window, or a card set aside). An answer already sent, or a mark already moved, can't come back.
export function undoable(run: Run, now: number): boolean {
  if (run.answering) return !run.answering.sending && run.answering.commitAt > now;
  const last = run.steps.at(-1);
  if (!last || last.outcome === "answered") return false;
  if (last.outcome !== "read") return true;
  return last.keys.every(k => run.marks.some(m => m.key === k && m.commitAt > now));
}
export function undo(run: Run, now: number): Run {
  if (!undoable(run, now)) return run;
  if (run.answering) return { ...run, answering: null };
  const last = run.steps.at(-1) as Step;
  const done = { ...run.done };
  for (const k of last.keys) delete done[k];
  return { ...run, done, steps: run.steps.slice(0, -1), marks: run.marks.filter(m => !last.keys.includes(m.key)), endedAt: null };
}

export const ended = (run: Run) => current(run) === null && run.answering === null;
export const end = (run: Run, now: number): Run => (run.endedAt === null ? { ...run, endedAt: now } : run);

export type Counts = { left: number; decisionsLeft: number; updatesLeft: number; decisionsInRun: number; decided: number; read: number; kept: number; later: number };
export function counts(run: Run): Counts {
  const left = run.order.filter(k => !(k in run.done));
  const kind = (k: string) => run.cards[k]?.kind;
  const by = (o: Outcome) => Object.values(run.done).filter(x => x === o).length;
  return {
    left: left.length,
    decisionsLeft: left.filter(k => kind(k) === "decision").length,
    updatesLeft: left.filter(k => kind(k) === "update").length,
    decisionsInRun: run.order.filter(k => kind(k) === "decision").length,
    decided: by("answered"), read: by("read"), kept: by("kept"), later: by("later"),
  };
}

// One segment per card of the run, for the bar under the counter: decisions stay outlined until done.
export type Segment = { key: string; decision: boolean; state: "done" | "now" | "next" };
export function segments(run: Run): Segment[] {
  const top = current(run)?.key;
  return run.order.map(k => ({ key: k, decision: run.cards[k]?.kind === "decision", state: k in run.done ? "done" : k === top ? "now" : "next" }));
}

// A run read back from the device: the shape it was written in, or nothing.
export function parseRun(v: unknown): Run | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<Run>;
  const ok = typeof r.startedAt === "number" && (r.endedAt === null || typeof r.endedAt === "number") && Array.isArray(r.order)
    && r.order.every(k => typeof k === "string") && !!r.cards && typeof r.cards === "object" && !!r.done && typeof r.done === "object"
    && Array.isArray(r.steps) && Array.isArray(r.marks) && (r.answering === null || typeof r.answering === "object");
  // An answer can't be half-sent across a reload: it isn't sent on its own, and its card says what became of it (lost).
  if (!ok) return null;
  const a = (r as Run).answering;
  const lost = a ? { key: a.key, id: a.id, body: a.body, label: a.label, seen: a.seen ?? "", requestId: a.requestId ?? "", sending: a.sending } : null;
  return { ...(r as Run), answering: null, lost };
}
