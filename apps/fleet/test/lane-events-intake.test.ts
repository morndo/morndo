// Lane events in the intake (fleet clients spec §6, §7): made in the same synced commit as the hook they come from,
// published as `lane` once it is on the disk, never twice for a replayed hook; a node's /lane events are the fleet's own
// (never counted as unrouted); `answered` and a fleet without deliverTo leave nothing waiting for the manager;
// GET /v1/lane-events?since= pages them; kept 7 days.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent, type LaneEvent } from "@morndo/protocol";
import type { LaneEventsConfig } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb, synced } from "../src/adapters/db.ts";
import { LaneEventsStore } from "../src/adapters/lane-events-store.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { EventHub, type FleetEvent } from "../src/application/events.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { IntakeWindow } from "../src/application/intake-window.ts";
import { LaneEvents } from "../src/application/lane-events.ts";
import { quiet, startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { client } from "./helpers/socket-client.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const TO_MANAGER: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 60_000 };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
type Row = { seq: number; event: string; lane: string; to_manager: number | null };
const rows = (db: { prepare(sql: string): { all(): unknown[] } }) => db.prepare("SELECT seq, event, lane, to_manager FROM lane_events ORDER BY seq").all() as Row[];

describe("lane events in the intake", () => {
  it("a Stop hook makes its lane event in the hook's own synced commit, published after it; a replayed hook makes none", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    const events = await client(fleet.config.socketPath).events();
    const syncs = watchSyncs(fleet.db);
    pc.hook(1, "/hook/stop", { session_id: SID, last_assistant_message: "STATUS: BLOCKED on review" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    expect(syncs).toEqual(FULL_THEN_NORMAL);                                          // one commit: the hook and its lane event
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "finished", lane: "api", to_manager: 0 }]);
    await vi.waitFor(() => expect(events.received.filter(e => e.t === "lane")).toHaveLength(1));
    expect(events.received.find(e => e.t === "lane")).toEqual({ t: "lane", node: "pc", body: {
      v: 1, t: "lane", seq: 1, event: "finished", node: "pc", window: "api", lane: "api", sessionId: SID, at: 1_700_000_000_001,
      status: "blocked", firstLine: "STATUS: BLOCKED on review", bg: 0, crons: 0,
    } });
    pc.hook(1, "/hook/stop", { session_id: SID, text: "again" }, { window: "api" });  // a replay after a lost ack
    pc.hook(2, "/cc", { session_id: SID }, { window: "api" });
    expect(await pc.acked(2)).toBe(2);
    expect(rows(fleet.db)).toHaveLength(1);                                            // negative control: built before the mark, 2
    events.close();
  });

  it("a node's /lane events are the fleet's own, never unrouted; answered is published but never waits for the manager", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.hook(1, "/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }, { window: "web" });
    pc.hook(2, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    expect(await pc.acked(2)).toBe(2);
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "needs_input", lane: "web", to_manager: 0 }, { seq: 2, event: "answered", lane: "web", to_manager: null }]);
    expect(fleet.outbox.unrouted()).toEqual([]);                                       // negative control: counted as unrouted /lane
  });

  it("a needs_input the session's last lane event already is (an agent restart reports the menu again) is dropped; after answered, the next is kept", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    const ask = { event: "needs_input", sessionId: SID, question: "Which branch?" };
    pc.hook(1, "/lane", ask, { window: "web" });
    pc.hook(2, "/lane", ask, { window: "web" });                                     // the node restarted: the same menu again
    pc.hook(3, "/lane", { event: "needs_input", sessionId: "other-session", question: "Merge?" }, { window: "api" });
    pc.hook(4, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    pc.hook(5, "/lane", ask, { window: "web" });                                     // a new menu, after the answer
    expect(await pc.acked(5)).toBe(5);
    expect(rows(fleet.db).map(r => [r.seq, r.event, r.lane])).toEqual([
      [1, "needs_input", "web"], [2, "needs_input", "api"], [3, "answered", "web"], [4, "needs_input", "web"],   // negative control: 5 rows
    ]);
  });

  it("without deliverTo nothing waits for the manager; every event is still published and kept", async () => {
    const fleet = await startTestFleet();                                              // the test fleet's deliverTo is null
    const pc = await fleet.online("pc");
    pc.hook(1, "/hook/failure", { session_id: SID, error_type: "overloaded" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "stop_failure", lane: "api", to_manager: null }]);
  });

  it("GET /v1/lane-events?since= answers after a seq, oldest first, at most 1000; a since that isn't a seq is 400", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    for (let seq = 1; seq <= 1005; seq++) pc.hook(seq, "/hook/stop", { text: `turn ${seq}` }, { window: "api" });
    expect(await pc.acked(1005, 10_000)).toBe(1005);
    const page = async (q: string) => ((await client(fleet.config.socketPath).get(`/v1/lane-events${q}`))?.body as { events?: LaneEvent[] } | undefined)?.events ?? [];
    const first = await page("");
    expect([first.length, first[0]?.seq, first.at(-1)?.seq]).toEqual([1000, 1, 1000]);
    expect((await page("?since=1000")).map(e => e.firstLine)).toEqual(["turn 1001", "turn 1002", "turn 1003", "turn 1004", "turn 1005"]);
    expect(await page("?since=1005")).toEqual([]);
    for (const q of ["?since=-1", "?since=abc", "?since=1.5"]) expect(await client(fleet.config.socketPath).get(`/v1/lane-events${q}`), q).toMatchObject({ status: 400 });
  });

  it("an intake commit that fails publishes no lane event and leaves none stored", async () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const hub = new EventHub();
    const published: FleetEvent[] = [];
    hub.subscribe(e => published.push(e));
    const lanes = new LaneEvents({ store: new LaneEventsStore(db), events: hub, config: TO_MANAGER, log: quiet });
    const intake = new HookIntake({ store: new OutboxStore(db), subscribers: [], audit: new Audit(db), lanes });
    const failing = { synced: <T>(fn: () => T): T => synced(db, () => db.transaction(() => { fn(); throw new Error("disk I/O error"); }).immediate()), savepoint: <T>(fn: () => T): T => db.transaction(fn)() };
    const window = new IntakeWindow({ intake, tx: failing, log: quiet, windowMs: 0 });
    const failed: unknown[] = [];
    const stop: HookEvent = { streamId: "3f0c1d2e-1111-4222-8333-444455556666", seq: 1, at: 1, path: "/hook/stop", node: "pc", window: "api", body: { text: "x" } };
    window.open({ node: "pc", streamId: stop.streamId, acked: () => {}, failed: e => failed.push(e) }).add(stop);
    window.flush();
    expect(failed).toHaveLength(1);
    expect(published).toEqual([]);                                                    // negative control: published inside the commit
    expect(rows(db)).toEqual([]);
    db.close();
  });

  it("keeps lane events 7 days by their time on the node", async () => {
    let now = 1_700_000_000_000;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.hook(1, "/hook/stop", { text: "a" }, { window: "api" });
    pc.hook(2, "/hook/stop", { text: "b" }, { window: "api", at: 1_700_000_000_000 + LIMITS.laneEventKeepMs });
    expect(await pc.acked(2)).toBe(2);
    now = 1_700_000_000_002 + LIMITS.laneEventKeepMs;
    expect(fleet.laneEvents.prune()).toBe(1);
    expect(rows(fleet.db).map(r => r.seq)).toEqual([2]);
  });
});
