// The hook bus's tables (spec 5.4, 5.6, 6): the highest accepted seq per (node, streamId), the outbox of events,
// one delivery row per subscriber, and dead letters. A delivery's delivered_at is when it reached a final state
// (delivered, dead or dropped); an outbox row goes LIMITS.outboxKeepMs after its last delivery's final state.
import type Database from "better-sqlite3";
import type { HookEvent } from "@morndo/protocol";

export type Delivery = {
  outboxId: number; subscriber: string; node: string; streamId: string; seq: number; path: string; body: string; attempts: number; nextAt: number;
};
export type DeadLetter = { subscriber: string; node: string; streamId: string; seq: number; path: string; body: string; reason: string; attempts: number; at: number };
// unrouted: per path, the events of this batch that no subscriber takes (acknowledged, stored for no one, counted).
export type Accepted = {
  seq: number; stored: number; duplicates: number; overflow: Map<string, { dropped: number; deadLettered: number }>; unrouted: Map<string, number>;
};
export type Unrouted = { path: string; count: number; latestAt: number };
// Per stream, a seq below which none of its rows is pending for the subscriber asked about: where heads() starts each
// stream's seek (`of`), and where it may start next time (`set`). The caller keeps them (B6 EF2).
export type Floors = { of(node: string, streamId: string): number; set(node: string, streamId: string, floor: number): void };
const NO_FLOORS: Floors = { of: () => 0, set: () => {} };

const COALESCIBLE = ["/cc", "/sl"];                      // progress events: only the latest per session matters
type Row = { outbox_id: number; subscriber: string; node: string; stream_id: string; seq: number; path: string; body: string; attempts: number; next_at: number };
const deliveryFrom = (r: Row): Delivery => ({
  outboxId: r.outbox_id, subscriber: r.subscriber, node: r.node, streamId: r.stream_id, seq: r.seq, path: r.path, body: r.body, attempts: r.attempts, nextAt: r.next_at,
});
const SELECT = `SELECT d.outbox_id, d.subscriber, d.attempts, d.next_at, o.node, o.stream_id, o.seq, o.path, o.body
  FROM deliveries d JOIN outbox o ON o.id = d.outbox_id`;

export class OutboxStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  hwm(node: string, streamId: string): { seq: number; known: boolean } {
    const r = this.#db.prepare("SELECT seq FROM stream_hwm WHERE node = ? AND stream_id = ?").get(node, streamId) as { seq: number } | undefined;
    return r ? { seq: r.seq, known: true } : { seq: 0, known: false };
  }

  // One transaction: every event above the stream's mark is stored for the subscribers `route` names, and the mark
  // rises to the last one. Seqs may skip (the agent coalesces progress events); an event at or below the mark is a
  // duplicate. A subscriber at `cap` pending deliveries loses its oldest pending progress event; with none to lose,
  // the new event goes straight to its dead letters (reason backlog_full). An event no subscriber takes is stored for no
  // one and counted per path in hook_unrouted, in the same transaction.
  // Each subscriber's backlog is counted once per batch, then kept by hand, and each search for its oldest pending
  // progress event goes on from where the last one stopped: no pending row at or below `after` is a progress event,
  // and rows only come above it. Per event, a count and a sort of the whole backlog made one 256-event window at the
  // 50,000 cap take 4 to 8 s inside this IMMEDIATE transaction (B6 EF3).
  accept(node: string, streamId: string, events: HookEvent[], route: (e: HookEvent) => string[], o: { now: number; cap: number }): Accepted {
    return this.#db.transaction((): Accepted => {
      let seq = this.hwm(node, streamId).seq;
      let stored = 0;
      let duplicates = 0;
      const overflow = new Map<string, { dropped: number; deadLettered: number }>();
      const unrouted = new Map<string, number>();
      const backlog = new Map<string, { pending: number; after: number }>();
      const backlogOf = (s: string) => {
        let b = backlog.get(s);
        if (!b) { b = { pending: this.pendingCount(s), after: 0 }; backlog.set(s, b); }
        return b;
      };
      const insertOutbox = this.#db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      const insertDelivery = this.#db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, ?, ?, 0, ?, ?)");
      for (const e of events) {
        if (e.seq <= seq) { duplicates++; continue; }
        seq = e.seq;
        const subscribers = route(e);
        if (subscribers.length === 0) { unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }
        const body = JSON.stringify(e);
        const id = Number(insertOutbox.run(node, streamId, e.seq, e.path, body, o.now).lastInsertRowid);
        for (const s of subscribers) {
          const b = backlogOf(s);
          if (b.pending >= o.cap) {
            const over = overflow.get(s) ?? { dropped: 0, deadLettered: 0 };
            overflow.set(s, over);
            const dropped = this.#dropOldestCoalescible(s, o.now, b.after);
            if (dropped !== null) { over.dropped++; b.after = dropped; b.pending--; }
            else {
              b.after = id;                                // none pending up to this row; later ones come above it
              over.deadLettered++;
              insertDelivery.run(id, s, "dead", o.now, o.now);
              this.#insertDead({ subscriber: s, node, streamId, seq: e.seq, path: e.path, body, reason: "backlog_full", attempts: 0, at: o.now });
              continue;
            }
          }
          insertDelivery.run(id, s, "pending", o.now, null);
          b.pending++;
        }
        stored++;
      }
      this.#db.prepare(`INSERT INTO stream_hwm (node, stream_id, seq) VALUES (?, ?, ?)
        ON CONFLICT(node, stream_id) DO UPDATE SET seq = excluded.seq`).run(node, streamId, seq);
      const count = this.#db.prepare(`INSERT INTO hook_unrouted (path, count, latest_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET count = count + excluded.count, latest_at = excluded.latest_at`);
      for (const [path, n] of unrouted) count.run(path, n, o.now);
      return { seq, stored, duplicates, overflow, unrouted };
    }).immediate();
  }

  pendingCount(subscriber: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE subscriber = ? AND state = 'pending'").get(subscriber) as { n: number }).n;
  }

  // Drops the subscriber's oldest pending progress event above outbox row `after`; returns its outbox row, or null when
  // there is none. deliveries_pending (migration 4) holds the pending rows in outbox order, so the walk starts above
  // `after` and stops at the first progress event, with no sort.
  #dropOldestCoalescible(subscriber: string, now: number, after: number): number | null {
    const r = this.#db.prepare(`UPDATE deliveries SET state = 'dropped', delivered_at = ? WHERE rowid = (
      SELECT d.rowid FROM deliveries d INDEXED BY deliveries_pending JOIN outbox o ON o.id = d.outbox_id
      WHERE d.subscriber = ? AND d.state = 'pending' AND d.outbox_id > ? AND o.path IN (${COALESCIBLE.map(() => "?").join(", ")})
      ORDER BY d.outbox_id LIMIT 1) RETURNING outbox_id`)
      .get(now, subscriber, after, ...COALESCIBLE) as { outbox_id: number } | undefined;
    return r ? r.outbox_id : null;
  }

  // The first pending delivery of each stream for a subscriber (B6 EF2): one seek per stream the fleet has a mark for
  // (stream_hwm), from the stream's floor, the same index range as next(), instead of grouping every pending row of the
  // subscriber (129 ms a round at a 50,000-event backlog, once a second and after every stored batch). Each stream's
  // next floor is set: its head's seq, or, with nothing pending, its mark + 1, since a stream's rows only ever come
  // above its mark (accept()).
  heads(subscriber: string, floors: Floors = NO_FLOORS): Delivery[] {
    const first = this.#db.prepare(`${SELECT} WHERE d.subscriber = ? AND o.node = ? AND o.stream_id = ? AND o.seq >= ? AND d.state = 'pending' ORDER BY o.seq LIMIT 1`);
    const streams = this.#db.prepare("SELECT node, stream_id, seq FROM stream_hwm").all() as { node: string; stream_id: string; seq: number }[];
    const heads: Delivery[] = [];
    for (const st of streams) {
      const r = first.get(subscriber, st.node, st.stream_id, floors.of(st.node, st.stream_id)) as Row | undefined;
      floors.set(st.node, st.stream_id, r ? r.seq : st.seq + 1);
      if (r) heads.push(deliveryFrom(r));
    }
    return heads;
  }

  // The next pending delivery of one stream for a subscriber, in seq order, at or after `fromSeq`: the caller knows no
  // row of the stream below it is pending for this subscriber (the seq it just finished). The read is then a range on
  // the outbox's (node, stream_id, seq) index, "The right-most column that is used can employ inequalities"
  // (https://www.sqlite.org/optoverview.html, read 2026-10-07), instead of a walk over every delivered row the outbox
  // keeps for 24 h (B6 EF1: 117 ms a read at 432,000 kept rows).
  next(subscriber: string, node: string, streamId: string, fromSeq = 0): Delivery | null {
    const r = this.#db.prepare(`${SELECT} WHERE d.subscriber = ? AND o.node = ? AND o.stream_id = ? AND o.seq >= ? AND d.state = 'pending' ORDER BY o.seq LIMIT 1`)
      .get(subscriber, node, streamId, fromSeq) as Row | undefined;
    return r ? deliveryFrom(r) : null;
  }

  delivered(outboxId: number, subscriber: string, at: number): void {
    this.#db.prepare("UPDATE deliveries SET state = 'delivered', delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'").run(at, outboxId, subscriber);
  }

  retry(outboxId: number, subscriber: string, attempts: number, nextAt: number): void {
    this.#db.prepare("UPDATE deliveries SET attempts = ?, next_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'").run(attempts, nextAt, outboxId, subscriber);
  }

  deadLetter(d: Delivery, reason: string, attempts: number, at: number): void {
    this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE deliveries SET state = 'dead', attempts = ?, delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'")
        .run(attempts, at, d.outboxId, d.subscriber).changes;
      if (changed) this.#insertDead({ subscriber: d.subscriber, node: d.node, streamId: d.streamId, seq: d.seq, path: d.path, body: d.body, reason, attempts, at });
    })();
  }

  #insertDead(x: DeadLetter): void {
    this.#db.prepare("INSERT INTO dead_letters (subscriber, node, stream_id, seq, path, body, reason, attempts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(x.subscriber, x.node, x.streamId, x.seq, x.path, x.body, x.reason, x.attempts, x.at);
  }

  deadLetters(subscriber?: string): DeadLetter[] {
    const rows = (subscriber === undefined ? this.#db.prepare("SELECT * FROM dead_letters ORDER BY id").all()
      : this.#db.prepare("SELECT * FROM dead_letters WHERE subscriber = ? ORDER BY id").all(subscriber)) as (Omit<DeadLetter, "streamId"> & { stream_id: string })[];
    return rows.map(r => ({ subscriber: r.subscriber, node: r.node, streamId: r.stream_id, seq: r.seq, path: r.path, body: r.body, reason: r.reason, attempts: r.attempts, at: r.at }));
  }

  // A subscriber removed from the config: its deliveries and dead letters go.
  forgetSubscribersExcept(names: string[]): number {
    const list = JSON.stringify(names);
    return this.#db.transaction(() =>
      this.#db.prepare("DELETE FROM deliveries WHERE subscriber NOT IN (SELECT value FROM json_each(?))").run(list).changes
      + this.#db.prepare("DELETE FROM dead_letters WHERE subscriber NOT IN (SELECT value FROM json_each(?))").run(list).changes)();
  }

  // Outbox rows with nothing pending whose last delivery ended (or, with no deliveries left, which were stored)
  // before now - keepMs; their deliveries go with them (ON DELETE CASCADE).
  gc(now: number, keepMs: number): number {
    return this.#db.prepare(`DELETE FROM outbox WHERE id IN (
      SELECT o.id FROM outbox o
      WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.outbox_id = o.id AND d.state = 'pending')
        AND COALESCE((SELECT MAX(d.delivered_at) FROM deliveries d WHERE d.outbox_id = o.id), o.created_at) < ?)`).run(now - keepMs).changes;
  }

  pruneDeadLetters(before: number): number {
    return this.#db.prepare("DELETE FROM dead_letters WHERE at < ?").run(before).changes;
  }

  // For `morndo-fleet status`: per path, the events no subscriber took, ever, and when the latest came.
  unrouted(): Unrouted[] {
    return (this.#db.prepare("SELECT path, count, latest_at FROM hook_unrouted ORDER BY path").all() as { path: string; count: number; latest_at: number }[])
      .map(r => ({ path: r.path, count: r.count, latestAt: r.latest_at }));
  }

  // For `morndo-fleet status`: what waits for a subscriber, its dead letters, and the latest one.
  summary(subscriber: string): { pending: number; dead: number; latest: { at: number; reason: string } | null } {
    const dead = (this.#db.prepare("SELECT COUNT(*) AS n FROM dead_letters WHERE subscriber = ?").get(subscriber) as { n: number }).n;
    const latest = this.#db.prepare("SELECT at, reason FROM dead_letters WHERE subscriber = ? ORDER BY id DESC LIMIT 1").get(subscriber) as { at: number; reason: string } | undefined;
    return { pending: this.pendingCount(subscriber), dead, latest: latest ?? null };
  }

  states(subscriber: string): Record<string, number> {
    const rows = this.#db.prepare("SELECT state, COUNT(*) AS n FROM deliveries WHERE subscriber = ? GROUP BY state").all(subscriber) as { state: string; n: number }[];
    return Object.fromEntries(rows.map(r => [r.state, r.n]));
  }
}
