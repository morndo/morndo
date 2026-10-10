// The fleet's own files at startup (final review M3, Task 10 review): a key file that is corrupt, half written, a link
// to nothing or not Ed25519, and a fleet.db that isn't SQLite, each stop `serve` and the console with exit 78 and one
// sentence, never a stack trace and exit 1 (a restart loop). A new key is written whole or not at all. fleet.db and its
// -wal and -shm are 0600 even in a directory that already existed, and a database from a newer fleet service is
// refused before anything is written to it: byte for byte as it was. Temp HOMEs and configs only.
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseUnreadable, openFleetDb } from "../src/adapters/db.ts";
import { DatabaseFromFuture, MIGRATIONS } from "../src/adapters/migrations.ts";
import { KeyFileUnreadable, loadOrCreateFleetKey } from "../src/adapters/keys.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const mode = (p: string) => statSync(p).mode & 0o777;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function setup() {
  const home = tempDir();
  const config = join(home, "fleet.json");
  writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, socketPath: join(home, "s", "f.sock") }));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
    env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000,
  });
  const dir = join(home, ".local/share/morndo-fleet");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { home, run, dir, dbPath: join(dir, "fleet.db"), keyPath: join(dir, "fleet-key.pem") };
}
// A refusal for the person at the box: exit 78, the sentence, no stack frame.
const refusedWith = (r: ReturnType<ReturnType<typeof setup>["run"]>, sentence: RegExp) => {
  expect(r.status, r.stderr).toBe(78);
  expect(r.stderr).toMatch(sentence);
  expect(r.stderr).not.toMatch(/\n\s+at /);
  expect(r.stderr.trim().split("\n")).toHaveLength(1);
};

describe("the fleet key file", { timeout: 30_000 }, () => {
  it("a corrupt or half-written PEM, a link to nothing, or a key that isn't Ed25519 is refused with one sentence (exit 78)", () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const cases: [string, (keyPath: string) => void, RegExp][] = [
      ["corrupt", k => writeFileSync(k, "not a key at all\n", { mode: 0o600 }), /fleet-key\.pem is not a readable private key/],
      ["half written", k => writeFileSync(k, pem.slice(0, 40), { mode: 0o600 }), /fleet-key\.pem is not a readable private key/],
      ["a link to nothing", k => symlinkSync(join(k, "..", "gone.pem"), k), /fleet-key\.pem is missing or a link to nothing/],
      ["RSA", k => writeFileSync(k, rsa, { mode: 0o600 }), /fleet-key\.pem holds a rsa key, not Ed25519/],
    ];
    for (const [why, make, sentence] of cases) {
      const s = setup();
      make(s.keyPath);
      expect(() => loadOrCreateFleetKey(s.keyPath), why).toThrow(KeyFileUnreadable);
      refusedWith(s.run("serve"), sentence);
      refusedWith(s.run("node", "add", "pc"), sentence);
      expect(existsSync(s.dbPath), why).toBe(false);                               // refused before the database
    }
  });

  it("a new key is written whole: mode 0600, nothing left beside it, and a key already there is never replaced", () => {
    const s = setup();
    const first = loadOrCreateFleetKey(s.keyPath);
    expect(mode(s.keyPath)).toBe(0o600);
    expect(readdirSync(s.dir)).toEqual(["fleet-key.pem"]);                         // no temporary file left
    expect(readFileSync(s.keyPath, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n$/);
    const before = sha(s.keyPath);
    expect(loadOrCreateFleetKey(s.keyPath).publicKey).toBe(first.publicKey);
    expect(sha(s.keyPath)).toBe(before);
  });
});

describe("fleet.db", { timeout: 30_000 }, () => {
  it("a file that isn't SQLite is refused with one sentence (exit 78), left as it was", () => {
    const s = setup();
    writeFileSync(s.dbPath, "these are not the bytes of a database ".repeat(40), { mode: 0o600 });
    const before = sha(s.dbPath);
    expect(() => openFleetDb(s.dbPath)).toThrow(DatabaseUnreadable);
    refusedWith(s.run("serve"), /fleet\.db is not a SQLite database/);
    refusedWith(s.run("node", "list"), /fleet\.db is not a SQLite database/);
    refusedWith(s.run("status"), /fleet\.db is not a SQLite database/);
    expect(sha(s.dbPath)).toBe(before);
  });

  it("a database from a newer fleet service is refused before any write: byte for byte untouched, no -wal or -shm", () => {
    const s = setup();
    const raw = new Database(s.dbPath);
    raw.exec("CREATE TABLE future_thing (x); INSERT INTO future_thing VALUES (1);");
    raw.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    raw.close();
    const before = sha(s.dbPath);
    expect(() => openFleetDb(s.dbPath)).toThrow(DatabaseFromFuture);
    expect(sha(s.dbPath)).toBe(before);                                            // journal_mode=WAL alone would change the header
    expect(existsSync(`${s.dbPath}-wal`) || existsSync(`${s.dbPath}-shm`)).toBe(false);
    refusedWith(s.run("serve"), /written by a newer morndo-fleet/);
    expect(sha(s.dbPath)).toBe(before);
  });

  it("fleet.db, -wal and -shm are 0600 in a directory that already existed, and an existing 0644 database is made 0600", () => {
    const s = setup();
    chmodSync(s.dir, 0o755);                                                        // made by someone else, before us
    const db = openFleetDb(s.dbPath);
    db.prepare("INSERT INTO audit (at, actor, action, node, detail) VALUES (1, 'test', 'x', NULL, '{}')").run();
    for (const f of [s.dbPath, `${s.dbPath}-wal`, `${s.dbPath}-shm`]) expect(mode(f), f).toBe(0o600);
    db.close();
    chmodSync(s.dbPath, 0o644);                                                     // an older fleet's, or a restored copy
    const again = openFleetDb(s.dbPath);
    for (const f of [s.dbPath, `${s.dbPath}-wal`, `${s.dbPath}-shm`]) expect(mode(f), f).toBe(0o600);
    again.close();
  });
});
