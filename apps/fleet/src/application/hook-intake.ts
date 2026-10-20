// The hook bus's intake (spec 5.4, 5.6): an agent's hook events, deduplicated by (node, streamId, seq) against the
// stream's mark and stored in the outbox, for the subscribers whose `paths` take them, in the same transaction that
// raises the mark. The connection acknowledges the returned mark only after that commit, so an acknowledged event is
// never lost. A new streamId (a reset or reinstalled agent) starts at nothing, so its events are never taken for
// duplicates. A subscriber whose backlog is full raises one alert until it drains below the cap again.
// An event no subscriber's paths take is acknowledged all the same (the relay already told its hook script "queued"),
// so it is never dropped silently (ADR-0012 decision 8): the store counts it per path (`morndo-fleet status`), and the
// first one of each script path in this process raises an unrouted_hook alert. Progress paths (/cc, /sl) are counted
// only. The service also logs, at startup, each script path no subscriber takes (serve.ts, unsubscribedScriptPaths).
// `store` runs inside the caller's transaction (the intake window's synced commit) and hands back what to do once that
// commit is on the disk: the alerts and the delivery worker's kick, so nothing is announced that a failed commit took
// back. `accept` is store and commit in one, for a caller with a single batch. With `lanes`, each event above its stream's
// mark also makes its lane event in the same transaction (fleet clients spec §7), published once the commit is on disk.
// `onCommitted` runs after every stored batch's commit, lane events or none: the fleet's Runs read the hooks' activity
// (ADR-0032) only once it is on the disk.
import { LIMITS, type HookEvent, type LaneEvent } from "@morndo/protocol";
import type { HookPath, Subscriber } from "../config.ts";
import type { Audit } from "../adapters/audit.ts";
import type { OutboxStore } from "../adapters/outbox-store.ts";
import type { Transactions } from "./hook-sink.ts";
import type { LaneEvents } from "./lane-events.ts";

// One connection's batch, stored in the caller's transaction: the stream's mark, and what to do once it committed.
export type Stored = { seq: number; after: () => void };

// The paths a hook script waits on (spec 5.5: kept events, and a 503 lets the script's own fallback run), whose loss
// the owner must hear of. /cc and /sl are progress: the latest per session, superseded seconds later.
export const SCRIPT_PATHS: readonly HookPath[] = ["/hook/stop", "/hook/failure", "/notify", "/file"];

export const unsubscribedScriptPaths = (subscribers: Subscriber[]): HookPath[] =>
  SCRIPT_PATHS.filter(p => !subscribers.some(s => s.paths.includes(p)));

export class HookIntake {
  #store: OutboxStore;
  #subscribers: Subscriber[];
  #audit: Audit;
  #now: () => number;
  #cap: number;
  #onStored: () => void;
  #onCommitted: () => void;
  #tx: Transactions | null;
  #lanes: Pick<LaneEvents, "take" | "committed"> | null;
  #overflowing = new Set<string>();
  #unroutedAlerted = new Set<string>();                 // script paths alerted in this process

  constructor(p: {
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void; tx?: Transactions;
    lanes?: Pick<LaneEvents, "take" | "committed">; onCommitted?: () => void;
  }) {
    this.#store = p.store;
    this.#subscribers = p.subscribers;
    this.#audit = p.audit;
    this.#now = p.now ?? Date.now;
    this.#cap = p.cap ?? LIMITS.subscriberBacklog;
    this.#onStored = p.onStored ?? (() => {});
    this.#onCommitted = p.onCommitted ?? (() => {});
    this.#tx = p.tx ?? null;
    this.#lanes = p.lanes ?? null;
  }

  known(node: string, streamId: string): { seq: number; known: boolean } {
    return this.#store.hwm(node, streamId);
  }

  // Stores one connection's batch in the caller's transaction (OutboxStore.accept: a savepoint inside it).
  store(node: string, streamId: string, events: HookEvent[]): Stored {
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const fresh: LaneEvent[] = [];
    const lanes = this.#lanes;
    const taken = lanes ? (e: HookEvent) => { const t = lanes.take(e); if (t.event) fresh.push(t.event); return t.own; } : undefined;
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap, ...(taken ? { taken } : {}) });
    return {
      seq: r.seq,
      after: () => {
        for (const name of this.#overflowing) if (this.#store.pendingCount(name) < this.#cap) this.#overflowing.delete(name);
        for (const [name, over] of r.overflow) {
          if (over.deadLettered === 0 || this.#overflowing.has(name)) continue;
          this.#overflowing.add(name);
          this.#audit.alert("backlog_full", node, { subscriber: name, cap: this.#cap, droppedProgress: over.dropped, deadLettered: over.deadLettered });
        }
        for (const [path, n] of r.unrouted) {
          if (!(SCRIPT_PATHS as readonly string[]).includes(path) || this.#unroutedAlerted.has(path)) continue;
          this.#audit.alert("unrouted_hook", node, { path, events: n });
          this.#unroutedAlerted.add(path);
        }
        if (r.stored > 0) this.#onStored();
        if (fresh.length > 0) lanes?.committed(fresh);
        if (events.length > 0) this.#onCommitted();
      },
    };
  }

  // One batch stored and committed on its own (synced, when the intake has fleet.db's transactions), then announced.
  accept(node: string, streamId: string, events: HookEvent[]): number {
    const r = this.#tx ? this.#tx.synced(() => this.store(node, streamId, events)) : this.store(node, streamId, events);
    r.after();
    return r.seq;
  }
}
