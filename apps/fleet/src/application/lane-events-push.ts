// Lane events delivered to the manager (fleet clients spec §7; following ~/.local/bin/lane-events-push, read
// 2026-10-08, which it retires): every laneEvents.batchMs after the first waiting event, everything waiting goes as
// deliveries (application/deliveries.ts) to the lane laneEvents.deliverTo, as the client "fleet":
// - the text: the header line, then one JSON line per event in today's shape (lane-events.ts lineOf), oldest first;
// - split into parts of at most LIMITS.maxSendText (8000) characters, each with the header, in order, when a batch is
//   longer (after a long outage; Review Focus 4): none is refused too_large;
// - the id (reconciliation ruling 6): `fleet:lane-events:<node>:<time>`, the node and the time (ms, the node's clock) of
//   the batch's first event; a batch split into parts gives them `-1`, `-2` … An id already used (one this process sent,
//   or one the mirror knows: a part given up, whose events come again first in the next batch) takes a suffix `.2`, `.3`
//   …, so it is a new delivery. A batch refused before anything was stored goes again under the same ids when nothing
//   came meanwhile; a part whose answer was lost goes again under a new id (at least once);
// - a part the node stored is marked sent with its id (not synced: a mark lost to a power loss sends it once more); a
//   part refused (no manager yet, its node offline) leaves it and every later part waiting, tried again after batchMs,
//   with one warning per episode;
// - a part whose delivery is given up (`expired`, `cancelled`, `gone`, `refused`) waits again and goes in the next
//   batch; at start, the same for every part given up while the fleet was down. `answered` is never delivered.
import type { Delivery } from "@morndo/protocol";
import type { LaneEventsConfig } from "../config.ts";
import type { LaneEventsStore } from "../adapters/lane-events-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { Answer, DeliveryRequest } from "./deliveries.ts";
import { partsOf } from "./lane-events.ts";

export const ID_PREFIX = "fleet:lane-events:";
// What the batches need of the deliveries (application/deliveries.ts).
export type DeliveriesPort = { post(r: DeliveryRequest, client: string): Promise<Answer>; get(id: string): { delivery: Delivery } | null };
const READ_MAX = 5000;                                   // waiting events read per batch; the rest go in the next one

export class LaneEventsPush {
  #store: LaneEventsStore;
  #deliveries: DeliveriesPort;
  #config: LaneEventsConfig;
  #log: Logger;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #again = false;                                        // a flush asked for while one send was still reading
  #used = new Set<string>();                             // ids taken in this process
  #refused = false;                                       // warned for this episode of refusals
  #stopped = false;

  constructor(p: { store: LaneEventsStore; deliveries: DeliveriesPort; config: LaneEventsConfig; log: Logger }) {
    this.#store = p.store;
    this.#deliveries = p.deliveries;
    this.#config = p.config;
    this.#log = p.log;
  }

  start(): void {
    if (this.#config.deliverTo === null) return;
    try {
      for (const id of this.#store.sentIn()) if (this.#deliveries.get(id)?.delivery.state === "given_up") this.#store.requeue(id);
      if (this.#store.waiting(1).length > 0) this.kick();
    } catch (e) { this.#log.error("lane events: looking for batches to send failed (fleet.db busy?); the next lane event tries again", e); }
  }

  // Waits for a batch being sent (the service settles every request first, so its answer comes at once), which marks
  // what its node stored; fleet.db closes after this.
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  // New events wait: a batch in batchMs, unless one is due or being sent.
  kick(): void {
    if (this.#stopped || this.#config.deliverTo === null || this.#timer !== null) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, this.#config.batchMs);
  }

  // A mirror change of one of ours: given up, its events wait again (the next batch).
  delivery(d: Delivery): void {
    if (!d.id.startsWith(ID_PREFIX) || d.state !== "given_up") return;
    try { if (this.#store.requeue(d.id) > 0) this.kick(); }
    catch (e) { this.#log.error(`lane events: putting back the events of ${d.id} failed (fleet.db busy?)`, e); }
  }

  // Sends what waits now (the timer, or a test). A flush that arrives while a send is still in flight (its read already
  // happened) runs another send when this one ends, so events committed during the post are not left until the next kick.
  flush(): Promise<void> {
    if (this.#running) { this.#again = true; return this.#running; }
    this.#running = this.#send().finally(() => {
      this.#running = null;
      if (!this.#again || this.#stopped) return;
      this.#again = false;
      void this.flush();
    });
    return this.#running;
  }

  async #send(): Promise<void> {
    const to = this.#config.deliverTo;
    if (to === null || this.#stopped) return;
    let left = false;
    try {
      const waiting = this.#store.waiting(READ_MAX);
      left = waiting.length === READ_MAX;
      const first = waiting[0];
      if (!first) return;
      const base = `${ID_PREFIX}${first.node}:${first.at}`;
      const parts = partsOf(waiting, this.#config.header);
      for (const [i, part] of parts.entries()) {
        const id = this.#idFor(parts.length > 1 ? `${base}-${i + 1}` : base);
        const answer = await this.#deliveries.post({ id, lane: to, text: part.text }, "fleet");
        if (!answer.ok) {
          if (answer.error.code === "id_conflict") this.#used.add(id);   // the mirror lost it: the next try takes another
          if (!this.#refused) this.#log.warn(`lane events: ${part.events.length} for ${to} not delivered yet (${answer.error.code}: ${answer.error.message}); trying again every ${this.#config.batchMs} ms`);
          this.#refused = true;
          left = true;
          break;
        }
        this.#refused = false;
        this.#used.add(id);
        this.#store.markSent(part.events.map(e => e.seq), id);
        // Given up by the answer, or by an event the mirror took before this ran (both may come in one read of the
        // socket, deliveries.ts): its requeue then found nothing marked yet (review #3).
        if (answer.delivery.state === "given_up" || this.#deliveries.get(id)?.delivery.state === "given_up") { this.#store.requeue(id); left = true; }
        if (this.#stopped) return;                         // stopping: the rest go after the restart
      }
    } catch (e) {
      this.#log.error("lane events: sending a batch to the manager failed (fleet.db busy?); trying again", e);
      left = true;
    }
    if (left) this.kick();
  }

  #idFor(base: string): string {
    let id = base;
    for (let n = 2; this.#used.has(id) || this.#deliveries.get(id) !== null; n++) id = `${base}.${n}`;
    return id;
  }
}
