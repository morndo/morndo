// Store-level unit tests for the Usage context's fix round on PR #125: the transaction the paired usage writes need
// (finding 4c), the one-row read by key (finding 5a) and notice retention (finding 5c). A real Store on a temp
// directory, no HTTP, synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noHealth } from "@morndo/domain";
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
});
