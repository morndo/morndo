// Inventory and health events (spec §5.4), latest wins. The inventory is read every 2 s (LIMITS.inventoryPollMs) and
// sent when its invVersion moved, and in full after every welcome; health every 30 s (LIMITS.healthMs) and after every
// welcome. Each loop waits for its previous round, so a slow tmux never piles reads up.
import { LIMITS, type AgentMessage, type Health } from "@morndo/protocol";
import type { Logger } from "./log.ts";
import type { Inventory } from "./ops/inventory.ts";

export type EventLoopOptions = {
  inventory: Inventory;
  send: (m: AgentMessage) => boolean;
  health: () => Promise<Health>;
  log: Logger;
  pollMs?: number;
  healthMs?: number;
};

export class EventLoops {
  #o: EventLoopOptions;
  #online = false;
  #sentVersion = -1;
  #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(o: EventLoopOptions) { this.#o = o; }

  start(): void {
    this.#loop(this.#o.pollMs ?? LIMITS.inventoryPollMs, () => this.#inventory());
    this.#loop(this.#o.healthMs ?? LIMITS.healthMs, () => this.#health());
  }

  // After a welcome: the full inventory and a health event, whatever was sent before.
  online(): void {
    this.#online = true;
    this.#sentVersion = -1;
    void this.#inventory();
    void this.#health();
  }

  offline(): void { this.#online = false; }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #loop(ms: number, round: () => Promise<void>): void {
    const next = () => {
      if (this.#stopped) return;
      const t = setTimeout(() => {
        this.#timers.delete(t);
        void round().finally(next);
      }, ms);
      this.#timers.add(t);
    };
    next();
  }

  async #inventory(): Promise<void> {
    try {
      const s = await this.#o.inventory.refresh();
      if (!this.#online || s.invVersion === this.#sentVersion) return;
      if (this.#o.send({ v: 1, t: "ev.inventory", invVersion: s.invVersion, panes: s.panes })) this.#sentVersion = s.invVersion;
    } catch (e) {
      this.#o.log.warn("reading the inventory failed", e);
    }
  }

  async #health(): Promise<void> {
    if (!this.#online) return;
    try { this.#o.send({ v: 1, t: "ev.health", health: await this.#o.health() }); }
    catch (e) { this.#o.log.warn("reading health failed", e); }
  }
}
