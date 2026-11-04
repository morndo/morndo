// Application watchers for B19 and B20 (ADR-0040), on the model of wait-watch.ts: a pass never overlaps another, the
// clock and the log are injected, and both send through a port, never typing anything themselves.
// - The decision inbox (B19) tells the manager, on its lane, every open decision with its deadline: at most once an
//   hour while any wait, and again at the next pass when a message did not go. It also tells the principal, once for
//   each decision that goes overdue (tracked by key and deadline in memory, so a restart may tell twice — the lane's
//   hourly message is the backstop); a push that fails is logged and never stops the message to the lane.
// - The stale sweep (B20) sends the manager the tasks nobody changed for 48 h that the board watches nothing on: at
//   once when the list of them changed, at most every 12 h while it is unchanged, and again at the next pass when a
//   message did not go.
// The domain says what waits (board-stale.ts); these only read the board, build the id and the text, and ask the port.
import { DECISION_DUE_MS, INBOX_EVERY_MS, STALE_REPEAT_MS, inboxItems, inboxMessage, staleMessage, staleTasks, type JudgedWait, type MergedView, type Task, type TaskKey } from "@morndo/domain";
import { log as defaultLog } from "../adapters/log.ts";
import type { Deliveries } from "./ports.ts";

// The fleet's delivery port as these use it (ports.ts Deliveries, answer ok → true): one text, to one lane, under an
// id of the caller's choosing, allowed to wait its ttlMs to be typed. A false answer and a throw are the same thing
// here: it did not go, and the next pass tries again — under the same id, which is the fleet's idempotency key, so a
// delivery that was taken but never answered is never doubled.
export type DeliverText = (d: { id: string; lane: string; text: string; ttlMs?: number }) => Promise<boolean>;

// The fleet takes a delivery id of the shape `<client>:<rest>`, the client lowercase letters, at most 16 of them
// (fleet.ts deliveryId): `board-inbox:<ms>` is not one and was refused outright. The hub is a client like any other,
// so its deliveries go out namespaced `hub:` ahead of the watcher's own id, which stays what the tests read.
export function fleetDeliverText(deliveries: Pick<Deliveries, "deliver">): DeliverText {
  return async d => (await deliveries.deliver({ ...d, id: `hub:${d.id}` })).ok;
}
// How long a message may wait on the lane to be typed: the inbox's list is stale in hours, the sweep's in half a day.
export const INBOX_TTL_MS = 90 * 60_000;
export const STALE_TTL_MS = 12 * 3_600_000;
type Warn = Pick<typeof defaultLog, "warn">;

// One message through the port: went, or why it did not.
async function tryDeliver(deliver: DeliverText, d: { id: string; lane: string; text: string; ttlMs?: number }): Promise<{ went: true } | { went: false; why: string }> {
  try {
    return await deliver(d) ? { went: true } : { went: false, why: "the fleet did not take it" };
  } catch (e) { return { went: false, why: String(e) }; }
}

// One pass at a time, and one more after it when asked meanwhile (wait-watch.ts's tick, written out per watcher).
type Tick = { sent: boolean; items: number };

// B20: the keys the board itself watches, so the sweep leaves them out: a blocked task whose waits the hub has read
// something of (an open wait may end any moment, and D7 moves the task), a review task whose merge is not live on
// every node yet, and every decision the inbox has (B19), a legacy one included — an answered one excluded, for the
// sweep has it again (the inbox let it go). `view` is what the board holds: the shown tasks, the wait watch's readings,
// the merged views.
export function watchedKeys(view: { tasks: readonly Task[]; waits?: readonly { key: string; readings: JudgedWait[] }[]; merged: readonly MergedView[] }, now: number, legacySince: number, answered?: (key: TaskKey, since: number) => boolean): Set<string> {
  const keys = new Set<string>();
  for (const w of view.waits ?? []) if (w.readings.some(r => r.state !== "unknown")) keys.add(w.key);
  const status = new Map(view.tasks.map(t => [t.key as string, t.status]));
  for (const m of view.merged) if (m.live === false && status.get(m.key) === "review") keys.add(m.key);
  for (const i of inboxItems(view.tasks, now, { legacySince, ...(answered !== undefined ? { answered } : {}) })) keys.add(i.key);
  return keys;
}

// B19: the decision inbox.
export class BoardInbox {
  #tasks: () => readonly Task[];
  #deliver: DeliverText;
  #push: (text: string) => void;
  #lane: string;
  #now: () => number;
  #legacySince: number;
  #answered: ((key: TaskKey, since: number) => boolean) | null;
  #log: Warn;
  #ttlMs: number;
  #everyMs: number;
  #sentAt: number | null = null;               // the pass's now of the last message that went; null: none has yet
  #pending: { id: string; text: string } | null = null;   // the message that did not go: retried under its id, its text unchanged
  #told = new Set<string>();                   // key@dueAt of the decisions the principal was told of
  #running: Promise<Tick> | null = null;
  #again = false;

  // `push`: the principal's notice, one text per pass for the newly overdue (a throw inside it is logged, never fatal).
  // `legacySince`: the hub's start, where the clock of a decision from before the rule begins. `answered`: an answer
  // after the ask closes the item (the hub reads the task's events for one).
  constructor(p: { tasks: () => readonly Task[]; deliver: DeliverText; push?: (text: string) => void; lane: string; now?: () => number; legacySince: number; answered?: (key: TaskKey, since: number) => boolean; log?: Warn; ttlMs?: number; everyMs?: number }) {
    this.#tasks = p.tasks; this.#deliver = p.deliver; this.#push = p.push ?? (() => {}); this.#lane = p.lane;
    this.#now = p.now ?? Date.now; this.#legacySince = p.legacySince; this.#answered = p.answered ?? null;
    this.#log = p.log ?? defaultLog; this.#ttlMs = p.ttlMs ?? INBOX_TTL_MS; this.#everyMs = p.everyMs ?? INBOX_EVERY_MS;
  }

  tick(): Promise<Tick> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      try {
        let r = await this.#pass();
        while (this.#again) { this.#again = false; r = await this.#pass(); }
        return r;
      } finally { this.#running = null; }
    })();
    return this.#running;
  }

  async #pass(): Promise<Tick> {
    const now = this.#now();
    const items = inboxItems(this.#tasks(), now, { legacySince: this.#legacySince, ...(this.#answered !== null ? { answered: this.#answered } : {}) });
    // The principal: one text for what just went overdue, never a second for the same decision. It goes before the
    // lane's message, and whatever the push port does with it cannot stop that.
    const fresh = items.filter(i => i.overdue && !this.#told.has(`${i.key}@${i.dueAt}`));
    if (fresh.length > 0) {
      for (const i of fresh) this.#told.add(`${i.key}@${i.dueAt}`);
      const text = `[board-inbox] ${fresh.length === 1 ? "1 decision is overdue" : `${fresh.length} decisions are overdue`} with no answer:\n${inboxMessage(fresh, now).split("\n").slice(1).join("\n")}`;
      try { this.#push(text); } catch (e) { this.#log.warn(`board inbox: telling the principal a decision went overdue failed: ${String(e)}`); }
    }
    if (items.length === 0) return { sent: false, items: 0 };
    // At most one message an hour after one that went; one that did not go is tried again at the next pass, under the
    // same id while its text is unchanged (the fleet answers what became of an id it knows, and answers the same id
    // with other text as id_conflict), and under a fresh one once the text has moved on.
    if (this.#sentAt !== null && now - this.#sentAt < this.#everyMs) return { sent: false, items: items.length };
    const text = inboxMessage(items, now);
    const id = this.#pending?.text === text ? this.#pending.id : `board-inbox:${now}`;
    const r = await tryDeliver(this.#deliver, { id, lane: this.#lane, text, ttlMs: this.#ttlMs });
    if (!r.went) {
      this.#pending = { id, text };
      this.#log.warn(`board inbox: the message to ${this.#lane} did not go (${r.why}); the next pass tries again`);
      return { sent: false, items: items.length };
    }
    this.#pending = null;
    this.#sentAt = now;
    return { sent: true, items: items.length };
  }
}

// B20: the stale sweep.
export class StaleSweep {
  #tasks: () => readonly Task[];
  #watched: () => ReadonlySet<string>;
  #answered: ((key: TaskKey, since: number) => boolean) | null;
  #deliver: DeliverText;
  #lane: string;
  #now: () => number;
  #log: Warn;
  #ttlMs: number;
  #repeatMs: number;
  #sentAt: number | null = null;               // the pass's now of the last message that went
  #lastList: string | null = null;             // that message's list, key and status per line: what "unchanged" means
  #pending: { id: string; text: string } | null = null;   // the message that did not go: retried under its id, its text unchanged
  #running: Promise<Tick> | null = null;
  #again = false;

  // `answered` (B19): a decision the manager answered while the task stays blocked is not the inbox's any more — it
  // goes back to being swept like any block that sits, so it is never lost between the two.
  constructor(p: { tasks: () => readonly Task[]; watched: () => ReadonlySet<string>; answered?: (key: TaskKey, since: number) => boolean; deliver: DeliverText; lane: string; now?: () => number; log?: Warn; ttlMs?: number; repeatMs?: number }) {
    this.#tasks = p.tasks; this.#watched = p.watched; this.#answered = p.answered ?? null; this.#deliver = p.deliver; this.#lane = p.lane;
    this.#now = p.now ?? Date.now; this.#log = p.log ?? defaultLog; this.#ttlMs = p.ttlMs ?? STALE_TTL_MS; this.#repeatMs = p.repeatMs ?? STALE_REPEAT_MS;
  }

  tick(): Promise<Tick> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = (async () => {
      try {
        let r = await this.#pass();
        while (this.#again) { this.#again = false; r = await this.#pass(); }
        return r;
      } finally { this.#running = null; }
    })();
    return this.#running;
  }

  async #pass(): Promise<Tick> {
    const now = this.#now();
    // A decision the inbox has let go (answered, the task still blocked) reads here as any other block, so the sweep
    // takes it; an unanswered one keeps its deadline and stays the inbox's.
    const tasks = this.#tasks().map(t => t.decisionDue !== undefined && this.#answered !== null && this.#answered(t.key, t.decisionDue - DECISION_DUE_MS)
      ? (() => { const { decisionDue: _due, ...plain } = t; return plain; })()
      : t);
    const items = staleTasks(tasks, now, { watched: this.#watched() });
    if (items.length === 0) return { sent: false, items: 0 };
    const list = items.map(i => `${i.key} ${i.status}`).join("\n");
    // An unchanged list is sent at most every repeatMs; a changed one at once. A message that did not go leaves both
    // as they were, so the next pass sends it however long the list has been the same.
    if (this.#sentAt !== null && list === this.#lastList && now - this.#sentAt < this.#repeatMs) return { sent: false, items: items.length };
    // A message that did not go is retried under its own id while its text is unchanged (the fleet answers the same
    // id with other text as id_conflict), and under a fresh one once the text has moved on.
    const text = staleMessage(items);
    const id = this.#pending?.text === text ? this.#pending.id : `board-stale:${now}`;
    const r = await tryDeliver(this.#deliver, { id, lane: this.#lane, text, ttlMs: this.#ttlMs });
    if (!r.went) {
      this.#pending = { id, text };
      this.#log.warn(`board stale: the message to ${this.#lane} did not go (${r.why}); the next pass tries again`);
      return { sent: false, items: items.length };
    }
    this.#pending = null;
    this.#sentAt = now;
    this.#lastList = list;
    return { sent: true, items: items.length };
  }
}
