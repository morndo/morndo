// Application service for Notifications (ADR-0008 phase F; N1–N5 in docs/domain.md): it hears a Decision start
// waiting, a worker start needing the principal and a device being linked, waits a second per kind (the latest
// wins), and then, unless he is attending on any device, sends the counts, numbers only, to every Push subscription.
// A push service answering 404 or 410 drops that subscription (N4). It grants and starts nothing (N5): it reads the
// board and the roster and writes only push_subscriptions and the audit's Notification rows.
import { NotificationQueue, anyAttending, payloadOf, raises, reasonCode, suppressedWhileAttending, type AttendingReport, type Counts, type NotificationEvent, type NotificationKind } from "@morndo/domain";
import { UNUSABLE_KEY, isP256Point, isPushService, type PushOptions, type PushResult, type PushSender, type PushSubscription } from "../adapters/webpush.ts";
import { log } from "../adapters/log.ts";

export type PushStore = {
  pushSubscriptions(): ({ endpointId: string } & PushSubscription)[];
  savePushSubscription(endpointId: string, s: PushSubscription, at: number): void;
  deletePushSubscription(endpointId: string): boolean;
  record(events: NotificationEvent[]): void;
};
export type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

// How long a push service keeps it for an offline device, and how urgently it delivers (RFC 8030 sections 5.2, 5.3).
// The topic is the kind's name: a newer one of the same kind replaces one still waiting there (section 5.4). At most 32
// URL-safe Base64 characters, of a length that decodes as Base64 (never 1 mod 4): Apple's push service refused "alert"
// (2026-10-12) and "usage" (2026-10-25), both 5 characters, with 400 BadWebPushTopic, so the topics are "alerts" and
// "usages".
const OPTIONS: Record<NotificationKind, PushOptions> = {
  decision: { ttlSeconds: 12 * 3600, topic: "decision", urgency: "high" },
  worker: { ttlSeconds: 3600, topic: "worker", urgency: "normal" },
  linked: { ttlSeconds: 3600, topic: "linked", urgency: "high" },
  alert: { ttlSeconds: 6 * 3600, topic: "alerts", urgency: "high" },
  usage: { ttlSeconds: 6 * 3600, topic: "usages", urgency: "normal" },
};
const delivered = (status: number) => status >= 200 && status < 300;

export class NotificationService {
  #store: PushStore;
  #send: PushSender;
  #now: () => number;
  #timers: Timers;
  #muted: (workerId: string) => boolean;
  #alerts: () => number;                               // urgent fleet alerts he hasn't seen
  #extraOrigins: readonly string[];
  #queue = new NotificationQueue();
  #reports = new Map<string, AttendingReport>();       // per feed connection
  #waiting: Set<string> | null = null;                 // the Decisions waiting, by id; null until the first board
  #needing = new Map<string, boolean>();               // per worker: whether it needs him with something that isn't an Ask
  #linked = 0;                                         // devices linked since the last such Notification went
  #usageNotices = 0;                                   // usage notices the hub wrote since the last such Notification went (S4)
  #timer: unknown = null;
  #sending: Promise<void> = Promise.resolve();

  // `extraOrigins`: push services a test runs, besides the browsers' own (never set in production).
  constructor(d: { store: PushStore; send: PushSender; now?: () => number; timers?: Timers; muted?: (workerId: string) => boolean; extraOrigins?: readonly string[]; alerts?: () => number }) {
    this.#store = d.store;
    this.#send = d.send;
    this.#now = d.now ?? Date.now;
    this.#timers = d.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) };
    this.#muted = d.muted ?? (() => false);
    this.#alerts = d.alerts ?? (() => 0);
    this.#extraOrigins = d.extraOrigins ?? [];
  }

  // N4: one subscription per Endpoint, replaced by a new one; only a browser vendor's push service, so a session can't
  // make the hub post to an address of its choosing. The keys must have the sizes RFC 8291 gives them.
  subscribe(endpointId: string, s: PushSubscription): { ok: true } | { refused: "not_a_push_service" | "bad_keys" } {
    if (!isPushService(s.endpoint, this.#extraOrigins)) return { refused: "not_a_push_service" };
    if (!isP256Point(Buffer.from(s.p256dh, "base64url")) || Buffer.from(s.auth, "base64url").length !== 16) return { refused: "bad_keys" };
    const at = this.#now();
    this.#store.savePushSubscription(endpointId, s, at);
    this.#store.record([{ type: "PushSubscribed", endpointId, at }]);
    return { ok: true };
  }
  unsubscribe(endpointId: string) {
    if (this.#store.deletePushSubscription(endpointId)) this.#store.record([{ type: "PushUnsubscribed", endpointId, reason: "device", at: this.#now() }]);
  }
  subscribed(endpointId: string) { return this.#store.pushSubscriptions().some(s => s.endpointId === endpointId); }

  // The board, whole, each time it changes. A Decision id not seen before starts waiting; the first board only tells
  // what already waits (a restart raises nothing).
  board(items: readonly { id: string; status: string; need: string }[]) {
    const now = new Set(items.filter(i => i.status === "open" && i.need === "decision").map(i => i.id));
    const fresh = this.#waiting !== null && [...now].some(id => !this.#waiting?.has(id));
    this.#waiting = now;
    if (fresh && raises({ kind: "decision", waiting: now.size })) this.#raise("decision");
  }

  // A worker's needs-you state: the roster at start (`initial`), then each change. `waitingOn`: the question or menu it
  // waits on, which is an Ask on the board and raises a Decision there; null: a need that isn't an Ask.
  worker(workerId: string, needsYou: boolean, waitingOn: string | null, initial = false) {
    const isAsk = waitingOn !== null && waitingOn !== "none";
    const was = this.#needing.get(workerId) ?? false;
    this.#needing.set(workerId, needsYou && !isAsk);
    if (!initial && raises({ kind: "worker", needsYou, was, muted: this.#muted(workerId), isAsk })) this.#raise("worker");
  }
  workerGone(workerId: string) { this.#needing.delete(workerId); }

  linked() {
    this.#linked++;
    if (raises({ kind: "linked" })) this.#raise("linked");
  }

  // A fleet alert came in (AlertsService): an urgent one raises a Notification, counts only (N1).
  alert(urgent: boolean) {
    if (raises({ kind: "alert", urgent })) this.#raise("alert");
  }

  // A usage notice the hub itself wrote (S4, plan 4.4): one more is counted, and one Notification is raised — the
  // debounce and the reset-on-send work as `linked` does.
  usage() {
    this.#usageNotices++;
    if (raises({ kind: "usage" })) this.#raise("usage");
  }

  // What each device's app says about the principal using it (N3); a connection that closes says nothing any more.
  attending(connection: string, attending: boolean) { this.#reports.set(connection, { attending, at: this.#now() }); }
  left(connection: string) { this.#reports.delete(connection); }

  counts(): Counts {
    const workers = [...this.#needing].filter(([id, needs]) => needs && !this.#muted(id)).length;
    return { decisions: this.#waiting?.size ?? 0, workers, linked: this.#linked, alerts: this.#alerts(), usage: this.#usageNotices };
  }

  // Resolves once everything due has been sent (for tests and an orderly stop).
  settled(): Promise<void> { return this.#sending; }

  stop() { if (this.#timer !== null) this.#timers.clearTimeout(this.#timer); this.#timer = null; }

  #raise(kind: NotificationKind) {
    this.#queue.raise(kind, this.counts(), this.#now());
    this.#arm();
  }

  #arm() {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    const next = this.#queue.next;
    this.#timer = next === null ? null : this.#timers.setTimeout(() => {
      this.#timer = null;
      // Whatever one round throws is logged, never left to end the hub or stop every later round (review H1).
      this.#sending = this.#sending.then(() => this.#flush()).catch((e: unknown) => log.error("sending notifications failed", e));
    }, Math.max(0, next - this.#now()));
  }

  async #flush() {
    const now = this.#now();
    const due = this.#queue.due(now);
    this.#arm();
    if (!due.length) return;
    const attending = anyAttending(this.#reports.values(), now);       // he is looking at it: nothing goes (N3)…
    for (const p of due) {
      if (attending && suppressedWhileAttending(p.kind)) continue;     // …but a device linked always does (review M2)
      const counts = this.counts();                                  // as things are now, not as they were a second ago
      const relevant = p.kind === "decision" ? counts.decisions : p.kind === "worker" ? counts.workers : p.kind === "alert" ? counts.alerts : p.kind === "usage" ? counts.usage : counts.linked;
      if (p.kind === "linked") this.#linked = 0;
      if (p.kind === "usage") this.#usageNotices = 0;
      if (relevant === 0) continue;                                  // answered meanwhile: nothing to say
      const payload = Buffer.from(JSON.stringify(payloadOf(p.kind, counts)));
      let sent = 0;
      for (const s of this.#store.pushSubscriptions()) {
        const r = await this.#send(s, payload, OPTIONS[p.kind]).catch((): PushResult => ({ status: 0 }));
        const at = this.#now();
        if (delivered(r.status)) sent++;
        else if (r.status === 404 || r.status === 410 || r.status === UNUSABLE_KEY) {   // gone, or never usable (N4)
          if (this.#store.deletePushSubscription(s.endpointId)) this.#store.record([{ type: "PushUnsubscribed", endpointId: s.endpointId, reason: r.status === UNUSABLE_KEY ? "invalid" : "gone", at }]);
        } else {
          // Kept and said: the status and the service's reason code tell what to fix (a 403 is our token, not his
          // device). Whatever the sender returned, only a code gets this far (N1).
          const reason = reasonCode(r.reason);
          this.#store.record([reason === undefined ? { type: "NotificationFailed", kind: p.kind, status: r.status, at } : { type: "NotificationFailed", kind: p.kind, status: r.status, reason, at }]);
          log.warn(r.status === 0 ? `a push service couldn't be reached for a ${p.kind} notification`
            : `a push service refused a ${p.kind} notification: ${r.status}${reason === undefined ? "" : ` ${reason}`}`);
        }
      }
      if (sent) this.#store.record([{ type: "NotificationSent", kind: p.kind, counts, devices: sent, at: this.#now() }]);
    }
  }
}
