// The highest store sequence each agent database has shown the fleet (fleet core §5.2, §5.3; the fix wave's follow-up),
// per (node, store), kept in fleet.db so a restart forgets nothing. Every `res` that carries a storeSeq raises it; it is
// never lowered here. Two readers:
// - the welcome (agent-session.ts) sends it for the hello's store as `storeSeqSeen`: an agent whose own database is
//   behind it was put back from an older copy, and starts a new store before it runs anything;
// - the fleet's own answers after sending (requests.ts) carry it: a number that database certainly reached.
// Written only when a sequence goes up (keyed ops started, not every poll), with an in-memory copy of what is stored.
// A write that fails (fleet.db busy or full) is logged and left for the next answer; so is a read that fails before it
// (a cache miss), whose value is then taken as unknown and the write tried all the same (it never lowers what is kept).
// Neither ever ends an agent's session (a throw here would close it with 1011; the residual round).
import type Database from "better-sqlite3";
import type { Logger } from "./log.ts";

const KEPT_IN_MEMORY = 4096;

export class StoreSeqsStore {
  #db: Database.Database;
  #now: () => number;
  #log: Logger | null;
  #known = new Map<string, number>();                       // "<node>\n<store>" → what fleet.db holds

  constructor(db: Database.Database, o: { now?: () => number; log?: Logger } = {}) {
    this.#db = db;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? null;
  }

  // An answer from `store` of `node` showed `seq`: kept when it is higher than what is kept.
  saw(node: string, store: string, seq: number): void {
    const k = `${node}\n${store}`;
    let known: number | null = null;
    let read = true;
    try { known = this.#cached(k, node, store); }
    catch (e) {
      read = false;
      this.#log?.error(`could not read store ${store.slice(0, 8)}'s sequence for node ${node} (fleet.db busy?); writing ${seq} without it`, e);
    }
    if (known !== null && known >= seq) return;
    try {
      this.#db.prepare(`INSERT INTO store_seqs (node, store, seq, at) VALUES (?, ?, ?, ?)
        ON CONFLICT(node, store) DO UPDATE SET seq = excluded.seq, at = excluded.at WHERE excluded.seq > store_seqs.seq`)
        .run(node, store, seq, this.#now());
    } catch (e) {
      this.#log?.error(`could not keep store ${store.slice(0, 8)}'s sequence ${seq} for node ${node} (fleet.db busy or full?); the next answer tries again`, e);
      return;
    }
    if (read) this.#remember(k, seq);          // unread, fleet.db may keep a higher one: the next read asks it
  }

  // The highest sequence `store` of `node` has shown, or null (none yet, or a fleet.db that can't be read now).
  highest(node: string, store: string): number | null {
    try { return this.#cached(`${node}\n${store}`, node, store); }
    catch (e) { this.#log?.error(`could not read store ${store.slice(0, 8)}'s sequence for node ${node} (fleet.db busy?)`, e); return null; }
  }

  #cached(k: string, node: string, store: string): number | null {
    const hit = this.#known.get(k);
    if (hit !== undefined) return hit;
    const r = this.#db.prepare("SELECT seq FROM store_seqs WHERE node = ? AND store = ?").get(node, store) as { seq: number } | undefined;
    if (r) this.#remember(k, r.seq);
    return r?.seq ?? null;
  }

  #remember(k: string, seq: number): void {
    this.#known.delete(k);
    this.#known.set(k, seq);
    if (this.#known.size > KEPT_IN_MEMORY) { const oldest = this.#known.keys().next().value; if (oldest !== undefined) this.#known.delete(oldest); }
  }
}
