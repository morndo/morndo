// The runner and the bucket the three services share (RU5, RU7): what each service's own tests already pin, once, where
// it lives, and that no service keeps a copy of either.
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseBusy, DatabaseUnreadable, NotLocalDisk, RateLimiter, assertLocalDisk, errno, migrate, openPrivateDb, takeAll, type Migration } from "../src/index.ts";

const M = (version: number): Migration => ({ version, name: `m${version}`, up: db => { db.exec(`CREATE TABLE t${version} (x)`); } });
const future = (found: number, known: number) => new Error(`future ${found} ${known}`);

describe("migrate", () => {
  it("runs the pending migrations once, in one transaction, and sets the version", () => {
    const db = new Database(":memory:");
    expect(migrate(db, [M(1), M(2)], future)).toEqual({ from: 0, to: 2 });
    expect(migrate(db, [M(1), M(2)], future)).toEqual({ from: 2, to: 2 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });
  it("leaves the database as it was when a migration fails", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [M(1), { version: 2, name: "bad", up: () => { throw new Error("boom"); } }], future)).toThrow("boom");
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't1'").all()).toEqual([]);
  });
  it("refuses a database from a newer service with that service's own error", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 5");
    expect(() => migrate(db, [M(1)], future)).toThrow("future 5 1");
  });
  it("refuses migrations that are not numbered from 1", () => {
    expect(() => migrate(new Database(":memory:"), [M(2)], future)).toThrow(/numbered 2, expected 1/);
  });
});

describe("RateLimiter", () => {
  it("is told its clock: a full bucket at once, then refills continuously", () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, () => t);
    expect([rl.take("a").ok, rl.take("a").ok, rl.take("a").ok]).toEqual([true, true, false]);
    t += 1000;
    expect(rl.take("a").ok).toBe(true);
  });
  it("takeAll charges every bucket only when all have room", () => {
    const a = new RateLimiter({ capacity: 1, refillPerSecond: 1 }, () => 0), b = new RateLimiter({ capacity: 5, refillPerSecond: 1 }, () => 0);
    a.take("k");
    expect(takeAll([[a, "k"], [b, "k"]])).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(b.peek("k")).toEqual({ ok: true });
  });
});

describe("errno", () => {
  it("reads an error code, and the stores share that one helper", () => {
    expect(errno(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("EACCES");
    expect(errno(new Error("plain"))).toBe("");
    expect(errno(null)).toBe("");
    const root = join(import.meta.dirname, "../../..");
    for (const p of ["apps/node-agent/src/ops/job-store.ts", "packages/service-kit/src/open-private-db.ts"]) {
      const text = readFileSync(join(root, p), "utf8");
      expect(text, p).toMatch(/errno/);
      expect(text, p).not.toMatch(/\((e|error) as \{ code\?: string \}\)\.code \?\? ""/);
    }
    // The node's and the fleet's stores open through openPrivateDb, so they read no error code of their own.
    for (const p of ["apps/node-agent/src/db/open.ts", "apps/fleet/src/adapters/db.ts"]) {
      const text = readFileSync(join(root, p), "utf8");
      expect(text, p).toMatch(/openPrivateDb\(/);
      expect(text, p).not.toMatch(/as \{ code\?: string \}|as NodeJS\.ErrnoException/);
    }
  });
});

describe("no service keeps a copy", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "../../..", p), "utf8");
  it("the migration runners call the kit", () => {
    for (const p of ["apps/hub/src/adapters/migrations.ts", "apps/fleet/src/adapters/migrations.ts", "apps/node-agent/src/db/migrations.ts"]) {
      expect(src(p), p).toMatch(/from "@morndo\/service-kit"/);
      expect(src(p), p).not.toMatch(/db\.transaction\(/);
    }
  });
  it("fleet, connections and the node agent open a private database through the kit", () => {
    for (const p of ["apps/fleet/src/adapters/db.ts", "apps/connections/src/adapters/store-sqlite.ts", "apps/node-agent/src/db/open.ts"]) {
      const text = src(p);
      expect(text, p).toMatch(/openPrivateDb/);
      expect(text, p).not.toMatch(/openSync\(/);
      expect(text, p).not.toMatch(/SQLITE_NOTADB/);
      expect(text, p).not.toMatch(/class DatabaseUnreadable/);
    }
    expect(src("apps/fleet/src/adapters/db.ts")).toContain('synchronous: "FULL"');
    expect(src("apps/connections/src/adapters/store-sqlite.ts")).toContain('synchronous: "NORMAL"');
    const age = src("apps/connections/src/adapters/vault-age.ts");
    const file = src("apps/connections/src/adapters/vault-file.ts");
    expect(age).toContain("./secret-ref.ts");
    expect(file).toContain("./secret-ref.ts");
    expect(age).not.toMatch(/SECRET_REF|const REF/);
    expect(file).not.toMatch(/SECRET_REF|const REF/);
  });
  it("the buckets are the kit's", () => {
    for (const p of ["apps/hub/src/adapters/rate-limit.ts", "apps/fleet/src/adapters/rate-limit.ts"]) {
      expect(src(p), p).toMatch(/from "@morndo\/service-kit"/);
      expect(src(p), p).not.toMatch(/#buckets/);
    }
  });
});

describe("assertLocalDisk", () => {
  const on = (type: number, platform: NodeJS.Platform = "linux") => () => assertLocalDisk("/data", { platform, fsType: () => type });
  it("refuses the network file systems SQLite's WAL mode can't run on, naming the file system", () => {
    for (const [type, name] of [[0x6969, "NFS"], [0x517b, "SMB"], [0xfe534d42, "SMB2"], [0xff534d42, "CIFS"], [0x01021997, "9P"], [0x5346414f, "AFS"], [0x73757245, "Coda"]] as const) {
      expect(on(type)).toThrow(NotLocalDisk);
      expect(on(type)).toThrow(`/data is on a network file system (${name})`);
    }
  });
  it("allows this machine's own file systems (ext4, btrfs, XFS, tmpfs) and FUSE, which may be local", () => {
    for (const type of [0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x65735546]) expect(on(type)).not.toThrow();
  });
  it("refuses nothing where the numbers mean something else (macOS)", () => {
    expect(on(0x6969, "darwin")).not.toThrow();
  });
  it("reads the real file system by default (this test's temp directory is local, on Linux and macOS alike)", () => {
    expect(() => assertLocalDisk(tmpdir(), { platform: "linux" })).not.toThrow();
  });
  it("a second open keeps what the first wrote, and a bad file is closed and named", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-private-db-"));
    const path = join(dir, "db");
    const options = {
      synchronous: "FULL" as const,
      foreignKeys: true,
      knownVersion: 1,
      refuseNewer: (found: number, known: number) => new Error(`future ${found} ${known}`),
      migrate: (db: Database.Database) => {
        if ((db.pragma("user_version", { simple: true }) as number) > 0) return;
        db.exec("CREATE TABLE t (x INTEGER)");
        db.prepare("INSERT INTO t VALUES (1)").run();
        db.pragma("user_version = 1");
      },
    };
    const first = openPrivateDb(path, options);
    first.prepare("UPDATE t SET x = 2").run();
    first.close();
    const second = openPrivateDb(path, options);
    expect(second.prepare("SELECT x FROM t").pluck().get()).toBe(2);
    expect(second.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(second.pragma("synchronous", { simple: true })).toBe(2);
    second.close();
    writeFileSync(join(dir, "bad"), "not a database", { mode: 0o600 });
    expect(() => openPrivateDb(join(dir, "bad"), options)).toThrow(DatabaseUnreadable);
    const opened: { db: Database.Database | null } = { db: null };
    expect(() => openPrivateDb(join(dir, "fresh"), {
      ...options,
      migrate: db => { opened.db = db; throw Object.assign(new Error("damaged"), { code: "SQLITE_CORRUPT" }); },
    })).toThrow(/not a SQLite database \(or is damaged\)/);
    expect(opened.db?.open).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a database locked by another opener is a retryable error", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-private-db-"));
    const path = join(dir, "db");
    const options = {
      synchronous: "FULL" as const,
      knownVersion: 1,
      timeout: 0,
      refuseNewer: (found: number, known: number) => new Error(`future ${found} ${known}`),
      migrate: (db: Database.Database) => {
        db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
        db.prepare("INSERT INTO t (x) VALUES (1)").run();
      },
    };
    const first = openPrivateDb(path, options);
    first.exec("BEGIN EXCLUSIVE");
    expect(() => openPrivateDb(path, options)).toThrow(DatabaseBusy);
    expect(() => openPrivateDb(path, options)).toThrow(/busy; retry/);
    first.exec("ROLLBACK");
    first.close();
    const again = openPrivateDb(path, options);
    expect(again.prepare("SELECT count(*) FROM t").pluck().get()).toBe(2);
    again.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("judges a directory not made yet by the nearest one that exists (a fresh install asks before creating anything)", () => {
    const asked: string[] = [];
    const missing = join(tmpdir(), `morndo-not-made-${process.pid}`, "a", "b");
    expect(() => assertLocalDisk(missing, { platform: "linux", fsType: d => { asked.push(d); return 0xef53; } })).not.toThrow();
    expect(asked).toEqual([tmpdir()]);
    expect(() => assertLocalDisk(missing, { platform: "linux" })).not.toThrow();       // the real statfs, on a path that isn't there
  });
});
