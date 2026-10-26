// The intake window (fleet clients spec §6; issue #21): hook events from every agent connection that arrive within
// LIMITS.intakeWindowMs (25 ms) of the first one share one transaction, synced to the disk once (fleet core §16.4: the
// node deletes an event once the fleet acknowledged it). Only after that commit is each connection acknowledged its own
// stream's mark. The window opens at the first event and closes 25 ms later whatever follows, so a steady stream is
// committed at least every 25 ms; the events of one event-loop turn always fall into one window. With windowMs 0 the
// window is one event-loop turn (setImmediate), as the fleet committed before this change.
// Each connection's events are stored in a savepoint of their own: one that fails (fleet.db refuses its rows) is
// rolled back alone and that connection is told (`failed`, it closes 1011 and the node replays), while the others
// commit. A commit that fails as a whole (its sync: a full or failing disk) acknowledges no one. What each stored batch
// announces (alerts, the delivery worker's kick, lane events) runs after the commit, never before.
// A connection the fleet closes (a revoked node, a replaced connection) cancels its events not yet committed; one the
// node closes keeps them: they are stored at the window's end and acknowledged to no one (the node replays them, and
// the stream's mark skips them).
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Logger } from "../adapters/log.ts";
import type { Stored } from "./hook-intake.ts";
import type { HookSink, IntakeConn, IntakeHandle, Transactions } from "./hook-sink.ts";

export type Intake = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  store(node: string, streamId: string, events: HookEvent[]): Stored;
};
type Group = { conn: IntakeConn; events: HookEvent[] };
type Result = ({ ok: true } & Stored) | { ok: false; error: unknown };

export class IntakeWindow implements HookSink {
  #intake: Intake;
  #tx: Transactions;
  #log: Logger;
  #windowMs: number;
  #open = new Map<IntakeHandle, Group>();               // each connection's events, in the order they came
  #timer: { cancel(): void } | null = null;

  constructor(p: { intake: Intake; tx: Transactions; log: Logger; windowMs?: number }) {
    this.#intake = p.intake;
    this.#tx = p.tx;
    this.#log = p.log;
    this.#windowMs = p.windowMs ?? LIMITS.intakeWindowMs;
  }

  known(node: string, streamId: string): { seq: number; known: boolean } { return this.#intake.known(node, streamId); }

  open(conn: IntakeConn): IntakeHandle {
    const handle: IntakeHandle = {
      add: e => {
        const g = this.#open.get(handle);
        if (g) g.events.push(e);
        else this.#open.set(handle, { conn, events: [e] });
        this.#arm();
      },
      cancel: () => { this.#open.delete(handle); },
    };
    return handle;
  }

  #arm(): void {
    if (this.#timer !== null) return;
    if (this.#windowMs > 0) {
      const t = setTimeout(() => this.flush(), this.#windowMs);
      this.#timer = { cancel: () => clearTimeout(t) };
    } else {
      const t = setImmediate(() => this.flush());
      this.#timer = { cancel: () => clearImmediate(t) };
    }
  }

  // Commits what the window holds now (the timer's end, or the service stopping), then acknowledges.
  flush(): void {
    this.#timer?.cancel();
    this.#timer = null;
    const groups = [...this.#open.values()];
    this.#open.clear();
    if (groups.length === 0) return;
    const results: Result[] = [];
    try {
      this.#tx.synced(() => {
        for (const g of groups) {
          try {
            const stored = this.#tx.savepoint(() => this.#intake.store(g.conn.node, g.conn.streamId, g.events));
            results.push({ ok: true, ...stored });
          } catch (error) { results.push({ ok: false, error }); }
        }
      });
    } catch (error) {
      const n = groups.reduce((sum, g) => sum + g.events.length, 0);
      this.#log.error(`hook intake: committing ${n} events of ${groups.length} connections failed (fleet.db full, or its disk failing?); none acknowledged`, error);
      for (const g of groups) this.#safely(() => g.conn.failed(error));
      return;
    }
    groups.forEach((g, i) => {
      const r = results[i];
      if (!r) return;
      if (!r.ok) { this.#safely(() => g.conn.failed(r.error)); return; }
      this.#safely(r.after);
      this.#safely(() => g.conn.acked(r.seq));
    });
  }

  // The service stops: what the window holds is stored (and acknowledged to the connections still open).
  stop(): void { this.flush(); }

  #safely(f: () => void): void {
    try { f(); } catch (e) { this.#log.error("hook intake: after a commit, announcing it failed", e); }
  }
}
