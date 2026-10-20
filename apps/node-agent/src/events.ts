// Inventory and health events (spec §5.4), latest wins. The inventory is read every 2 s (LIMITS.inventoryPollMs) and
// sent when its invVersion moved, and in full after every welcome; health every 30 s (LIMITS.healthMs) and after every
// welcome. Each loop waits for its previous round, so a slow tmux never piles reads up.
// Fleet clients: each inventory read is also handed to `onInventory` (the deliverer's kick; Task 6's lane state events),
// whether or not the fleet is connected, and is sent meanwhile: a lane state event may wait for a menu to draw, and the
// inventory never waits for it (review #11). A round ends once both are done. A failure there is logged and never stops
// the loop.
import { LIMITS, type AgentMessage, type Health } from "@morndo/protocol";
import type { Logger } from "./log.ts";
import type { Inventory, Snapshot } from "./ops/inventory.ts";

// Health.tzOffsetMin (ADR-0032, R3): this node's UTC offset in minutes at `at`, east positive (UTC+2 is 120), the zone
// its lanes' wake-up schedules are written in, so the fleet can tell when a lane's cron fires. Read at every health, so
// a daylight-saving change shows at the next one. Date's getTimezoneOffset counts west positive, so it is negated; `|| 0`
// keeps UTC a plain 0, not -0.
export const utcOffsetMin = (at: Date = new Date()): number => -at.getTimezoneOffset() || 0;

export type EventLoopOptions = {
  inventory: Inventory;
  send: (m: AgentMessage) => boolean;
  health: () => Promise<Health>;
  log: Logger;
  pollMs?: number;
  healthMs?: number;
  onInventory?: (s: Snapshot) => void | Promise<void>;
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
    let s: Snapshot;
    try { s = await this.#o.inventory.refresh(); }
    catch (e) { this.#o.log.warn("reading the inventory failed", e); return; }
    const acting = (async () => {
      try { await this.#o.onInventory?.(s); }
      catch (e) { this.#o.log.warn("acting on the inventory failed", e); }
    })();
    if (this.#online && s.invVersion !== this.#sentVersion && this.#o.send({ v: 1, t: "ev.inventory", invVersion: s.invVersion, panes: s.panes })) {
      this.#sentVersion = s.invVersion;
    }
    await acting;
  }

  async #health(): Promise<void> {
    if (!this.#online) return;
    try { this.#o.send({ v: 1, t: "ev.health", health: await this.#o.health() }); }
    catch (e) { this.#o.log.warn("reading health failed", e); }
  }
}
