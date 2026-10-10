// The SQLite store keeps the directory, its events and the routing policy, and a compare-and-set version.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { addKey, emptyDirectory, emptyPolicy, setPriority, type Actor } from "@morndo/domain";
import { spawn } from "node:child_process";
import { FileRefused } from "../src/adapters/file-mode.ts";
import { DatabaseFromFuture, MIGRATIONS } from "../src/adapters/store-migrations.ts";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";

const who: Actor = { kind: "principal", command: "c1" };
const T = 1_700_000_000_000;

function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error("refused");
  return result.value;
}

describe("store-sqlite", () => {
  let dir: string;
  const open: SqliteStore[] = [];
  afterEach(() => {
    for (const store of open) store.close();
    open.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    return join(dir, "connections.db");
  }

  it("round-trips the directory, its events and the policy, and rejects a stale version", () => {
    const file = path();
    const directory = must(addKey(emptyDirectory(), {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
      ref: "ref-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, T));
    const policy = must(setPriority(emptyPolicy(), { mode: "custom", order: [] }, [], "c1", T));
    const store = new SqliteStore(file);
    open.push(store);
    const first = store.load();
    expect(first.version).toBe(0);
    expect(first.directory.connections).toEqual([]);
    expect(store.save(directory, policy, first.version)).toBe(true);
    expect(store.save(emptyDirectory(), emptyPolicy(), first.version)).toBe(false);
    const loaded = store.load();
    expect(loaded.version).toBe(1);
    expect(loaded.directory).toEqual(directory);
    expect(loaded.policy).toEqual(policy);
    expect(loaded.directory.events.at(-1)).toMatchObject({ type: "ConnectionAdded", name: "key-a" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const other = new SqliteStore(file);
    open.push(other);
    expect(other.save(emptyDirectory(), emptyPolicy(), first.version)).toBe(false);
    expect(other.load().directory).toEqual(directory);
    expect(readFileSync(file).includes("synthetic-key")).toBe(false);
  });

  it("refuses a 0644 database and one owned by someone else", () => {
    const file = path();
    const store = new SqliteStore(file);
    open.push(store);
    store.load();
    let owner = "";
    try { new SqliteStore(file, 0); } catch (error) {
      owner = error instanceof FileRefused ? error.reason : "other";
    }
    expect(owner).toBe("owner");
    store.close();
    open.pop();
    chmodSync(file, 0o644);
    let mode = "";
    try { new SqliteStore(file); } catch (error) {
      mode = error instanceof FileRefused ? error.reason : "other";
    }
    expect(mode).toBe("mode");
    expect(readFileSync(file).subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
  });

  it("a second opener that also sees no file does not empty the first one's database", () => {
    const file = path();
    const directory = must(addKey(emptyDirectory(), {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
      ref: "ref-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, T));
    const policy = must(setPriority(emptyPolicy(), { mode: "custom", order: [] }, [], "c1", T));
    const store = new SqliteStore(file);
    expect(store.save(directory, policy, 0)).toBe(true);
    store.close();
    const second = new SqliteStore(file);
    open.push(second);
    expect(second.load().version).toBe(1);
    expect(second.load().directory).toEqual(directory);
  });

  it("load reads version, directory and policy from one snapshot", () => {
    const file = path();
    const first = must(addKey(emptyDirectory(), {
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
      ref: "ref-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, T));
    const second = must(addKey(emptyDirectory(), {
      name: "key-b", vendor: "vendor-b", runtime: "runtime-b", isolation: "rules", floor: "rules",
      ref: "ref-b", fingerprint: "ba9876543210", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null,
    }, who, T));
    const policy = must(setPriority(emptyPolicy(), { mode: "custom", order: [] }, [], "c1", T));
    let other: SqliteStore;
    const store = new SqliteStore(file, undefined, {
      afterVersion: () => { expect(other.save(second, policy, 1)).toBe(true); },
    });
    open.push(store);
    expect(store.save(first, policy, 0)).toBe(true);
    other = new SqliteStore(file);
    open.push(other);
    const loaded = store.load();
    expect(loaded.version).toBe(1);
    expect(loaded.directory).toEqual(first);
    expect(other.load().directory).toEqual(second);
  });

  it("two first openers leave a database that still loads", async () => {
    const file = path();
    const fixture = join(import.meta.dirname, "fixtures/open-store.ts");
    const run = () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture, file]);
      let err = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { err += chunk; });
      child.on("close", code => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
    });
    const settled = await Promise.allSettled([run(), run()]);
    const failed = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(failed.length).toBeLessThanOrEqual(1);
    for (const result of failed) expect(String(result.reason)).toMatch(/busy; retry/);
    expect(settled.some(result => result.status === "fulfilled")).toBe(true);
    const store = new SqliteStore(file);
    open.push(store);
    expect(store.load().version).toBe(0);
    expect(readFileSync(file).subarray(0, 15).toString("utf8")).toBe("SQLite format 3");
  });

  it("refuses a file that is not a database and leaves those bytes alone", () => {
    const file = path();
    writeFileSync(file, "these are not the bytes of a database\n", { mode: 0o600 });
    const before = readFileSync(file);
    expect(() => new SqliteStore(file)).toThrow(/not a SQLite database \(or is damaged\)/);
    expect(readFileSync(file)).toEqual(before);
  });

  it("a newer schema stays DatabaseFromFuture", () => {
    const file = path();
    const raw = new Database(file);
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    chmodSync(file, 0o600);
    expect(() => new SqliteStore(file)).toThrow(DatabaseFromFuture);
  });

  it("closes the database when opening it fails", () => {
    const file = path();
    const opened: { db: { open: boolean } | null } = { db: null };
    expect(() => new SqliteStore(file, undefined, {
      afterOpen: db => {
        opened.db = db;
        throw Object.assign(new Error("damaged"), { code: "SQLITE_CORRUPT" });
      },
    })).toThrow(/not a SQLite database \(or is damaged\)/);
    expect(opened.db?.open).toBe(false);
  });

  it("tightens its own loose directory and refuses any other", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    const own = join(dir, "morndo-connections");
    mkdirSync(own);
    chmodSync(own, 0o755);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = message => { warnings.push(String(message)); };
    try {
      open.push(new SqliteStore(join(own, "connections.db")));
      expect(statSync(own).mode & 0o777).toBe(0o700);
      expect(warnings.join("\n")).toContain(own);
    } finally { console.warn = warn; }
    const other = join(dir, "shared");
    mkdirSync(other);
    chmodSync(other, 0o755);
    expect(() => new SqliteStore(join(other, "connections.db"))).toThrow(FileRefused);
    expect(statSync(other).mode & 0o777).toBe(0o755);
    const marked = join(dir, "restored");
    mkdirSync(marked);
    chmodSync(marked, 0o755);
    writeFileSync(join(marked, ".morndo-store"), "morndo-connections\n", { mode: 0o600 });
    open.push(new SqliteStore(join(marked, "connections.db")));
    expect(statSync(marked).mode & 0o777).toBe(0o700);
  });

  it("refuses a database directly under the home directory or ~/.config", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    chmodSync(dir, 0o755);
    const config = join(dir, ".config");
    mkdirSync(config);
    chmodSync(config, 0o755);
    const previous = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(() => new SqliteStore(join(dir, "connections.db"))).toThrow(/home directory/);
      expect(() => new SqliteStore(join(config, "connections.db"))).toThrow(/\.config/);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(statSync(config).mode & 0o777).toBe(0o755);
    } finally { process.env.HOME = previous; }
  });
});
