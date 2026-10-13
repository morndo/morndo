// The outbox runner (ADR-0008 phase C; S4–S8): written down before the first attempt, one at a time per conversation
// and parallel across conversations, retried on its own for 2 minutes, waiting while offline, resumed after a reload,
// and ended by its echo. A memory store and fake timers; the real IndexedDB store is tested in Chromium.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { post } from "../src/lib/outbox/device.ts";
import { Outbox, type PostOutcome } from "../src/lib/outbox/outbox.ts";
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { ATTEMPT_TIMEOUT_MS, BUDGET_MS, RETRY_MS, RETRY_WINDOW_MS, canRetry, type OutboxRecord } from "../src/lib/outbox/state.ts";
import { sendLabel } from "../src/lib/outbox/words.ts";

const T0 = Date.UTC(2026, 9, 2, 12);
let store: OutboxStore;
let connected: boolean;
let posts: { id: string; worker: string; at: number; storedFirst: boolean }[];
let answer: (r: OutboxRecord, attempt: number, signal: AbortSignal) => Promise<PostOutcome>;
let seen: OutboxRecord[];
let n: number;

function outbox() {
  return new Outbox({
    store,
    post: async (r, signal) => {
      const storedFirst = (await store.all()).some(x => x.id === r.id);
      posts.push({ id: r.id, worker: r.worker, at: Date.now(), storedFirst });
      return answer(r, posts.filter(p => p.id === r.id).length, signal);
    },
    timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
    connected: () => connected,
    onChange: rs => { seen = rs; },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}
const cmd = (worker = "%1", text = "ship it") => ({ worker, workerName: "alpha", text, uploads: [], seen: "none" });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
const state = (o: Outbox, id: string) => o.records.find(r => r.id === id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = memoryStore(); connected = true; posts = []; seen = []; n = 0;
  answer = async () => ({ kind: "typed" });
});
afterEach(() => vi.useRealTimers());

describe("queueing (S4)", () => {
  it("Retry of an expired command is posted as the owner's retry, and that flag does not stay", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    let revived = false;
    answer = async rec => { revived = rec.revive === true; return { kind: "typed", queued: true, inbox: "queued", reason: null }; };
    await o.retry(r.id);
    await flush();
    expect(revived).toBe(true);
    expect(state(o, r.id)?.revive).toBeUndefined();
  });
  it("asks again after 2 minutes, so an expired command does not stay Queued", async () => {
    answer = async () => ({ kind: "typed", queued: true });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true });
    expect(state(o, r.id)?.inbox).toBeUndefined();
    const sentAt = state(o, r.id)?.sentAt;
    let asks = 0;
    answer = async rec => {
      asks += 1;
      expect(rec.revive).toBeUndefined();
      expect(rec.again).toBeUndefined();
      return { kind: "typed", queued: true, inbox: "expired", reason: null };
    };
    await advance(BUDGET_MS);
    expect(asks).toBe(1);
    const saved = state(o, r.id);
    expect(saved?.inbox).toBe("expired");
    expect(saved?.sentAt).toBe(sentAt);
    expect(saved && sendLabel(saved, [saved], T0 + BUDGET_MS)).toBe("Not sent");
    expect(saved && canRetry(saved, T0 + BUDGET_MS)).toBe(true);
  });
  it("a successful Retry drops the expired spool word, so it is not still Not sent", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    answer = async () => ({ kind: "typed", queued: true });
    await o.retry(r.id);
    await flush();
    const saved = state(o, r.id);
    expect(saved?.inbox).toBeUndefined();
    expect(saved?.inboxReason).toBeUndefined();
    expect(saved && sendLabel(saved, [saved], T0)).toBe("Queued, it will be delivered");
    expect(saved && canRetry(saved, T0)).toBe(false);
  });
  it("a Retry the hub says was delivered is Sent, not still queued as lost", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "lost", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    const deliveredAt = T0 + 30_000;
    answer = async () => ({ kind: "typed", at: deliveredAt });
    await o.retry(r.id);
    await flush();
    const saved = state(o, r.id);
    expect(saved?.queued).toBeUndefined();
    expect(saved?.inbox).toBeUndefined();
    expect(saved?.inboxReason).toBeUndefined();
    expect(saved && sendLabel(saved, [saved], deliveredAt)).toBe("Sent");
  });
  it("keeps the spool status a queued answer reported, so the label can name it", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "accepted", reason: null });
    const o = outbox();
    const r = await o.enqueue(cmd("%0"));
    await flush();
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true, inbox: "accepted", inboxReason: null });
  });
  it("writes the Command down before its first attempt, and it ends Sent", async () => {
    const o = outbox();
    const r = await o.enqueue(cmd());
    await flush();
    expect(posts).toEqual([{ id: r.id, worker: "%1", at: T0, storedFirst: true }]);
    expect(state(o, r.id)?.state).toBe("sent");
    expect((await store.all())[0]?.state).toBe("sent");
  });
  it("one at a time per conversation, in order; other conversations don't wait", async () => {
    let release = () => {};
    answer = r => (r.worker === "%1" && posts.length === 1 ? new Promise(res => (release = () => res({ kind: "typed" }))) : Promise.resolve({ kind: "typed" }));
    const o = outbox();
    const a = await o.enqueue(cmd("%1", "first"));
    const b = await o.enqueue(cmd("%1", "second"));
    const c = await o.enqueue(cmd("%2", "elsewhere"));
    await flush();
    expect(posts.map(p => p.id)).toEqual([a.id, c.id]);                // %2 went while %1's first was still in flight
    release();
    await flush();
    expect(posts.map(p => p.id)).toEqual([a.id, c.id, b.id]);
  });
});

describe("retrying (S7)", () => {
  it("an unanswered attempt is retried after 1.5, 3, 6, 12 s, then every 15 s, and is Not sent after 2 minutes", async () => {
    answer = async () => ({ kind: "unanswered" });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(130_000);
    const gaps = posts.slice(1).map((p, i) => p.at - (posts[i]?.at ?? 0));
    expect(gaps.slice(0, 5)).toEqual([1500, 3000, 6000, 12_000, 15_000]);
    expect(posts.every(p => p.at - T0 < 120_000)).toBe(true);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "timeout" });
  });
  it("a 429 is waited out for its Retry-After, then the same request id goes again", async () => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "wait", ms: 20_000 } : { kind: "typed" });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(19_000);
    expect(posts).toHaveLength(1);
    await advance(1000);
    expect(posts).toHaveLength(2);
    expect(state(o, r.id)?.state).toBe("sent");
  });
  it("a definite refusal is final: Not sent with its reason, no retry", async () => {
    answer = async () => ({ kind: "refused", code: "stale" });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(60_000);
    expect(posts).toHaveLength(1);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "stale" });
  });
  it("uncertain is never sent again on its own, and holds what was written after it", async () => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : { kind: "typed" });
    const o = outbox();
    const r = await o.enqueue(cmd("%1", "first"));
    await o.enqueue(cmd("%1", "second"));
    await advance(10 * 60_000);
    expect(posts.map(p => p.id)).toEqual([r.id]);
    expect(state(o, r.id)).toMatchObject({ state: "uncertain", error: "uncertain" });
  });
  // Check again (fleet core §3.1, §7): the same request id once more, so the hub asks the worker's machine (op.status).
  it("Check again sends the same request id once; typed then or now, it is Sent with that time, and what waited goes", async () => {
    answer = async (r, attempt) => (r.text === "first" && attempt === 1 ? { kind: "uncertain" } : { kind: "typed", at: T0 - 42 });
    const o = outbox();
    const r = await o.enqueue(cmd("%1", "first"));
    const b = await o.enqueue(cmd("%1", "second"));
    await advance(10_000);
    await o.retry(r.id);
    await flush();
    expect(posts.map(p => p.id)).toEqual([r.id, r.id, b.id]);
    expect(state(o, r.id)).toMatchObject({ state: "sent", typedAt: T0 - 42, error: null, sentAt: T0 + 10_000 });
    expect(state(o, b.id)?.state).toBe("sent");
  });
  it.each<[string, PostOutcome]>([
    ["still uncertain (409)", { kind: "uncertain" }],
    ["500 internal error", { kind: "refused", code: "internal error", status: 500 }],
    ["502 from a proxy", { kind: "refused", code: "bad_gateway", status: 502 }],
    ["a refusal with no status", { kind: "refused", code: "no_pane" }],
    ["no answer", { kind: "unanswered" }],
    ["wait", { kind: "wait", ms: 1000 }],
  ])("Check again answered %s leaves it Uncertain, sent once, not again on its own", async (_name, second) => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : second);
    const o = outbox();
    const r = await o.enqueue(cmd());
    await flush();
    await o.retry(r.id);
    await advance(10 * 60_000);
    expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
    expect(state(o, r.id)).toMatchObject({ state: "uncertain", error: "uncertain" });
  });
  // The hub answers a repeat in doubt before it judges anything else; a refusal means its machine never had it and the
  // hub refused it now: nothing was typed (fleet core §3.1). Not sent, with the refusal's words, and Retry.
  it.each<[string, PostOutcome]>([
    ["409 stale", { kind: "refused", code: "stale", status: 409 }],
    ["409 menu_open", { kind: "refused", code: "menu_open", status: 409 }],
    ["409 node_offline", { kind: "refused", code: "node_offline", status: 409 }],
    ["404 no_pane", { kind: "refused", code: "no_pane", status: 404 }],
    ["403 step_up", { kind: "refused", code: "step_up", status: 403 }],
  ])("Check again answered %s: Not sent with that reason, held what came after, and Retry sends the same id", async (_name, second) => {
    answer = async (r, attempt) => (r.text !== "first" ? { kind: "typed" } : attempt === 1 ? { kind: "uncertain" } : attempt === 2 ? second : { kind: "typed" });
    const o = outbox();
    const r = await o.enqueue(cmd("%1", "first"));
    const b = await o.enqueue(cmd("%1", "second"));
    await flush();
    await o.retry(r.id);
    await advance(60_000);                                             // inside the 2 minutes: nothing goes on its own
    expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: (second as { code: string }).code });
    expect(state(o, b.id)?.state).toBe("queued");                       // still held behind the Not sent one
    await o.retry(r.id);
    await advance(10_000);
    expect(posts.map(p => p.id)).toEqual([r.id, r.id, r.id, b.id]);
    expect(state(o, r.id)?.state).toBe("sent");
  });
  it("Check again only one at a time, and only while the hub still holds its record (L1)", async () => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : new Promise<PostOutcome>(() => {}));
    const o = outbox();
    const r = await o.enqueue(cmd());
    await flush();
    void o.retry(r.id);
    void o.retry(r.id);
    await flush();
    expect(posts).toHaveLength(2);                                     // the second press finds one in flight
    await advance(ATTEMPT_TIMEOUT_MS);                                 // given up: still Uncertain
    expect(state(o, r.id)?.state).toBe("uncertain");
    vi.setSystemTime(T0 + RETRY_WINDOW_MS);
    await o.retry(r.id);
    await flush();
    expect(posts).toHaveLength(2);
  });
  it("the principal's Retry sends the same request id again, with a fresh 2 minutes", async () => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "refused", code: "menu_open" } : { kind: "typed" });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(5 * 60_000);
    await o.retry(r.id);
    await flush();
    expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
    expect(state(o, r.id)?.state).toBe("sent");
  });
});

describe("offline (S7)", () => {
  it("waits while disconnected, Queued, and goes at once when connected again", async () => {
    connected = false;
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(30_000);
    expect(posts).toEqual([]);
    expect(state(o, r.id)?.state).toBe("queued");
    connected = true;
    o.connected();
    await flush();
    expect(posts).toHaveLength(1);
    expect(state(o, r.id)?.state).toBe("sent");
  });
  it("the 2 minutes keep running while offline: past them it is Not sent, never sent late", async () => {
    connected = false;
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(121_000);
    connected = true;
    o.connected();
    await flush();
    expect(posts).toEqual([]);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "timeout" });
  });
});

describe("a reload", () => {
  it("within the 2 minutes, a send that was in flight resumes with the same request id", async () => {
    answer = () => new Promise(() => {});                               // the page goes away mid-send
    const before = outbox();
    const r = await before.enqueue(cmd());
    await flush();
    before.stop();
    await advance(30_000);
    answer = async () => ({ kind: "typed" });
    const after = outbox();
    await after.start();
    await flush();
    expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
    expect(state(after, r.id)?.state).toBe("sent");
  });
  it("past the 2 minutes, it is Not sent, and Retry can still check it with the same id", async () => {
    answer = () => new Promise(() => {});
    const before = outbox();
    const r = await before.enqueue(cmd());
    await flush();
    before.stop();
    await advance(3 * 60_000);
    const after = outbox();
    await after.start();
    await flush();
    expect(state(after, r.id)).toMatchObject({ state: "failed", error: "closed" });
    expect(posts).toHaveLength(1);
  });
});

describe("held for a passkey check", () => {
  it("a Command whose passkey check failed is written down Not sent: verify, and nothing is posted until Retry", async () => {
    const o = outbox();
    const r = await o.enqueue(cmd(), "step_up");
    await advance(60_000);
    expect(posts).toEqual([]);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "step_up" });
    await o.retry(r.id);
    await flush();
    expect(posts.map(p => p.id)).toEqual([r.id]);
  });
});

describe("echoes (S8)", () => {
  it("an echo takes the entry off the screen before its disk delete finishes", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const base = memoryStore();
    const slow: OutboxStore = {
      durable: true,
      all: () => base.all(),
      get: id => base.get(id),
      put: r => base.put(r),
      delete: async id => { await held; await base.delete(id); },
    };
    const o = new Outbox({
      store: slow,
      post: async () => ({ kind: "typed" }),
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
      connected: () => true,
      onChange: rs => { seen = rs; },
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    });
    await o.enqueue(cmd("%1", "survive the reload"));
    await flush();
    const done = o.echoes("%1", [{ id: "m1", at: Date.now(), text: "survive the reload" }]);
    await flush();
    expect(o.records).toEqual([]);                                          // gone while the disk delete is still waiting
    expect(seen).toEqual([]);
    release();
    await done;
    expect(await base.all()).toEqual([]);
  });
  it("an echo while the sent row is still being written is not put back", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const base = memoryStore();
    let gate = false;
    const slow: OutboxStore = {
      durable: true,
      all: () => base.all(),
      get: id => base.get(id),
      put: async r => { if (gate && r.state === "sent") await held; await base.put(r); },
      delete: id => base.delete(id),
    };
    let o!: Outbox;
    o = new Outbox({
      store: slow,
      post: async () => { gate = true; return { kind: "typed" }; },
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
      connected: () => true,
      onChange: rs => { seen = rs; if (rs.some(r => r.state === "sent")) void o.echoes("%1", [{ id: "m1", at: Date.now(), text: "ship it" }]); },
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    });
    await o.enqueue(cmd());
    await flush();
    expect(o.records).toEqual([]);
    release();
    await flush();
    expect(await base.all()).toEqual([]);
  });
  it("an echo ends a Sent record; one echo ends one of two identical texts, the oldest", async () => {
    const o = outbox();
    const a = await o.enqueue(cmd("%1", "yes"));
    await advance(1000);
    const b = await o.enqueue(cmd("%1", "yes"));
    await flush();
    await o.echoes("%1", [{ id: "m1", at: Date.now(), text: "yes" }]);
    expect(o.records.map(r => r.id)).toEqual([b.id]);
    expect((await store.all()).map(r => r.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });
  it("discard removes a record for good", async () => {
    answer = async () => ({ kind: "refused", code: "stale" });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await flush();
    await o.discard(r.id);
    expect(o.records).toEqual([]);
    expect(await store.all()).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("phase C review fixes", () => {
  it("a POST that never answers is given up after 15 s and tried again; past the budget, Not sent (H3)", async () => {
    let aborted = 0;
    answer = (_r, _n, signal) => new Promise(() => { signal.addEventListener("abort", () => aborted++); });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(15_000);
    expect(aborted).toBe(1);
    expect(posts.length).toBeGreaterThanOrEqual(1);
    await advance(130_000);
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "timeout" });
    expect(posts.every(p => p.at - T0 < 120_000)).toBe(true);
  });
  it("Discard while it is being sent stops it and lets the next one go (H3, L3)", async () => {
    let aborted = false;
    answer = (r, _n, signal) => (r.text === "stuck" ? new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }) : Promise.resolve({ kind: "typed" }));
    const o = outbox();
    const a = await o.enqueue(cmd("%1", "stuck"));
    const b = await o.enqueue(cmd("%1", "next"));
    await flush();
    await o.discard(a.id);
    await flush();
    expect(aborted).toBe(true);
    expect(state(o, b.id)?.state).toBe("sent");
  });
  it("one echo ends one of two identical entries, however often the conversation is read (M1)", async () => {
    const o = outbox();
    await o.enqueue(cmd("%1", "yes"));
    await advance(1000);
    await o.enqueue(cmd("%1", "yes"));
    await flush();
    const echo = [{ id: "m1", at: Date.now(), text: "yes" }];
    await Promise.all([o.echoes("%1", echo), o.echoes("%1", echo)]);
    await o.echoes("%1", echo);
    expect(o.records).toHaveLength(1);
  });
  it("matches echoes on the hub's clock: a hub 30 s behind still ends the entry (M2)", async () => {
    answer = async () => ({ kind: "typed", at: T0 - 30_000 });
    const o = outbox();
    await o.enqueue(cmd("%1", "late clock"));
    await flush();
    await o.echoes("%1", [{ id: "m1", at: T0 - 29_000, text: "late clock" }]);
    expect(o.records).toEqual([]);
  });
  it("a failed earlier message holds the later ones of its conversation until Retry or Discard (M3)", async () => {
    answer = async r => (r.text === "first" ? { kind: "refused", code: "busy" } : { kind: "typed" });
    const o = outbox();
    const a = await o.enqueue(cmd("%1", "first"));
    const b = await o.enqueue(cmd("%1", "second"));
    const c = await o.enqueue(cmd("%2", "elsewhere"));
    await advance(5000);
    expect(state(o, b.id)?.state).toBe("queued");                        // held: it must not overtake "first"
    expect(state(o, c.id)?.state).toBe("sent");                          // another conversation doesn't wait
    answer = async () => ({ kind: "typed" });
    await o.retry(a.id);
    await flush();
    expect(posts.filter(p => p.worker === "%1").map(p => p.id)).toEqual([a.id, a.id, b.id]);
  });
  it("a record another tab deleted is neither sent nor written back (M5)", async () => {
    connected = false;
    const o = outbox();
    const r = await o.enqueue(cmd());
    await store.delete(r.id);                                           // Discard in another tab
    connected = true;
    o.connected();
    await flush();
    expect(posts).toEqual([]);
    expect(await store.all()).toEqual([]);
  });
});

// V14 (ADR-0008 phase C): not_submitted comes after the paste: the text is in the worker's input box. It is never Not
// sent, on Check again or on a first attempt; the entry stays May have been sent, and is never sent again on its own.
describe("pasted but not submitted (409 not_submitted)", () => {
  it("Check again answered 409 not_submitted leaves it Uncertain, sent once more only, not again on its own", async () => {
    answer = async (_r, attempt) => (attempt === 1 ? { kind: "uncertain" } : { kind: "refused", code: "not_submitted", status: 409 });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await flush();
    await o.retry(r.id);
    await advance(10 * 60_000);
    expect(posts.map(p => p.id)).toEqual([r.id, r.id]);
    expect(state(o, r.id)).toMatchObject({ state: "uncertain" });
  });
  it("a first attempt answered 409 not_submitted is Uncertain with that reason, never Not sent, and never sent again on its own", async () => {
    answer = async () => ({ kind: "refused", code: "not_submitted", status: 409 });
    const o = outbox();
    const r = await o.enqueue(cmd());
    await advance(10 * 60_000);
    expect(posts).toHaveLength(1);
    expect(state(o, r.id)).toMatchObject({ state: "uncertain", error: "not_submitted" });
  });
});

// Send again on the phone (review, 2026-10-05): a message Sent into the manager's inbox but never echoed goes again with
// the same request id (the hub queues it once more only if the inbox gave the first up), and its clock starts over.
describe("again", () => {
  it("re-posts a Sent-into-the-inbox record with the same request id; it is Sent again with a fresh time", async () => {
    answer = async () => ({ kind: "typed", queued: true });
    const o = outbox();
    await o.start();
    const r = await o.enqueue(cmd("%0", "hello"));
    await advance(10);
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true });
    const first = state(o, r.id)?.sentAt ?? 0;
    await advance(61 * 60_000);
    const tapped = Date.now();
    // The wait also runs the inbox poll (a queued command is asked again after two minutes). Send again is the next post.
    const before = posts.length;
    await o.again(r.id);
    await advance(10);
    expect(posts.slice(before).map(p => p.id)).toEqual([r.id]);
    expect(posts.every(p => p.id === r.id)).toBe(true);
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true });
    expect(state(o, r.id)?.sentAt).toBeGreaterThanOrEqual(tapped);
    expect(tapped - first).toBeGreaterThan(60 * 60_000);
    expect((await store.all()).map(x => x.id)).toEqual([r.id]);                // kept on the device all along
  });
  it("a status check is not Send again, and a second copy the inbox then gives up is final", async () => {
    const flags: boolean[] = [];
    answer = async rec => { flags.push(rec.again === true); return { kind: "typed", queued: true, inbox: "queued" }; };
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    await advance(BUDGET_MS);
    expect(flags.at(-1)).toBe(false);
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
    answer = async rec => { flags.push(rec.again === true); return { kind: "typed", queued: true, inbox: "expired" }; };
    await advance(5_000);
    expect(flags.at(-1)).toBe(false);
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
    answer = async rec => { flags.push(rec.again === true); return { kind: "typed", queued: true, inbox: "queued" }; };
    await o.again(r.id);
    await flush();
    expect(flags.at(-1)).toBe(true);
    expect(state(o, r.id)?.again).toBeUndefined();
    expect(state(o, r.id)?.resent).toBe(true);
    answer = async rec => { flags.push(rec.again === true); return { kind: "typed", queued: true, inbox: "expired" }; };
    await advance(BUDGET_MS);
    expect(flags.at(-1)).toBe(false);
    expect(state(o, r.id)?.resendFailed).toBe(true);
  });
  it("sets resent only after the hub accepts the copy, and Retry clears it so a later expiry is not final", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    let posted: { again: boolean | undefined; resent: boolean | undefined } | null = null;
    answer = async rec => { posted = { again: rec.again, resent: rec.resent }; return { kind: "typed", queued: true, inbox: "queued" }; };
    await o.again(r.id);
    await flush();
    expect(posted).toEqual({ again: true, resent: undefined });
    expect(state(o, r.id)?.resent).toBe(true);
    expect(state(o, r.id)?.again).toBeUndefined();
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    await advance(BUDGET_MS);
    expect(state(o, r.id)?.resendFailed).toBe(true);
    answer = async rec => { expect(rec.again).toBeUndefined(); expect(rec.resent).toBeUndefined(); return { kind: "typed", queued: true, inbox: "queued" }; };
    await o.retry(r.id);
    await flush();
    expect(state(o, r.id)?.resent).toBeUndefined();
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    await advance(BUDGET_MS);
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
  });
  it("a refused Send again does not keep the again or resent flags", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    answer = async rec => { expect(rec.again).toBe(true); expect(rec.resent).toBeUndefined(); return { kind: "refused", code: "step_up", status: 403 }; };
    await o.again(r.id);
    await flush();
    expect(state(o, r.id)).toMatchObject({ state: "failed", error: "step_up" });
    expect(state(o, r.id)?.again).toBeUndefined();
    expect(state(o, r.id)?.resent).toBeUndefined();
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
  });
  it("a Send again the inbox cannot take stays queued, and is not marked final", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    answer = async () => ({ kind: "unanswered" });
    await o.again(r.id);
    await flush();
    expect(state(o, r.id)?.state).not.toBe("failed");
    expect(state(o, r.id)?.resendFailed).toBeUndefined();
  });
  it("Check asks where a queued command stands and does not send it again", async () => {
    const flags: boolean[] = [];
    answer = async rec => { flags.push(rec.again === true); return { kind: "typed", queued: true, inbox: "held" }; };
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    const sentAt = state(o, r.id)?.sentAt;
    flags.length = 0;
    await o.check(r.id);
    await flush();
    expect(flags).toEqual([false]);
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true, inbox: "held", sentAt });
    expect(state(o, r.id)?.again).toBeUndefined();
  });
  it("leaves alone a record that isn't Sent into the inbox", async () => {
    const o = outbox();
    await o.start();
    const r = await o.enqueue(cmd("%1", "typed one"));
    await advance(10);
    await o.again(r.id);
    await advance(10);
    expect(posts).toHaveLength(1);
  });
});

describe("review #2 (2026-10-05): where it stands in the manager's inbox", () => {
  it("a repeat's answer with the inbox's state is kept on the record", async () => {
    let n = 0;
    answer = async () => (++n === 1 ? { kind: "typed", queued: true } : { kind: "typed", queued: true, inbox: { status: "held", reason: "foreign_text" } });
    const o = outbox();
    await o.start();
    const r = await o.enqueue(cmd("%0", "hello"));
    await advance(10);
    await o.again(r.id);
    await advance(10);
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true, inbox: { status: "held", reason: "foreign_text" } });
  });
});

describe("a lasting Send-again refusal", () => {
  it("marks the bubble dead on the answer and does not ask again", async () => {
    answer = async () => ({ kind: "typed", queued: true, inbox: "expired" });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "ship it"));
    await flush();
    let n = 0;
    answer = async () => { n += 1; return { kind: "refused", code: "cannot_resend", status: 409 }; };
    await o.again(r.id);
    await flush();
    await advance(BUDGET_MS);
    expect(n).toBe(1);
    expect(state(o, r.id)).toMatchObject({ state: "sent", queued: true, resendFailed: true });
    expect(state(o, r.id)?.state).not.toBe("failed");
  });
});

describe("medium verify (2026-10-05), issue 1: a Send again the hub couldn't queue once more", () => {
  it("a record the inbox gave up, sent again and answered still given up, is marked: no further resend is possible", async () => {
    const given = { status: "cancelled", reason: null };
    answer = async () => ({ kind: "typed", queued: true, inbox: "queued" });
    const o = outbox();
    const r = await o.enqueue(cmd("%0", "hello"));
    await flush();
    answer = async rec => { expect(rec.again).toBeUndefined(); return { kind: "typed", queued: true, inbox: given }; };
    await advance(BUDGET_MS);
    expect(state(o, r.id)).toMatchObject({ inbox: given });
    expect(state(o, r.id)?.resendFailed).toBeUndefined();                  // a status check learned it; Send again is still possible
    answer = async rec => { expect(rec.again).toBe(true); return { kind: "typed", queued: true, inbox: given }; };
    await o.again(r.id);
    await flush();
    expect(state(o, r.id)).toMatchObject({ inbox: given, resendFailed: true });
  });
});

describe("a hub that is updating", () => {
  it("retries a send the hub answers 503", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify({ error: "updating" }), { status: 503, headers: { "retry-after": "1", "content-type": "application/json" } });
      return new Response(JSON.stringify({ at: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const o = new Outbox({
      store: memoryStore(),
      post,
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
      connected: () => true,
      onChange: () => {},
      newId: () => "00000000-0000-4000-8000-000000000099",
    });
    const r = await o.enqueue(cmd("%1"));
    await flush();
    expect(n).toBe(1);
    expect(state(o, r.id)?.state === "queued" || state(o, r.id)?.state === "sending").toBe(true);
    await advance(RETRY_MS[0]);
    expect(n).toBe(2);
    expect(state(o, r.id)?.state).toBe("sent");
    vi.unstubAllGlobals();
  });
});
