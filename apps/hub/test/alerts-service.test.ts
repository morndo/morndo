// The fleet's alerts in the app (the owner, 2026-10-12): the hub keeps the latest, one per id, newest first; reads the
// fleet's list at each connect without calling it new; tells the notifications of each new one as it comes, a push only
// for the urgent ones (counts only, N1); and the feed sends them. Pure service tests, then the real fleet adapter over
// the fake fleet on a real Unix socket.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetClient } from "@morndo/fleet-client";
import type { Alert } from "@morndo/protocol";
import { fleetPorts } from "../src/adapters/fleet-adapters.ts";
import { ALERTS_KEPT, AlertsService, urgent } from "../src/application/alerts-service.ts";
import { NotificationService } from "../src/application/notification-service.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";
import { startInProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

const alert = (id: number, kind: Alert["kind"], detail: Record<string, unknown> = {}, at = 1000 + id): Alert => ({ id, at, node: "pc", kind, detail });

describe("which alerts are urgent (a push)", () => {
  it("a node's key in doubt, events lost or piling up, a message waiting 15 min or more; not the rest", () => {
    for (const k of ["source_changed", "instance_conflict", "dead_letter", "backlog_full"] as const) expect(urgent(alert(1, k)), k).toBe(true);
    expect(urgent(alert(1, "delivery_waiting", { minutes: 15 }))).toBe(true);
    expect(urgent(alert(1, "delivery_waiting", { minutes: 2 }))).toBe(false);
    for (const k of ["lane_conflict", "subscriber_lagging", "clock_offset", "rate_limited", "unrouted_hook", "job_failed", "job_unnoticed"] as const) expect(urgent(alert(1, k)), k).toBe(false);
  });
});

describe("AlertsService", () => {
  it("a connect's list is kept, never news; an event is news once, with whether it is urgent", () => {
    const news: [number, boolean][] = [];
    const told: number[] = [];
    const s = new AlertsService({ onNew: (a, u) => news.push([a.id, u]) });
    s.subscribe(items => told.push(items.length));
    s.load([alert(1, "lane_conflict"), alert(2, "source_changed")]);
    expect(news).toEqual([]);
    expect(s.view().items.map(a => a.id)).toEqual([2, 1]);                         // newest first
    s.add(alert(3, "dead_letter"));
    s.add(alert(3, "dead_letter"));                                                 // the same id again: not news
    s.add(alert(4, "clock_offset", { offsetMs: 3000 }));
    s.load([alert(1, "lane_conflict"), alert(2, "source_changed"), alert(3, "dead_letter"), alert(4, "clock_offset")]);   // a reconnect
    expect(news).toEqual([[3, true], [4, false]]);
    expect(told).toEqual([2, 3, 4]);
    expect(s.urgentSince(0)).toBe(2);
    expect(s.urgentSince(1003)).toBe(0);                                            // seen up to the dead letter
  });

  it("keeps the latest ALERTS_KEPT and drops what isn't an alert", () => {
    const s = new AlertsService();
    s.load([...Array.from({ length: ALERTS_KEPT + 20 }, (_, i) => alert(i, "lane_conflict")), null, { id: "x" }, { id: 1.5, at: 1, kind: "k", node: null }]);
    expect(s.view().items).toHaveLength(ALERTS_KEPT);
    expect(s.view().items[0]?.id).toBe(ALERTS_KEPT + 19);
  });
});

describe("an urgent alert is a push, counts only (N1)", () => {
  afterEach(() => vi.useRealTimers());
  it("after a second, kind 3 with how many urgent ones he hasn't seen; a non-urgent one sends nothing", async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const s = new AlertsService();
    const n = new NotificationService({
      store: { pushSubscriptions: () => [{ endpointId: "ep", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "", auth: "" }], savePushSubscription: () => {}, deletePushSubscription: () => false, record: () => {} },
      send: async (_s, payload) => { sent.push(JSON.parse(payload.toString())); return { status: 201 }; },
      alerts: () => s.urgentSince(0),
    });
    const linked = new AlertsService({ onNew: (a, u) => { s.add(a); n.alert(u); } });
    linked.add(alert(1, "lane_conflict"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toEqual([]);
    linked.add(alert(2, "source_changed"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(sent).toEqual([{ kind: 3, decisions: 0, workers: 0, linked: 0, alerts: 1, usage: 0 }]);
    n.stop();
  });
});

describe("the fleet adapter", () => {
  let fleet: FakeFleet | null = null;
  let stop: () => void = () => {};
  const dir = mkdtempSync(join(tmpdir(), "morndo-alerts-"));
  afterEach(async () => { stop(); await fleet?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("reads the fleet's alerts at connect, then takes each new one from its events", async () => {
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({}))] });
    fleet.raise(alert(1, "lane_conflict", { name: "alpha", claims: [] }));
    const loads: unknown[][] = [];
    const adds: unknown[] = [];
    const ports = fleetPorts(new FleetClient(fleet.socketPath), { files: null, stagingDir: dir, alerts: { load: l => loads.push([...l]), add: a => adds.push(a) } });
    stop = () => ports.stop();
    await ports.start();
    expect(loads.at(-1)).toEqual([expect.objectContaining({ id: 1, kind: "lane_conflict" })]);
    fleet.raise(alert(2, "dead_letter", { subscriber: "kira" }));
    await until(() => adds.length === 1);
    expect(adds[0]).toMatchObject({ id: 2, kind: "dead_letter" });
  });
});

describe("the feed's alerts frame", () => {
  it("after every hello the latest, newest first; then each change, live", async () => {
    const s = new AlertsService();
    s.load([alert(1, "lane_conflict", { name: "alpha" })]);
    const hub = await startInProcessHub({ alerts: s });
    try {
      const ws = await hub.socket("/api/feed", await hub.cookie());
      const frames: { t: string; items?: { id: number }[] }[] = [];
      ws.on("message", raw => frames.push(JSON.parse(frameText(raw)) as { t: string; items?: { id: number }[] }));
      ws.send(JSON.stringify({ t: "hello" }));
      await until(() => frames.some(f => f.t === "alerts"));
      expect(frames.find(f => f.t === "alerts")?.items?.map(a => a.id)).toEqual([1]);
      s.add(alert(2, "source_changed", { from: "100.64.0.1", to: "100.64.0.9" }));
      await until(() => frames.filter(f => f.t === "alerts").length === 2);
      expect(frames.filter(f => f.t === "alerts").at(-1)?.items?.map(a => a.id)).toEqual([2, 1]);
      ws.close();
    } finally { await hub.close(); }
  });
});
