// The hook stream (spec §5.4, §5.5): every hook the relay accepts is committed here before it is answered, and stays
// until the fleet acknowledges it. The commit is not synced to the disk (synchronous=NORMAL, spec §16.4): an agent that
// crashes loses none, while a power loss or a crash of the machine may take back the last ones, from lanes that went
// down with it.
// - `seq` comes from an AUTOINCREMENT key, so it only grows within a stream, never repeats, and may have gaps:
//   coalescing deletes superseded rows. The fleet records the highest seq it accepted.
// - /cc and /sl are progress, coalesced to the latest per session: a new one replaces the unacknowledged one before it.
// - Caps (LIMITS.spoolMaxEvents, spoolMaxBytes): at the cap a progress event is dropped; a kept event first evicts the
//   oldest progress events, and is refused only when that isn't enough. The byte cap is the node's whole disk budget:
//   what the relay's copies and the upload inbox hold (`held`) counts toward it too.
// - Every event that couldn't be spooled (full, or the write failed) counts in `drops`, which health reports.
// - `failWrites` (the test hook spoolFail) makes every write fail the way a write to a full disk does: append answers
//   write_failed, ack throws (its callers, stream-sender.ts, log it and go on).
// - The stream id is the database's (meta); rotate() moves to a new one (agent.ts, for a restored database).
import type Database from "better-sqlite3";
import { LIMITS, type HookEvent } from "@morndo/protocol";

export type HookPath = HookEvent["path"];
export type SpoolEvent = { path: HookPath; at: number; session: string | null; window: string | null; body: unknown };
export type Stored = { seq: number; at: number; path: HookPath; window: string | null; body: unknown };
export type Appended = { ok: true; seq: number } | { ok: false; why: "full" | "write_failed" };

// Thrown inside append's transaction so a refusal rolls back every deletion made on the way.
class Refused extends Error {}

export const isProgress = (path: string): boolean => path === "/cc" || path === "/sl";

export class Spool {
  #streamId: string;
  #db: Database.Database;
  #maxEvents: number;
  #maxBytes: number;
  #now: () => number;
  #failWrites: boolean;
  #held: () => number;
  #count = 0;
  #bytes = 0;
  #openLastSeq: number | null;
  drops = 0;

  constructor(db: Database.Database, streamId: string, o: { maxEvents?: number; maxBytes?: number; now?: () => number; failWrites?: boolean; held?: () => number } = {}) {
    this.#db = db;
    this.#streamId = streamId;
    this.#maxEvents = o.maxEvents ?? LIMITS.spoolMaxEvents;
    this.#maxBytes = o.maxBytes ?? LIMITS.spoolMaxBytes;
    this.#now = o.now ?? Date.now;
    this.#failWrites = o.failWrites === true;
    this.#held = o.held ?? (() => 0);
    const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream").get() as { n: number; b: number };
    this.#count = r.n;
    this.#bytes = r.b;
    // the high-water mark before the relay can spool anything (null: unreadable; the agent still starts, as before)
    try { this.#openLastSeq = this.lastSeq(); } catch { this.#openLastSeq = null; }
  }

  get streamId(): string { return this.#streamId; }
  rotate(streamId: string): void { this.#streamId = streamId; }
  depth(): number { return this.#count; }
  bytes(): number { return this.#bytes; }
  maxSeq(): number { return (this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM stream").get() as { m: number }).m; }
  // The highest seq this database ever issued, acknowledged (deleted) rows included: AUTOINCREMENT keeps it in
  // sqlite_sequence (https://www.sqlite.org/autoinc.html, read 2026-10-06).
  lastSeq(): number {
    return (this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'stream'").get() as { seq: number } | undefined)?.seq ?? 0;
  }

  // The highest seq this database had issued when it was opened (before any new event of this process); null when it
  // couldn't be read then. restored() bounds its ack by this so events spooled after a restore, before the first
  // welcome, are not acked away.
  openLastSeq(): number | null { return this.#openLastSeq; }

  // Counted without spooling (a progress body too large to keep, say).
  dropped(): void { this.drops++; }

  // Commits the event; `within(seq)` runs in the same transaction (the relay records its file copy there).
  append(e: SpoolEvent, within?: (seq: number) => void): Appended {
    const body = JSON.stringify(e.body ?? null);
    const size = Buffer.byteLength(body);
    const coalesce = isProgress(e.path) ? `${e.path}\n${e.session ?? ""}` : null;
    try {
      if (this.#failWrites) throw new Error("the test hook spoolFail refuses every spool write");
      const out = this.#db.transaction((): { appended: Appended; count: number; bytes: number } => {
        let count = this.#count, bytes = this.#bytes;
        if (coalesce !== null) {
          const old = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream WHERE coalesce_key = ?").get(coalesce) as { n: number; b: number };
          if (old.n) {
            this.#db.prepare("DELETE FROM stream WHERE coalesce_key = ?").run(coalesce);
            count -= old.n;
            bytes -= old.b;
          }
        }
        const held = this.#held();
        const full = () => count + 1 > this.#maxEvents || bytes + held + size > this.#maxBytes;
        if (full() && coalesce !== null) throw new Refused();
        while (full()) {
          const victim = this.#db.prepare("SELECT seq, size FROM stream WHERE coalesce_key IS NOT NULL ORDER BY seq LIMIT 1").get() as { seq: number; size: number } | undefined;
          if (!victim) throw new Refused();
          this.#db.prepare("DELETE FROM stream WHERE seq = ?").run(victim.seq);
          count -= 1;
          bytes -= victim.size;
        }
        const seq = Number(this.#db.prepare("INSERT INTO stream (at, path, session, window, coalesce_key, body, size) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(e.at, e.path, e.session, e.window, coalesce, body, size).lastInsertRowid);
        within?.(seq);
        return { appended: { ok: true, seq }, count: count + 1, bytes: bytes + size };
      }).immediate();
      this.#count = out.count;
      this.#bytes = out.bytes;
      return out.appended;
    } catch (e) {
      this.drops++;
      return { ok: false, why: e instanceof Refused ? "full" : "write_failed" };
    }
  }

  // Events after `seq`, oldest first.
  after(seq: number, limit: number): Stored[] {
    return (this.#db.prepare("SELECT seq, at, path, window, body FROM stream WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as
      { seq: number; at: number; path: HookPath; window: string | null; body: string }[])
      .map(r => ({ seq: r.seq, at: r.at, path: r.path, window: r.window, body: JSON.parse(r.body) as unknown }));
  }

  // A cumulative acknowledgement: everything up to `seq` is the fleet's now. Relay copies those events carried start
  // their 24 hours. Throws when the database can't be written.
  ack(seq: number): void {
    if (this.#failWrites) throw new Error("the test hook spoolFail refuses every spool write");
    const gone = this.#db.transaction(() => {
      const g = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream WHERE seq <= ?").get(seq) as { n: number; b: number };
      this.#db.prepare("UPDATE relay_files SET acked_at = ? WHERE seq <= ? AND acked_at IS NULL").run(this.#now(), seq);
      this.#db.prepare("DELETE FROM stream WHERE seq <= ?").run(seq);
      return g;
    }).immediate();
    this.#count -= gone.n;                                  // only once the commit succeeded
    this.#bytes -= gone.b;
  }
}
