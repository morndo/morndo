// Usage notices raise a push (S4, plan 4.4): a notice the UsageService newly writes counts one more usage
// notification on the real NotificationService — counts only, never the notice's words — while a repeat the store
// ignored and a "forgotten" notice raise none. The real services over a real store; a fake sender, no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "@morndo/domain";
import type { PushOptions } from "../src/adapters/webpush.ts";
import { NotificationService, type PushStore } from "../src/application/notification-service.ts";
import { UsageService } from "../src/application/usage-service.ts";
import { Store } from "../src/adapters/store.ts";

const HOUR = 3_600_000, MIN = 60_000, DAY = 24 * HOUR;
let dir: string;
let store: Store;
let now: number;
let sent: { payload: unknown; options: PushOptions }[];
let audit: NotificationEvent[];
let notifications: NotificationService;
let usage: UsageService;

// A reading as a source posts it, straight into the real service (epoch seconds on the wire).
const reading = (o: { plan?: string; capturedAt?: number; windows?: { id: string; used_percent: number; resets_at?: number; length_mins?: number }[]; failure?: { reason: string; hint?: string } } = {}) =>
  usage.reading({
    source: "app-server", node: null, captured_at: Math.floor((o.capturedAt ?? now) / 1000),
    ...(o.plan === undefined ? {} : { plan: o.plan }),
    ...(o.windows === undefined ? {} : { windows: o.windows }),
    ...(o.failure === undefined ? {} : { failure: o.failure }),
  }, "seat-a", { kind: "worker", name: "builder", token: "t-1" });
const fiveHour = (n: number, at = now + 2 * HOUR) => ({ id: "five_hour", used_percent: n, resets_at: Math.floor(at / 1000), length_mins: 300 });
// The hub's clock goes with the fake timers: the NotificationService's debounce only hands a raise to the sender once
// its own clock is past the second (a fixed `now` would starve it for ever).
const settle = async (ms: number) => { now += ms; await vi.advanceTimersByTimeAsync(ms); await notifications.settled(); };

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_700_000_000_000;
  dir = mkdtempSync(join(tmpdir(), "morndo-usage-push-"));
  store = new Store(dir);
  sent = []; audit = [];
  const pushStore: PushStore = {
    pushSubscriptions: () => [{ endpointId: "phone", endpoint: "https://fcm.googleapis.com/fcm/send/phone", p256dh: "k", auth: "a" }],
    savePushSubscription: () => {}, deletePushSubscription: () => false, record: e => { audit.push(...e); },
  };
  notifications = new NotificationService({
    store: pushStore, now: () => now,
    send: async (_s, payload, options) => { sent.push({ payload: JSON.parse(payload.toString()), options }); return { status: 201 }; },
  });
  usage = new UsageService({ store, now: () => now, onNotice: () => notifications.usage() });
});
afterEach(() => { notifications.stop(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("usage notices raise a push (S4)", () => {
  it("a plan change told by readings raises one usage push, counts only, through the real services", async () => {
    // The plan watch needs two agreeing readings per change: the first holds, the second tells.
    expect(reading({ plan: "Max 5x", windows: [fiveHour(20)] })).toEqual({ ok: true });
    expect(reading({ plan: "Max 20x", windows: [fiveHour(21)], capturedAt: now + MIN })).toEqual({ ok: true });
    expect(reading({ plan: "Max 20x", windows: [fiveHour(22)], capturedAt: now + 2 * MIN })).toEqual({ ok: true });
    await settle(2000);
    expect(sent.map(s => s.payload)).toEqual([{ kind: 4, decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 1 }]);
    expect(sent[0]?.options).toEqual({ ttlSeconds: 6 * 3600, topic: "usage", urgency: "normal" });
    expect(audit).toEqual([{ type: "NotificationSent", kind: "usage", counts: { decisions: 0, workers: 0, linked: 0, alerts: 0, usage: 1 }, devices: 1, at: now }]);
    expect(JSON.stringify(sent[0]?.payload)).not.toContain("plan changed");            // the notice's words never leave the hub
  });

  it("a repeated notice raises none: the count stays what the last push said", async () => {
    expect(reading({ plan: "Max 5x", windows: [fiveHour(20)] })).toEqual({ ok: true });
    expect(reading({ plan: "Max 20x", windows: [fiveHour(21)], capturedAt: now + MIN })).toEqual({ ok: true });
    expect(reading({ plan: "Max 20x", windows: [fiveHour(22)], capturedAt: now + 2 * MIN })).toEqual({ ok: true });
    await settle(2000);
    expect(sent).toHaveLength(1);
    // The same plan, read again: no new notice, and after the push went the count started from zero.
    expect(reading({ plan: "Max 20x", windows: [fiveHour(22)], capturedAt: now + 2 * MIN })).toEqual({ ok: true });
    await settle(2000);
    expect(sent).toHaveLength(1);
    expect(notifications.counts().usage).toBe(0);
  });

  it("a 'forgotten' notice raises none: forgetting is housekeeping, not news", async () => {
    expect(reading({ windows: [fiveHour(20)] })).toEqual({ ok: true });
    now += 15 * DAY;                                                  // two weeks quiet: the sweep forgets the source
    usage.sweep();
    await settle(2000);
    expect(usage.view().notices.some(n => n.kind === "forgotten")).toBe(true);   // the notice was written…
    expect(sent).toEqual([]);                                                    // …and raised nothing
    expect(audit).toEqual([]);
  });
  it("a write whose commit fails tells nobody: the push follows the commit, never the write", async () => {
    // The write's statements all run and queue their notice, then the commit itself fails: nothing is told.
    const spy = vi.spyOn(store, "atomically").mockImplementation(fn => { fn(); throw new Error("commit failed"); });
    expect(() => usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toThrow("commit failed");
    await settle(2000);
    expect(sent).toEqual([]);
    expect(audit).toEqual([]);
    expect(notifications.counts().usage).toBe(0);
    spy.mockRestore();
    // A write that does commit pushes once.
    expect(usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });
    await settle(2000);
    expect(sent).toHaveLength(1);
  });
});
