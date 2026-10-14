// The outbox (ADR-0008 phase C; S4–S8 in docs/domain.md): Commands queued on this device, written down before their
// first attempt, sent one at a time per conversation (parallel across conversations), retried on their own for 2
// minutes, resumed after a reload, and ended by their echo in the conversation. No Svelte and no globals: the store,
// the transport and the timers come in, so a test can reload it, take the network away and run the clock.
// Design reference, not code: Signal-Desktop ts/jobs/JobQueue.std.ts and conversationJobQueue.preload.ts.
import type { QueuedCommand } from "@morndo/protocol";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, advance, canCancel, canRetry, matchEchoes, retryDelay, type CommandDelivery, type Echo, type OutboxRecord } from "./state.ts";
import type { OutboxStore } from "./store.ts";
import { sentTo } from "../manager.ts";

// What one POST came to. "typed": ok, or "duplicate" (typed before), with the typing machine's time of it when it says;
// "wait": a 429 with its Retry-After; "unanswered": no answer of the hub's own (a network error, a proxy's page, or no
// answer within the attempt's time); "refused": the hub's definite no, by its code.
export type PostOutcome =
  | { kind: "typed"; at?: number; delivery?: CommandDelivery }   // delivery: the manager's queue has it (fleet-clients §9.1)
  | { kind: "uncertain" }
  | { kind: "refused"; code: string; status?: number }   // status: the hub's HTTP status, when it answered one
  | { kind: "wait"; ms: number }
  | { kind: "unanswered" };

// A refusal that says nothing was typed, then or now (fleet core §3.1). The hub answers a repeat of a request in doubt
// before it judges anything else: 409 uncertain while the worker's machine can't say, a 5xx when it threw. Only once the
// machine said it never had it does the hub judge the send anew, and then a 404 no_pane, a 403 step_up or any other 409
// is a refusal of a send that was never typed. A 5xx, a 429 or a refusal without a status says nothing of the kind.
// A refusal after the paste (not_submitted) is never one: the text is in the worker's input box and may still be
// submitted, so the entry is never Not sent (ADR-0008, phase C: the hub keeps its row and answers a repeat "uncertain").
export const afterPaste = (o: Extract<PostOutcome, { kind: "refused" }>) => o.status === 409 && o.code === "not_submitted";
const byStatus = (o: Extract<PostOutcome, { kind: "refused" }>) =>
  o.status === 409 || (o.status === 404 && o.code === "no_pane") || (o.status === 403 && o.code === "step_up");
export const definiteRefusal = (o: Extract<PostOutcome, { kind: "refused" }>) => byStatus(o) && !afterPaste(o);

// A sent record, with where the manager's queue has it when the hub says so (fleet-clients §9.1).
function sentRecord(r: OutboxRecord, o: Extract<PostOutcome, { kind: "typed" }>, sentAt: number): OutboxRecord {
  const next: OutboxRecord = { ...r, state: advance(r.state, "sent"), sentAt, typedAt: o.at ?? null, error: null, ...(o.delivery ? { delivery: o.delivery } : {}) };
  // Send again (ADR-0011): the attempt the hub queued once more is "resent", so a later given-up is final. One the hub
  // typed directly instead (the queue switched off) keeps no word from the queue. A later status read is never Send again.
  if (r.again && o.delivery && o.delivery.state !== "given_up") next.resent = true;
  if (r.again && o.delivery?.state === "given_up") next.resendFailed = true;       // still given up: no copy was queued
  if (r.again && !o.delivery) delete next.delivery;
  delete next.again;
  return next;
}

// What the hub said to a Cancel (ruling 83): withdrawn, with where it stands now (given up: cancelled); too late (typed
// meanwhile), with where it stands when the hub says; or no answer of the hub's own (Cancel can be pressed again).
// `unknown`: the hub has no such delivery (its 404): nothing to cancel, and nothing says it was typed; the record stays.
export type CancelOutcome = { kind: "cancelled"; delivery: CommandDelivery } | { kind: "too_late"; delivery: CommandDelivery | null } | { kind: "unknown" } | { kind: "unanswered" };

export type Timers = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

export type NewCommand = { worker: string; workerName: string; text: string; uploads: string[]; seen: string };

const KEEP_SENT_MS = 24 * 3_600_000;               // a Sent entry never echoed is dropped after a day
const ECHOES_KEPT = 2000;                          // echoes already spent, remembered for this page (M1)

export class Outbox {
  #store: OutboxStore;
  #post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>;
  #cancel: ((r: OutboxRecord) => Promise<CancelOutcome>) | null;
  #timers: Timers;
  #connected: () => boolean;
  #onChange: (records: OutboxRecord[], fromRefresh: boolean) => void;
  #newId: () => string;
  #records = new Map<string, OutboxRecord>();
  #running = new Set<string>();                    // workers whose queue is being worked through
  #waiters = new Set<() => void>();                // runners waiting for the connection, a timer, or a change
  #inFlight = new Map<string, AbortController>();  // the POST of each record being sent
  #spent = new Set<string>();                      // echoes that already ended an entry
  #cancelling = new Map<string, Promise<CancelOutcome["kind"] | null>>();   // a Cancel on its way, per record
  #echoing: Promise<void> = Promise.resolve();     // echo matching runs one call at a time
  #disk: Promise<void> = Promise.resolve();        // writes for a record stay in order
  #stopped = false;
  #active: boolean;

  constructor(d: {
    store: OutboxStore; post: (r: OutboxRecord, signal: AbortSignal) => Promise<PostOutcome>; timers: Timers; connected: () => boolean;
    cancel?: (r: OutboxRecord) => Promise<CancelOutcome>;               // the hub's cancel of a message the manager's queue holds
    // `fromRefresh`: the change is what the store already held (another tab's, or a reload's), not this tab's own: the
    // device tells the other tabs of its own changes only (review M5), so a refresh never echoes between them.
    onChange: (records: OutboxRecord[], fromRefresh: boolean) => void; newId?: () => string;
    // false: another tab sends; this one only writes down and shows (activate() when it takes over; review M5).
    active?: boolean;
  }) {
    this.#store = d.store;
    this.#post = d.post;
    this.#cancel = d.cancel ?? null;
    this.#timers = d.timers;
    this.#connected = d.connected;
    this.#onChange = d.onChange;
    this.#newId = d.newId ?? (() => crypto.randomUUID());
    this.#active = d.active ?? true;
  }

  get records(): OutboxRecord[] { return [...this.#records.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)); }

  // Loads what a previous page left (or another tab wrote): a send that was queued or in flight resumes if its 2 minutes
  // aren't over (the same request id, so the hub types it at most once); past them it is Not sent, with Retry. Sent
  // ones wait for their echo; ones never echoed after a day are dropped.
  async start() { await this.refresh(true); }

  async refresh(resume = false) {
    const now = this.#timers.now();
    const before = new Map(this.#records);
    const fresh = new Map<string, OutboxRecord>();
    for (const r of await this.#store.all()) {
      if (r.state === "sent" && now - r.createdAt >= KEEP_SENT_MS) { await this.#store.delete(r.id); continue; }
      let next = r;
      if (resume && (r.state === "sending" || r.state === "queued") && !this.#inFlight.has(r.id)) {
        next = now - r.budgetFrom < BUDGET_MS ? { ...r, state: "queued" } : { ...r, state: advance(r.state, "failed"), error: r.error ?? "closed" };
        if (next !== r) await this.#store.put(next);
      }
      fresh.set(next.id, next);
    }
    // What this tab wrote while the store was read (a message written, a state saved) is newer than what was read: kept,
    // or a message written during a refresh would be dropped from this tab until the next one, and never sent from it.
    for (const [id, r] of this.#records) if (before.get(id) !== r) fresh.set(id, r);
    for (const id of this.#records.keys()) if (!fresh.has(id)) this.#inFlight.get(id)?.abort();   // gone elsewhere
    this.#records = fresh;
    this.#changed(true);
    this.#kickAll();
  }

  activate() { this.#active = true; void this.refresh(true); }

  stop() { this.#stopped = true; for (const c of this.#inFlight.values()) c.abort(); this.#wakeAll(); }

  // S4: written down before the first attempt; returns once it is (and throws if it couldn't be, so the caller keeps
  // the draft: review M6). `held`: written down Not sent with that reason and not posted (a passkey check that failed
  // after its conversation was left: "Not sent: verify", sent on Retry).
  async enqueue(c: NewCommand, held?: string): Promise<OutboxRecord> {
    const now = this.#timers.now();
    const r: OutboxRecord = {
      id: this.#newId(), ...c, createdAt: now, budgetFrom: now, attempts: 0, sentAt: null, typedAt: null,
      ...(held ? { state: "failed" as const, error: held } : { state: "queued" as const, error: null }),
    };
    await this.#store.put(r);
    this.#records.set(r.id, r);
    this.#changed();
    if (!held) this.#kick(r.worker);
    return r;
  }

  // The principal's Retry (S7, S8): only Not sent, only within the Retry window; the same id, and a fresh 2 minutes.
  // On an Uncertain one it is Check again (#check).
  async retry(id: string) {
    const r = this.#records.get(id);
    if (!r || !canRetry(r, this.#timers.now())) return;
    if (r.state === "uncertain") return this.#check(id);
    const renewed: OutboxRecord = { ...r, state: advance(r.state, "queued", true), error: null, budgetFrom: this.#timers.now() };
    delete renewed.again;
    delete renewed.resent;
    delete renewed.resendFailed;
    if (!(await this.#save(renewed))) return;
    this.#kick(r.worker);
  }

  // Check again (fleet core §3.1, §7): one POST of the same request id. The hub asks the worker's machine whether it
  // typed it, and types it now if it never got it; either way it answers ok, and the entry is Sent with the machine's
  // time. A definite refusal (definiteRefusal) means the hub found it never typed and refused it now: Not sent, with
  // that refusal's words, and Retry. Any other answer, or none, leaves it Uncertain, and it is never sent again on its
  // own. Any tab may ask: the hub types a request id at most once (S5).
  async #check(id: string) {
    if (this.#inFlight.has(id) || this.#stopped) return;
    const outcome = await this.#attempt(id, ATTEMPT_TIMEOUT_MS);
    const r = this.#records.get(id);
    if (!r) return;
    if (outcome.kind === "refused" && definiteRefusal(outcome)) {
      await this.#save({ ...r, state: advance(r.state, "failed"), error: outcome.code });
      return;
    }
    if (outcome.kind !== "typed") return;
    if (!(await this.#save(sentRecord(r, outcome, this.#timers.now())))) return;
    this.#kick(r.worker);                                             // what was written after it goes now
  }

  // Where this device's messages to the manager stand in the fleet's queue (the hub's `deliveries` frame, by request id;
  // fleet-clients §9.1): each record it names takes the hub's latest word. One Uncertain (the hub couldn't say it was
  // queued) is Sent once the hub says it has it. A record ends as before: by its echo, or Dismiss.
  async deliveries(items: readonly QueuedCommand[]) {
    for (const item of items) {
      const r = this.#records.get(item.requestId);
      if (!r || (r.state !== "sent" && r.state !== "uncertain")) continue;
      const delivery: CommandDelivery = { state: item.state, waiting: item.waiting, why: item.why };
      if (r.state === "sent" && JSON.stringify(r.delivery) === JSON.stringify(delivery)) continue;
      const sent = r.state === "uncertain" ? { state: advance(r.state, "sent"), sentAt: this.#timers.now(), error: null } : {};
      if (await this.#save({ ...r, ...sent, delivery })) this.#kick(r.worker);
    }
  }

  // The principal's Cancel of a message the manager's queue still holds, not typed yet (ruling 83): the hub withdraws it
  // there, and the record says where it stands (Not delivered: cancelled). Too late: it was typed meanwhile, and says so.
  // Tapped again while the first is on its way, it is the same one: the hub is asked once (staging QA, 2026-10-12).
  cancel(id: string): Promise<CancelOutcome["kind"] | null> {
    const going = this.#cancelling.get(id);
    if (going) return going;
    const once = this.#cancelOnce(id).finally(() => this.#cancelling.delete(id));
    this.#cancelling.set(id, once);
    return once;
  }

  async #cancelOnce(id: string): Promise<CancelOutcome["kind"] | null> {
    const r = this.#records.get(id);
    if (!r || !canCancel(r) || !this.#cancel) return null;
    const c = await this.#cancel(r);
    const now = this.#records.get(id);
    if (now && c.kind === "cancelled") await this.#save({ ...now, delivery: c.delivery });
    // A frame during the cancel may already have said delivered or given up. That stands: the 409's delivery, or the
    // typed fallback, must not put the card back to Queued.
    const stood = now?.delivery?.state;
    if (now && c.kind === "too_late" && stood !== "delivered" && stood !== "uncertain" && stood !== "given_up") {
      await this.#save({ ...now, delivery: c.delivery ?? { state: "queued", waiting: "typed", why: null } });
    }
    return c.kind;
  }

  // Send again on the phone (ADR-0011): a message to the manager the queue gave up goes again under the same request id,
  // flagged, so the hub queues it once more as the next attempt (steering-service #sendAgain). Once: a second copy given
  // up is final. A plain repeat of the request id is a status read and never queues anything.
  async again(id: string) {
    const r = this.#records.get(id);
    if (!r || r.state !== "sent" || r.delivery?.state !== "given_up" || r.resent || r.resendFailed) return;
    const next: OutboxRecord = { ...r, state: "queued", error: null, budgetFrom: this.#timers.now(), sentAt: null, typedAt: null, again: true };
    delete next.hubAt;
    if (!(await this.#save(next))) return;
    this.#kick(r.worker);
  }

  // Discard: gone for good, its POST (if any) abandoned, and the next one of its conversation goes (H3, L3).
  async discard(id: string) {
    const r = this.#records.get(id);
    if (!r) return;
    this.#records.delete(id);
    this.#inFlight.get(id)?.abort();
    await this.#store.delete(id);
    this.#changed();
    this.#wakeAll();
    this.#kick(r.worker);
  }

  // The feed is live again, or the browser is online: whoever waits tries now.
  connected() { this.#wakeAll(); }

  // The principal's messages as the conversation shows them: each ends at most one Sent record (S8), and an echo that
  // ended one never ends another, however often the conversation is read (M1). The screen drops the entry before the
  // disk delete: the echo is already in the conversation, and a slow disk must not keep the pending copy up.
  // `name`: the conversation's worker name; the manager's also ends what was written while it had no window.
  echoes(worker: string, echoes: Echo[], name = ""): Promise<void> {
    this.#echoing = this.#echoing.then(async () => {
      const matched = matchEchoes(this.records.filter(r => sentTo(r, { id: worker, name })), echoes, this.#spent);
      const drop: string[] = [];
      for (const [id, echo] of matched) {
        this.#spent.add(echo);
        this.#records.delete(id);
        drop.push(id);
      }
      if (this.#spent.size > ECHOES_KEPT) this.#spent = new Set([...this.#spent].slice(-ECHOES_KEPT / 2));
      if (matched.size) this.#changed();
      if (drop.length) await this.#onDisk(async () => { for (const id of drop) await this.#store.delete(id); });
    }).catch(() => {});
    return this.#echoing;
  }

  // Saves a record only if it is still there: another tab may have discarded it (M5). The screen hears the new state
  // before the disk write, so an echo already in the conversation can end the entry without waiting on that write.
  // Returns whether this version stood (false: it was gone, so the caller must not carry on).
  async #save(r: OutboxRecord): Promise<boolean> {
    if (!this.#records.has(r.id)) return false;
    this.#records.set(r.id, r);
    this.#changed();
    let stood = true;
    await this.#onDisk(async () => {
      if (this.#records.get(r.id) !== r) return;                         // an echo, or a newer save, already took over
      if (!(await this.#store.get(r.id))) {
        if (this.#records.get(r.id) === r) { this.#records.delete(r.id); this.#changed(); stood = false; }
        return;
      }
      if (this.#records.get(r.id) !== r) return;
      await this.#store.put(r);
    });
    return stood;
  }

  // One disk write at a time, in the order they were asked: a sent row must not land after the echo that ended it.
  #onDisk(work: () => Promise<void>): Promise<void> {
    const run = this.#disk.then(work, work);
    this.#disk = run.then(() => {}, () => {});
    return run;
  }

  #changed(fromRefresh = false) { this.#onChange(this.records, fromRefresh); }

  #wakeAll() { const w = [...this.#waiters]; this.#waiters.clear(); for (const f of w) f(); }

  // Waits `ms`, or until something changes (connected, a discard, stop), whichever is first.
  #sleep(ms: number) {
    return new Promise<void>(resolve => {
      let id: unknown = null;
      const wake = () => { this.#waiters.delete(wake); if (id !== null) this.#timers.clearTimeout(id); resolve(); };
      this.#waiters.add(wake);
      id = this.#timers.setTimeout(wake, Math.max(0, ms));
    });
  }

  #kickAll() { for (const w of new Set(this.records.map(r => r.worker))) this.#kick(w); }

  // One runner per worker: its Commands in the order they were written, one at a time (S4).
  #kick(worker: string) {
    if (this.#running.has(worker) || this.#stopped || !this.#active) return;
    this.#running.add(worker);
    void this.#run(worker).finally(() => {
      this.#running.delete(worker);
      if (!this.#stopped && this.#next(worker)) this.#kick(worker);
    });
  }

  // The next Command to send for a worker, or null. One that ended Not sent or Uncertain holds the ones written after it
  // until Retry or Discard, so the agent never gets them out of order (review M3).
  #next(worker: string): OutboxRecord | null {
    for (const r of this.records) {
      if (r.worker !== worker || r.state === "sent") continue;
      return r.state === "queued" || r.state === "sending" ? r : null;
    }
    return null;
  }

  async #run(worker: string) {
    for (;;) {
      if (this.#stopped || !this.#active) return;
      const next = this.#next(worker);
      if (!next) return;
      await this.#deliver(next.id);
    }
  }

  async #deliver(id: string) {
    let unanswered = 0;
    let lastProblem = "unanswered";
    for (;;) {
      const r = this.#records.get(id);
      if (!r || this.#stopped) return;
      const left = BUDGET_MS - (this.#timers.now() - r.budgetFrom);
      if (left <= 0) { await this.#save({ ...r, state: advance(r.state, "failed"), error: lastProblem === "unanswered" ? "timeout" : lastProblem }); return; }
      if (!this.#connected()) {                                       // Queued (offline): the budget keeps running
        if (r.state !== "queued" && !(await this.#save({ ...r, state: "queued" }))) return;
        await this.#sleep(left);
        continue;
      }
      if (!(await this.#save({ ...r, state: advance(r.state, "sending"), attempts: r.attempts + 1 }))) return;
      const outcome = await this.#attempt(id, Math.min(left, ATTEMPT_TIMEOUT_MS));
      const now = this.#records.get(id);
      if (!now) return;                                               // discarded meanwhile
      switch (outcome.kind) {
        case "typed": {
          await this.#save(sentRecord(now, outcome, this.#timers.now()));
          return;
        }
        case "uncertain": await this.#save({ ...now, state: advance(now.state, "uncertain"), error: "uncertain" }); return;
        case "refused": {
          // A Send again the hub will never queue (expired uploads, empty or too-long body) is final: Sent and given up as
          // it stood, with no Send again left, not a failure the budget keeps retrying.
          if (outcome.code === "cannot_resend") {
            const saved: OutboxRecord = { ...now, state: "sent", resendFailed: true, error: null, sentAt: now.sentAt ?? this.#timers.now() };
            delete saved.again;
            delete saved.resent;
            await this.#save(saved);
            return;
          }
          const failed: OutboxRecord = { ...now, state: advance(now.state, afterPaste(outcome) ? "uncertain" : "failed"), error: outcome.code };
          delete failed.again;
          delete failed.resent;
          await this.#save(failed);
          return;
        }
        case "wait":
          lastProblem = "rate_limited";
          await this.#sleep(Math.max(1000, outcome.ms));
          continue;
        case "unanswered":
          lastProblem = "unanswered";
          await this.#sleep(retryDelay(unanswered++));
          continue;
      }
    }
  }

  // One POST, given up after `ms` (a stalled connection never answers; review H3) or when the record is discarded.
  async #attempt(id: string, ms: number): Promise<PostOutcome> {
    const r = this.#records.get(id);
    if (!r) return { kind: "unanswered" };
    const control = new AbortController();
    this.#inFlight.set(id, control);
    const timer = this.#timers.setTimeout(() => control.abort(), ms);
    const given = new Promise<PostOutcome>(resolve => control.signal.addEventListener("abort", () => resolve({ kind: "unanswered" })));
    try { return await Promise.race([this.#post(r, control.signal).catch((): PostOutcome => ({ kind: "unanswered" })), given]); }
    finally { this.#timers.clearTimeout(timer); this.#inFlight.delete(id); }
  }
}
