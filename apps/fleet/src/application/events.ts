// What the fleet tells its clients as it happens (spec 5.6, WS /v1/events): a node's inventory and health, its status,
// lane-name conflicts, alerts, a delivery's latest state (fleet clients spec §4.6; body: Delivery & { stale }), lane
// events (§7; body: LaneEvent) and a job view (design §4). One subscriber that throws never keeps the others from hearing
// an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery" | "lane" | "job"; node: string; body: unknown };

export class EventHub {
  #subscribers = new Set<(e: FleetEvent) => void>();
  #onError: (e: unknown) => void;
  #queue: FleetEvent[] = [];
  #emitting = false;

  constructor(onError: (e: unknown) => void = () => {}) { this.#onError = onError; }

  subscribe(fn: (e: FleetEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  // An event emitted by a subscriber (the lane registry's conflict, on an inventory) goes out after the event that
  // caused it has reached everyone, so every subscriber hears them in the same, causal order.
  emit(e: FleetEvent): void {
    this.#queue.push(e);
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        for (const fn of this.#subscribers) {
          try { fn(next); } catch (err) { this.#onError(err); }
        }
      }
    } finally { this.#emitting = false; }
  }
}
