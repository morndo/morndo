// The catch-up on this device (ADR-0009): the cards that wait (from the live feed, by the domain's rules C1–C4), the
// run he is in (run.ts), its 5-second windows on a timer, and what it hands on: read marks to the feed, answers to the
// hub, "caught up" at the end (C7). The run and the decisions he kept for later are kept on the device (localStorage),
// never on the hub (C6): reading grants nothing, and "later" only shapes this device's stack and dashboard.
import { catchUpCards, decisionKey, mutedWithUpdates, type Card } from "@morndo/domain";
import type { LiveFeed } from "../feed.svelte.ts";
import { PASSKEY_UNFINISHED, STEP_UP_CHANGED, STEP_UP_MISMATCH, STILL_OFFLINE } from "../desktop/decisions.ts";
import { MAY_HAVE_GONE, type AnswerOutcome } from "./answer.ts";
import {
  answered, answerFailed, answerNow, bringToTop, current, dueAnswer, dueMarks, end, ended, markAllRead, markRead, moveOn, newRun, parseRun,
  refresh, setAside, startAnswer, undo, undoable, type Body, type Mark, type Run,
} from "./run.ts";

const RUN_KEY = "morndo.catchup.run";
const LATER_KEY = "morndo.later";
// An unfinished run is taken up again within this time of his last step; after it, a new run starts and what he kept
// unread or for later comes round again ("next time").
export const RESUME_MS = 30 * 60_000;

// The answer's outcome and the may-have-gone codes live with the answer POST (answer.ts); re-exported for catch-up's card.
export { MAY_HAVE_GONE, type AnswerOutcome };

// Why the card's answer didn't go, and the answer to send again: "Try again" reuses the request id (an unknown
// outcome, typed at most once; review of PR #7, finding 6), and a passkey confirm sends the same body with a new id.
export type Retry = { id: string; body: Body; label: string; seen: string; requestId: string };
export type Refusal = { key: string; code: string; text: string; retry?: Retry };

type Store = { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void };
const browserStore: Store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: this page keeps it */ } },
  remove: k => { try { localStorage.removeItem(k); } catch { /* as above */ } },
};

export class CatchUpSession {
  run = $state<Run | null>(null);
  refusal = $state<Refusal | null>(null);
  // A run opened in this page on current data: a run kept on the device is shown and acted on only once open() took it
  // up (review of PR #7, finding 8).
  opened = $state(false);
  // Decision id → the version of the ask he kept for later, on this device (horizon.ts keptForLater: only while that
  // same ask is open; review of PR #7, finding 7).
  later = $state<Record<string, string>>({});
  now = $state(Date.now());
  #feed: LiveFeed;
  #answer: (id: string, body: Body, seen: string, requestId: string) => Promise<AnswerOutcome>;
  #store: Store;
  #clock: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastStep = 0;

  // Every decision that waits now, in order (C1, C3), and the number on Today's tab.
  cards: Card[] = $derived.by(() => catchUpCards({
    decisions: this.#feed.decisions,
    conversations: this.#feed.workers.map(w => ({ worker: w.id, name: w.name, lastMessageAt: w.lastMessageAt, needsYou: w.needsYou })),
    reads: this.#feed.reads, muted: this.#feed.muted,
    claims: Object.fromEntries(Object.values(this.#feed.catchup).map(c => [c.name, c.claim])),
    updates: false,                                       // ADR-0011: updates wait in each chat and in the digest (H5)
  }));
  count = $derived(this.cards.length);
  // Muted conversations with something new: no card, only counted at the end (C4).
  skipped = $derived.by(() => mutedWithUpdates({
    conversations: this.#feed.workers.map(w => ({ worker: w.id, name: w.name, lastMessageAt: w.lastMessageAt, needsYou: w.needsYou })),
    reads: this.#feed.reads, muted: this.#feed.muted, updates: false,
  }).length);
  top = $derived(this.run ? current(this.run) : null);
  canUndo = $derived(this.run ? undoable(this.run, this.now) : false);

  constructor(d: { feed: LiveFeed; answer: (id: string, body: Body, seen: string, requestId: string) => Promise<AnswerOutcome>; store?: Store; now?: () => number }) {
    this.#feed = d.feed;
    this.#answer = d.answer;
    this.#store = d.store ?? browserStore;
    this.#clock = d.now ?? Date.now;
    try {
      const saved = JSON.parse(this.#store.get(RUN_KEY) ?? "null") as { run?: unknown; at?: unknown } | null;
      const run = parseRun(saved?.run);
      if (run && typeof saved?.at === "number") { this.run = run; this.#lastStep = saved.at; }
      // An answer pending when the page closed: never sent on its own, never dropped without a word.
      const lost = run?.lost;
      if (lost) {
        const retry = { id: lost.id, body: lost.body, label: lost.label, seen: lost.seen, requestId: lost.requestId };
        this.refusal = lost.sending
          ? { key: lost.key, code: "unknown", text: "Not sure it went: Morndo closed while it was sending. If it arrived, this card says so; Try again sends the same answer, typed at most once.", retry }
          : { key: lost.key, code: "closed", text: "Not sent: Morndo closed before your answer went. Tap it again if it still stands." };
      }
      const later = JSON.parse(this.#store.get(LATER_KEY) ?? "{}") as Record<string, unknown>;
      this.later = Object.fromEntries(Object.entries(later).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch { /* unreadable: start clean */ }
  }

  start() { this.#timer = setInterval(() => void this.tick(), 250); }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  // Opening catch-up: the unfinished run again if it is recent, else a new one from what waits now. `decision`: this
  // decision's card on top ("Decide now"); `decisions`: a decision card on top if any waits (a push about decisions).
  open(o: { decision?: string; decisions?: boolean } = {}) {
    const now = this.#clock();
    const r = this.run;
    const resume = r !== null && r.endedAt === null && now - this.#lastStep < RESUME_MS;
    if (!resume) {
      this.run = newRun(this.cards, now);
      this.later = {};                                      // a new run: what was kept for later comes round again
      this.#saveLater();
      this.refusal = null;
    } else {
      this.run = refresh(r, this.cards);
    }
    this.opened = true;
    this.#feed.requestCatchUp();
    const want = o.decision !== undefined ? this.cards.find(c => c.key === decisionKey(o.decision ?? ""))
      : o.decisions && this.top?.kind !== "decision" ? this.cards.find(c => c.kind === "decision") : undefined;
    if (want && this.run) {
      this.run = bringToTop(this.run, want);
      if (want.kind === "decision") this.#forgetLater([want.id]);          // on top again: not set aside any more
    }
    this.#changed();
  }

  // The live feed changed what waits: the cards still to come follow it (refresh keeps the one on top in place).
  follow() {
    if (!this.run || this.run.endedAt !== null || !this.opened || !this.#feed.primed) return;   // only from current data
    const next = refresh(this.run, this.cards);
    if (JSON.stringify(next.order) !== JSON.stringify(this.run.order)) { this.run = next; this.#save(); }
  }

  markRead(key: string, mark: Omit<Mark, "key">) { this.#step(r => markRead(r, { key, ...mark }, this.#clock())); }
  markAllRead(marks: Mark[]) { this.#step(r => markAllRead(r, marks, this.#clock())); }
  setAside(key: string) {
    const card = this.run?.cards[key];
    if (!this.#step(r => setAside(r, key)) || card?.kind !== "decision") return;   // only what the run did set aside
    const version = this.#feed.decisions.find(d => d.id === card.id)?.version;
    if (version !== undefined) { this.later = { ...this.later, [card.id]: version }; this.#saveLater(); }
  }
  #forgetLater(ids: string[]) {
    if (!ids.some(id => id in this.later)) return;
    this.later = Object.fromEntries(Object.entries(this.later).filter(([id]) => !ids.includes(id)));
    this.#saveLater();
  }
  moveOn(key: string) { this.#step(r => moveOn(r, key)); }
  answer(key: string, id: string, body: Body, label: string, seen: string) {
    this.refusal = null;
    this.#step(r => startAnswer(r, key, id, body, label, this.#clock(), seen, crypto.randomUUID()));
  }
  // The board says the card's answer arrived after all (an unknown outcome that did reach the hub): it counts as his.
  confirmAnswered(key: string) {
    if (this.refusal?.key !== key || !MAY_HAVE_GONE.has(this.refusal.code) || !this.run || key in this.run.done) return;
    this.refusal = null;
    this.run = answered(this.run, key);
    this.#lastStep = this.#clock();
    this.#changed();
  }
  undo() {
    const r = this.run;
    if (!r) return;
    const last = r.answering ? null : r.steps.at(-1);
    this.#step(x => undo(x, this.#clock()));
    // A decision brought back from "later" isn't kept for later any more.
    if (last?.outcome === "later") this.#forgetLater(last.keys.map(k => r.cards[k]).flatMap(c => (c?.kind === "decision" ? [c.id] : [])));
  }
  // The answer the hub refused for step-up, once more after the passkey check (no new window: he just confirmed it).
  // Once more at once: after the passkey check, or "Try again" after an unknown outcome (the same request id then).
  // The one passkey confirm: the refusal's own answer, checked against the live ask, the card on top and the
  // connection. A reason when it cannot be sent (the card and the sheet show that); null once it has gone.
  async retryStepUp(feed: { status: string; decisions: readonly { id: string; version: string }[] }, verify: () => Promise<boolean>): Promise<string | null> {
    const r = this.refusal;
    const again = r?.retry;
    const top = this.top;
    if (!r || !again || r.code !== "step_up" || top?.kind !== "decision" || r.key !== top.key) return STEP_UP_MISMATCH;
    const live = feed.decisions.find(d => d.id === again.id)?.version ?? "";
    if (live !== again.seen) return STEP_UP_CHANGED;
    if (feed.status !== "live" || navigator.onLine === false) return STILL_OFFLINE;
    if (!(await verify())) return PASSKEY_UNFINISHED;
    await this.retry(r.key, again.id, again.body, again.label, again.seen);
    return null;
  }

  async retry(key: string, id: string, body: Body, label: string, seen: string, requestId: string = crypto.randomUUID()) {
    this.refusal = null;
    if (!this.run) return;
    this.run = { ...this.run, answering: { key, id, body, label, seen, requestId, commitAt: this.#clock(), sending: false } };
    await this.tick();
  }

  // Leaving catch-up, or the page going to the background: marks and an answer still in their window go now, as he left
  // them (a phone put away may not run this page again for hours).
  leave() {
    if (!this.run) return;
    const now = this.#clock();
    const d = dueMarks(answerNow(this.run, now), now, true);
    this.run = d.run;
    for (const m of d.send) this.#feed.markRead(m.conversation, m.at);
    this.#save();
    if (this.run.answering) void this.tick();
  }
  // "Kept for later" on the end screen: that decision's card again, in this run.
  revisit(id: string) {
    const card = this.cards.find(c => c.key === decisionKey(id));
    if (!card || !this.run) return;
    this.run = bringToTop(this.run, card);
    this.#forgetLater([id]);
    this.#lastStep = this.#clock();
    this.#save();
  }
  // The end screen was left: marks still in their window go now, and the next opening starts a new run.
  finish() { this.leave(); this.run = null; this.#store.remove(RUN_KEY); }

  async tick() {
    this.now = this.#clock();
    let r = this.run;
    if (!r) return;
    const marks = dueMarks(r, this.now);
    r = marks.run;
    for (const m of marks.send) this.#feed.markRead(m.conversation, m.at);
    const due = dueAnswer(r, this.now);
    this.run = due.run;
    // Saved as "sending" before the POST: a page that closes now reads it back as maybe sent, never as not sent.
    if (marks.send.length || due.send) this.#save();
    if (due.late) {
      this.refusal = { key: due.late.key, code: "late", text: "Not sent: Morndo was asleep when your answer was due, so nothing was answered. Tap it again if it still stands." };
      this.#save();
    }
    if (due.send) {
      const a = due.send;
      const outcome = await this.#answer(a.id, a.body, a.seen, a.requestId);
      if (!this.run) return;
      if (outcome.ok) this.run = answered(this.run, a.key);
      else {
        this.run = answerFailed(this.run);
        const retry = { id: a.id, body: a.body, label: a.label, seen: a.seen, requestId: a.requestId };
        const again = MAY_HAVE_GONE.has(outcome.code) || outcome.code === "step_up";
        this.refusal = { key: a.key, code: outcome.code, text: outcome.text, ...(again ? { retry } : {}) };
      }
      this.#lastStep = this.#clock();
      this.#changed();
    }
    this.#endIfDone();
  }

  #step(f: (r: Run) => Run): boolean {
    if (!this.run) return false;
    const next = f(this.run);
    if (next === this.run) return false;
    this.run = next;
    this.#lastStep = this.#clock();
    this.now = this.#lastStep;
    this.#changed();
    return true;
  }
  #changed() { this.#endIfDone(); this.#save(); }
  // The last card done: the run ends, and the hub hears when he was last caught up (C7).
  #endIfDone() {
    const r = this.run;
    if (!r || r.endedAt !== null || !ended(r)) return;
    this.run = end(r, this.#clock());
    this.#feed.markCaughtUp(this.run.endedAt ?? this.#clock());
    this.#save();
  }
  #save() { if (this.run) this.#store.set(RUN_KEY, JSON.stringify({ run: this.run, at: this.#lastStep })); }
  #saveLater() { this.#store.set(LATER_KEY, JSON.stringify(this.later)); }
}
