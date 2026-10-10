// Runs a task's buttons on Today (quick.ts): the 5-second windows on a timer, the answers through the hub's answer path
// (catchup/answer.ts), and Later and what he said from here kept on the device (localStorage). Leaving the page sends
// what waits in its window now, as catch-up does.
import type { Body } from "../catchup/run.ts";
import type { AnswerOutcome } from "../catchup/answer.ts";
import { bringBack, dueQuick, emptyQuick, keepForLater, parseQuick, settleFromBoard, settleQuick, startQuick, undoQuick, type QuickState } from "./quick.ts";

const KEY = "morndo.today.tasks";
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked: this page keeps it */ } },
};

export class QuickAnswers {
  state = $state<QuickState>(emptyQuick());
  now = $state(Date.now());
  #answer: (id: string, body: Body, seen: string, requestId: string) => Promise<AnswerOutcome>;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(answer: (id: string, body: Body, seen: string, requestId: string) => Promise<AnswerOutcome>) {
    this.#answer = answer;
    try { this.state = parseQuick(JSON.parse(store.get() ?? "null")); } catch { /* unreadable: start clean */ }
  }
  start() { this.#timer = setInterval(() => void this.tick(), 250); }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  answer(id: string, body: Body, label: string, seen: string, requestId: string = crypto.randomUUID()) {
    this.state = startQuick(this.state, { id, body, label, seen, requestId }, Date.now());
    this.#save();
  }
  undo(id: string) { this.state = undoQuick(this.state, id); this.#save(); }
  later(id: string, version: string) { this.state = keepForLater(this.state, id, version, Date.now()); this.#save(); }
  back(id: string) { this.state = bringBack(this.state, id); this.#save(); }
  // "Try again" after an unknown outcome: the same request id, so the hub types it at most once.
  retry(id: string) {
    const r = this.state.failed[id]?.retry;
    if (r) this.answer(r.id, r.body, r.label, r.seen, r.requestId);
  }
  // The page is left: what waits in its window goes now.
  flush() { void this.tick(true); }
  // The board (only once current) settles the notices of answers the app closed on.
  confirm(items: readonly { id: string; status: string; decision: { at: number; via: string } | null }[]) {
    const next = settleFromBoard(this.state, items);
    if (next !== this.state) { this.state = next; this.#save(); }
  }

  async tick(all = false) {
    this.now = Date.now();
    const d = dueQuick(this.state, this.now, all);
    if (d.state === this.state) return;
    this.state = d.state;
    this.#save();
    await Promise.all(d.send.map(async a => {
      const o = await this.#answer(a.id, a.body, a.seen, a.requestId);
      this.state = settleQuick(this.state, a.id, o, Date.now());
      this.#save();
    }));
  }
  // Only what still matters is kept: Later until its day ends, what he said and a notice that can be tried again for
  // three days (the board shows it answered for as long as the list keeps it; after that the row is gone anyway). An
  // answer in its window or being sent is kept too, so a killed app reads it back as a notice (code review #2); other
  // notices go once the board settles them.
  #save() {
    const now = Date.now(), DAYS3 = 3 * 86_400_000;
    const later = Object.fromEntries(Object.entries(this.state.later).filter(([, l]) => l.until > now));
    const sent = Object.fromEntries(Object.entries(this.state.sent).filter(([, x]) => now - x.at < DAYS3));
    const failed = Object.fromEntries(Object.entries(this.state.failed).filter(([, f]) => !f.retry || now - f.retry.commitAt < DAYS3));
    store.set(JSON.stringify({ later, sent, failed, pending: this.state.pending }));
  }
}
