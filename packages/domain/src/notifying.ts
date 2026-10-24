// Notifications (ADR-0008 phase F; N1–N5 in docs/domain.md): a content-free alert to the principal's devices that a
// number of Decisions wait, of workers need him, of devices were linked, of urgent fleet alerts came in, or of usage
// notices the hub wrote. Counts only (N1), raised only on those five changes (N2), never while he is attending (N3),
// and granting nothing (N5). Pure: time comes in as `now`.
// Design reference, not code: Signal-Desktop ts/services/notifications.preload.ts (the latest one wins, after a pause).

export const NOTIFY_DEBOUNCE_MS = 1000;            // N3: per kind, the latest one wins after a 1-second pause
export const ATTENDING_INPUT_MS = 2 * 60_000;      // "Attending": focus, and his input in the last 2 minutes

export type NotificationKind = "decision" | "worker" | "linked" | "alert" | "usage";
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["decision", "worker", "linked", "alert", "usage"];
// `alerts`: urgent fleet alerts he hasn't seen (the fleet's alerts in the app, 2026-10-12). `usage`: usage notices the
// hub itself wrote since the last such Notification went (plan 4.4, S4).
export type Counts = { decisions: number; workers: number; linked: number; alerts: number; usage: number };

// What goes to the push service, numbers only (N1; the product lane's amendment 4): the kind as its number, then the
// counts. The device builds its words from these.
export type NotificationPayload = { kind: number; decisions: number; workers: number; linked: number; alerts: number; usage: number };
export const kindCode = (k: NotificationKind) => NOTIFICATION_KINDS.indexOf(k);
export const payloadOf = (kind: NotificationKind, c: Counts): NotificationPayload =>
  ({ kind: kindCode(kind), decisions: c.decisions, workers: c.workers, linked: c.linked, alerts: c.alerts, usage: c.usage });

// What one device's app last said: focused or not, and when it saw his input. Its report ages: a device that stopped
// reporting (asleep, gone) isn't attending.
export type AttendingReport = { attending: boolean; at: number };
export const isAttending = (r: AttendingReport, now: number) => r.attending && now - r.at < ATTENDING_INPUT_MS;
export const anyAttending = (reports: Iterable<AttendingReport>, now: number) => [...reports].some(r => isAttending(r, now));

// N2: what raises a Notification. A worker's question or menu is an Ask, so it raises one as a Decision waiting, muted
// or not (Signal: mentions break mute), and never a second one as a worker (Phase F review M1). A worker raises its
// own kind only for a need that isn't an Ask, and not when its Conversation is muted.
export type Raise =
  | { kind: "decision"; waiting: number }                                          // a Decision started waiting; how many wait now
  | { kind: "worker"; needsYou: boolean; was: boolean; muted: boolean; isAsk: boolean }
  | { kind: "linked" }
  | { kind: "alert"; urgent: boolean }                                              // a fleet alert came in
  | { kind: "usage" };                                                              // the hub wrote a usage notice (S4)
export function raises(r: Raise): boolean {
  switch (r.kind) {
    case "decision": return r.waiting > 0;
    case "worker": return r.needsYou && !r.was && !r.muted && !r.isAsk;
    case "linked": return true;
    case "alert": return r.urgent;
    case "usage": return true;
  }
}

// N3: while he is attending, nothing goes, except that a device was linked: the device that approved or issued the link
// is usually the one he is attending on, and every other device must still hear of it (AC13; review M2).
export const suppressedWhileAttending = (kind: NotificationKind) => kind !== "linked";

// N3: per kind, the latest one waits a second; a newer one of the same kind replaces it and starts the second again.
// `due` hands out what is ready; at sending time no one may be attending, else it is dropped, not delayed.
export type Pending = { kind: NotificationKind; counts: Counts; dueAt: number };
export class NotificationQueue {
  #pending = new Map<NotificationKind, Pending>();

  raise(kind: NotificationKind, counts: Counts, now: number): Pending {
    const p = { kind, counts, dueAt: now + NOTIFY_DEBOUNCE_MS };
    this.#pending.set(kind, p);
    return p;
  }

  // The ones whose second is over, oldest first, taken out of the queue.
  due(now: number): Pending[] {
    const ready = [...this.#pending.values()].filter(p => p.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
    for (const p of ready) this.#pending.delete(p.kind);
    return ready;
  }

  get next(): number | null {
    let at: number | null = null;
    for (const p of this.#pending.values()) if (at === null || p.dueAt < at) at = p.dueAt;
    return at;
  }
}

// A push service's reason for a refusal, kept only as a short code of letters and digits ("BadJwtToken"): what else it
// writes there is its own text, and the audit and the log keep codes, never text (N1).
export const reasonCode = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(v) ? v : undefined);

// N1, N5: the audit keeps when and how many, never who or what; and these events touch no Escalation's state. A failure
// keeps the push service's status and, where it gave one, its reason code (a short code such as "BadJwtToken").
export type NotificationEvent =
  | { type: "NotificationSent"; kind: NotificationKind; counts: Counts; devices: number; at: number }
  | { type: "NotificationFailed"; kind: NotificationKind; status: number; reason?: string; at: number }
  | { type: "PushSubscribed"; endpointId: string; at: number }
  | { type: "PushUnsubscribed"; endpointId: string; reason: "device" | "revoked" | "signed_out" | "gone" | "invalid"; at: number };
