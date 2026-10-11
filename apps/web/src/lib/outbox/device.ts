// This device's outbox (ADR-0008 phase C), as the desktop and the phone both start it: the IndexedDB store, one sender
// across tabs through a Web Lock, the other tabs told of every change, and the one POST that sends a Command. Moved here
// from Desktop.svelte unchanged (ADR-0009), so a reply from a catch-up card goes through the same outbox (S4–S8).
import { api, ApiError } from "../api.ts";
import { Outbox, type CancelOutcome, type PostOutcome } from "./outbox.ts";
import { commandDelivery, type OutboxRecord } from "./state.ts";
import { openStore } from "./store.ts";

// One POST of a queued Command: what it came to, for the outbox. A hub answer of its own is final; no answer of the
// hub's own (a network error, a proxy's page) is "unanswered" and retried with the same request id (S5).
export async function post(r: OutboxRecord, signal: AbortSignal): Promise<PostOutcome> {
  try {
    const res = await api.post<{ at?: unknown; delivery?: unknown }>(`/api/workers/${encodeURIComponent(r.worker)}/send`, { text: r.text, requestId: r.id, uploads: r.uploads, seen: r.seen, name: r.workerName, createdAt: r.createdAt, ...(r.again ? { again: true } : {}) }, signal);
    // ok, or 200 "duplicate": typed before. `at` is the hub's time of the typing (review M2). `delivery`: the manager's
    // queue has it (fleet-clients §9.1), and where it stands there. `createdAt`: a message to the manager waits up to 24
    // hours from when it was written (ruling 83). `again`: the phone's Send again (ADR-0011), never a status read.
    const delivery = commandDelivery(res.delivery);
    return { kind: "typed", ...(typeof res.at === "number" ? { at: res.at } : {}), ...(delivery ? { delivery } : {}) };
  } catch (e) {
    if (!(e instanceof ApiError) || e.code === `http_${e.status}`) return { kind: "unanswered" };
    if (e.code === "uncertain") return { kind: "uncertain" };
    if (e.status === 429) return { kind: "wait", ms: e.retryAfterMs ?? 1000 };
    if (e.status === 503) return { kind: "unanswered" };                 // the hub holds new work while it updates; try again
    return { kind: "refused", code: e.code, status: e.status };
  }
}

// The Cancel of a message the manager's queue still holds (ruling 83): what the hub said. A 409 is too late (typed
// meanwhile). A 404 (`unknown`: the hub, or the fleet, has no such delivery) says nothing was typed: the record stays as
// it stood, and the hub's `deliveries` frames go on saying where it stands (review #6).
export async function cancelDelivery(r: OutboxRecord): Promise<CancelOutcome> {
  try {
    const res = await api.post<{ delivery?: unknown }>("/api/manager/cancel", { requestId: r.id });
    const delivery = commandDelivery(res.delivery);
    return delivery ? { kind: "cancelled", delivery } : { kind: "unanswered" };
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code !== `http_${e.status}`) return { kind: "too_late", delivery: commandDelivery(e.data.delivery) };
    if (e instanceof ApiError && e.status === 404 && e.code !== `http_${e.status}`) return { kind: "unknown" };
    return { kind: "unanswered" };
  }
}

// Several tabs share one IndexedDB: one of them sends (a Web Lock), the others only write down and show, and every
// change is told to the other tabs (review M5). Without Web Locks, every tab sends; the hub types each id once.
// The lock is held while this outbox runs and given back when it stops (or its request withdrawn, if it never got it):
// the app swaps the desktop and the phone at 900 px (a rotated tablet or large phone), and the next outbox must be able
// to take over, or its sends would wait for ever (review, 2026-10-04).
export function startDeviceOutbox(o: { connected: () => boolean; onChange: (records: OutboxRecord[]) => void }): { ready: Promise<Outbox>; stop(): void } {
  let outbox: Outbox | null = null;
  let stopped = false;
  let release = () => {};
  const withdraw = new AbortController();
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("morndo-outbox") : null;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const ready = openStore().then(async store => {
    let quiet = false;
    const box = new Outbox({
      store, post, cancel: cancelDelivery, active: !locks,
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
      connected: o.connected,
      onChange: records => { o.onChange(records); if (!quiet && !stopped) channel?.postMessage("changed"); },   // closed once stopped
    });
    outbox = box;
    if (channel) channel.onmessage = () => { quiet = true; void box.refresh().finally(() => { quiet = false; }); };
    await box.start();
    if (stopped) box.stop();
    else {
      locks?.request("morndo-outbox", { signal: withdraw.signal }, () => {
        if (stopped) return;
        box.activate();
        return new Promise<void>(r => (release = r));
      }).catch(() => { /* withdrawn on stop: nothing to hold */ });
    }
    return box;
  });
  return { ready, stop: () => { stopped = true; outbox?.stop(); withdraw.abort(); release(); channel?.close(); } };
}
