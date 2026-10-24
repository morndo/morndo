// Store-level unit tests for the Usage context's fix round on PR #125: the transaction the paired usage writes need
// (finding 4c), the one-row read by key (finding 5a) and notice retention (finding 5c). A real Store on a temp
// directory, no HTTP, synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noHealth, type BoardActor, type SeatRecord } from "@morndo/domain";
import { Store, type UsageSourceBody } from "../src/adapters/store.ts";
import { UsageService } from "../src/application/usage-service.ts";

let dir: string;
let store: Store;
const body: UsageSourceBody = { health: noHealth("app-server"), reading: null, previous: null, hint: null };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-usage-store-"));
  store = new Store(dir);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the usage store (fix round, PR #125)", () => {
  it("usageSource returns the one row by key, and null for a key nothing holds (finding 5a)", () => {
    store.saveUsageSource("seat-a", "app-server", "", body);
    store.saveUsageSource("seat-a", "app-server", "node-2", body);
    store.saveUsageSource("seat-b", "app-server", "", body);
    expect(store.usageSource("seat-a", "app-server", "")).toEqual({ account: "seat-a", source: "app-server", node: "", body });
    expect(store.usageSource("seat-a", "app-server", "node-2")).toEqual({ account: "seat-a", source: "app-server", node: "node-2", body });
    expect(store.usageSource("seat-a", "cli-screen", "")).toBeNull();
    expect(store.usageSource("seat-c", "app-server", "")).toBeNull();
  });

  it("a write inside atomically is not persisted when a later one in it throws (finding 4c)", () => {
    expect(() => store.atomically(() => {
      store.saveUsageSource("seat-a", "app-server", "", body);
      store.takeTaskNumber(999);      // throws: 999 is not the next task number
    })).toThrow(/not the next one/);
    expect(store.usageSources()).toEqual([]);
  });

  it("sweep keeps the newest 500 usage notices and nothing older than 30 days (finding 5c)", () => {
    let now = 1_700_000_000_000;
    const svc = new UsageService({ store, now: () => now });
    for (let i = 0; i < 600; i++) store.saveUsageNotice({ id: `n${i}`, kind: "plan", account: "seat-a", at: now + i * 1000, text: `t${i}` }, `s${i}`);
    store.saveUsageNotice({ id: "old", kind: "plan", account: "seat-a", at: now - 31 * 24 * 3_600_000, text: "old" }, "old");
    now += 600 * 1000;
    svc.sweep();
    const kept = store.usageNotices(1000);
    expect(kept).toHaveLength(500);
    expect(kept[0]?.id).toBe("n599");
    expect(kept.some(n => n.id === "old")).toBe(false);       // older than 30 days
    expect(kept.some(n => n.id === "n99")).toBe(false);       // only the newest 500 remain
  });
  it("a notice older than 30 days goes even when fewer than 500 are kept (finding 5c)", () => {
    const now = 1_700_000_000_000;
    const svc = new UsageService({ store, now: () => now });
    store.saveUsageNotice({ id: "old", kind: "plan", account: "seat-a", at: now - 31 * 24 * 3_600_000, text: "old" }, "old");
    store.saveUsageNotice({ id: "edge", kind: "plan", account: "seat-a", at: now - 29 * 24 * 3_600_000, text: "edge" }, "edge");
    store.saveUsageNotice({ id: "new", kind: "plan", account: "seat-a", at: now, text: "new" }, "new");
    svc.sweep();
    expect(store.usageNotices(10).map(n => n.id)).toEqual(["new", "edge"]);
  });

  it("usageSourcesOf returns only one account's rows, and usageSeat its one seat row or null (PR #125 fix round 2, finding 3c)", () => {
    store.saveUsageSource("seat-a", "app-server", "", body);
    store.saveUsageSource("seat-a", "cli-screen", "", body);
    store.saveUsageSource("seat-b", "app-server", "", body);
    const seat: SeatRecord = { state: "out", why: "usage_limit", since: 1, markedAt: 1, backAt: null, cycleReset: null, windowId: null, owner: "derived", by: "a source" };
    store.saveUsageSeat("seat-a", seat);
    store.saveUsageSeat("seat-b", { ...seat, state: "retired", why: "refused" });
    expect(store.usageSourcesOf("seat-a")).toEqual([
      { account: "seat-a", source: "app-server", node: "", body },
      { account: "seat-a", source: "cli-screen", node: "", body },
    ]);
    expect(store.usageSourcesOf("seat-c")).toEqual([]);
    expect(store.usageSeat("seat-a")).toEqual({ account: "seat-a", record: seat });
    expect(store.usageSeat("seat-c")).toBeNull();
  });

  it("a report for one account does not scan every account's rows (PR #125 fix round 2, finding 3c)", () => {
    store.saveUsageSource("seat-a", "app-server", "", body);
    store.saveUsageSource("seat-b", "app-server", "", body);
    const svc = new UsageService({ store, now: () => 1_700_000_000_000 });
    const everyRow = vi.spyOn(store, "usageSources");
    const actor: BoardActor = { kind: "worker", name: "builder", token: "t" };
    const r = svc.report({ session_id: "s1" }, "seat-a", actor);
    if (!r.ok) throw new Error("report refused");
    expect(r.account.account).toBe("seat-a");
    expect(everyRow).not.toHaveBeenCalled();
  });

  it("sweep prunes notices the service itself wrote, not only direct store inserts (PR #125 fix round 2, finding 3b)", () => {
    let now = 1_700_000_000_000;
    const svc = new UsageService({ store, now: () => now });
    // 520 seat notices through noteLimit's own path: a retired seat that alternates its why is a change every time.
    for (let i = 0; i < 520; i++) {
      now += 1000;
      expect(svc.noteLimit({ account: "seat-a", kind: i % 2 === 0 ? "refused" : "billing", backAt: null, by: "reporter", at: now })).toEqual({ ok: true, resolved: true });
    }
    expect(store.usageNotices(1000).filter(n => n.kind === "seat")).toHaveLength(520);
    svc.sweep();
    const kept = store.usageNotices(1000);
    expect(kept).toHaveLength(500);
    expect(kept.every(n => n.kind === "seat")).toBe(true);
  });
});
