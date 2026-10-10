// An outbox an older app left in this browser (ADR-0008 phase C) may hold Commands for legacy pane ids ("%3"). A fleet
// hub has no such worker, but its send route still matches (worker-id.ts takes both forms) and it answers 404 "no_pane":
// the entry ends Not sent, said in words, and nothing throws. Entries for worker ids go as usual. A node the hub can't
// reach is said in words too. The real Outbox and post(); a memory store seeded as IndexedDB would hand the records
// back; fetch answers as a fleet hub does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox } from "../src/lib/outbox/outbox.ts";
import { post } from "../src/lib/outbox/device.ts";
import { memoryStore } from "../src/lib/outbox/store.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { sendReason } from "../src/lib/outbox/words.ts";

const T0 = Date.UTC(2026, 9, 6, 12);
const record = (id: string, worker: string, workerName: string): OutboxRecord => ({
  id, worker, workerName, text: `to ${workerName}`, uploads: [], createdAt: T0 - 1000, budgetFrom: T0 - 1000,
  state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, typedAt: null,
});
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  requests = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const worker = decodeURIComponent(/^\/api\/workers\/([^/]+)\/send$/.exec(input)?.[1] ?? "");
    requests.push(worker);
    const [status, body] = /^%\d+$/.test(worker) ? [404, { error: "no_pane" }] : [200, { ok: true, at: T0 }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("an outbox an older app left, against a fleet hub", () => {
  it("a legacy %N entry ends Not sent as no_pane, in words; a worker id entry goes", async () => {
    const store = memoryStore();
    await store.put(record("00000000-0000-4000-8000-000000000001", "%3", "alpha"));
    await store.put(record("00000000-0000-4000-8000-000000000002", "pc.3fa2c1d0.12", "beta"));
    const o = new Outbox({
      store, post, connected: () => true, onChange: () => {},
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
    });
    await o.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.sort()).toEqual(["%3", "pc.3fa2c1d0.12"]);
    const legacy = o.records.find(r => r.worker === "%3");
    expect(legacy).toMatchObject({ state: "failed", error: "no_pane" });
    expect(legacy ? sendReason(legacy, "alpha") : null).toBe("alpha is no longer running.");
    expect(o.records.find(r => r.worker === "pc.3fa2c1d0.12")).toMatchObject({ state: "sent", typedAt: T0 });
  });

  it("a node the hub can't reach is said in words (Task 5's wording), never as its code", () => {
    const r: OutboxRecord = { ...record("00000000-0000-4000-8000-000000000003", "pc.3fa2c1d0.12", "beta"), state: "failed", error: "node_offline" };
    expect(sendReason(r, "beta")).toBe("beta is on a machine that isn't answering right now, so nothing was typed. Try again once it's back.");
  });
});
