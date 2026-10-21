// The manager's answers and messages through the fleet's delivery queue (fleet-clients spec §9.1; ADR-0014; ADR-0010's
// domain rules). Each goes to the manager's lane by name (a sticky name: it waits on its node through a manager restart,
// spec §4.6), under the key the hub would type it under (`hub:<key>`), so the switch never types one twice. Each has a
// row (manager_deliveries, migration 18), written before the fleet is asked, so a hub restart keeps following it; and
// each is followed to its end from the fleet's `delivery` events, and by asking every few seconds (an event sent while
// the hub wasn't subscribed is not replayed). Listeners hear every change of state or of the reason it waits, once, in
// one transaction with the row's new state: a change acted on (an answer recorded, an ask opened again) is acted on once
// across restarts, and one whose listener failed is heard again on the next round.
// The switch (MORNDO_MANAGER_QUEUE): on, new answers and messages for the manager come here; off, none do, what is still
// queued is cancelled first (so a direct retry types it once), and the rest is followed to its end.
import { FINAL_DELIVERY_STATES, LIMITS, type Delivery, type DeliveryState, type ErrorCode, type GiveUpReason, type QueuedCommand, type WaitingReason } from "@morndo/protocol";
import type { ManagerDeliveryRow, Store } from "../adapters/store.ts";
import { log } from "../adapters/log.ts";
import type { Deliveries } from "./ports.ts";

// Where a delivery stands, as the hub shows it. `at`: delivered, when it reached the manager; else when it was typed or
// queued (the node's clock, which the manager's transcript is on).
export type QueueView = { state: DeliveryState; reason: WaitingReason | null; why: GiveUpReason | null; at: number | null };
export type QueueChange = { row: ManagerDeliveryRow; view: QueueView };
export type NewDelivery = Omit<ManagerDeliveryRow, "state" | "updatedAt">;
// put()'s answer: queued (or found: the same id again), with its row and where it stands; or nothing queued, by the
// fleet's or the node's code ("node_offline" when the fleet couldn't be reached at all, spec §10); or "uncertain": the
// fleet took it and never answered, so it may be queued: its row stays "sending", and the same id again asks again.
export type PutResult = { ok: true; row: ManagerDeliveryRow; view: QueueView; delivery: Delivery } | { ok: false; problem: ErrorCode };
// cancel()'s answer: withdrawn (given up, "cancelled"), or not: "already_typed" (it goes on to its end), "unknown" (the
// fleet never had it), "uncertain" (the fleet took the cancel and never answered), or the fleet's refusal.
export type CancelResult = { ok: true; view: QueueView } | { ok: false; problem: ErrorCode | "unknown" };

export const QUEUE_POLL_MS = 5000;
// A 404 drops a "sending" row only once the fleet's own wait for the node's answer has passed, plus this slack: the
// fleet mirrors the delivery only when that answer comes, and a put() in doubt (no answer from the fleet at all) may
// still be waiting on it.
const DELIVERY_MIRROR_SLACK_MS = 2_000;
export const SENDING_DROP_AFTER_MS = LIMITS.deliveryOpTimeoutMs + DELIVERY_MIRROR_SLACK_MS;
const KEEP_MS = 7 * 24 * 3_600_000;              // the node keeps a final delivery 7 days (spec §4.3); the hub its row as long
const COMMANDS_SHOWN_MS = 24 * 3_600_000;         // a device's messages the feed lists after its hello: the outbox's day
// The switch off asks again when a cancel is answered busy (the node typing it this moment): this often, this long apart.
const CANCEL_BUSY_TRIES = 8;
const CANCEL_BUSY_WAIT_MS = 250;
// How far a state is on: an older word (an event that crossed a newer answer) never moves a delivery back. The node's
// one retype is the exception: held, then typed again after an interrupt dropped it.
const RANK: Record<DeliveryState, number> = { queued: 0, typed: 1, held: 2, delivered: 3, uncertain: 3, given_up: 3 };
export const isFinal = (state: string): boolean => FINAL_DELIVERY_STATES.has(state as DeliveryState);

export function viewOf(d: Delivery): QueueView {
  return {
    state: d.state, reason: d.state === "queued" ? d.waiting?.reason ?? null : null, why: d.state === "given_up" ? d.why ?? null : null,
    at: d.deliveredAt ?? d.typedAt ?? d.queuedAt,
  };
}
// A message's delivery as the app reads it (feed `deliveries`): typed and held are still "queued" (not in the
// conversation yet), each with its own words for why.
export function queuedCommand(row: ManagerDeliveryRow, view: QueueView): QueuedCommand {
  const waiting = view.state === "queued" ? view.reason : view.state === "typed" || view.state === "held" ? view.state : null;
  const state = view.state === "typed" || view.state === "held" ? "queued" : view.state;
  return { requestId: row.requestId, state, waiting, why: view.why };
}

export class ManagerQueue {
  readonly lane: string;
  readonly on: boolean;
  #store: Store;
  #deliveries: Deliveries;
  #now: () => number;
  #pollMs: number;
  #views = new Map<string, QueueView>();
  #latest = new Map<string, Delivery>();          // the fleet's latest word on each delivery this process heard of
  #listeners = new Set<(c: QueueChange) => void>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: () => void = () => {};
  #polling: Promise<void> | null = null;
  #stopped = false;                               // stop() was called: a poll still waiting on the fleet touches nothing when it answers
  // Delivery ids whose put() is still waiting on the fleet, in this process, and how many: the app sends a message again
  // under the same id when one attempt goes unanswered, so two put()s of one id may overlap.
  #inFlight = new Map<string, number>();
  #unreadable = new Set<string>();             // delivery ids whose answer didn't read, said once each

  constructor(p: { store: Store; deliveries: Deliveries; lane: string; on: boolean; now?: () => number; pollMs?: number }) {
    this.#store = p.store;
    this.#deliveries = p.deliveries;
    this.lane = p.lane;
    this.on = p.on;
    this.#now = p.now ?? Date.now;
    this.#pollMs = p.pollMs ?? QUEUE_POLL_MS;
  }

  subscribe(fn: (c: QueueChange) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  // The delivery id of an answer under its key: `hub:<key>`, the key a direct send types it under (spec §9.1). Once every
  // delivery under that key was given up (nothing of it was typed: expired, cancelled), the key with "~2", "~3" …: an id
  // names one delivery for its 7 days (spec §4.1), and the same answer must be able to go again. The next suffix is one
  // past the highest "~N" still on record (the base id is attempt 1), so a pruned older attempt is not reused. While the
  // last one is anything else, its own id: the same id again answers what became of it.
  idFor(key: string): string {
    const base = `hub:${key}`;
    const attempt = (id: string) => { const m = /^~(\d+)$/.exec(id.slice(base.length)); return m ? Number(m[1]) : 1; };
    // The last attempt is the highest-numbered one, whatever the clock said: by time and then by id as text, equal
    // times (or a clock stepped back) would put "~10" before "~2" (review #12).
    const last = this.#store.managerDeliveryAttempts(base)
      .reduce<ManagerDeliveryRow | null>((a, r) => (a === null || attempt(r.deliveryId) > attempt(a.deliveryId) ? r : a), null);
    if (!last) return base;
    if (last.state !== "given_up") return last.deliveryId;
    return `${base}~${attempt(last.deliveryId) + 1}`;
  }

  // A new answer or message for the manager: its row written first (a hub that stops now still follows it), then the
  // fleet asked. The same id again (a repeat) asks again: the fleet answers its current state and queues nothing (§4.1).
  // put()'s own answer is no change heard by the listeners: the caller acts on it (a change an event brought meanwhile is
  // heard as usual, and view() has the latest). `ttlMs`: how long it may wait to be typed (absent: the fleet's 24 hours).
  async put(d: NewDelivery, text: string, ttlMs?: number): Promise<PutResult> {
    const known = this.#store.managerDelivery(d.deliveryId);
    if (!known) this.#store.saveManagerDelivery({ ...d, state: "sending", updatedAt: this.#now() });
    this.#inFlight.set(d.deliveryId, (this.#inFlight.get(d.deliveryId) ?? 0) + 1);
    let r: Awaited<ReturnType<Deliveries["deliver"]>>;
    try {
      r = await this.#deliveries.deliver({ id: d.deliveryId, lane: this.lane, text, ...(ttlMs === undefined ? {} : { ttlMs }) });
    } finally {
      const left = (this.#inFlight.get(d.deliveryId) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(d.deliveryId, left);
      else this.#inFlight.delete(d.deliveryId);
    }
    if (r.ok) {
      this.#apply(r.delivery, false);
      const row = this.#store.managerDelivery(d.deliveryId);
      if (!row) return { ok: false, problem: "internal" };                          // pruned meanwhile: never in practice
      return { ok: true, row, view: this.view(d.deliveryId) ?? viewOf(r.delivery), delivery: r.delivery };
    }
    if ("inDoubt" in r) {
      // The fleet's own event may have said meanwhile that it is queued: then it is.
      const heard = this.#latest.get(d.deliveryId);
      const row = this.#store.managerDelivery(d.deliveryId);
      if (heard && row && row.state !== "sending") return { ok: true, row, view: this.view(d.deliveryId) ?? viewOf(heard), delivery: heard };
      log.warn(`${d.deliveryId}: the fleet took it and never answered; it may be queued, and a repeat asks again`);
      return { ok: false, problem: "uncertain" };
    }
    // Nothing queued now. A row from an earlier attempt that is still "sending" may be queued (it was in doubt):
    // this refusal (the fleet gone, the node offline) is not the last word, so the caller stays uncertain.
    if (known?.state === "sending") {
      log.warn(`${d.deliveryId}: a repeat was refused (${r.refused}) while an earlier attempt may still be queued`);
      return { ok: false, problem: "uncertain" };
    }
    // Its row goes with it, unless another put() of the same id still waits on the fleet: that one may queue it.
    if (!known && !this.#inFlight.has(d.deliveryId)) this.#store.dropManagerDelivery(d.deliveryId);
    log.warn(`${d.deliveryId}: not queued for ${this.lane}: ${r.refused}`);
    return { ok: false, problem: r.refused };
  }

  // Where a delivery stands now; null when the hub has no row of it, or its row is still "sending".
  view(id: string): QueueView | null {
    const v = this.#views.get(id);
    if (v) return v;
    const row = this.#store.managerDelivery(id);
    return !row || row.state === "sending" ? null : { state: row.state, reason: null, why: null, at: null };
  }
  row(id: string): ManagerDeliveryRow | null { return this.#store.managerDelivery(id); }
  byRequest(endpointId: string, requestId: string): ManagerDeliveryRow | null { return this.#store.managerDeliveryOfRequest(endpointId, requestId); }
  answerRow(escalationId: string, queuedAt: number): ManagerDeliveryRow | null { return this.#store.answerDelivery(escalationId, queuedAt); }
  // The answers to one ask still in doubt (`prefix`: "hub:answer:<id>:<ask>:").
  sendingOf(prefix: string): ManagerDeliveryRow[] { return this.#store.managerDeliveriesWithPrefix(prefix).filter(r => r.state === "sending"); }
  openAnswers(): ManagerDeliveryRow[] { return this.#store.openManagerDeliveries().filter(r => r.kind === "answer"); }
  // Every answer to one escalation id through the queue, oldest first, whatever its ask.
  answersTo(escalationId: string): ManagerDeliveryRow[] { return this.#store.managerDeliveriesWithPrefix(`hub:answer:${escalationId}:`).filter(r => r.kind === "answer"); }
  // One device's messages to the manager of the last day, as the feed lists them after a hello.
  commandsOf(endpointId: string): QueuedCommand[] {
    return this.#store.commandDeliveriesOf(endpointId, this.#now() - COMMANDS_SHOWN_MS).flatMap(row => {
      const view = this.view(row.deliveryId);
      return view ? [queuedCommand(row, view)] : [];
    });
  }
  // A message's row given up while the switch is off: the hub types it directly now (nothing of it was typed).
  forget(id: string) { this.#store.dropManagerDelivery(id); this.#views.delete(id); this.#latest.delete(id); }

  // Withdraws a delivery still queued (spec §4.3 delivery.cancel). One typed already can't be (already_typed): it is
  // followed to its end. A row still "sending" whose delivery the fleet doesn't know (its cancel answered 404
  // no_such_delivery: cancelDelivery's null, rulings 3 and 56) was never queued: it goes.
  async cancel(id: string): Promise<CancelResult> {
    const r = await this.#deliveries.cancel(id);
    if (r.ok) { this.#safeApply(r.delivery); return { ok: true, view: this.view(id) ?? viewOf(r.delivery) }; }
    if ("unknown" in r) {
      if (this.#store.managerDelivery(id)?.state === "sending") this.#store.dropManagerDelivery(id);
      else log.warn(`${id}: the fleet knows no such delivery; it is followed until its row is pruned`);
      return { ok: false, problem: "unknown" };
    }
    if ("inDoubt" in r) {
      log.warn(`${id}: cancelling it went unanswered; it is followed, and the next start tries again`);
      return { ok: false, problem: "uncertain" };
    }
    if (r.refused === "already_typed") { log.info(`${id} was typed already: it is followed to its end`); return { ok: false, problem: "already_typed" }; }
    if (this.#store.managerDelivery(id)?.state === "sending" && r.refused !== "node_offline" && r.refused !== "timeout") {
      this.#store.dropManagerDelivery(id);
      return { ok: false, problem: r.refused };
    }
    log.warn(`${id}: cancelling it was refused (${r.refused}); it is followed, and may still be delivered`);
    return { ok: false, problem: r.refused };
  }

  // A 404 for a row still "sending" is final only when this process has no put() of it in flight, the row is older
  // than the fleet's wait for the node's answer plus slack (SENDING_DROP_AFTER_MS), and the manager lane's node is
  // online, so a delivery the node stored would have been mirrored by its replay after the welcome. Otherwise the row
  // stays: the fleet mirrors a delivery only once the node has answered, and a node that stored it and went offline
  // has no mirror until that replay.
  async #sendingNeverArrived(row: ManagerDeliveryRow): Promise<boolean> {
    if (row.state !== "sending" || this.#inFlight.has(row.deliveryId)) return false;
    if (this.#now() - row.updatedAt <= SENDING_DROP_AFTER_MS) return false;
    const online = await this.#deliveries.laneNodeOnline(this.lane);
    return !this.#stopped && online === true;                            // stopped: the store may be closed, drop nothing
  }

  // Asks the fleet about every delivery not final yet; one round at a time. A queue that was stopped ends the round at its
  // next answer: the hub closes the store right after it stops the queue, and an answer that comes later must not use it.
  poll(): Promise<void> {
    this.#polling ??= (async () => {
      for (const row of this.#store.openManagerDeliveries()) {
        const d = await this.#deliveries.get(row.deliveryId);
        if (this.#stopped) return;
        if (d === "unavailable") return;                                 // the fleet can't be asked now: the next round
        if (d === "unreadable") {                                        // this one only: the rest are still asked (review #5)
          if (!this.#unreadable.has(row.deliveryId)) log.warn(`${row.deliveryId}: the fleet's answer about it doesn't read; asked again each round`);
          this.#unreadable.add(row.deliveryId);
          continue;
        }
        this.#unreadable.delete(row.deliveryId);
        if (d === null) {
          if (await this.#sendingNeverArrived(row)) this.#store.dropManagerDelivery(row.deliveryId);
          continue;
        }
        this.#safeApply(d);
      }
    })().finally(() => { this.#polling = null; });
    return this.#polling;
  }

  // Prunes, subscribes and starts the polls at once (a throw here fails the start, as before). The promise is the first
  // round: off, every delivery still queued cancelled first (spec §9.1), then one poll; on, the sticky check, then one
  // poll. main.ts waits for it only when the switch is off: on, the hub serves meanwhile (review #8).
  start(): Promise<void> {
    this.#stopped = false;
    const pruned = this.#store.pruneManagerDeliveries(this.#now() - KEEP_MS);
    if (pruned) log.info(`manager deliveries: pruned ${pruned} rows older than 7 days`);
    this.#unsubscribe = this.#deliveries.subscribe(d => this.#safeApply(d), () => { void this.poll(); });
    this.#timer = setInterval(() => { void this.poll(); }, this.#pollMs);
    this.#timer.unref();
    return (async () => {
      if (this.on) await this.#checkSticky();
      else await this.#cancelQueued();
      await this.poll();
    })();
  }
  // Idempotent: the hub stops the queue before it drains and again with the rest.
  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe();
    this.#unsubscribe = () => {};
  }

  // Review Focus 5: the manager's window under a name the fleet doesn't keep sticky (MORNDO_MANAGER_WINDOW renamed, the
  // fleet's stickyLanes not) still gets its deliveries, but not through a manager restart. Said once, at start.
  async #checkSticky() {
    const sticky = await this.#deliveries.stickyLanes();
    if (sticky === null || sticky.includes(this.lane)) return;
    log.warn(`the manager's window is "${this.lane}" (MORNDO_MANAGER_WINDOW), but the fleet's stickyLanes is ${JSON.stringify(sticky)}: answers and messages to it are delivered, but not through a restart of the manager (one queued then is given up, one sent while its window is gone is refused). Add "${this.lane}" to stickyLanes in the fleet's config.json.`);
  }

  // The switch off (spec §9.1): every delivery still queued is cancelled first, so it is never typed after the hub has
  // begun typing directly; a row still "sending" too (its delivery may be queued). All at once: each may wait as long
  // as the fleet waits for its node, and the hub serves only once every one is answered (review #8).
  async #cancelQueued() {
    const open = this.#store.openManagerDeliveries().filter(r => r.state === "queued" || r.state === "sending");
    await Promise.all(open.map(r => this.#cancelAtStart(r.deliveryId)));
  }

  // A cancel answered busy means the node is typing that delivery this very moment — its deliverer tries a delivery
  // that waits for a menu to close every few seconds — and "ask again in a moment" (spec §4.3, delivery.cancel). Asked
  // again a few times, it ends cancelled (still queued) or already_typed (followed to its end). Given up on, it was
  // followed and could be typed after the hub began typing directly, which the switch off exists to prevent.
  async #cancelAtStart(id: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const r = await this.cancel(id);
      if (r.ok || r.problem !== "busy" || attempt >= CANCEL_BUSY_TRIES) return;
      await new Promise<void>(resolve => setTimeout(resolve, CANCEL_BUSY_WAIT_MS));
    }
  }

  #safeApply(d: Delivery) {
    try { this.#apply(d, true); }
    catch (e) { log.error(`${d.id}: acting on its change failed; the next round tries again`, e); }
  }

  // The fleet's word on one delivery. Not one of this hub's (no row): ignored. Older than what was applied: ignored. A
  // change: the row's new state and every listener, in one transaction; the view is kept only once that committed.
  #apply(d: Delivery, notify: boolean) {
    const row = this.#store.managerDelivery(d.id);
    if (!row) return;
    const before = this.view(d.id);
    if (before && RANK[d.state] < RANK[before.state] && !(before.state === "held" && d.state === "typed")) return;
    this.#latest.set(d.id, d);
    const view = viewOf(d);
    if (before && before.state === view.state && before.reason === view.reason) { this.#views.set(d.id, view); return; }
    const now = { ...row, state: d.state, updatedAt: this.#now() };
    this.#store.transaction(() => {
      this.#store.setManagerDeliveryState(d.id, d.state, now.updatedAt);
      if (notify) for (const l of this.#listeners) l({ row: now, view });
    });
    this.#views.set(d.id, view);
  }
}
