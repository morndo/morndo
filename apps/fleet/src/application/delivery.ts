// The hook bus's delivery (spec 5.6): each stored event is POSTed as JSON to each of its subscribers with
// `Idempotency-Key: <node>:<streamId>:<seq>`, at least once, in seq order per (subscriber, node, streamId): one request
// in flight per stream and subscriber, the next only after the previous one is delivered or dead. Streams and
// subscribers don't wait for each other.
//   - 2xx: delivered.
//   - 408, 429, 5xx, no answer: retried with exponential backoff (base·2^(n-1), capped, halved by jitter at most);
//     after LIMITS.deadLetterAttempts attempts, a dead letter.
//   - any other 4xx: a dead letter at once (the subscriber refused it; a retry would be refused too).
//   - A dead letter raises a dead_letter alert once per subscriber episode: the first since that subscriber's last
//     successful delivery (or since start); later ones are kept and counted (`morndo-fleet status`), not alerted, so a
//     subscriber that refuses everything can't bury the other alerts.
// The subscriber contract (fleet clients spec §6; docs/fleet-api.md): a subscriber answers 2xx once it has the event and
// never refuses one for a reason of its own downstream (a blocked chat service, a failed handler): it keeps what it
// can't act on yet and acts later. The bus's side: each stream in order, one event in flight, so a refused event holds
// up the ones behind it; `outcomeOf` is the whole classification. A subscriber whose oldest undelivered event is older
// than LIMITS.subscriberLagMs (60 s, by the time it was stored) raises subscriber_lagging, once per episode: the next one
// only after nothing of it was that old (checked every tick). Its detail: { subscriber, oldestAgeMs, streams }, streams
// being how many streams have an event waiting for it (reconciliation ruling 25); its node, the oldest event's.
// A retry time is stored on the wall clock; one further away than the longest backoff can only come from a clock that
// jumped back, and is due at once (Review Focus 4). On start: rows of subscribers no longer configured are deleted;
// every hour: outbox rows LIMITS.outboxKeepMs after their last delivery, and dead letters as long after they died
// (spec 8: hook bodies are kept only until delivery plus 24 h). A tick, the hourly clean-up or the start of a stream's
// next delivery that meets a busy or full fleet.db is logged and tried again later, never thrown out of its timer.
// fetch is Node's built-in (undici): https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch;
// AbortSignal.any/timeout: https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal (read 2026-10-06).
import { LIMITS } from "@morndo/protocol";
import type { Subscriber } from "../config.ts";
import type { Audit } from "../adapters/audit.ts";
import type { Logger } from "../adapters/log.ts";
import type { Delivery, Floors, OutboxStore } from "../adapters/outbox-store.ts";

export type Post = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;
export type Backoff = { baseMs: number; maxMs: number };

export const BACKOFF: Backoff = { baseMs: 1000, maxMs: 600_000 };
export const POST_TIMEOUT_MS = 10_000;
export const DEAD_LETTER_KEEP_MS = LIMITS.outboxKeepMs;
const GC_EVERY_MS = 3_600_000;

export const httpPost: Post = async (url, body, headers, signal) => {
  const r = await fetch(url, { method: "POST", body, headers, redirect: "manual", signal });
  await r.body?.cancel();
  return r.status;
};

const streamKey = (subscriber: string, node: string, streamId: string) => `${subscriber}\n${node}\n${streamId}`;

// What an answer means (the subscriber contract): 2xx delivered; any other 4xx than 408 and 429 dead at once (the
// subscriber refused it, and would again); everything else (408, 429, 5xx, no answer, anything unexpected) tried again
// later, up to LIMITS.deadLetterAttempts. RFC 9110 §15.5.9 and RFC 6585 §4 invite a retry of 408 and 429.
export function outcomeOf(status: number | null): "delivered" | "retry" | "dead" {
  if (status !== null && status >= 200 && status < 300) return "delivered";
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "dead";
  return "retry";
}

export class DeliveryWorker {
  #store: OutboxStore;
  #subscribers: Subscriber[];
  #audit: Audit;
  #log: Logger;
  #post: Post;
  #now: () => number;
  #random: () => number;
  #backoff: Backoff;
  #tickMs: number;
  #inflight = new Map<string, Promise<void>>();
  #abort = new AbortController();
  #timers: ReturnType<typeof setInterval>[] = [];
  #deadEpisodes = new Set<string>();                    // subscribers alerted since their last successful delivery
  #lagging = new Set<string>();                         // subscribers alerted lagging, until none of theirs is that old
  // Per stream and subscriber: outcome writes fleet.db refused in a row, and until when that stream waits (B6 V39).
  #storeFailures = new Map<string, { n: number; until: number }>();
  // Per stream and subscriber: a seq below which none of the stream's rows is pending for the subscriber, where its next
  // seek starts (B6 EF2). In memory: after a restart the first round seeks each stream from 0, once.
  #floors = new Map<string, number>();
  #kicked = false;
  #stopped = false;

  constructor(p: {
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; log: Logger; post?: Post; now?: () => number; random?: () => number;
    backoff?: Backoff; tickMs?: number;
  }) {
    this.#store = p.store;
    this.#subscribers = p.subscribers;
    this.#audit = p.audit;
    this.#log = p.log;
    this.#post = p.post ?? httpPost;
    this.#now = p.now ?? Date.now;
    this.#random = p.random ?? Math.random;
    this.#backoff = p.backoff ?? BACKOFF;
    this.#tickMs = p.tickMs ?? 1000;
  }

  start(): void {
    const removed = this.#store.forgetSubscribersExcept(this.#subscribers.map(s => s.name));
    if (removed > 0) this.#audit.record("fleet", "subscriber.removed", null, { rows: removed });
    this.#safely("removing old delivered events", () => this.gc());
    this.#timers.push(setInterval(() => this.#tick(), this.#tickMs), setInterval(() => this.#safely("removing old delivered events", () => this.gc()), GC_EVERY_MS));
    this.#tick();
  }

  // Timers and callbacks that read or write fleet.db go through here: a busy or full database fails that round, logged,
  // and the next one tries again. A throw would escape a setInterval or a promise's finally and end the service.
  #safely(what: string, f: () => void): void {
    try { f(); } catch (e) { this.#log.error(`hook bus: ${what} failed (fleet.db busy or full?); trying again later`, e); }
  }

  #tick(): void {
    this.#safely("a delivery round", () => this.runOnce());
    this.#safely("the lag check", () => this.checkLag());
  }

  // subscriber_lagging, once per episode per subscriber.
  checkLag(): void {
    const now = this.#now();
    for (const s of this.#subscribers) {
      const oldest = this.#store.oldestPending(s.name);
      const ageMs = oldest === null ? 0 : now - oldest.createdAt;
      if (ageMs <= LIMITS.subscriberLagMs) { this.#lagging.delete(s.name); continue; }
      if (this.#lagging.has(s.name) || oldest === null) continue;
      this.#lagging.add(s.name);
      this.#audit.alert("subscriber_lagging", oldest.node, { subscriber: s.name, oldestAgeMs: ageMs, streams: this.#store.pendingStreams(s.name) });
    }
  }

  // Aborts what is in flight (those rows stay pending and go again after a restart) and waits for it to settle.
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#abort.abort();
    await Promise.all(this.#inflight.values());
  }

  // Soon, once, however often it is asked (new events were stored).
  kick(): void {
    if (this.#kicked || this.#stopped) return;
    this.#kicked = true;
    setImmediate(() => { this.#kicked = false; this.#tick(); });
  }

  // Starts every due head of every stream that has nothing in flight; returns how many started.
  runOnce(): number {
    if (this.#stopped) return 0;
    let started = 0;
    for (const s of this.#subscribers) for (const d of this.#store.heads(s.name, this.#floorsOf(s.name))) if (this.#start(s, d)) started++;
    return started;
  }

  #floorsOf(subscriber: string): Floors {
    return {
      of: (node, streamId) => this.#floors.get(streamKey(subscriber, node, streamId)) ?? 0,
      set: (node, streamId, floor) => { this.#floors.set(streamKey(subscriber, node, streamId), floor); },
    };
  }

  get inflight(): number { return this.#inflight.size; }

  gc(): void {
    const now = this.#now();
    const rows = this.#store.gc(now, LIMITS.outboxKeepMs);
    const dead = this.#store.pruneDeadLetters(now - DEAD_LETTER_KEEP_MS);
    if (rows || dead) this.#log.info(`hook bus: removed ${rows} delivered events and ${dead} old dead letters`);
  }

  #due(d: Delivery): boolean {
    const wait = d.nextAt - this.#now();
    return wait <= 0 || wait > this.#backoff.maxMs;
  }

  // A stream whose last outcome fleet.db refused waits; a wait further off than the longest backoff can only come from a
  // clock that jumped back, and is over (as #due has it).
  #held(k: string): boolean {
    const f = this.#storeFailures.get(k);
    if (!f) return false;
    const wait = f.until - this.#now();
    return wait > 0 && wait <= this.#backoff.maxMs;
  }

  #start(s: Subscriber, d: Delivery): boolean {
    const k = streamKey(s.name, d.node, d.streamId);
    if (this.#stopped || this.#inflight.has(k) || !this.#due(d) || this.#held(k)) return false;
    let recorded = true;
    const run = this.#deliver(s, d)
      .then(() => { this.#storeFailures.delete(k); })
      .catch((e: unknown) => {
        // The outcome couldn't be written (fleet.db busy or full): the row is still pending as it was, so starting it
        // again at once would POST the same event in a tight loop. The stream waits base·2^(n-1), capped, and a tick
        // after that starts it (AWS Builders' Library, "Timeouts, retries, and backoff with jitter": "Instead of
        // retrying immediately and aggressively, the client waits some amount of time between tries", read 2026-10-07).
        recorded = false;
        const n = (this.#storeFailures.get(k)?.n ?? 0) + 1;
        const wait = Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** (n - 1));
        this.#storeFailures.set(k, { n, until: this.#now() + wait });
        this.#log.error(`hook bus: delivering to ${s.name} failed (fleet.db busy or full?); that stream waits ${wait} ms`, e);
      })
      .finally(() => {
        this.#inflight.delete(k);
        if (!recorded) return;                            // held: a tick after its wait starts it again
        this.#floors.set(k, d.seq);                       // nothing of this stream below d is pending any more
        // The stream's next event at once; if the store fails here, the next tick starts it.
        this.#safely(`starting the next delivery to ${s.name}`, () => {
          const next = this.#stopped ? null : this.#store.next(s.name, d.node, d.streamId, d.seq);
          if (next) this.#start(s, next);
        });
      });
    this.#inflight.set(k, run);
    return true;
  }

  async #deliver(s: Subscriber, d: Delivery): Promise<void> {
    let status: number | null = null;
    let failure = "";
    try {
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(POST_TIMEOUT_MS)]);
      status = await this.#post(s.url, d.body, { "content-type": "application/json", "idempotency-key": `${d.node}:${d.streamId}:${d.seq}` }, signal);
    } catch (e) {
      if (this.#abort.signal.aborted) return;                // stopping: stays pending, goes again after the restart
      failure = e instanceof Error ? e.name : "error";
    }
    const now = this.#now();
    const outcome = outcomeOf(status);
    if (outcome === "delivered") { this.#store.delivered(d.outboxId, s.name, now); this.#deadEpisodes.delete(s.name); return; }
    const attempts = d.attempts + 1;
    const reason = status === null ? `no answer (${failure})` : `HTTP ${status}`;
    if (outcome === "dead" || attempts >= LIMITS.deadLetterAttempts) {
      this.#store.deadLetter(d, reason, attempts, now);
      if (!this.#deadEpisodes.has(s.name)) {
        this.#deadEpisodes.add(s.name);
        this.#audit.alert("dead_letter", d.node, { subscriber: s.name, streamId: d.streamId, seq: d.seq, path: d.path, reason, attempts });
      }
      return;
    }
    const delay = Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** (attempts - 1)) * (0.5 + this.#random() / 2);
    this.#store.retry(d.outboxId, s.name, attempts, now + Math.round(delay));
  }
}
