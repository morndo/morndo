// The update store's contract (design §4.6 UpdateStore, §5 update.db and apply.lock): trust that never moves
// backwards whatever it is given (RL3), the staged Version above every committed one, the last hundred checks,
// and an apply lock (RL4) another process cannot take and the operating system drops when its holder dies.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  beginRollback, beginStep, beginUpdate, parseVersion, RECORD_FORMAT, type Installation,
} from "@morndo/domain";
import { MIGRATIONS, openUpdateStore } from "../src/adapters/store-sqlite.ts";
import { DEFAULT_SETTINGS } from "./helpers/fakes.ts";

let scratch = "";
let state = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  state = join(scratch, "state");
  // The lock probe: another process taking the lock exactly the way the store does, saying what happened.
  // "busy" and exit 3 only for SQLITE_BUSY — any other failure is named, so a pass means the lock bit, not an
  // error misread as one; "locked", then holds it until its parent stops it.
  writeFileSync(join(scratch, "lock-child.cjs"), `
    const [better, lock] = process.argv.slice(2);
    const Database = require(better);
    const db = new Database(lock, { timeout: 0 });
    db.pragma("locking_mode = EXCLUSIVE");
    try { db.exec("BEGIN EXCLUSIVE"); } catch (e) {
      console.log(e.code === "SQLITE_BUSY" ? "busy" : "error:" + e.code);
      process.exit(e.code === "SQLITE_BUSY" ? 3 : 4);
    }
    console.log("locked");
    process.stdin.on("data", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
  `);
});
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => { rmSync(state, { recursive: true, force: true }); });

const open = () => openUpdateStore({ db: join(state, "update.db"), lock: join(state, "apply.lock") });

const KEY_SET = (version: number) => ({
  schema: 1 as const, version, expiresAt: 1_800_000_000_000,
  root: [`SHA256:root-${version}`], release: [`SHA256:release-${version}`], feed: [`SHA256:feed-${version}`],
});

// A made-up Manifest text, the canonical shape the release scripts write (scripts/release/json.ts).
const MANIFEST_TEXT = `${JSON.stringify({ schema: 1, product: "morndo", version: "0.2.0" }, null, 2)}\n`;

// Whatever installation the apply read when it began: 0.1.0 running, nothing staged.
const MACHINE: Installation = {
  current: parseVersion("0.1.0")!, previous: null, staged: null, badVersions: [],
  highestCommitted: parseVersion("0.1.0")!, keySet: null,
  highestFeedSeq: { stable: 0, latest: 0 }, installMethod: "updater", settings: DEFAULT_SETTINGS,
};

describe("the update store (§4.6, §5)", () => {
  it("a fresh store: no trust, no checks, nothing staged or committed", () => {
    const store = open();
    expect(store.trust()).toEqual({ keySet: null, highestFeedSeq: { stable: 0, latest: 0 } });
    expect(store.checks(10)).toEqual([]);
    expect(store.staged()).toBeNull();
    expect(store.highestCommitted()).toBeNull();
    expect(store.badVersions()).toEqual([]);
    store.close();
  });

  it("saveTrust never lowers a feed number or a key set version (RL3), whatever it is given", () => {
    const store = open();
    store.saveTrust({ keySet: null, highestFeedSeq: { stable: 5, latest: 2 } });
    store.saveTrust({ keySet: null, highestFeedSeq: { stable: 3, latest: 7 } });
    expect(store.trust().highestFeedSeq).toEqual({ stable: 5, latest: 7 });
    store.saveTrust({ keySet: KEY_SET(2), highestFeedSeq: { stable: 5, latest: 7 } });
    expect(store.trust().keySet).toEqual(KEY_SET(2));
    // an older key set, or none at all, never displaces the one already trusted
    store.saveTrust({ keySet: KEY_SET(1), highestFeedSeq: { stable: 0, latest: 0 } });
    store.saveTrust({ keySet: null, highestFeedSeq: { stable: 0, latest: 0 } });
    expect(store.trust().keySet).toEqual(KEY_SET(2));
    expect(store.trust().highestFeedSeq).toEqual({ stable: 5, latest: 7 });
    store.close();
  });

  it("a newer key set is taken, and an equal one re-saved with new keys is too", () => {
    const store = open();
    store.saveTrust({ keySet: KEY_SET(1), highestFeedSeq: { stable: 0, latest: 0 } });
    store.saveTrust({ keySet: KEY_SET(2), highestFeedSeq: { stable: 4, latest: 4 } });
    expect(store.trust().keySet).toEqual(KEY_SET(2));
    store.close();
  });

  it("recordCheck keeps the newest hundred rows; checks() reads them newest first", () => {
    const store = open();
    for (let i = 0; i < 105; i++)
      store.recordCheck({ at: 1_000 + i, channel: "stable", outcome: "ok", detail: `check ${i}`, version: "0.1.0",
        feedSeq: i + 1, feedExpiresAt: 2_000 });
    const ten = store.checks(10);
    expect(ten).toHaveLength(10);
    expect(ten[0]!.detail).toBe("check 104");
    expect(ten[9]!.detail).toBe("check 95");
    expect(ten[0]!.at).toBe(1_104);
    const all = store.checks(500);
    expect(all).toHaveLength(100);
    expect(all[0]!.detail).toBe("check 104");
    expect(all[99]!.detail).toBe("check 5");
    store.close();
  });

  it("recordCheck clips a detail to the 500 the wire carries: the start kept, the cut marked", () => {
    const store = open();
    store.recordCheck({ at: 10, channel: "stable", outcome: "refused", detail: "d".repeat(2_000), version: null, feedSeq: null, feedExpiresAt: null });
    const row = store.checks(1)[0]!;
    expect(row.detail.length).toBeLessThanOrEqual(500);
    expect(row.detail).toBe(`${"d".repeat(499)}…`);
    store.close();
  });

  it("lastFeedCheck(): the newest row with the feed's word, however far back among the kept hundred", () => {
    const store = open();
    expect(store.lastFeedCheck()).toBeNull();                     // no row ever carried the feed's word
    store.recordCheck({ at: 1, channel: "stable", outcome: "staged", detail: "verified", version: "0.2.0", feedSeq: 7, feedExpiresAt: 9_000 });
    for (let i = 0; i < 12; i++)
      store.recordCheck({ at: 2 + i, channel: "stable", outcome: "refused", detail: `refused ${i}`, version: null, feedSeq: null, feedExpiresAt: null });
    expect(store.lastFeedCheck()).toMatchObject({ outcome: "staged", feedSeq: 7, feedExpiresAt: 9_000 });
    store.close();
  });

  it("the feed's word outlives the kept check rows: a row of its own, past the hundred", () => {
    const store = open();
    store.recordCheck({ at: 1, channel: "stable", outcome: "staged", detail: "verified", version: "0.2.0", feedSeq: 7, feedExpiresAt: 9_000 });
    // a hundred and one checks without the feed's word — a long outage, a stale feed — take its row out of checks
    for (let i = 0; i < 101; i++)
      store.recordCheck({ at: 2 + i, channel: "stable", outcome: "refused", detail: `refused ${i}`, version: null, feedSeq: null, feedExpiresAt: null });
    const kept = store.checks(100);
    expect(kept).toHaveLength(100);
    expect(kept.some(row => row.feedSeq !== null)).toBe(false);    // the trim really dropped the feed's own row
    expect(store.lastFeedCheck()).toMatchObject({ outcome: "staged", feedSeq: 7, feedExpiresAt: 9_000 });
    store.close();
  });

  it("an update.db from before the last_feed table keeps its feed word", () => {
    // A database as the updater before migration 2 left it: migration 1's tables, version 1, the feed's word still
    // only in checks. Written here by hand, so the copy runs against the shape an old updater really wrote.
    mkdirSync(state, { recursive: true });
    const old = new Database(join(state, "old.db"));
    old.exec(`
      CREATE TABLE trust (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        key_set TEXT,
        seq_stable INTEGER NOT NULL DEFAULT 0,
        seq_latest INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE versions (
        version TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        files_sha256 TEXT NOT NULL,
        staged_at INTEGER NOT NULL
      );
      CREATE TABLE committed (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE bad (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        version TEXT,
        feed_seq INTEGER,
        feed_expires_at INTEGER
      );
      INSERT INTO checks (at, channel, outcome, detail, version, feed_seq, feed_expires_at)
        VALUES (40, 'stable', 'staged', 'verified 0.2.0', '0.2.0', 9, 12_000);
      INSERT INTO checks (at, channel, outcome, detail, version, feed_seq, feed_expires_at)
        VALUES (41, 'stable', 'refused', 'no word', NULL, NULL, NULL);
    `);
    old.pragma("user_version = 1");
    old.close();

    const store = openUpdateStore({ db: join(state, "old.db"), lock: join(state, "apply.lock") });
    expect(store.lastFeedCheck()).toMatchObject({ at: 40, outcome: "staged", feedSeq: 9, feedExpiresAt: 12_000 });
    store.close();
  });

  it("staged(): the highest staged Version above every committed one, or null", () => {
    const store = open();
    store.recordStaged({ version: "0.2.0", manifestSha256: "a".repeat(64), filesSha256: "b".repeat(64), at: 10, manifest: MANIFEST_TEXT });
    store.recordStaged({ version: "0.3.0", manifestSha256: "c".repeat(64), filesSha256: "d".repeat(64), at: 20, manifest: MANIFEST_TEXT });
    expect(store.staged()).toEqual({
      version: "0.3.0", manifestSha256: "c".repeat(64), filesSha256: "d".repeat(64), at: 20, manifest: MANIFEST_TEXT,
    });
    expect(store.versionRecord("0.2.0")!.filesSha256).toBe("b".repeat(64));
    // a commit (written from PR 5 on) retires the staged Version above it and leaves the older one out too
    const raw = new Database(join(state, "update.db"));
    raw.prepare("INSERT INTO committed (version, at) VALUES ('0.3.0', 99)").run();
    raw.close();
    expect(store.staged()).toBeNull();
    expect(store.highestCommitted()).toBe("0.3.0");
    store.recordStaged({ version: "0.4.0", manifestSha256: "e".repeat(64), filesSha256: "f".repeat(64), at: 30, manifest: MANIFEST_TEXT });
    expect(store.staged()?.version).toBe("0.4.0");
    store.close();
  });

  it("badVersions(): everything ever marked bad here (RL7)", () => {
    const store = open();
    const raw = new Database(join(state, "update.db"));
    raw.prepare("INSERT INTO bad (version, at) VALUES ('0.2.0', 1), ('0.3.0', 2)").run();
    raw.close();
    expect(store.badVersions().sort()).toEqual(["0.2.0", "0.3.0"]);
    store.close();
  });

  it("the apply lock (RL4): this process holds it, another is busy, a killed holder leaves it free", { timeout: 20_000 }, async () => {
    const store = open();
    const node = process.execPath;
    const better = createRequire(import.meta.url).resolve("better-sqlite3");
    const script = join(scratch, "lock-child.cjs");
    const lock = join(state, "apply.lock");

    const held = store.tryLock();
    expect(held).not.toBeNull();
    // another process trying the same lock file: busy at once, no wait
    const probe = spawnSync(node, [script, better, lock], { encoding: "utf8", timeout: 10_000 });
    expect(probe.stdout.trim()).toBe("busy");
    expect(probe.status).toBe(3);
    held!.release();

    // a child takes it and holds it; this process can't
    const child = spawn(node, [script, better, lock], { stdio: ["pipe", "pipe", "inherit"] });
    const first = await new Promise<string>(resolve => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())));
    expect(first).toBe("locked");
    expect(store.tryLock()).toBeNull();

    // SIGKILL: the operating system drops the lock with the process, so recovery can take it (§13)
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.on("exit", () => resolve()));
    const again = store.tryLock();
    expect(again).not.toBeNull();
    again!.release();
    store.close();
  });

  it("reopening keeps everything, and the database file is private to its owner", () => {
    const store = open();
    store.saveTrust({ keySet: KEY_SET(3), highestFeedSeq: { stable: 8, latest: 6 } });
    store.recordStaged({ version: "0.9.0", manifestSha256: "1".repeat(64), filesSha256: "2".repeat(64), at: 40, manifest: MANIFEST_TEXT });
    store.recordCheck({ at: 50, channel: "latest", outcome: "skipped", detail: "not newer", version: null, feedSeq: null, feedExpiresAt: null });
    store.close();

    const again = open();
    expect(again.trust()).toEqual({ keySet: KEY_SET(3), highestFeedSeq: { stable: 8, latest: 6 } });
    expect(again.staged()?.version).toBe("0.9.0");
    expect(again.checks(10)).toEqual([{ at: 50, channel: "latest", outcome: "skipped", detail: "not newer", version: null, feedSeq: null, feedExpiresAt: null }]);
    again.close();
    expect(statSync(join(state, "update.db")).mode & 0o777).toBe(0o600);
  });
});

describe("the step record (RL4, §6.2)", () => {
  it("saveUpdate and openUpdate round trip; finishUpdate ends the attempt and openUpdate answers null", () => {
    const store = open();
    expect(store.openUpdate()).toBeNull();
    const begun = beginUpdate({ id: "upd-4907", target: parseVersion("0.2.0")!, machine: MACHINE });
    store.saveUpdate({ ...begun, format: RECORD_FORMAT, startedAt: 1_000, doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null });
    const live = store.openUpdate();
    expect(live).toMatchObject({
      id: "upd-4907", kind: "update", state: "staged", mark: null,
      format: RECORD_FORMAT, startedAt: 1_000, doneMarks: [],
    });
    expect(live!.target).toEqual(parseVersion("0.2.0"));
    expect(live!.preUpdate).toEqual({ current: parseVersion("0.1.0"), previous: null });

    // the drain step's own save: the mark it stands in, recorded done, before the step runs (§6.2)
    const stepped = beginStep(live!, "draining", { lockHeld: true });
    expect(stepped.ok).toBe(true);
    if (stepped.ok) store.saveUpdate({ ...stepped.value, format: RECORD_FORMAT, startedAt: 1_000, doneMarks: ["draining"], judgeBaseline: null, backupOf: null, attempt: null });
    expect(store.openUpdate()).toMatchObject({ state: "draining", mark: "draining", doneMarks: ["draining"] });

    store.finishUpdate("upd-4907", "abandoned", 2_000);
    expect(store.openUpdate()).toBeNull();
    const history = store.recentUpdates(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "upd-4907", state: "abandoned", mark: "draining", doneMarks: ["draining"], finishedAt: 2_000,
    });
    store.close();
  });

  it("openUpdate is the newest attempt not in a terminal state; the finished ones stay in the history", () => {
    const store = open();
    const first = beginUpdate({ id: "upd-1", target: parseVersion("0.2.0")!, machine: MACHINE });
    const second = beginUpdate({ id: "upd-2", target: parseVersion("0.3.0")!, machine: MACHINE });
    store.saveUpdate({ ...first, format: RECORD_FORMAT, startedAt: 1_000, doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null });
    store.saveUpdate({ ...second, format: RECORD_FORMAT, startedAt: 5_000, doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null });
    expect(store.openUpdate()!.id).toBe("upd-2");
    store.finishUpdate("upd-2", "abandoned", 6_000);
    expect(store.openUpdate()!.id).toBe("upd-1");     // the older attempt is still live
    expect(store.recentUpdates(10).map(row => row.id)).toEqual(["upd-2", "upd-1"]);   // newest by when it began
    store.finishUpdate("upd-1", "abandoned", 7_000);
    expect(store.openUpdate()).toBeNull();
    store.close();
  });

  it("a rollback's record round trips: the previous Version as target, rolling_back as its first mark", () => {
    const store = open();
    const after: Installation = { ...MACHINE, current: parseVersion("0.2.0")!, previous: parseVersion("0.1.0")! };
    const begun = beginRollback({ id: "rb-1", machine: after });
    expect(begun.ok).toBe(true);
    if (begun.ok) store.saveUpdate({ ...begun.value, format: RECORD_FORMAT, startedAt: 9_000, doneMarks: ["rolling_back"], judgeBaseline: null, backupOf: null, attempt: null });
    const live = store.openUpdate()!;
    expect(live).toMatchObject({ id: "rb-1", kind: "rollback", state: "rolling_back", mark: "rolling_back" });
    expect(live.target).toEqual(parseVersion("0.1.0"));
    expect(live.preUpdate).toEqual({ current: parseVersion("0.2.0"), previous: parseVersion("0.1.0") });
    store.finishUpdate("rb-1", "rolled_back", 9_500);
    expect(store.openUpdate()).toBeNull();
    store.close();
  });

  it("recordCommitted raises highestCommitted; recordBad keeps a Version out (the tables exist)", () => {
    const store = open();
    store.recordCommitted("0.1.0", 50, null);         // a commit that judged nothing (data from before §6.7) is no baseline
    expect(store.highestCommitted()).toBe("0.1.0");
    store.recordCommitted("0.2.0", 100, { hub: ["ready"] });
    expect(store.highestCommitted()).toBe("0.2.0");
    store.recordCommitted("0.1.1", 200, null);        // an older Version never lowers it
    expect(store.highestCommitted()).toBe("0.2.0");
    store.recordBad("0.3.0", 300);
    expect(store.badVersions()).toEqual(["0.3.0"]);
    // §6.7: the last commit's own baseline is what a boot apply judges against — the newest commit's word,
    // whatever it recorded; a stale one would forgive failures the machine has never passed
    expect(store.commitBaseline()).toBeNull();
    store.recordCommitted("0.2.1", 400, { hub: ["ready"], fleet: ["ready"] });
    expect(store.commitBaseline()).toEqual({ hub: ["ready"], fleet: ["ready"] });
    store.close();
  });

  it("manifestOf reads the Manifest text recorded at staging; a Version never staged reads null", () => {
    const store = open();
    store.recordStaged({ version: "0.2.0", manifestSha256: "a".repeat(64), filesSha256: "b".repeat(64), at: 10, manifest: MANIFEST_TEXT });
    expect(store.manifestOf("0.2.0")).toBe(MANIFEST_TEXT);
    expect(store.manifestOf("0.9.9")).toBeNull();
    store.close();
  });

  it("records a Rollout halt and lists it, newest first (RL12)", () => {
    const store = openUpdateStore({ db: join(state, "halts.db"), lock: join(state, "halts.lock") });
    try {
      store.recordHalt("0.2.0", "hub: no_report", 10);
      store.recordHalt("0.3.0", "node: restarted", 20);
      expect(store.halts()).toEqual([
        { version: "0.3.0", reason: "node: restarted", at: 20 },
        { version: "0.2.0", reason: "hub: no_report", at: 10 },
      ]);
    } finally { store.close(); }
  });

  it("an update.db at schema 2 migrates to the newest schema and keeps its rows", () => {
    // Written by hand, as the updater before this step left it: migrations 1 and 2, version 2, a staged Version
    // from before manifests were kept, the feed's word in its own row.
    mkdirSync(state, { recursive: true });
    const old = new Database(join(state, "old2.db"));
    old.exec(`
      CREATE TABLE trust (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        key_set TEXT,
        seq_stable INTEGER NOT NULL DEFAULT 0,
        seq_latest INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE versions (
        version TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        files_sha256 TEXT NOT NULL,
        staged_at INTEGER NOT NULL
      );
      CREATE TABLE committed (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE bad (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        version TEXT,
        feed_seq INTEGER,
        feed_expires_at INTEGER
      );
      CREATE TABLE last_feed (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT NOT NULL,
        version TEXT,
        feed_seq INTEGER NOT NULL,
        feed_expires_at INTEGER NOT NULL
      );
      INSERT INTO versions (version, manifest_sha256, files_sha256, staged_at) VALUES ('0.2.0', '${"a".repeat(64)}', '${"b".repeat(64)}', 30);
      INSERT INTO committed (version, at) VALUES ('0.1.0', 20);
      INSERT INTO last_feed (id, at, channel, outcome, detail, version, feed_seq, feed_expires_at)
        VALUES (1, 40, 'stable', 'staged', 'verified 0.2.0', '0.2.0', 9, 12000);
    `);
    old.pragma("user_version = 2");
    old.close();

    const store = openUpdateStore({ db: join(state, "old2.db"), lock: join(state, "apply.lock") });
    const raw = new Database(join(state, "old2.db"), { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);   // every migration since, all additive
    raw.close();
    expect(store.lastFeedCheck()).toMatchObject({ at: 40, feedSeq: 9 });   // the old rows read as they were
    expect(store.highestCommitted()).toBe("0.1.0");
    // the staged row has no manifest (nothing wrote one yet): not a record this updater can use, and not an error
    expect(store.versionRecord("0.2.0")).toBeNull();
    expect(store.staged()).toBeNull();
    // the next check re-stages the Version and the row heals
    store.recordStaged({ version: "0.2.0", manifestSha256: "a".repeat(64), filesSha256: "b".repeat(64), at: 60, manifest: MANIFEST_TEXT });
    expect(store.staged()?.version).toBe("0.2.0");
    expect(store.manifestOf("0.2.0")).toBe(MANIFEST_TEXT);
    store.close();
  });
});
