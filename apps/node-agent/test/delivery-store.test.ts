// The delivery store (fleet clients spec §4.1–4.3; plan Contracts, "Agent internals shared by Tasks 4 to 6" and Databases:
// agent.db migration 7) on a real agent database:
// - storing is synced to the disk, and nothing after it is;
// - a deadline arrives as a duration and becomes notAfter on this node's clock (plan Review Focus 3);
// - the same id is the same delivery, or an id_conflict;
// - a target's open deliveries come in the order stored;
// - a final delivery is never changed, and final ones are pruned after 7 days.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, type DeliveryTarget } from "@morndo/protocol";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { tempHome } from "./helpers.ts";

const T0 = Date.parse("2026-10-08T05:00:00.000Z");
const S1 = "1a2b3c4d-0000-4000-8000-000000000001";
const S2 = "1a2b3c4d-0000-4000-8000-000000000002";
const W = "pc.0a1b2c3d.4";
const MANAGER: DeliveryTarget = { lane: "manager", sticky: true };

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function storeOn(start = T0) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  const clock = { now: start };
  return { store: new DeliveryStore(adb.db, () => clock.now, "pc"), adb, clock };
}
type Put = { target?: DeliveryTarget; text?: string; ttlMs?: number; boundSession?: string | null };
const put = (s: DeliveryStore, id: string, o: Put = {}) =>
  s.store({ id, target: o.target ?? MANAGER, text: o.text ?? `text of ${id}`, ttlMs: o.ttlMs ?? LIMITS.deliveryTtlMs, boundSession: o.boundSession ?? null });
// The answer of a fresh store; a conflict fails the test here.
const fresh = (r: ReturnType<typeof put>) => { if ("conflict" in r) throw new Error("an id conflict"); return r; };
const rows = (adb: AgentDb) => (adb.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n;
// What the store asks of the database: each change of the synchronous setting and each write, in order.
function watch(adb: AgentDb): string[] {
  const seen: string[] = [];
  const pragma = adb.db.pragma.bind(adb.db);
  adb.db.pragma = ((source: string, options?: { simple?: boolean }) => {
    if (/^synchronous\s*=/.test(source)) seen.push(source);
    return pragma(source, options as never);
  }) as typeof adb.db.pragma;
  const prepare = adb.db.prepare.bind(adb.db);
  adb.db.prepare = ((source: string) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(source)) seen.push(source.trim().split(/\s+/).slice(0, 3).join(" "));
    return prepare(source);
  }) as typeof adb.db.prepare;
  return seen;
}

describe("storing", () => {
  it("stores a delivery queued, with notAfter on this node's clock: the time it was stored plus the duration sent (Review Focus 3)", () => {
    const { store } = storeOn();
    const r = fresh(put(store, "hub:a", { ttlMs: 90_000 }));
    expect(r).toEqual({ fresh: true, delivery: { id: "hub:a", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: T0, notAfter: T0 + 90_000 } });
    expect(store.get("hub:a")).toEqual(r.delivery);
    expect(store.textOf("hub:a")).toBe("text of hub:a");
    expect(store.detail("hub:a")).toEqual({ target: { lane: "manager", sticky: true }, boundSession: null, retyped: false });
    // A node whose clock runs 1.1 s behind the sender's (the owner's PC): the deadline is the node's own time plus the
    // duration, so the delivery has all of it.
    const behind = storeOn(T0 - 1100).store;
    expect(fresh(put(behind, "hub:b", { ttlMs: 90_000 })).delivery).toMatchObject({ queuedAt: T0 - 1100, notAfter: T0 - 1100 + 90_000 });
    expect(store.get("hub:none")).toBeNull();
    expect(store.textOf("hub:none")).toBeNull();
    expect(store.detail("hub:none")).toBeNull();
  });

  it("answers the same id with the same target and text with that delivery as it is now, and stores nothing again", () => {
    const { store, adb, clock } = storeOn();
    put(store, "hub:a", { text: "x" });
    store.update("hub:a", { state: "typed", typedAt: T0 + 5, sessionId: S1 });
    clock.now = T0 + 60_000;
    expect(put(store, "hub:a", { text: "x", ttlMs: 1 }))
      .toEqual({ fresh: false, delivery: expect.objectContaining({ state: "typed", queuedAt: T0, notAfter: T0 + LIMITS.deliveryTtlMs, sessionId: S1 }) });
    // Whether a name is sticky is the fleet's judgement when it routes, not the delivery's content.
    expect(put(store, "hub:a", { text: "x", target: { lane: "manager", sticky: false } })).toMatchObject({ fresh: false });
    expect(rows(adb)).toBe(1);
  });

  it("refuses the same id with another text or target as a conflict, and keeps the first as it was (negative control: an id conflict accepted)", () => {
    const { store } = storeOn();
    put(store, "hub:a", { text: "x" });
    const others: Put[] = [{ text: "y" }, { text: "x", target: { lane: "api", sticky: false } }, { text: "x", target: { workerId: W } }];
    for (const other of others) expect(put(store, "hub:a", other), JSON.stringify(other)).toEqual({ conflict: true });
    expect(store.textOf("hub:a")).toBe("x");
    expect(store.get("hub:a")?.target).toEqual({ lane: "manager" });
  });

  it("commits a new delivery synced to the disk (FULL for that transaction only), and a repeat or a later change without a sync", () => {
    const { store, adb } = storeOn();
    const seen = watch(adb);
    put(store, "hub:a");
    expect(seen.splice(0)).toEqual(["synchronous = FULL", "INSERT INTO deliveries", "synchronous = NORMAL"]);
    put(store, "hub:a");
    expect(seen.splice(0)).toEqual(["synchronous = FULL", "synchronous = NORMAL"]);
    store.update("hub:a", { waiting: { reason: "menu_open", since: T0 } });
    expect(seen.splice(0)).toEqual(["UPDATE deliveries SET"]);
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);   // NORMAL again
  });

  it("stores nothing when the disk refuses, and throws: the sender is told, never a silent loss", () => {
    const { store, adb } = storeOn();
    adb.db.exec("CREATE TRIGGER no_room BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => put(store, "hub:a")).toThrow(/disk full/);
    expect(store.get("hub:a")).toBeNull();
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);
  });
});

describe("reading", () => {
  it("finds a target's head, the oldest open one, in the order stored even within one millisecond; open() and recentFinal() likewise", () => {
    const { store, clock } = storeOn();
    for (const id of ["hub:z", "hub:m", "hub:a"]) put(store, id);                       // one millisecond, ids out of order
    put(store, "hub:w", { target: { workerId: W } });
    put(store, "hub:b", { target: { lane: "api", sticky: false }, boundSession: S1 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:z");
    store.update("hub:z", { state: "typed", typedAt: T0, sessionId: S1 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:z");                         // typed is not final: still the head
    clock.now = T0 + 10;
    store.update("hub:z", { state: "delivered", deliveredAt: T0 + 10 });
    expect(store.head({ lane: "manager" })?.id).toBe("hub:m");
    expect(store.head({ workerId: W })?.id).toBe("hub:w");
    expect(store.head({ lane: "nowhere" })).toBeNull();
    expect(store.open().map(d => d.id)).toEqual(["hub:m", "hub:a", "hub:w", "hub:b"]);
    clock.now = T0 + 20;
    store.update("hub:b", { state: "given_up", why: "gone" });
    expect(store.recentFinal(T0 + 15).map(d => d.id)).toEqual(["hub:b"]);
    expect(store.recentFinal(T0).map(d => d.id)).toEqual(["hub:z", "hub:b"]);
  });
});

describe("changing", () => {
  it("keeps a reason while queued and drops it once typed; sessionId binds a queued name and records where a typed one went; the retype is kept", () => {
    const { store } = storeOn();
    put(store, "hub:a", { target: { lane: "api", sticky: false }, boundSession: S1 });
    expect(store.get("hub:a")).toMatchObject({ sessionId: S1 });
    expect(store.update("hub:a", { waiting: { reason: "menu_open", since: T0 + 1 } }).waiting).toEqual({ reason: "menu_open", since: T0 + 1 });
    const typed = store.update("hub:a", { state: "typed", typedAt: T0 + 2, sessionId: S2 });
    expect(typed).toMatchObject({ state: "typed", typedAt: T0 + 2, sessionId: S2 });
    expect(typed).not.toHaveProperty("waiting");
    expect(store.detail("hub:a")).toMatchObject({ boundSession: S1, retyped: false });
    store.update("hub:a", { retyped: true });
    expect(store.detail("hub:a")?.retyped).toBe(true);
    put(store, "hub:late", { target: { lane: "api", sticky: false } });                 // queued while its lane was starting
    store.update("hub:late", { sessionId: S1 });
    expect(store.detail("hub:late")?.boundSession).toBe(S1);
    expect(() => store.update("hub:none", { state: "typed" })).toThrow(/no delivery hub:none/);
  });

  it("never changes a final delivery", () => {
    const { store } = storeOn();
    put(store, "hub:a");
    const done = store.update("hub:a", { state: "delivered", deliveredAt: T0 + 3 });
    expect(store.update("hub:a", { state: "typed", note: "again" })).toEqual(done);
    expect(store.get("hub:a")).toEqual(done);
  });

  it("prunes final deliveries 7 days after their last change, never an open one", () => {
    const { store, clock } = storeOn();
    for (const id of ["hub:old", "hub:newer", "hub:open"]) put(store, id, { target: { lane: id, sticky: true } });
    store.update("hub:old", { state: "delivered", deliveredAt: T0 });
    clock.now = T0 + 3_600_000;
    store.update("hub:newer", { state: "given_up", why: "expired" });
    clock.now = T0 + LIMITS.deliveryKeepMs + 1;
    expect(store.prune()).toBe(1);
    expect(store.get("hub:old")).toBeNull();
    expect(store.get("hub:newer")?.state).toBe("given_up");
    expect(store.get("hub:open")?.state).toBe("queued");
  });
});

// #64 (agent.db migration 8): the draft stashed so a delivery could go in is kept with it, across a reopen, and through
// its later changes.
describe("a stashed draft", () => {
  it("is kept with its delivery and comes back with it", () => {
    const h = tempHome();
    const path = join(h.home, "agent.db");
    let adb = openAgentDb(path);
    const stashed = { at: T0 + 3_600_000, since: T0, chars: 9, copy: "/data/drafts/1-manager.txt" };
    try {
      const s = new DeliveryStore(adb.db, () => T0, "pc");
      put(s, "lanes:x");
      expect(s.get("lanes:x")?.stashed).toBeUndefined();
      s.update("lanes:x", { stashed });
      s.update("lanes:x", { state: "typed", typedAt: T0 + 3_600_001, sessionId: S1 });
      adb.close();
      adb = openAgentDb(path);
      expect(new DeliveryStore(adb.db, () => T0, "pc").get("lanes:x")).toMatchObject({ state: "typed", stashed });
    } finally { adb.close(); h.cleanup(); }
  });
});
