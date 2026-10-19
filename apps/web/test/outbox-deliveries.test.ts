// A message to the manager through the fleet's delivery queue, in the outbox (fleet-clients §9.1, Task 13): the hub's
// answer says where it stands, and each `deliveries` frame moves it on by its request id; one in doubt that the hub
// later finds queued is Sent. A frame for a request this device doesn't hold changes nothing. While it waits it can be
// cancelled, and it is never retried: no two-minute deadline, no Retry (ruling 83). A memory store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox, type CancelOutcome, type PostOutcome } from "../src/lib/outbox/outbox.ts";
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import { BUDGET_MS, canCancel, canRetry, commandDelivery } from "../src/lib/outbox/state.ts";
import { sendLabel } from "../src/lib/outbox/words.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let store: OutboxStore;
let answer: () => PostOutcome;
let cancelled: () => CancelOutcome | Promise<CancelOutcome>;
let posts = 0;
let cancels = 0;
let n = 0;
const outbox = () => new Outbox({
  store, post: async () => { posts++; return answer(); }, cancel: async () => { cancels++; return cancelled(); }, connected: () => true, onChange: () => {},
  timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
});
const cmd = { worker: "pc.aaaaaaaa.0", workerName: "manager", text: "status please", uploads: [], seen: "none" };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); store = memoryStore(); n = 0; posts = 0; cancels = 0; });
afterEach(() => vi.useRealTimers());

describe("the hub's word on a message to the manager", () => {
  it("is kept with the Sent record, and each deliveries frame moves it on", async () => {
    answer = () => ({ kind: "typed", at: T0, delivery: { state: "queued", waiting: "menu_open", why: null } });
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    expect(o.records[0]).toMatchObject({ state: "sent", delivery: { state: "queued", waiting: "menu_open" } });
    await o.deliveries([{ requestId: r.id, state: "delivered", waiting: null, why: null }]);
    expect(o.records[0]?.delivery).toEqual({ state: "delivered", waiting: null, why: null });
    expect((await store.all())[0]?.delivery?.state).toBe("delivered");
  });

  it("one in doubt that the hub then finds queued is Sent, with its delivery", async () => {
    answer = () => ({ kind: "uncertain" });
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    expect(o.records[0]?.state).toBe("uncertain");
    await o.deliveries([{ requestId: r.id, state: "queued", waiting: null, why: null }]);
    expect(o.records[0]).toMatchObject({ state: "sent", error: null, delivery: { state: "queued" } });
  });

  it("a frame for a request this device doesn't hold changes nothing (negative control)", async () => {
    answer = () => ({ kind: "typed", at: T0 });
    const o = outbox();
    await o.enqueue(cmd);
    await flush();
    await o.deliveries([{ requestId: "someone-elses", state: "delivered", waiting: null, why: null }]);
    expect(o.records[0]?.delivery).toBeUndefined();
  });
});

describe("waiting, and Cancel (ruling 83)", () => {
  const waiting = () => ({ kind: "typed" as const, at: T0, delivery: { state: "queued" as const, waiting: "busy", why: null } });

  it("waits as long as the hub says, never Not sent after two minutes, never retried; Cancel withdraws it", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * BUDGET_MS);
    const saved = o.records[0];
    expect(saved && [sendLabel(saved, [saved], T0 + 10 * BUDGET_MS), canRetry(saved, T0 + 10 * BUDGET_MS), canCancel(saved)]).toEqual(["Queued, it will be delivered", false, true]);
    expect(posts).toBe(1);
    cancelled = () => ({ kind: "cancelled", delivery: { state: "given_up", waiting: null, why: "cancelled" } });
    expect(await o.cancel(r.id)).toBe("cancelled");
    expect(o.records[0]).toMatchObject({ state: "sent", delivery: { state: "given_up", why: "cancelled" } });
    expect(o.records[0] && canCancel(o.records[0])).toBe(false);
    expect((await store.all())[0]?.delivery?.state).toBe("given_up");
  });

  it("Cancel tapped again while the first is on its way asks the hub once (staging QA, 2026-10-12: three asks)", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    const asked: (() => void)[] = [];
    const answerNow = () => { for (const a of asked) a(); };
    cancelled = () => new Promise(res => asked.push(() => res({ kind: "cancelled", delivery: { state: "given_up", waiting: null, why: "cancelled" } })));
    const taps = [o.cancel(r.id), o.cancel(r.id), o.cancel(r.id)];
    await flush();
    answerNow();
    expect(await Promise.all(taps)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(cancels).toBe(1);
    expect(await o.cancel(r.id)).toBeNull();                         // done: not cancellable any more, nothing asked
    expect(cancels).toBe(1);
  });

  it("too late, typed meanwhile: it says it was typed, and Cancel is gone", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    cancelled = () => ({ kind: "too_late", delivery: null });
    expect(await o.cancel(r.id)).toBe("too_late");
    expect(o.records[0]?.delivery).toEqual({ state: "queued", waiting: "typed", why: null });
    expect(o.records[0] && canCancel(o.records[0])).toBe(false);
  });

  it("too late after a deliveries frame already said delivered: that final stands", async () => {
    answer = waiting;
    const o = outbox();
    const r = await o.enqueue(cmd);
    await flush();
    cancelled = async () => {
      await o.deliveries([{ requestId: r.id, state: "delivered", waiting: null, why: null }]);
      return { kind: "too_late", delivery: { state: "queued", waiting: "typed", why: null } };
    };
    expect(await o.cancel(r.id)).toBe("too_late");
    expect(o.records[0]?.delivery).toEqual({ state: "delivered", waiting: null, why: null });
    expect((await store.all())[0]?.delivery).toEqual({ state: "delivered", waiting: null, why: null });
  });

  it("typed already, or a message typed directly: no Cancel, nothing asked of the hub (negative control)", async () => {
    answer = () => ({ kind: "typed", at: T0, delivery: { state: "queued", waiting: "typed", why: null } });
    const o = outbox();
    const typed = await o.enqueue(cmd);
    answer = () => ({ kind: "typed", at: T0 });
    const direct = await o.enqueue({ ...cmd, worker: "pc.aaaaaaaa.1", workerName: "alpha" });
    await flush();
    expect([await o.cancel(typed.id), await o.cancel(direct.id), cancels]).toEqual([null, null, 0]);
  });
});

describe("reading the hub's delivery", () => {
  it("takes what fits, and reads a state it doesn't know as queued", () => {
    expect(commandDelivery({ requestId: "r1", state: "delivered", waiting: null, why: null })).toEqual({ state: "delivered", waiting: null, why: null });
    expect(commandDelivery({ state: "beamed", waiting: 7, why: "expired" })).toEqual({ state: "queued", waiting: null, why: "expired" });
    expect(commandDelivery(undefined)).toBeNull();
    expect(commandDelivery("queued")).toBeNull();
  });
});
