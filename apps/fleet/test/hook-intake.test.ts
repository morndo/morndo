// The hook bus's intake (spec 5.4, 5.6, 9 "Stream"): events above the stream's mark are stored for the subscribers
// whose paths take them, in the one transaction that raises the mark; duplicates are skipped; seqs may skip; a new
// streamId starts fresh. Negative control: without streamId tracking, a reset agent's events are dropped. Backlog
// cap: progress events (/cc, /sl) give way first, then dead letters and one alert. S3: a limit failure's usage tap,
// read in the same transaction and published only once that commit is on the disk.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { LaneEventsStore } from "../src/adapters/lane-events-store.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { EventHub, type FleetEvent } from "../src/application/events.ts";
import { HookIntake, unsubscribedScriptPaths } from "../src/application/hook-intake.ts";
import { LaneEvents } from "../src/application/lane-events.ts";
import { quiet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (streamId: string, seq: number, path: HookEvent["path"] = "/hook/stop"): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path, node: "pc", window: "api", body: { seq } });
const ALL: Subscriber = { name: "kira", url: "http://127.0.0.1:1/hooks", paths: ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] };
const STOPS: Subscriber = { name: "stops", url: "http://127.0.0.1:2/hooks", paths: ["/hook/stop"] };

function setup(subscribers: Subscriber[] = [ALL, STOPS], cap?: number) {
  const db = openFleetDb(join(tempDir(), "fleet.db"));
  const store = new OutboxStore(db);
  const audit = new Audit(db);
  let stored = 0;
  const intake = new HookIntake({ store, subscribers, audit, onStored: () => { stored++; }, ...(cap === undefined ? {} : { cap }) });
  const outbox = () => (db.prepare("SELECT stream_id, seq, path FROM outbox ORDER BY id").all() as { stream_id: string; seq: number; path: string }[]).map(r => `${r.stream_id}:${r.seq}${r.path}`);
  return { db, store, audit, intake, outbox, kicks: () => stored };
}

describe("hook intake", () => {
  it("stores each event once for the subscribers whose paths take it, and returns the stream's mark", () => {
    const { intake, store, outbox, kicks } = setup();
    expect(intake.known("pc", "s1")).toEqual({ seq: 0, known: false });
    expect(intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 2, "/cc")])).toBe(2);
    expect(intake.accept("pc", "s1", [ev("s1", 2, "/cc"), ev("s1", 3)])).toBe(3);    // 2 again: a replay after a lost ack
    expect(intake.known("pc", "s1")).toEqual({ seq: 3, known: true });
    expect(outbox()).toEqual(["s1:1/hook/stop", "s1:2/cc", "s1:3/hook/stop"]);
    expect(store.states("kira")).toEqual({ pending: 3 });
    expect(store.states("stops")).toEqual({ pending: 2 });                            // /cc isn't one of its paths
    expect(kicks()).toBe(2);
  });

  it("takes a stream whose seqs skip (the agent coalesced progress events) and moves the mark past unsubscribed events", () => {
    const { intake, outbox } = setup([STOPS]);
    expect(intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 4, "/cc"), ev("s1", 9)])).toBe(9);
    expect(outbox()).toEqual(["s1:1/hook/stop", "s1:9/hook/stop"]);
    expect(intake.accept("pc", "s1", [ev("s1", 5)])).toBe(9);                          // below the mark: a duplicate
    expect(outbox()).toHaveLength(2);
  });

  it("a reset agent's new stream is delivered from seq 1; without streamId tracking it would be dropped", () => {
    const { intake, outbox } = setup([STOPS]);
    intake.accept("pc", "old", [1, 2, 3, 4, 5].map(n => ev("old", n)));
    expect(intake.known("pc", "new")).toEqual({ seq: 0, known: false });
    expect(intake.accept("pc", "new", [1, 2, 3].map(n => ev("new", n)))).toBe(3);
    expect(outbox().filter(r => r.startsWith("new:"))).toEqual(["new:1/hook/stop", "new:2/hook/stop", "new:3/hook/stop"]);
    // Negative control: one mark per node (the stream ignored) takes the reset's seqs 1..3 for duplicates of 1..5.
    const control = setup([STOPS]);
    control.intake.accept("pc", "node-wide", [1, 2, 3, 4, 5].map(n => ev("old", n)));
    control.intake.accept("pc", "node-wide", [1, 2, 3].map(n => ev("new", n)));
    expect(control.outbox().filter(r => r.startsWith("node-wide:")).map(r => r.split(":")[1])).toEqual(["1/hook/stop", "2/hook/stop", "3/hook/stop", "4/hook/stop", "5/hook/stop"]);
    expect(control.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 5 });   // the 3 new events: dropped
  });

  it("stores a batch and raises the mark in one transaction: a failure part way keeps neither", () => {
    const { store, outbox } = setup();
    let calls = 0;
    const route = () => { if (++calls === 3) throw new Error("disk full"); return ["kira"]; };
    expect(() => store.accept("pc", "s1", [1, 2, 3].map(n => ev("s1", n)), route, { now: 1, cap: 100 })).toThrow(/disk full/);
    expect(store.hwm("pc", "s1")).toEqual({ seq: 0, known: false });
    expect(outbox()).toEqual([]);
  });

  it("a full backlog drops the oldest progress events first, then dead-letters new ones with one alert", () => {
    const NOTES: Subscriber = { name: "notes", url: "http://127.0.0.1:3/hooks", paths: ["/notify"] };
    const { intake, store, audit } = setup([ALL, NOTES], 4);
    intake.accept("pc", "s1", [ev("s1", 1, "/cc"), ev("s1", 2, "/sl"), ev("s1", 3), ev("s1", 4)]);
    expect(store.pendingCount("kira")).toBe(4);
    intake.accept("pc", "s1", [ev("s1", 5)]);                                          // drops /cc 1
    intake.accept("pc", "s1", [ev("s1", 6)]);                                          // drops /sl 2
    expect(store.states("kira")).toEqual({ pending: 4, dropped: 2 });
    expect(audit.of("alert.backlog_full")).toEqual([]);
    intake.accept("pc", "s1", [ev("s1", 7), ev("s1", 8, "/notify")]);                 // nothing left to drop
    expect(store.states("kira")).toEqual({ pending: 4, dropped: 2, dead: 2 });
    expect(store.deadLetters("kira").map(d => [d.seq, d.reason])).toEqual([[7, "backlog_full"], [8, "backlog_full"]]);
    intake.accept("pc", "s1", [ev("s1", 9)]);
    expect(audit.of("alert.backlog_full")).toHaveLength(1);                             // one alert while it stays full
    expect(store.states("notes")).toEqual({ pending: 1 });                              // another subscriber's own backlog
  });
});

describe("events no subscriber takes (final review I3, ADR-0012 decision 8: never lost silently)", () => {
  it("are counted per path in fleet.db, across restarts; the first of each script path raises one alert, progress paths none", () => {
    const { db, intake, audit, store, outbox } = setup([STOPS]);
    intake.accept("pc", "s1", [ev("s1", 1, "/cc"), ev("s1", 2, "/sl"), ev("s1", 3, "/notify"), ev("s1", 4), ev("s1", 5, "/notify")]);
    intake.accept("pc", "s1", [ev("s1", 6, "/hook/failure"), ev("s1", 7, "/notify"), ev("s1", 8, "/file"), ev("s1", 9, "/cc")]);
    intake.accept("pc", "s1", [ev("s1", 9, "/cc")]);                                    // a duplicate: not counted again
    expect(outbox()).toEqual(["s1:4/hook/stop"]);
    expect(store.unrouted().map(u => [u.path, u.count])).toEqual([["/cc", 2], ["/file", 1], ["/hook/failure", 1], ["/notify", 3], ["/sl", 1]]);
    expect(audit.of("alert.unrouted_hook").map(a => [a.node, a.detail])).toEqual([
      ["pc", { path: "/notify", events: 2 }], ["pc", { path: "/hook/failure", events: 1 }], ["pc", { path: "/file", events: 1 }],
    ]);
    // A restart: the counts stay (fleet.db); the next first event of a script path alerts again, once.
    const again = new HookIntake({ store: new OutboxStore(db), subscribers: [STOPS], audit });
    again.accept("pc", "s1", [ev("s1", 10, "/notify"), ev("s1", 11, "/notify"), ev("s1", 12, "/sl")]);
    expect(store.unrouted().find(u => u.path === "/notify")?.count).toBe(5);
    expect(audit.of("alert.unrouted_hook").map(a => a.detail.path)).toEqual(["/notify", "/hook/failure", "/file", "/notify"]);
  });

  it("names the script paths no subscriber takes, for the startup log; a subscribed path is not named", () => {
    expect(unsubscribedScriptPaths([])).toEqual(["/hook/stop", "/hook/failure", "/notify", "/file"]);
    expect(unsubscribedScriptPaths([STOPS, { name: "n", url: "http://127.0.0.1:3/h", paths: ["/notify", "/cc"] }])).toEqual(["/hook/failure", "/file"]);
    expect(unsubscribedScriptPaths([ALL])).toEqual([]);
  });
});

// S3, plan 4.5 item 4: the tap rides the batch's own transaction, like its lane events — published only once that
// commit is on the disk, so a batch that rolled back told nothing, and never again for a replayed hook. The limit
// reading itself is round 2; until then a limit failure throws "not implemented".
describe("usage taps in the intake", () => {
  const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
  const fail = (seq: number, error: string): HookEvent =>
    ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/failure", node: "pc", window: "api", body: { session_id: SID, error_type: error } });

  it("a limit failure's tap is published once the batch's commit is on the disk, and a replayed hook never again", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const hub = new EventHub();
    const published: FleetEvent[] = [];
    hub.subscribe(e => published.push(e));
    const lanes = new LaneEvents({ store: new LaneEventsStore(db), events: hub, config: { deliverTo: "manager", header: "h", ignore: [], batchMs: 3000 }, log: quiet });
    let commits = 0;
    const tx = { synced: <T>(fn: () => T): T => { const r = fn(); commits++; return r; }, savepoint: <T>(fn: () => T): T => fn() };
    const intake = new HookIntake({ store: new OutboxStore(db), subscribers: [], audit: new Audit(db), lanes, events: hub, tx });
    intake.accept("pc", "s1", [fail(1, "rate_limit")]);
    expect(commits).toBe(1);
    expect(published.filter(e => e.t === "usage")).toEqual([{ t: "usage", node: "pc", body: { kind: "failure", lane: "api", window: "api", sessionId: SID, error: "rate_limit", account: null, at: 1_700_000_000_001 } }]);
    intake.accept("pc", "s1", [fail(1, "rate_limit")]);                                 // a replay after a lost ack
    expect(published.filter(e => e.t === "usage")).toHaveLength(1);                     // negative control: below the mark
    db.close();
  });

  it("a failure that is no limit at all publishes no tap", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const hub = new EventHub();
    const published: FleetEvent[] = [];
    hub.subscribe(e => published.push(e));
    const lanes = new LaneEvents({ store: new LaneEventsStore(db), events: hub, config: { deliverTo: "manager", header: "h", ignore: [], batchMs: 3000 }, log: quiet });
    const intake = new HookIntake({ store: new OutboxStore(db), subscribers: [], audit: new Audit(db), lanes, events: hub, tx: { synced: fn => fn(), savepoint: fn => fn() } });
    intake.accept("pc", "s1", [fail(1, "overloaded")]);
    expect(published.filter(e => e.t === "usage")).toEqual([]);
    db.close();
  });
});
