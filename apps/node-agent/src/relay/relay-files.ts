// The hook relay's copies of files a lane sends with /file (spec §5.5): the named file is opened under today's
// confinement rules (node-files.ts' opener: O_NOFOLLOW after the check), copied from that open handle into
// ~/.local/state/morndo-node/relay-files/<ref>, 0600, and the event carries { ref, name, size } for the fleet to fetch
// with file.get. What the copies hold counts toward the node's disk budget (LIMITS.spoolMaxBytes, with the spool and
// the upload inbox): a copy that doesn't fit in `room` is refused (503, so the script's own fallback runs). A copy is
// deleted 24 hours after its event was acknowledged (LIMITS.relayFileKeepMs); a copy no event ever took (a crash
// between copy and commit) goes after 24 hours too.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import { LIMITS } from "@morndo/protocol";
import type { Opened } from "../ops/node-files.ts";

export type Copied = { ok: true; ref: string; file: string; name: string; size: number } | { ok: false; status: 403 | 404 | 413 | 503 };

export class RelayFiles {
  #dir: string;
  #db: Database.Database;
  #open: (path: string) => Promise<Opened>;
  #room: () => number;
  #now: () => number;
  #inflight = 0;                                              // bytes of copies under way, reserved against the budget

  constructor(o: { dir: string; db: Database.Database; open: (path: string) => Promise<Opened>; room?: () => number; now?: () => number }) {
    this.#dir = o.dir;
    this.#db = o.db;
    this.#open = o.open;
    this.#room = o.room ?? (() => Number.POSITIVE_INFINITY);
    this.#now = o.now ?? Date.now;
  }

  async copy(path: string): Promise<Copied> {
    const c = await this.#open(path);
    if (!c.ok) return { ok: false, status: c.reason === "too_large" ? 413 : c.reason === "missing" ? 404 : 403 };
    const size = c.size;
    try {
      if (size > this.#room()) return { ok: false, status: 503 };          // room() now reflects other in-flight copies
      this.#inflight += size;                                              // reserve against the shared budget
      try {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        const ref = randomBytes(16).toString("hex");
        const file = join(this.#dir, ref);
        const tmp = `${file}.tmp`;
        try {
          await pipeline(c.fh.createReadStream({ start: 0, end: size - 1, autoClose: false }), createWriteStream(tmp, { mode: 0o600 }));
          chmodSync(tmp, 0o600);
          const actual = statSync(tmp).size;
          if (actual > LIMITS.maxFileBytes) { rmSync(tmp, { force: true }); return { ok: false, status: 413 }; }
          const tfd = openSync(tmp, "r"); try { fsyncSync(tfd); } finally { closeSync(tfd); }   // the copy's data is on disk
          renameSync(tmp, file);
          const dfd = openSync(this.#dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }   // the new dir entry is durable
          return { ok: true, ref, file, name: basename(path), size: actual };
        } catch (e) { rmSync(tmp, { force: true }); throw e; }
      } finally { this.#inflight -= size; }
    } finally { await c.fh.close(); }
  }

  // What the copies hold, for the disk budget.
  bytes(): number {
    return (this.#db.prepare("SELECT COALESCE(SUM(size), 0) AS b FROM relay_files").get() as { b: number }).b + this.#inflight;
  }

  // Inside the spool's transaction: the copy belongs to the event `seq`.
  record(c: { ref: string; file: string; name: string; size: number }, seq: number): void {
    this.#db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(c.ref, c.file, c.name, c.size, this.#now(), seq);
  }

  discard(file: string): void { rmSync(file, { force: true }); }

  sweep(): number {
    const before = this.#now() - LIMITS.relayFileKeepMs;
    const old = this.#db.prepare("SELECT ref, file FROM relay_files WHERE acked_at IS NOT NULL AND acked_at < ?").all(before) as { ref: string; file: string }[];
    for (const r of old) rmSync(r.file, { force: true });
    this.#db.prepare("DELETE FROM relay_files WHERE acked_at IS NOT NULL AND acked_at < ?").run(before);
    let removed = old.length;
    if (existsSync(this.#dir)) {
      const known = new Set((this.#db.prepare("SELECT ref FROM relay_files").all() as { ref: string }[]).map(r => r.ref));
      for (const f of readdirSync(this.#dir)) {
        const p = join(this.#dir, f);
        try {
          if (!known.has(f.replace(/\.tmp$/, "")) && statSync(p).mtimeMs < before) { rmSync(p, { force: true }); removed++; }
        } catch { /* gone meanwhile */ }
      }
    }
    return removed;
  }
}
