// The delivery queue's store (fleet clients spec §4.1–4.3; plan Contracts, "Agent internals shared by Tasks 4 to 6" and
// Databases, agent.db migration 7). One row per delivery in agent.db, with this agent as its only writer.
// - Storing a delivery is its own transaction, its WAL synced off the event loop before the answer goes out (db/wal-sync.ts,
//   fleet core §16.4): an answer of `queued` is a promise the sender may stop retrying on, so it must outlive a power
//   loss. Every later change (a waiting reason, typed, held, delivered, expired) is an ordinary NORMAL commit. One lost
//   to a power loss is found again: a `started` key (synced, ops/done-keys.ts) says a delivery may have been typed, and
//   the transcript says whether it was taken.
// - A deadline arrives as a duration (ttlMs) and becomes notAfter on this node's clock when stored. A client's clock is
//   never compared with the node's (plan Review Focus 3: the owner's PC ran 1.1 s behind the control plane).
// - The same id with the same target and text is the same delivery: the answer is its state now, and nothing is stored
//   again (its notAfter stays). The same id with another target or text is a conflict (id_conflict). Whether a lane name
//   is sticky is the fleet's judgement when it routes, not the delivery's content.
// - The order stored is the rowid, which SQLite gives "one larger than the largest ROWID in the table prior to the
//   insert" (https://www.sqlite.org/autoinc.html, read 2026-10-08). So a new row sorts after every row still there, even
//   two stored in one millisecond, whatever pruning removed.
// - `sessionId` in a change binds a queued delivery to a session (a lane name queued while its lane was starting binds
//   the first session it shows) and, once typed, records the session it was typed into. The Delivery the fleet sees
//   shows the second, else the first.
// - A final delivery (delivered, uncertain, given_up) is never changed. Final ones are pruned 7 days after their last
//   change (LIMITS.deliveryKeepMs); open ones never are.
// - The text stays on this node: the Delivery the store answers with carries none (textOf reads it for the deliverer).
import type Database from "better-sqlite3";
import { FINAL_DELIVERY_STATES as FINAL, LIMITS, type Delivery, type DeliveryState, type DeliveryTarget, type DraftStash, type GiveUpReason, type WaitingReason } from "@morndo/protocol";
import { walSyncOf, type WalSync } from "../db/wal-sync.ts";

const OPEN = "('queued', 'typed', 'held')";

// What the deliverer needs beyond the Delivery the fleet sees: whether a lane name is sticky, the session a name is bound
// to, and whether its one retype after an interrupt was used (spec §4.1, §4.3).
export type DeliveryDetail = { target: DeliveryTarget; boundSession: string | null; retyped: boolean };
export type DeliveryChange = Partial<Pick<Delivery, "state" | "waiting" | "sessionId" | "typedAt" | "deliveredAt" | "why" | "note" | "stashed">> & { retyped?: boolean };

type Row = {
  id: string; target_lane: string | null; target_worker: string | null; sticky: number; bound_session: string | null; text: string;
  state: DeliveryState; waiting_reason: WaitingReason | null; waiting_since: number | null; queued_at: number; not_after: number;
  typed_at: number | null; typed_session: string | null; delivered_at: number | null; why: GiveUpReason | null; note: string | null;
  retyped: number; updated_at: number; stashed: string | null;
};

export class DeliveryStore {
  #db: Database.Database;
  #now: () => number;
  #node: string;
  #sync: WalSync;

  constructor(db: Database.Database, now: () => number, node: string, walSync?: WalSync) {
    this.#db = db;
    this.#now = now;
    this.#node = node;
    this.#sync = walSync ?? walSyncOf(db);
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
  }

  #delivery(r: Row): Delivery {
    const sessionId = r.typed_session ?? r.bound_session;
    return {
      id: r.id, node: this.#node,
      target: r.target_lane !== null ? { lane: r.target_lane } : { workerId: r.target_worker ?? "" },
      state: r.state, queuedAt: r.queued_at, notAfter: r.not_after,
      ...(r.state === "queued" && r.waiting_reason !== null ? { waiting: { reason: r.waiting_reason, since: r.waiting_since ?? r.queued_at } } : {}),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(r.typed_at !== null ? { typedAt: r.typed_at } : {}),
      ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
      ...(r.why !== null ? { why: r.why } : {}),
      ...(r.note !== null ? { note: r.note } : {}),
      ...(r.stashed !== null ? { stashed: JSON.parse(r.stashed) as DraftStash } : {}),
    };
  }

  // A fresh row is committed and its WAL synced before the promise resolves: `queued` goes out only once the row is
  // durable (domain.md FL15). A sync that fails takes a fresh row back and throws, so the deliverer answers internal,
  // executed "no" — nothing was queued. A row that was already there (the same id, target and text) was synced when it
  // was stored, in the same per-id queue (delivery-ops.ts); it answers its state now with no sync of its own.
  async store(d: { id: string; target: DeliveryTarget; text: string; ttlMs: number; boundSession: string | null }): Promise<{ delivery: Delivery; fresh: boolean } | { conflict: true }> {
    const lane = "lane" in d.target ? d.target.lane : null;
    const worker = "workerId" in d.target ? d.target.workerId : null;
    const sticky = "lane" in d.target && d.target.sticky ? 1 : 0;
    let fresh = false;
    const write = () => this.#db.transaction((): { delivery: Delivery; fresh: boolean } | { conflict: true } => {
      const old = this.#row(d.id);
      if (old) {
        const same = old.target_lane === lane && old.target_worker === worker && old.text === d.text;
        return same ? { delivery: this.#delivery(old), fresh: false } : { conflict: true };
      }
      const at = this.#now();
      this.#db.prepare(`INSERT INTO deliveries (id, target_lane, target_worker, sticky, bound_session, text, state, queued_at, not_after, retyped, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 0, ?)`).run(d.id, lane, worker, sticky, d.boundSession, d.text, at, at + d.ttlMs, at);
      fresh = true;
      return { delivery: this.#delivery(this.#row(d.id) as Row), fresh: true };
    }).immediate();
    const stored = write();
    if (!fresh) return stored;                               // an earlier call stored it, and synced it, in the same queue
    try { await this.#sync(); }
    catch (e) {                                              // a row that is not durable must not stay queued
      try { this.#db.prepare("DELETE FROM deliveries WHERE id = ?").run(d.id); } catch { /* the original error stands */ }
      throw e;
    }
    return stored;
  }

  get(id: string): Delivery | null {
    const r = this.#row(id);
    return r ? this.#delivery(r) : null;
  }

  textOf(id: string): string | null {
    return this.#row(id)?.text ?? null;
  }

  detail(id: string): DeliveryDetail | null {
    const r = this.#row(id);
    if (!r) return null;
    return {
      target: r.target_lane !== null ? { lane: r.target_lane, sticky: r.sticky === 1 } : { workerId: r.target_worker ?? "" },
      boundSession: r.bound_session,
      retyped: r.retyped === 1,
    };
  }

  // The oldest delivery of that target that isn't final (spec §4.3, "One at a time per lane").
  head(t: { lane: string } | { workerId: string }): Delivery | null {
    const lane = "lane" in t ? t.lane : null;
    const worker = "workerId" in t ? t.workerId : null;
    const r = this.#db.prepare(`SELECT * FROM deliveries WHERE (target_lane = ? OR target_worker = ?) AND state IN ${OPEN} ORDER BY rowid LIMIT 1`)
      .get(lane, worker) as Row | undefined;
    return r ? this.#delivery(r) : null;
  }

  open(): Delivery[] {
    return (this.#db.prepare(`SELECT * FROM deliveries WHERE state IN ${OPEN} ORDER BY rowid`).all() as Row[]).map(r => this.#delivery(r));
  }

  // Final deliveries whose last change is at or after `sinceMs`, a time on this node's clock (spec §4.4: the last hour's).
  recentFinal(sinceMs: number): Delivery[] {
    return (this.#db.prepare(`SELECT * FROM deliveries WHERE state NOT IN ${OPEN} AND updated_at >= ? ORDER BY rowid`).all(sinceMs) as Row[])
      .map(r => this.#delivery(r));
  }

  update(id: string, change: DeliveryChange): Delivery {
    const r = this.#row(id);
    if (!r) throw new Error(`no delivery ${id}`);
    if (FINAL.has(r.state)) return this.#delivery(r);
    const state = change.state ?? r.state;
    const queued = state === "queued";
    const next: Row = {
      ...r,
      state,
      waiting_reason: !queued ? null : change.waiting !== undefined ? change.waiting.reason : r.waiting_reason,
      waiting_since: !queued ? null : change.waiting !== undefined ? change.waiting.since : r.waiting_since,
      bound_session: queued && change.sessionId !== undefined ? change.sessionId : r.bound_session,
      typed_session: !queued && change.sessionId !== undefined ? change.sessionId : r.typed_session,
      typed_at: change.typedAt ?? r.typed_at,
      delivered_at: change.deliveredAt ?? r.delivered_at,
      why: change.why ?? r.why,
      note: change.note ?? r.note,
      retyped: change.retyped === undefined ? r.retyped : change.retyped ? 1 : 0,
      updated_at: this.#now(),
      stashed: change.stashed !== undefined ? JSON.stringify(change.stashed) : r.stashed,
    };
    this.#db.prepare(`UPDATE deliveries SET state = ?, waiting_reason = ?, waiting_since = ?, bound_session = ?, typed_session = ?, typed_at = ?,
      delivered_at = ?, why = ?, note = ?, retyped = ?, updated_at = ?, stashed = ? WHERE id = ?`)
      .run(next.state, next.waiting_reason, next.waiting_since, next.bound_session, next.typed_session, next.typed_at, next.delivered_at, next.why,
        next.note, next.retyped, next.updated_at, next.stashed, id);
    return this.#delivery(next);
  }

  prune(): number {
    return this.#db.prepare(`DELETE FROM deliveries WHERE state NOT IN ${OPEN} AND updated_at < ?`).run(this.#now() - LIMITS.deliveryKeepMs).changes;
  }
}
