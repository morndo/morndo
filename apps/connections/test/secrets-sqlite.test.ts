// The node's Secrets in the Connections database (design §6, "Metadata"; §3.4 SC2; §15.1): migration 2's tables and
// indexes, a lossless round trip, one BEGIN IMMEDIATE write per change, and the checks a save makes before it writes.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  KEEP_SHAPE, deleteSecret, emptySecretDirectory, grantSecret, revokeSecret, storeSecret,
  type Actor, type SecretDirectory, type StoreInput,
} from "@morndo/domain";
import type { SecretsState, VaultRefRow, WorkspaceRow } from "../src/application/ports.ts";
import { FileRefused } from "../src/adapters/file-mode.ts";
import { SqliteSecrets } from "../src/adapters/secrets-sqlite.ts";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";

const who: Actor = { kind: "principal", command: "c1" };
const T = 1_700_000_000_000;
const DAY = 86_400_000;
const PAYMENTS = "secret://example-app/payments-test";
const WEBHOOK = "secret://example-app/webhook-test";
const MAILER = "secret://example-app/mailer-test";

function must<V>(result: { ok: true; value: V } | { ok: false }): V {
  if (!result.ok) throw new Error("refused");
  return result.value;
}

const input = (reference: string, fingerprint: string, more: Partial<StoreInput> = {}): StoreInput =>
  ({ reference, fingerprint, shape: null, grants: [], expiry: null, destinations: [], ...more });

// A store, a rotation, a Grant, a Revoke, a Delete and a store after it, so every column and both kinds of version list
// (the Secret's own, which restart after a Delete, and the ledger's, which don't) carry something.
function history(): SecretDirectory {
  let dir = emptySecretDirectory();
  dir = must(storeSecret(dir, input(PAYMENTS, "0000000000a1", {
    shape: "example-shape", expiry: T + 30 * DAY, destinations: ["api.example.com"],
    grants: [{ subject: { kind: "lane", lane: "lane-a" }, modes: ["exec"], until: { kind: "lane-end" } }],
  }), who, T));
  dir = must(storeSecret(dir, input(PAYMENTS, "0000000000a2", { shape: KEEP_SHAPE, expiry: T + 60 * DAY }), who, T + 1));
  dir = must(storeSecret(dir, input(WEBHOOK, "0000000000b1"), who, T + 2));
  dir = must(storeSecret(dir, input(MAILER, "0000000000c1"), who, T + 3));
  dir = must(grantSecret(dir, PAYMENTS, {
    subject: { kind: "workspace", workspace: "example-app" }, modes: ["file", "helper"], until: { kind: "at", at: T + DAY },
  }, who, T + 4));
  dir = must(revokeSecret(dir, WEBHOOK, who, T + 5));
  dir = must(deleteSecret(dir, MAILER, who, T + 6));
  return must(storeSecret(dir, input(MAILER, "0000000000c2"), who, T + 7));
}

// One row per ledger entry, in ledger order; null where the file is removed.
const VAULTS: VaultRefRow[] = [
  { reference: PAYMENTS, version: 1, ref: "s-first" },
  { reference: PAYMENTS, version: 2, ref: "s-second" },
  { reference: WEBHOOK, version: 1, ref: null },
  { reference: MAILER, version: 1, ref: null },
  { reference: MAILER, version: 2, ref: "s-fifth" },
];
const WORKSPACES: WorkspaceRow[] = [
  { name: "example-app", root: "/srv/example-app/.git", at: T, command: "c1" },
  { name: "example-site", root: "/srv/example-site/.git", at: T + 1, command: "c2" },
];

function attempt<V>(f: () => V): V | string {
  try { return f(); } catch (error) {
    return `threw ${(error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error))}`;
  }
}

// A sleep that blocks this thread, as a synchronous transaction does.
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// A Node that strips types, for a child that imports the adapter: the flag this Node knows for it, if it needs one.
const STRIP = ["--strip-types", "--experimental-strip-types"].filter(f => process.allowedNodeEnvironmentFlags.has(f)).slice(0, 1);
const ADAPTER = join(import.meta.dirname, "../src/adapters/secrets-sqlite.ts");
const DOMAIN = join(import.meta.dirname, "../../../packages/domain/src/index.ts");

// The second writer runs in a process of its own: better-sqlite3 is synchronous, so a connection that waits for the lock
// can't be on this thread. It notes the time, marks that it is about to write, writes, and reports what its change read.
const SECOND_WRITER = `
  import { writeFileSync } from "node:fs";
  import { pathToFileURL } from "node:url";
  const [file, ready, adapter, domain, reference, fingerprint, at] = process.argv.slice(1);
  const { SqliteSecrets } = await import(pathToFileURL(adapter).href);
  const { storeSecret } = await import(pathToFileURL(domain).href);
  const secrets = new SqliteSecrets(file);
  const began = Date.now();
  writeFileSync(ready, "");
  const report = secrets.write(state => {
    const seen = { waited: Date.now() - began, ledger: state.directory.ledger.length };
    const input = { reference, fingerprint, shape: null, grants: [], expiry: null, destinations: [] };
    const r = storeSecret(state.directory, input, { kind: "principal", command: "c2" }, Number(at));
    return { next: r.ok ? { ...state, directory: r.value } : null, result: { ...seen, outcome: r.ok ? "stored" : r.error.problem } };
  });
  secrets.close();
  console.log(JSON.stringify(report));
`;

type Exit = { code: number | null; out: string; err: string };
const finished = (child: ChildProcess) => new Promise<Exit>(resolve => {
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
  child.on("close", code => resolve({ code, out, err }));
});

describe("secrets-sqlite", () => {
  let dir = "";
  const open: { close(): void }[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children) child.kill();
    children.length = 0;
    for (const db of open) db.close();
    open.length = 0;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function path(): string {
    dir = mkdtempSync(join(tmpdir(), "morndo-secrets-"));
    return join(dir, "connections.db");
  }
  function opened(file: string, hooks?: { beforeSave?: () => void }, uid?: number): SqliteSecrets {
    const secrets = new SqliteSecrets(file, uid, hooks);
    open.push(secrets);
    return secrets;
  }
  function raw(file: string): Database.Database {
    const db = new Database(file);
    open.push(db);
    return db;
  }
  function saved(secrets: SqliteSecrets): SecretsState {
    const state: SecretsState = { directory: history(), vaults: VAULTS, workspaces: WORKSPACES };
    expect(secrets.write(() => ({ next: state, result: "saved" }))).toBe("saved");
    return state;
  }

  it("criterion 10: migration 2 makes the six tables and their unique indexes", () => {
    const file = path();
    opened(file);
    const db = raw(file);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'secret%' ORDER BY name").pluck().all();
    expect(tables).toEqual(["secret_events", "secret_grants", "secret_uses", "secret_versions", "secret_workspaces", "secrets"]);
    const unique = (table: string) => (db.pragma(`index_list(${table})`) as { name: string; unique: number; partial: number }[])
      .filter(i => i.unique === 1 && i.partial === 0)
      .map(i => (db.pragma(`index_info(${i.name})`) as { name: string }[]).map(c => c.name));
    expect(unique("secrets")).toContainEqual(["reference"]);
    expect(unique("secret_versions")).toEqual(expect.arrayContaining([["reference", "keyed_fingerprint"], ["reference", "version"]]));
    expect(unique("secret_workspaces")).toEqual(expect.arrayContaining([["name"], ["root"]]));
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("criterion 10: SQLite itself refuses a second row for a Reference, and for a Reference's keyed fingerprint or version", () => {
    const file = path();
    opened(file);
    const db = raw(file);
    const run = (sql: string, ...args: unknown[]) => attempt(() => { db.prepare(sql).run(...args); return "inserted"; });
    const secret = "INSERT INTO secrets (reference, status, current, expiry, shape, warned, destinations, versions) VALUES (?, 'active', NULL, NULL, NULL, '[]', '[]', '[]')";
    expect(run(secret, PAYMENTS)).toBe("inserted");
    expect(run(secret, PAYMENTS)).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    const version = "INSERT INTO secret_versions (reference, version, keyed_fingerprint, state, vault_ref) VALUES (?, ?, ?, ?, NULL)";
    expect(run(version, PAYMENTS, 1, "0000000000a1", "retired")).toBe("inserted");
    expect(run(version, PAYMENTS, 2, "0000000000a1", "current")).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    expect(run(version, PAYMENTS, 1, "0000000000a2", "current")).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    // Another Reference may hold the same value: the card says "same value as" (SC2).
    expect(run(version, WEBHOOK, 1, "0000000000a1", "current")).toBe("inserted");
    // At most one version of a Reference is current (SC2).
    expect(run(version, PAYMENTS, 2, "0000000000a2", "current")).toBe("inserted");
    expect(run(version, PAYMENTS, 3, "0000000000a3", "current")).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    const workspace = "INSERT INTO secret_workspaces (name, root, at, command) VALUES (?, ?, 1, 'c1')";
    expect(run(workspace, "example-app", "/srv/example-app/.git")).toBe("inserted");
    expect(run(workspace, "example-app", "/srv/other/.git")).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    expect(run(workspace, "example-other", "/srv/example-app/.git")).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
  });

  it("the checks refuse a ledger state, a status, a use mode, a version number or a keyed fingerprint outside its grammar", () => {
    const file = path();
    opened(file);
    const db = raw(file);
    const run = (sql: string, ...args: unknown[]) => attempt(() => { db.prepare(sql).run(...args); return "inserted"; });
    const version = "INSERT INTO secret_versions (reference, version, keyed_fingerprint, state) VALUES (?, ?, ?, ?)";
    expect(run(version, MAILER, 1, "0000000000c1", "current")).toBe("inserted");
    expect(run(version, MAILER, 2, "0000000000c2", "lost")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(version, MAILER, 2, "0000000000C2", "retired")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(version, MAILER, 2, "00000000c2", "retired")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(version, MAILER, 2, "0000000000c2x", "retired")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(version, MAILER, 2, "00000000-0c2", "retired")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(version, MAILER, 0, "0000000000c0", "retired")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    const secret = "INSERT INTO secrets (reference, status, current, expiry, shape, warned, destinations, versions) VALUES (?, ?, ?, NULL, NULL, '[]', '[]', '[]')";
    expect(run(secret, MAILER, "paused", null)).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(secret, MAILER, "active", 0)).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(secret, MAILER, "disabled", null)).toBe("inserted");
    const use = "INSERT INTO secret_uses (id, reference, version, mode, lane, workspace, at, outcome) VALUES (?, ?, 1, ?, NULL, NULL, 1, ?)";
    expect(run(use, "u1", MAILER, "exec", null)).toBe("inserted");
    expect(run(use, "u2", MAILER, "print", null)).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(use, "u3", MAILER, "file", "vanished")).toBe("threw SQLITE_CONSTRAINT_CHECK");
    expect(run(use, "u1", MAILER, "file", "exited")).toBe("threw SQLITE_CONSTRAINT_PRIMARYKEY");
  });

  it("round-trips held Secrets, the ledger, the events, vault refs and workspaces, in order, beside the Connections store", () => {
    const file = path();
    const secrets = opened(file);
    expect(secrets.load()).toStrictEqual({ directory: emptySecretDirectory(), vaults: [], workspaces: [] });
    const state = saved(secrets);
    expect(state.directory.ledger.map(e => e.state)).toEqual(["retired", "current", "revoked", "retired", "current"]);
    expect(state.directory.held.map(s => s.versions.map(v => v.number))).toEqual([[1, 2], [1], [2]]);
    expect(secrets.load()).toStrictEqual(state);
    const other = opened(file);
    expect(other.load()).toStrictEqual(state);
    // The first version's file is removed: only a stored ledger entry's vault ref changes.
    const removed: VaultRefRow[] = [{ reference: PAYMENTS, version: 1, ref: null }, ...VAULTS.slice(1)];
    expect(other.write(now => ({ next: { ...now, vaults: removed }, result: "saved" }))).toBe("saved");
    expect(secrets.load()).toStrictEqual({ ...state, vaults: removed });
    // A later write reads what is stored and changes it: a rotation retires a stored ledger entry and appends one, a
    // revoked Reference gets a new value, and a workspace is dropped.
    const vaults: VaultRefRow[] = [
      ...removed, { reference: PAYMENTS, version: 3, ref: "s-sixth" }, { reference: WEBHOOK, version: 2, ref: "s-seventh" },
    ];
    const later = other.write(now => {
      const rotated = must(storeSecret(now.directory, input(PAYMENTS, "0000000000a3", { shape: KEEP_SHAPE }), who, T + 8));
      const directory = must(storeSecret(rotated, input(WEBHOOK, "0000000000b2"), who, T + 9));
      return { next: { directory, vaults, workspaces: WORKSPACES.slice(1) }, result: directory };
    });
    expect(later.ledger.map(e => `${e.version} ${e.state}`)).toEqual(["1 retired", "2 retired", "1 revoked", "1 retired", "2 current", "3 current", "2 current"]);
    expect(later.events.length).toBe(state.directory.events.length + 2);
    expect(secrets.load()).toStrictEqual({ directory: later, vaults, workspaces: WORKSPACES.slice(1) });
    // A change that returns no next saves nothing and still returns its result.
    expect(secrets.write(() => ({ next: null, result: 7 }))).toBe(7);
    expect(secrets.load().directory).toStrictEqual(later);
    const store = new SqliteStore(file);
    open.push(store);
    expect(store.load().version).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("criterion 11: two writers of one Reference and value store it once; the second waits for the first's commit and is refused", async () => {
    const file = path();
    const ready = join(dir, "second-writer-ready");
    const second: { exit?: Promise<Exit> } = {};
    const first = opened(file, {
      // The first has read and decided. Before it saves, a second connection starts the same store and must wait.
      beforeSave: () => {
        const child = spawn(process.execPath, [
          ...STRIP, "--input-type=module", "-e", SECOND_WRITER, file, ready, ADAPTER, DOMAIN, PAYMENTS, "0000000000a1", String(T + 1),
        ]);
        children.push(child);
        second.exit = finished(child);
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline) pause(10);
        pause(300);
      },
    });
    const outcome = attempt(() => first.write(state => {
      const r = storeSecret(state.directory, input(PAYMENTS, "0000000000a1"), who, T);
      return { next: r.ok ? { ...state, directory: r.value } : null, result: r.ok ? "stored" : r.error.problem };
    }));
    expect(outcome).toBe("stored");
    expect(second.exit, "the second writer was started").toBeDefined();
    const exit = await (second.exit ?? Promise.resolve({ code: null, out: "", err: "" }));
    expect(exit.code, exit.err).toBe(0);
    const report = JSON.parse(exit.out) as { waited: number; ledger: number; outcome: string };
    // It read the first one's commit, so the ledger refused the same value again under the same Reference.
    expect(report).toMatchObject({ outcome: "earlier", ledger: 1 });
    // It had asked before that commit: its write waited for the lock.
    expect(report.waited).toBeGreaterThanOrEqual(250);
    const after = first.load().directory;
    expect(after.ledger).toStrictEqual([{ reference: PAYMENTS, version: 1, fingerprint: "0000000000a1", state: "current" }]);
    expect(after.events.filter(e => e.type === "SecretStored")).toHaveLength(1);
    expect(after.held.map(s => s.reference)).toStrictEqual([PAYMENTS]);
  });

  it("a throw inside change, or an insert SQLite refuses, rolls the whole write back", () => {
    const file = path();
    const secrets = opened(file);
    const state = saved(secrets);
    expect(() => secrets.write(() => { throw new Error("change failed"); })).toThrow("change failed");
    expect(secrets.load()).toStrictEqual(state);
    // Every check passes, the held Secrets are rewritten, and then the ledger insert repeats a Reference's keyed fingerprint.
    const repeat: SecretsState = {
      directory: {
        held: [], events: state.directory.events,
        ledger: [...state.directory.ledger, { reference: PAYMENTS, version: 3, fingerprint: "0000000000a1", state: "retired" }],
      },
      vaults: [], workspaces: [],
    };
    expect(attempt(() => secrets.write(() => ({ next: repeat, result: "saved" })))).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    expect(secrets.load()).toStrictEqual(state);
    // Two Secrets under one Reference.
    const [payments] = state.directory.held;
    const twice: SecretsState = { ...state, directory: { ...state.directory, held: payments ? [payments, payments] : [] } };
    expect(attempt(() => secrets.write(() => ({ next: twice, result: "saved" })))).toBe("threw SQLITE_CONSTRAINT_UNIQUE");
    expect(secrets.load()).toStrictEqual(state);
  });

  it("events are append-only: a next whose events don't start with the stored ones throws and saves nothing", () => {
    const file = path();
    const secrets = opened(file);
    const state = saved(secrets);
    const events = state.directory.events;
    const lose = (next: SecretDirectory["events"]): SecretsState =>
      ({ ...state, directory: { ...state.directory, held: [], events: next }, workspaces: [] });
    expect(() => secrets.write(() => ({ next: lose(events.slice(1)), result: null }))).toThrow(/append-only/);
    expect(() => secrets.write(() => ({ next: lose(events.map((e, i) => i === 2 ? { ...e, at: e.at + 1 } : e)), result: null })))
      .toThrow(/append-only/);
    expect(() => secrets.write(() => ({ next: lose([]), result: null }))).toThrow(/append-only/);
    expect(secrets.load()).toStrictEqual(state);
  });

  it("the ledger only grows: a next that drops a stored entry or changes its fingerprint throws and saves nothing", () => {
    const file = path();
    const secrets = opened(file);
    const state = saved(secrets);
    const ledger = state.directory.ledger;
    const lose = (next: SecretDirectory["ledger"]): SecretsState =>
      ({ ...state, directory: { ...state.directory, held: [], ledger: next }, workspaces: [], vaults: [] });
    // A Delete keeps the ledger's versions (SC8), so a revoked value stays refused.
    expect(() => secrets.write(() => ({ next: lose(ledger.filter(e => e.reference !== WEBHOOK)), result: null }))).toThrow(/ledger only grows/);
    expect(() => secrets.write(() => ({ next: lose(ledger.map((e, i) => i === 2 ? { ...e, fingerprint: "0000000000d1" } : e)), result: null })))
      .toThrow(/ledger only grows/);
    expect(() => secrets.write(() => ({ next: lose([...ledger].reverse()), result: null }))).toThrow(/ledger only grows/);
    expect(secrets.load()).toStrictEqual(state);
  });

  it("a vault ref names one ledger entry, once; a held Secret's current version is one of its versions", () => {
    const file = path();
    const secrets = opened(file);
    const state = saved(secrets);
    const withVaults = (vaults: VaultRefRow[]): SecretsState => ({ ...state, vaults, workspaces: [] });
    expect(() => secrets.write(() => ({ next: withVaults([...VAULTS, { reference: WEBHOOK, version: 2, ref: "s-stray" }]), result: null })))
      .toThrow(/vault ref/);
    expect(() => secrets.write(() => ({ next: withVaults([...VAULTS, { reference: PAYMENTS, version: 2, ref: "s-other" }]), result: null })))
      .toThrow(/vault ref/);
    const held = state.directory.held.map(s => s.reference === PAYMENTS && s.current ? { ...s, current: { ...s.current, storedAt: T + 99 } } : s);
    expect(() => secrets.write(() => ({ next: { ...state, directory: { ...state.directory, held }, workspaces: [] }, result: null })))
      .toThrow(/current version/);
    expect(secrets.load()).toStrictEqual(state);
  });

  it("refuses a 0644 database and one owned by someone else, as the Connections store does", () => {
    const file = path();
    const secrets = opened(file);
    secrets.load();
    let owner = "";
    try { opened(file, undefined, 0); } catch (error) {
      owner = error instanceof FileRefused ? error.reason : "other";
    }
    expect(owner).toBe("owner");
    for (const db of open.splice(0)) db.close();
    chmodSync(file, 0o644);
    let mode = "";
    try { opened(file); } catch (error) {
      mode = error instanceof FileRefused ? error.reason : "other";
    }
    expect(mode).toBe("mode");
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("refuses a loose directory that isn't the store's, and a database directly in the home directory", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-secrets-"));
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    expect(() => opened(join(shared, "connections.db"))).toThrow(FileRefused);
    expect(statSync(shared).mode & 0o777).toBe(0o755);
    const home = join(dir, "home");
    mkdirSync(home);
    chmodSync(home, 0o755);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(() => opened(join(home, "connections.db"))).toThrow(/home directory/);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
    expect(statSync(home).mode & 0o777).toBe(0o755);
  });

  it("load refuses a stored Secret whose current version is not among its versions", () => {
    const file = path();
    const secrets = opened(file);
    const db = raw(file);
    const versions = JSON.stringify([{ number: 1, fingerprint: "0000000000a1", storedAt: T, command: "c1", retiredAt: null }]);
    const sql = "INSERT INTO secrets (reference, status, current, expiry, shape, warned, destinations, versions) VALUES (?, 'active', 2, NULL, NULL, '[]', '[]', ?)";
    expect(attempt(() => { db.prepare(sql).run(PAYMENTS, versions); return "inserted"; })).toBe("inserted");
    expect(() => secrets.load()).toThrow(/not among its versions/);
  });
});
