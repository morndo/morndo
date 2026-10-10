// A task's buttons on Today (the owner's feedback, 2026-10-04): Done, one of its options or his own words go to the
// manager through the same path as a decision's answer (E8–E12), after the same 5-second window catch-up gives, with
// Undo; Later keeps the task off today on this device only (C6: the hub hears nothing of it). Pure and serializable:
// no Svelte, no timers, no clock (callers pass `now`); quick.svelte.ts runs it.
import { LATE_ANSWER_MS, UNDO_MS, type Body } from "../catchup/run.ts";
import { MAY_HAVE_GONE, endsDoubt, type AnswerOutcome } from "../catchup/answer.ts";

// `doubt`: set on Check again (the same request id as an answer that may have gone): the notice it checks, put back by
// Undo, a closed app, or an outcome that settles nothing (S7 for an answer; E8).
export type QuickAnswer = { id: string; body: Body; label: string; seen: string; requestId: string; commitAt: number; sending: boolean; doubt?: { code: string; text: string } };
export type QuickState = {
  pending: Record<string, QuickAnswer>;                                    // in their window, or being sent
  sent: Record<string, { label: string; at: number }>;                     // what he said from here (the hub keeps only "in words")
  // retry: may have gone, sent again with the same request id; again: refused for the passkey check, sent again once
  // he confirmed it (code review #3).
  failed: Record<string, { code: string; text: string; retry?: QuickAnswer; again?: QuickAnswer }>;
  later: Record<string, { version: string; until: number }>;               // kept off today: that ask, until the day ends
};


export const emptyQuick = (): QuickState => ({ pending: {}, sent: {}, failed: {}, later: {} });
const without = <T>(r: Record<string, T>, id: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== id));
// An answer as kept to send again (Try again, Check again, the passkey confirm): not being sent, without its doubt.
const asRetry = (a: QuickAnswer): QuickAnswer => ({ id: a.id, body: a.body, label: a.label, seen: a.seen, requestId: a.requestId, commitAt: a.commitAt, sending: false });

// Check again (the same request id as an answer that may have gone) keeps that notice with it, so the answer is never
// told Not sent while it may have reached the asker.
export function startQuick(s: QuickState, a: Omit<QuickAnswer, "commitAt" | "sending" | "doubt">, now: number): QuickState {
  const f = s.failed[a.id];
  const doubt = f && MAY_HAVE_GONE.has(f.code) && (f.retry?.requestId === a.requestId || f.again?.requestId === a.requestId) ? { code: f.code, text: f.text } : null;
  const pending: QuickAnswer = { ...a, commitAt: now + UNDO_MS, sending: false, ...(doubt ? { doubt } : {}) };
  return { ...s, pending: { ...s.pending, [a.id]: pending }, failed: without(s.failed, a.id), later: without(s.later, a.id) };
}

// Undo, inside the window only: once it is being sent it can't be taken back. An undone Check again leaves the answer as
// it was: in doubt, with Check again.
export function undoQuick(s: QuickState, id: string): QuickState {
  const a = s.pending[id];
  if (!a || a.sending) return s;
  const pending = without(s.pending, id);
  return a.doubt ? { ...s, pending, failed: { ...s.failed, [id]: { ...a.doubt, retry: asRetry(a) } } } : { ...s, pending };
}

// What goes now: every answer whose window closed (or all of them, `all`, when the page is left). One whose window closed
// more than LATE_ANSWER_MS ago (the phone slept) isn't sent: he tapped it for then (as catch-up's run.ts).
export function dueQuick(s: QuickState, now: number, all = false): { state: QuickState; send: QuickAnswer[]; late: QuickAnswer[] } {
  const send: QuickAnswer[] = [], late: QuickAnswer[] = [];
  const pending = { ...s.pending };
  const failed = { ...s.failed };
  for (const a of Object.values(s.pending)) {
    if (a.sending || (!all && a.commitAt > now)) continue;
    if (now - a.commitAt > LATE_ANSWER_MS) {
      late.push(a);
      delete pending[a.id];
      failed[a.id] = { code: "late", text: "Not sent: Morndo was asleep when it was due, so nothing was sent. Tap it again if it still stands." };
      continue;
    }
    const going = { ...a, sending: true };
    pending[a.id] = going;
    send.push(going);
  }
  return { state: send.length || late.length ? { ...s, pending, failed } : s, send, late };
}

export function settleQuick(s: QuickState, id: string, o: AnswerOutcome, now: number): QuickState {
  const a = s.pending[id];
  const pending = without(s.pending, id);
  if (o.ok) return { ...s, pending, sent: { ...s.sent, [id]: { label: a?.label ?? "your answer", at: now } } };
  // Check again that settled nothing (step_up, which the hub checks before it asks the asker's machine; 429; a 5xx):
  // still in doubt, with Check again, and with the passkey confirm when that was the refusal.
  if (a?.doubt && !MAY_HAVE_GONE.has(o.code) && !endsDoubt(o.code)) {
    const text = o.code === "step_up" ? `${a.doubt.text} ${o.text}` : a.doubt.text;
    return { ...s, pending, failed: { ...s.failed, [id]: { code: a.doubt.code, text, retry: asRetry(a), ...(o.code === "step_up" ? { again: asRetry(a) } : {}) } } };
  }
  const retry = a && MAY_HAVE_GONE.has(o.code) ? { retry: asRetry(a) } : a && o.code === "step_up" ? { again: asRetry(a) } : {};
  return { ...s, pending, failed: { ...s.failed, [id]: { code: o.code, text: o.text, ...retry } } };
}

// Later: kept off today until the day ends, while the same ask (its version) stands.
export function keepForLater(s: QuickState, id: string, version: string, now: number): QuickState {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return { ...s, later: { ...s.later, [id]: { version, until: end.getTime() } } };
}
export const bringBack = (s: QuickState, id: string): QuickState => ({ ...s, later: without(s.later, id) });

export function keptTasks(s: QuickState, items: readonly { id: string; version: string; status: string }[], now: number): Set<string> {
  return new Set(items.filter(d => d.status === "open" && s.later[d.id]?.version === d.version && (s.later[d.id]?.until ?? 0) > now).map(d => d.id));
}

// Read back from the device: Later, what was said from here, the notices, and the answers that were in their window or
// being sent when the app closed (code review #2). Those are never sent again by themselves, and never dropped without
// a word: one being sent "may have gone" (Try again sends it with the same request id, typed at most once); one still in
// its window was not sent. The board settles either (settleFromBoard).
export const GONE_TEXT = "Not sure it went: Morndo closed while it was sending. If it arrived, this row says so; Try again sends the same answer, typed at most once.";
export const CLOSED_TEXT = "Not sent: Morndo closed before it went. Tap it again if it still stands.";
const str = (x: unknown): x is string => typeof x === "string";
function answerOf(x: unknown): QuickAnswer | null {
  const a = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
  const b = a?.body && typeof a.body === "object" ? (a.body as Record<string, unknown>) : null;
  const body = b && str(b.key) ? { key: b.key } : b && str(b.text) ? { text: b.text } : null;
  if (!a || !body || !str(a.id) || !str(a.label) || !str(a.seen) || !str(a.requestId) || typeof a.commitAt !== "number") return null;
  const d = a.doubt && typeof a.doubt === "object" ? (a.doubt as Record<string, unknown>) : null;
  const doubt = d && str(d.code) && str(d.text) ? { code: d.code, text: d.text } : null;
  return { id: a.id, body, label: a.label, seen: a.seen, requestId: a.requestId, commitAt: a.commitAt, sending: a.sending === true, ...(doubt ? { doubt } : {}) };
}
export function parseQuick(v: unknown): QuickState {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const rec = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.entries(x as Record<string, unknown>) : []);
  const later = rec(o.later).flatMap(([id, x]) => {
    const l = x as Record<string, unknown> | null;
    return l && typeof l.version === "string" && typeof l.until === "number" ? [[id, { version: l.version, until: l.until }] as const] : [];
  });
  const sent = rec(o.sent).flatMap(([id, x]) => {
    const l = x as Record<string, unknown> | null;
    return l && typeof l.label === "string" && typeof l.at === "number" ? [[id, { label: l.label, at: l.at }] as const] : [];
  });
  const failed: QuickState["failed"] = {};
  for (const [id, x] of rec(o.failed)) {
    const f = x as Record<string, unknown> | null;
    if (!f || !str(f.code) || !str(f.text)) continue;
    const retry = answerOf(f.retry), again = answerOf(f.again);
    failed[id] = { code: f.code, text: f.text, ...(retry ? { retry } : {}), ...(again ? { again } : {}) };
  }
  for (const [id, x] of rec(o.pending)) {
    const a = answerOf(x);
    if (!a) continue;
    failed[id] = a.sending ? { code: "unknown", text: GONE_TEXT, retry: asRetry(a) } : a.doubt ? { ...a.doubt, retry: asRetry(a) } : { code: "closed", text: CLOSED_TEXT };
  }
  return { ...emptyQuick(), later: Object.fromEntries(later), sent: Object.fromEntries(sent), failed };
}

// The board says how a noticed answer ended: one that may have gone and shows answered from here counts as said from
// here (as catch-up's confirmAnswered); anything no longer open clears its notice. Unchanged while it is still open.
export function settleFromBoard(s: QuickState, items: readonly { id: string; status: string; decision: { at: number; via: string } | null }[]): QuickState {
  let next = s;
  for (const [id, f] of Object.entries(s.failed)) {
    const d = items.find(i => i.id === id);
    if (!d || d.status === "open") continue;
    const arrived = f.retry && MAY_HAVE_GONE.has(f.code) && d.status === "answered" && d.decision?.via === "here";
    next = { ...next, failed: without(next.failed, id), sent: arrived && f.retry && d.decision ? { ...next.sent, [id]: { label: f.retry.label, at: d.decision.at } } : next.sent };
  }
  return next;
}
