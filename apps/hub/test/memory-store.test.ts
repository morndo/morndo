// Memory's own file (ADR-0031, docs/design/memory/README.md "Storage"): memory.db beside morndo.db, its migrations
// linted as the hub's are (§11.2), its schema floor its own, the full-text index kept with each Note's first write, a
// Note's words never rewritten (M2), and everything still there after a reopen. Temporary directories, synthetic notes.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { additiveViolations, lintMigrations, writeFloor } from "@morndo/service-kit";
import { approveNote, invalidateNote, noteId, proposeNote, type MemoryActor, type Note, type NoteDraft } from "@morndo/domain";
import { MEMORY_MIGRATIONS, MemoryFromFuture } from "../src/adapters/memory-migrations.ts";
import { MemoryStore, ftsQuery } from "../src/adapters/memory-store.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const lane: MemoryActor = { kind: "worker", name: "api-fix", token: "t1" };
const owner: MemoryActor = { kind: "principal", via: "console", id: "console" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "morndo-memory-store-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function note(store: MemoryStore, d: Partial<NoteDraft>, actor: MemoryActor = lane, at = NOW): Note {
  const r = proposeNote({ kind: "fact", scope: "repo:shop-api", title: "A title", body: "A body.", ...d }, actor, store.takeId(), at);
  if (!r.ok) throw new Error(r.error.problem);
  store.save(r.value.note);
  store.saveEvents([r.value.event]);
  return r.value.note;
}
const ids = (notes: Note[]) => notes.map(n => n.id);

describe("Memory's migrations", () => {
  it("are linted like the hub's: the one breaking migration is v1, breaking only for its FTS5 table", () => {
    expect(MEMORY_MIGRATIONS.filter(m => m.compat === "breaking").map(m => m.version)).toEqual([1]);
    expect(lintMigrations(MEMORY_MIGRATIONS)).toEqual([]);
    const first = MEMORY_MIGRATIONS[0];
    if (!first) throw new Error("no migration");
    // Declared additive, the linter would find the virtual table and nothing else.
    expect(additiveViolations({ ...first, compat: "additive" })).toEqual([expect.stringMatching(/creates a virtual table/)]);
  });

  it("make memory.db beside morndo.db, private, with its own version and floor", () => {
    const dir = tmp();
    new MemoryStore(dir).close();
    expect(statSync(join(dir, "memory.db")).mode & 0o777).toBe(0o600);
    const db = new Database(join(dir, "memory.db"), { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(MEMORY_MIGRATIONS.length);
    expect(db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get()).toEqual({ floor: 1 });
    db.close();
  });

  it("refuse a memory.db whose floor is above this hub, and leave it as it was", () => {
    const dir = tmp();
    new MemoryStore(dir).close();
    const raw = new Database(join(dir, "memory.db"));
    writeFloor(raw, MEMORY_MIGRATIONS.length + 1);
    raw.pragma(`user_version = ${MEMORY_MIGRATIONS.length + 1}`);
    raw.close();
    expect(() => new MemoryStore(dir)).toThrow(MemoryFromFuture);
    const after = new Database(join(dir, "memory.db"), { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(MEMORY_MIGRATIONS.length + 1);
    after.close();
  });
});

describe("the store", () => {
  it("numbers notes in order, and a peek takes no number", () => {
    const store = new MemoryStore(tmp());
    expect(store.peekId()).toBe("N-1");
    expect(store.peekId()).toBe("N-1");
    expect(store.takeId()).toBe("N-1");
    expect(store.takeId()).toBe("N-2");
    store.close();
  });

  it("finds notes by their words, best match first and the most recently confirmed first within a match", () => {
    const store = new MemoryStore(tmp());
    const body = note(store, { title: "Deploys", body: "The release runs the migrations first." });
    const title = note(store, { title: "Migrations need a lock", body: "Take the advisory lock." });
    const other = note(store, { title: "Coffee", body: "Nothing about it.", scope: "repo:web-app" });
    note(store, { title: "Unrelated", body: "Caching headers." });
    expect(ids(store.search({ q: "migrations", limit: 10 }))).toEqual([title.id, body.id]);   // a title match counts more
    expect(ids(store.search({ q: "coffee migrations", limit: 10 }))).toContain(other.id);    // any word may match
    expect(ids(store.search({ q: "coffee", scope: "repo:shop-api" as never, limit: 10 }))).toEqual([]);
    expect(ids(store.search({ q: "migrations", limit: 1 }))).toEqual([title.id]);
    expect(ids(store.search({ q: "migrations", kind: "procedure", limit: 10 }))).toEqual([]);
    // Two notes as good as each other: the newer confirmation first.
    const older = note(store, { title: "Twin", body: "Same words here." }, lane, NOW - 1000);
    const newer = note(store, { title: "Twin", body: "Same words here." }, lane, NOW);
    expect(ids(store.search({ q: "twin", limit: 10 }))).toEqual([newer.id, older.id]);
    store.close();
  });

  it("reads the words as words: FTS5's own syntax in them is quoted, and punctuation alone matches nothing", () => {
    expect(ftsQuery('a "b" OR c*')).toBe('"a" OR """b""" OR "OR" OR "c*"');
    expect(ftsQuery("-- ?!")).toBeNull();
    const store = new MemoryStore(tmp());
    note(store, { title: "Quotes", body: 'He said "NEAR(a b)" twice.' });
    expect(() => store.search({ q: 'NEAR(a b) "x', limit: 5 })).not.toThrow();
    expect(store.search({ q: "?!", limit: 5 })).toEqual([]);
    store.close();
  });

  it("applies the caller's rule before the limit, so a dropped note never hides a kept one", () => {
    const store = new MemoryStore(tmp());
    const dropped = note(store, { title: "Release steps", body: "Release.", kind: "procedure" });
    const kept = note(store, { title: "Release day", body: "Fridays only." });
    expect(ids(store.search({ q: "release", limit: 1, where: n => n.id !== dropped.id }))).toEqual([kept.id]);
    store.close();
  });

  it("lists in index order with an empty query: the most trusted first, then the most recently confirmed", () => {
    const store = new MemoryStore(tmp());
    const agentOld = note(store, { title: "a" }, lane, NOW - 5000);
    const agentNew = note(store, { title: "b" }, lane, NOW);
    const own = note(store, { title: "c" }, owner, NOW - 9000);
    expect(ids(store.search({ q: "", limit: 10 }))).toEqual([own.id, agentNew.id, agentOld.id]);
    expect(ids(store.list())).toEqual([own.id, agentNew.id, agentOld.id]);
    store.close();
  });

  it("never rewrites a note's words (M2): a later save changes only what a domain function changes", () => {
    const store = new MemoryStore(tmp());
    const n = note(store, { title: "Original", body: "Original body.", kind: "procedure" });
    const approved = approveNote(n, owner, NOW + 1);
    if (!approved.ok) throw new Error(approved.error.problem);
    store.save({ ...approved.value.note, title: "Changed", body: "Changed body." });
    expect(store.get(n.id)).toMatchObject({ title: "Original", body: "Original body.", tier: 1, approvedAt: NOW + 1, approvedBy: "principal:console" });
    expect(ids(store.search({ q: "changed", limit: 5 }))).toEqual([]);
    expect(ids(store.search({ q: "original", limit: 5 }))).toEqual([n.id]);
    store.close();
  });

  it("keeps notes, events, the index, the numbering and each node's last version after a reopen", () => {
    const dir = tmp();
    const store = new MemoryStore(dir);
    const n = note(store, { title: "Kept", body: "Survives a restart." });
    const gone = invalidateNote(n, lane, "wrong", NOW + 5);
    if (!gone.ok) throw new Error(gone.error.problem);
    store.save(gone.value.note);
    store.saveEvents([gone.value.event]);
    store.setSynced("pc", "0123456789abcdef0123456789abcdef", NOW);
    store.close();

    const again = new MemoryStore(dir);
    expect(again.get(n.id)).toMatchObject({ title: "Kept", invalidatedAt: NOW + 5, invalidReason: "wrong" });
    expect(again.events(n.id).map(e => e.change.kind)).toEqual(["proposed", "invalidated"]);
    expect(ids(again.search({ q: "restart", limit: 5 }))).toEqual([n.id]);
    expect(again.list()).toEqual([]);                                   // invalidated: not live
    expect(ids(again.list({ includeInvalid: true }))).toEqual([n.id]);
    expect(again.peekId()).toBe(noteId(2));
    expect(again.lastSynced("pc")).toEqual({ version: "0123456789abcdef0123456789abcdef", at: NOW });
    expect(again.lastSynced("laptop")).toBeNull();
    again.close();
  });
});
