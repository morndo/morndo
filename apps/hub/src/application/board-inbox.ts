// Application watchers for B19, B20 and B23 (ADR-0040, ADR-0042), on the model of wait-watch.ts: a pass never overlaps
// another, the clock and the log are injected, and both send through a port, never typing anything themselves.
// - The decision inbox (B19) tells the manager, on its lane, every open decision with its deadline: at most once an
//   hour while any wait, and again at the next pass when a message did not go. It also tells the principal, once for
//   each decision that goes overdue (tracked by key and deadline in memory, so a restart may tell twice — the lane's
//   hourly message is the backstop); a push that fails is logged and never stops the message to the lane.
// - The stale sweep (B20) sends the manager the tasks nobody changed for 48 h that the board watches nothing on: at
//   once when the list of them changed, at most every 12 h while it is unchanged, and again at the next pass when a
//   message did not go.
// - The merged sweep (B23) sends the manager the open tasks whose pull request merged without a merge record, on the
//   same rhythm as the stale sweep; nothing moves and nothing is recorded (the flag is a list, D5, B11).
// The domain says what waits (board-stale.ts, board-merged.ts); these only read the board, build the id and the text,
// and ask the port.
import { INBOX_EVERY_MS, STALE_BLOCK_MS, STALE_REPEAT_MS, answeredOnce, inboxItems, inboxMessage, mergedMessage, staleMessage, staleTasks, type MergedFlag, type Task, type TaskKey } from "@morndo/domain";
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

// B20, B23: the rhythm the stale sweep and the merged sweep share — a list that changed goes at once, one that is the
// same goes at most every `repeatMs`, and a message that did not go is tried again at the next pass under its own id
// while its text is unchanged (the fleet answers the same id with other text as id_conflict) and under a fresh one
// once the text has moved on. The caller computes the list and the text; this holds only what "unchanged" and
// "pending" mean. `forget()`: the list went away, so whatever comes next is a change — the stale sweep never calls it
// (an empty stale list is no news); the merged sweep does (B23: a flag that goes away and comes back is news again).
class GatedSweep {
  #deliver: DeliverText;
  #lane: string;
  #now: () => number;
  #log: Warn;
  #ttlMs: number;
  #repeatMs: number;
  #prefix: string;
  #label: string;
  #sentAt: number | null = null;               // the pass's now of the last message that went
  #lastList: string | null = null;             // that message's list: what "unchanged" means
  #pending: { id: string; text: string } | null = null;   // the message that did not go: retried under its id, its text unchanged

  constructor(p: { deliver: DeliverText; lane: string; now: () => number; log: Warn; ttlMs: number; repeatMs: number; prefix: string; label: string }) {
    this.#deliver = p.deliver; this.#lane = p.lane; this.#now = p.now; this.#log = p.log; this.#ttlMs = p.ttlMs; this.#repeatMs = p.repeatMs;
    this.#prefix = p.prefix; this.#label = p.label;
  }

  forget(): void { this.#lastList = null; }

  // `count`: how many items the list holds (what a pass reports when it sends nothing); `list`: the lines that say
  // whether it changed; `text`: the message itself.
  async send(count: number, list: string, text: string): Promise<Tick> {
    const now = this.#now();
    if (this.#sentAt !== null && list === this.#lastList && now - this.#sentAt < this.#repeatMs) return { sent: false, items: count };
    const id = this.#pending?.text === text ? this.#pending.id : `${this.#prefix}:${now}`;
    const r = await tryDeliver(this.#deliver, { id, lane: this.#lane, text, ttlMs: this.#ttlMs });
    if (!r.went) {
      this.#pending = { id, text };
      this.#log.warn(`${this.#label}: the message to ${this.#lane} did not go (${r.why}); the next pass tries again`);
      return { sent: false, items: count };
    }
    this.#pending = null;
    this.#sentAt = now;
    this.#lastList = list;
    return { sent: true, items: count };
  }
}

// B20: the stale sweep.
export class StaleSweep {
  #tasks: () => readonly Task[];
  #watched: (answered?: (key: TaskKey, since: number) => boolean) => ReadonlySet<string>;
  #answered: ((key: TaskKey, since: number) => boolean) | null;
  #now: () => number;
  #gate: GatedSweep;
  #running: Promise<Tick> | null = null;
  #again = false;

  // `answered` (B19): a decision the manager answered while the task stays blocked is not the inbox's any more — it
  // goes back to being swept like any block that sits, so it is never lost between the two. `watched` receives that
  // predicate for the pass (a caller that takes none still works): the rule runs once per decision, for the watched
  // set and the list together.
  constructor(p: { tasks: () => readonly Task[]; watched: (answered?: (key: TaskKey, since: number) => boolean) => ReadonlySet<string>; answered?: (key: TaskKey, since: number) => boolean; deliver: DeliverText; lane: string; now?: () => number; log?: Warn; ttlMs?: number; repeatMs?: number }) {
    this.#tasks = p.tasks; this.#watched = p.watched; this.#answered = p.answered ?? null; this.#now = p.now ?? Date.now;
    this.#gate = new GatedSweep({ deliver: p.deliver, lane: p.lane, now: this.#now, log: p.log ?? defaultLog, ttlMs: p.ttlMs ?? STALE_TTL_MS, repeatMs: p.repeatMs ?? STALE_REPEAT_MS, prefix: "board-stale", label: "board stale" });
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
    // A decision the inbox has let go (answered, the task still blocked) is swept like any block that sits; an
    // unanswered one keeps its deadline and stays the inbox's. The rule is asked only of a task idle STALE_BLOCK_MS,
    // and only once in the pass, for the watched set and the list together.
    const tasks = this.#tasks();
    const raw = this.#answered;
    const idleEnough = raw === null ? undefined : (key: TaskKey, since: number): boolean => {
      const task = tasks.find(t => t.key === key);
      if (task !== undefined && now - task.updatedAt < STALE_BLOCK_MS) return false;
      return raw(key, since);
    };
    const answered = idleEnough === undefined ? undefined : answeredOnce(idleEnough);
    const items = staleTasks(tasks, now, { watched: this.#watched(answered), ...(answered !== undefined ? { answered } : {}) });
    if (items.length === 0) return { sent: false, items: 0 };
    return this.#gate.send(items.length, items.map(i => `${i.key} ${i.status}`).join("\n"), staleMessage(items));
  }
}

// B23 (ADR-0042): the merged sweep — the open tasks whose pull request merged without a merge record, as the merge
// watch flags them now (live, from the last pass's facts against the board as it stands), told to the manager's lane
// in one message after each of the watch's passes (mergedPass, merge-watch.ts: never before the pass it follows).
// Same rhythm as the stale sweep, and a list that went away and came back is news again. It moves nothing and records
// nothing: the message says so itself.
export class MergedSweep {
  #flags: () => readonly MergedFlag[];
  #gate: GatedSweep;
  #running: Promise<Tick> | null = null;
  #again = false;

  constructor(p: { flags: () => readonly MergedFlag[]; deliver: DeliverText; lane: string; now?: () => number; log?: Warn; ttlMs?: number; repeatMs?: number }) {
    this.#flags = p.flags;
    this.#gate = new GatedSweep({ deliver: p.deliver, lane: p.lane, now: p.now ?? Date.now, log: p.log ?? defaultLog, ttlMs: p.ttlMs ?? STALE_TTL_MS, repeatMs: p.repeatMs ?? STALE_REPEAT_MS, prefix: "board-merged", label: "board merged" });
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
    const flags = this.#flags();
    if (flags.length === 0) { this.#gate.forget(); return { sent: false, items: 0 }; }
    return this.#gate.send(flags.length, flags.map(f => [f.key, ...f.prs.map(p => `${p.repo}#${p.n}`)].join("|")).join("\n"), mergedMessage(flags));
  }
}
