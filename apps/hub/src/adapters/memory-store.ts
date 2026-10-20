// SQLite adapter for the Memory context (ADR-0031, docs/design/memory/README.md "Storage"): memory.db beside the hub's
// morndo.db, opened with the kit's private open. The domain never sees SQL; this maps rows to Notes. A Note's words are
// written once: a later save of the same id changes only what a domain function may change (its tier, approval,
// invalidation, successor and last confirmation), so a row is append-only in effect (M2). The full-text index gets a
// Note's words on that first write, in the same transaction. Only Memory's own code imports this; no other context
// reads these tables.
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertLocalDisk, openPrivateDb } from "@morndo/service-kit";
import { noteId, type MemoryChange, type MemoryEvent, type Note, type NoteId, type NoteKind, type Scope, type Tier } from "@morndo/domain";
import { MEMORY_SCHEMA_VERSION, MemoryFromFuture, migrateMemory } from "./memory-migrations.ts";

export const MEMORY_FILE = "memory.db";

type NoteRow = {
  id: string; kind: NoteKind; scope: string; title: string; summary: string; body: string; tier: Tier;
  provenance_by: string; provenance_node: string | null; provenance_ref: string | null; provenance_untrusted: number;
  created_at: number; last_confirmed_at: number; recheck_at: number | null;
  approved_at: number | null; approved_by: string | null; invalidated_at: number | null; invalidated_by: string | null; invalid_reason: string | null;
  supersedes: string | null; superseded_by: string | null;
};
const noteOf = (r: NoteRow): Note => ({
  id: r.id as NoteId, kind: r.kind, scope: r.scope as Scope, title: r.title, summary: r.summary, body: r.body, tier: r.tier,
  provenance: { by: r.provenance_by, node: r.provenance_node, ref: r.provenance_ref, untrusted: r.provenance_untrusted === 1 },
  createdAt: r.created_at, lastConfirmedAt: r.last_confirmed_at, recheckAt: r.recheck_at,
  approvedAt: r.approved_at, approvedBy: r.approved_by, invalidatedAt: r.invalidated_at, invalidatedBy: r.invalidated_by, invalidReason: r.invalid_reason,
  supersedes: r.supersedes as NoteId | null, supersededBy: r.superseded_by as NoteId | null,
});
const rowOf = (n: Note): NoteRow => ({
  id: n.id, kind: n.kind, scope: n.scope, title: n.title, summary: n.summary, body: n.body, tier: n.tier,
  provenance_by: n.provenance.by, provenance_node: n.provenance.node, provenance_ref: n.provenance.ref, provenance_untrusted: n.provenance.untrusted ? 1 : 0,
  created_at: n.createdAt, last_confirmed_at: n.lastConfirmedAt, recheck_at: n.recheckAt,
  approved_at: n.approvedAt, approved_by: n.approvedBy, invalidated_at: n.invalidatedAt, invalidated_by: n.invalidatedBy, invalid_reason: n.invalidReason,
  supersedes: n.supersedes, superseded_by: n.supersededBy,
});
// Every column once: a Record over the row's keys, so a field added to the row fails to compile here until listed.
const COLUMNS = Object.keys({
  id: 1, kind: 1, scope: 1, title: 1, summary: 1, body: 1, tier: 1, provenance_by: 1, provenance_node: 1, provenance_ref: 1, provenance_untrusted: 1,
  created_at: 1, last_confirmed_at: 1, recheck_at: 1, approved_at: 1, approved_by: 1, invalidated_at: 1, invalidated_by: 1, invalid_reason: 1,
  supersedes: 1, superseded_by: 1,
} satisfies Record<keyof NoteRow, 1>);

// The index order a lane receives (selectIndex): most trusted first, then the most recently confirmed, then the newest.
const LIST_ORDER = "tier, last_confirmed_at DESC, CAST(substr(id, 3) AS INTEGER) DESC";
// Words, never FTS5's query syntax: each word is a quoted string (a phrase of the tokens it holds), any word may match,
// and bm25 ranks the rows, a match in the title counting four times one in the body and the summary twice
// (https://www.sqlite.org/fts5.html#full_text_query_syntax and #the_bm25_function, read 2026-10-20).
const MAX_WORDS = 16;
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).slice(0, MAX_WORDS);
  return words.length ? words.map(w => `"${w.replace(/"/g, '""')}"`).join(" OR ") : null;
}

export type NoteSearch = { q: string; scope?: Scope | null; kind?: NoteKind | null; limit: number; where?: (n: Note) => boolean };

export class MemoryStore {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    assertLocalDisk(dataDir);                            // before anything is created, as the hub's own store does
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = openPrivateDb(join(dataDir, MEMORY_FILE), {
      synchronous: "NORMAL",
      knownVersion: MEMORY_SCHEMA_VERSION,
      refuseNewer: (found, known) => new MemoryFromFuture(found, known),
      migrate: db => { migrateMemory(db); },
    });
  }

  // IMMEDIATE: the console writes to this file while the hub runs, and a deferred transaction that has read could not
  // take the write lock later without failing at once (https://www.sqlite.org/lang_transaction.html, read 2026-10-20).
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }

  // The next note number, read without taking it; takeId takes it. A refused Note takes none.
  peekId(): NoteId { return noteId(this.#setting<number>("next_note") ?? 1); }
  takeId(): NoteId {
    return this.transaction(() => {
      const id = this.peekId();
      this.#saveSetting("next_note", Number(id.slice(2)) + 1);
      return id;
    });
  }

  save(n: Note) {
    const row = rowOf(n);
    this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO notes (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(c => `@${c}`).join(", ")})`).run(row);
      if (inserted.changes === 1) {
        this.db.prepare("INSERT INTO notes_fts (id, title, summary, body) VALUES (?, ?, ?, ?)").run(n.id, n.title, n.summary, n.body);
        return;
      }
      // M2: what a domain function changes, and nothing else.
      this.db.prepare(`UPDATE notes SET tier = @tier, last_confirmed_at = @last_confirmed_at, approved_at = @approved_at, approved_by = @approved_by,
        invalidated_at = @invalidated_at, invalidated_by = @invalidated_by, invalid_reason = @invalid_reason, superseded_by = @superseded_by WHERE id = @id`).run(row);
    });
  }
  saveEvents(events: readonly MemoryEvent[]) {
    const ins = this.db.prepare("INSERT INTO note_events (note, at, actor, change) VALUES (?, ?, ?, ?)");
    this.transaction(() => { for (const e of events) ins.run(e.note, e.at, e.actor, JSON.stringify(e.change)); });
  }

  get(id: string): Note | null {
    const r = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
    return r ? noteOf(r) : null;
  }
  events(id: string): MemoryEvent[] {
    return (this.db.prepare("SELECT note, at, actor, change FROM note_events WHERE note = ? ORDER BY seq").all(id) as { note: string; at: number; actor: string; change: string }[])
      .map(r => ({ note: r.note as NoteId, at: r.at, actor: r.actor, change: JSON.parse(r.change) as MemoryChange }));
  }
  // Live notes in index order, of one scope or all; with includeInvalid, the superseded and invalidated ones too.
  list(o: { scope?: Scope | null; includeInvalid?: boolean } = {}): Note[] {
    const where = [...(o.scope ? ["scope = @scope"] : []), ...(o.includeInvalid ? [] : ["invalidated_at IS NULL"])];
    return (this.db.prepare(`SELECT * FROM notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${LIST_ORDER}`).all({ scope: o.scope ?? null }) as NoteRow[]).map(noteOf);
  }

  // The notes matching `q`, best ranked first and the most recently confirmed first within a rank, up to `limit` of
  // those `where` keeps (the caller's rule, applied before the limit so a note it drops never hides one it keeps). An
  // empty `q` lists in index order; words that hold no letter or digit match nothing.
  search(s: NoteSearch): Note[] {
    const keep = s.where ?? (() => true);
    const filters = [...(s.scope ? ["n.scope = @scope"] : []), ...(s.kind ? ["n.kind = @kind"] : [])];
    const params = { scope: s.scope ?? null, kind: s.kind ?? null };
    let rows: Iterable<NoteRow>;
    if (!s.q.trim()) {
      rows = this.db.prepare(`SELECT * FROM notes n WHERE n.invalidated_at IS NULL${filters.map(f => ` AND ${f}`).join("")} ORDER BY ${LIST_ORDER}`).iterate(params) as Iterable<NoteRow>;
    } else {
      const match = ftsQuery(s.q);
      if (match === null) return [];
      rows = this.db.prepare(`SELECT n.* FROM notes_fts JOIN notes n ON n.id = notes_fts.id WHERE notes_fts MATCH @match${filters.map(f => ` AND ${f}`).join("")}
        ORDER BY bm25(notes_fts, 0.0, 4.0, 2.0, 1.0), n.last_confirmed_at DESC`).iterate({ ...params, match }) as Iterable<NoteRow>;
    }
    const out: Note[] = [];
    for (const r of rows) {
      const n = noteOf(r);
      if (!keep(n)) continue;
      out.push(n);
      if (out.length >= s.limit) break;              // ends the statement (the iterator's return())
    }
    return out;
  }

  // Per node, the bundle version it last took whole, and when (Sync: every 30 minutes, it is sent again).
  lastSynced(node: string): { version: string; at: number } | null { return this.#setting<{ version: string; at: number }>(`synced:${node}`); }
  setSynced(node: string, version: string, at: number) { this.#saveSetting(`synced:${node}`, { version, at }); }

  close() { this.db.close(); }

  #setting<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value FROM memory_settings WHERE key = ?").get(key) as { value: string } | undefined;
    try { return r ? (JSON.parse(r.value) as T) : null; } catch { return null; }
  }
  #saveSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO memory_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }
}
