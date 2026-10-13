// The agent's database: numbered migrations, WAL with synchronous=NORMAL (fleet core §16.4), a streamId born with the
// database, a newer database refused, and one on a network file system refused before anything is written. Real SQLite
// files in a temporary directory.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/db/migrations.ts";
import { DatabaseUnreadable, openAgentDb, rotateStreamId } from "../src/db/open.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function dbPath() { const h = tempHome(); homes.push(h); return join(h.home, "state", "agent.db"); }
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("agent database", () => {
  it("is created with WAL, synchronous=NORMAL, every migration and a streamId", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    expect(a.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(a.db.pragma("synchronous", { simple: true })).toBe(1);              // 1 = NORMAL: no sync per commit (§16.4)
    expect(a.db.pragma("fullfsync", { simple: true })).toBe(1);               // macOS's full flush for what is synced
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const tables = (a.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    expect(tables).toEqual(["_morndo_schema", "deliveries", "done_keys", "job_deliveries", "jobs", "meta", "relay_files", "store_seq", "stream", "token_cache"]);
    expect(a.db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get()).toEqual({ floor: 0 });   // no breaking migration yet (§11.1)
    expect(a.db.prepare("SELECT one, seq FROM store_seq").all()).toEqual([{ one: 1, seq: 0 }]);
    expect(a.streamId).toMatch(UUID);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    a.close();
  });
  it("migrates a database made at version 1: its keys, stream and store kept, the store sequence from 0 (final review I2)", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    migrate(raw, MIGRATIONS.slice(0, 1));
    raw.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES ('hub:a', 'h', 'started', 1)").run();
    const stream = (raw.prepare("SELECT value FROM meta WHERE key = 'streamId'").get() as { value: string }).value;
    raw.close();
    const a = openAgentDb(path);
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(a.streamId).toBe(stream);
    expect(a.db.prepare("SELECT key, state FROM done_keys").all()).toEqual([{ key: "hub:a", state: "started" }]);
    expect(a.db.prepare("SELECT seq FROM store_seq").all()).toEqual([{ seq: 0 }]);
    expect(a.db.prepare("SELECT name FROM sqlite_master WHERE name = 'jobs'").get()).toEqual({ name: "jobs" });
    a.db.exec("UPDATE store_seq SET seq = 3");
    expect(() => a.db.exec("INSERT INTO store_seq (one, seq) VALUES (2, 0)")).toThrow(/CHECK/);   // one row only
    expect(() => a.db.exec("UPDATE store_seq SET seq = -1")).toThrow(/CHECK/);
    a.close();
  });
  it("migrates a database made at version 2 to the jobs table and keeps its done keys", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    migrate(raw, MIGRATIONS.slice(0, 2));
    raw.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES ('hub:a', 'h', 'started', 1)").run();
    raw.close();
    const a = openAgentDb(path);
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(a.db.prepare("SELECT key, state FROM done_keys").all()).toEqual([{ key: "hub:a", state: "started" }]);
    a.db.exec(`INSERT INTO jobs (id, lane, name, job_class, notify, command_hash, cwd_hash, accepted_at, state, notice)
      VALUES ('job-1', 'builder', 'pack', 'default', '{"kind":"fleet"}', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 1, 'queued', 'none')`);
    expect(a.db.prepare("SELECT id, state FROM jobs").all()).toEqual([{ id: "job-1", state: "queued" }]);
    expect(() => a.db.exec(`INSERT INTO jobs (id, lane, name, job_class, notify, command_hash, cwd_hash, accepted_at, state, notice)
      VALUES ('job-2', 'builder', 'pack', 'default', '{}', 'aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', 1, 'nope', 'none')`)).toThrow(/CHECK/);
    a.close();
  });
  it("migrates a database made at version 6 (the jobs' tables) to the deliveries table (fleet clients, migration 7), with its checks", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    migrate(raw, MIGRATIONS.slice(0, 6));
    raw.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES ('hub:a', 'h', 'started', 1)").run();
    raw.close();
    const a = openAgentDb(path);
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(a.db.prepare("SELECT key FROM done_keys").all()).toEqual([{ key: "hub:a" }]);
    const ins = (o: Record<string, unknown>) => a.db.prepare(`INSERT INTO deliveries (id, target_lane, target_worker, sticky, text, state, queued_at, not_after, updated_at)
      VALUES (@id, @lane, @worker, @sticky, 'x', @state, 1, 2, 1)`).run({ id: "hub:x", lane: "manager", worker: null, sticky: 1, state: "queued", ...o });
    expect(() => ins({ id: "hub:both", worker: "pc.0a1b2c3d.1" })).toThrow(/CHECK/);       // exactly one target
    expect(() => ins({ id: "hub:none", lane: null })).toThrow(/CHECK/);
    expect(() => ins({ id: "hub:state", state: "sent" })).toThrow(/CHECK/);
    expect(() => ins({ id: "hub:sticky", sticky: 2 })).toThrow(/CHECK/);
    ins({ id: "hub:ok" });
    expect(a.db.prepare("SELECT id, state, retyped, waiting_reason FROM deliveries").all()).toEqual([{ id: "hub:ok", state: "queued", retyped: 0, waiting_reason: null }]);
    a.close();
  });
  it("keeps its streamId across restarts, and a reset database gets a new one", () => {
    const path = dbPath();
    const first = openAgentDb(path);
    const id = first.streamId;
    first.close();
    const again = openAgentDb(path);
    expect(again.streamId).toBe(id);
    again.close();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    expect(existsSync(path)).toBe(false);
    const reset = openAgentDb(path);
    expect(reset.streamId).toMatch(UUID);
    expect(reset.streamId).not.toBe(id);
    reset.close();
  });
  it("a copy made with cp (agent.db, -wal and -shm) opened at another path is a new store; each file keeps its own (final review I2)", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    a.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)").run();   // in the -wal, not yet checkpointed
    expect(existsSync(`${path}-wal`)).toBe(true);
    const copy = join(dirname(path), "copied", "agent.db");
    mkdirSync(dirname(copy));
    for (const suffix of ["", "-wal", "-shm"]) execFileSync("cp", [`${path}${suffix}`, `${copy}${suffix}`]);
    const original = a.streamId;
    a.close();
    const b = openAgentDb(copy);
    expect(b.streamId).toMatch(UUID);
    expect(b.streamId).not.toBe(original);                                         // a copied file: another store
    expect(b.copied).toBe(true);
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM stream").get()).toEqual({ n: 1 });   // the copy's -wal was read: its data is there
    const copiedStore = b.streamId;
    b.close();
    const again = openAgentDb(copy);
    expect([again.streamId, again.copied]).toEqual([copiedStore, false]);          // the same file again: the same store
    again.close();
    const back = openAgentDb(path);
    expect([back.streamId, back.copied]).toEqual([original, false]);               // the original file keeps its own
    back.close();
  });
  // The residual round: the device number isn't part of the identity. WSL2's distro disk, btrfs subvolumes and external
  // volumes can come back under another device number (attach order), which would start a new store at every such start.
  it("the same file under another device number keeps its store: only the inode is compared", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    const id = a.streamId;
    const recorded = (a.db.prepare("SELECT value FROM meta WHERE key = 'fileId'").get() as { value: string }).value;
    const ino = recorded.split(":").at(-1);
    a.db.prepare("UPDATE meta SET value = ? WHERE key = 'fileId'").run(`999999:${ino}`);   // the disk attached as another device
    a.close();
    const b = openAgentDb(path);
    expect([b.streamId, b.copied]).toEqual([id, false]);
    b.close();
  });
  it("records the file's identity once for a database made before it was recorded, and keeps its store", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    const id = a.streamId;
    a.db.prepare("DELETE FROM meta WHERE key = 'fileId'").run();                 // as an agent before final review I2 left it
    a.close();
    const b = openAgentDb(path);
    expect([b.streamId, b.copied]).toEqual([id, false]);
    expect(b.db.prepare("SELECT value FROM meta WHERE key = 'fileId'").get()).toEqual({ value: expect.stringMatching(/^\d+:\d+$/) });
    b.close();
  });
  it("rotates to a new streamId on demand (a restored backup, Task 9), and keeps the new one across restarts", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    const old = a.streamId;
    const next = rotateStreamId(a.db);
    expect(next).toMatch(UUID);
    expect(next).not.toBe(old);
    a.close();
    const again = openAgentDb(path);
    expect(again.streamId).toBe(next);
    again.close();
  });
  it("refuses a database written by a newer agent and changes nothing", () => {
    const path = dbPath();
    openAgentDb(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.exec("UPDATE _morndo_schema SET floor = 99");       // a breaking newer agent raised the floor (§11.1)
    raw.close();
    expect(() => openAgentDb(path)).toThrow(DatabaseFromFuture);
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(99);
    check.close();
  });
  it("refuses a database from a newer agent before any write: byte for byte untouched, no -wal or -shm (final review M3)", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const raw = new Database(path);
    raw.exec("CREATE TABLE future_thing (x); INSERT INTO future_thing VALUES (1);");
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    const before = sha(path);
    expect(() => openAgentDb(path)).toThrow(DatabaseFromFuture);
    expect(sha(path)).toBe(before);                                                // journal_mode=WAL alone would change the header
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });
  it("refuses a file that isn't SQLite with DatabaseUnreadable, and leaves it as it was", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "these are not the bytes of a database ".repeat(40), { mode: 0o600 });
    const before = sha(path);
    expect(() => openAgentDb(path)).toThrow(DatabaseUnreadable);
    expect(() => openAgentDb(path)).toThrow(/agent\.db is not a SQLite database/);
    expect(sha(path)).toBe(before);
  });
  it("makes agent.db, -wal and -shm 0600 in a state directory that already existed, an existing 0644 database too", () => {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    chmodSync(dirname(path), 0o755);
    const a = openAgentDb(path);
    a.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)").run();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(f).mode & 0o777, f).toBe(0o600);
    a.close();
    chmodSync(path, 0o644);                                                         // an older agent's, or a restored copy
    const again = openAgentDb(path);
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect(statSync(f).mode & 0o777, f).toBe(0o600);
    again.close();
  });
  it("stream sequence numbers never repeat, even after every row is deleted", () => {
    const a = openAgentDb(dbPath());
    const ins = a.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)");
    ins.run(); ins.run();
    a.db.exec("DELETE FROM stream");
    expect(Number(ins.run().lastInsertRowid)).toBe(3);
    a.close();
  });
});
