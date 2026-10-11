// The manager's deliveries (fleet-clients §9.1): each one's row written before the fleet is asked, then followed to its
// end from the fleet's events and by asking (an event sent while the hub wasn't listening isn't replayed), across hub
// restarts; each change heard once, with the row's new state in the same transaction. The switch off cancels what is
// still queued first and follows the rest; and the hub says once, at start, when the fleet's sticky names don't include
// the manager's window (plan.md Review Focus 5). Over the fake fleet on a real Unix socket and a real Store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetClient } from "@morndo/fleet-client";
import type { Delivery } from "@morndo/protocol";
import { Store } from "../src/adapters/store.ts";
import { log } from "../src/adapters/log.ts";
import { fleetDeliveries } from "../src/adapters/fleet-deliveries.ts";
import type { Deliveries } from "../src/application/ports.ts";
import { ManagerQueue, SENDING_DROP_AFTER_MS, type NewDelivery, type QueueChange } from "../src/application/manager-queue.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const T0 = Date.UTC(2026, 9, 8, 9);
let dir: string;
let store: Store;
let fleet: FakeFleet;
let queues: ManagerQueue[] = [];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-manager-queue-"));
  store = new Store(dir);
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "manager", cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))] });
});
afterEach(async () => {
  for (const q of queues.splice(0)) q.stop();
  vi.restoreAllMocks();
  await fleet.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// A queue as main.ts builds one; `heard` collects every change its listeners hear.
function queue(o: { on?: boolean; lane?: string; pollMs?: number } = {}) {
  const q = new ManagerQueue({ store, deliveries: fleetDeliveries(new FleetClient(fleet.socketPath)), lane: o.lane ?? "manager", on: o.on ?? true, now: () => T0, pollMs: o.pollMs ?? 60_000 });
  const heard: QueueChange[] = [];
  q.subscribe(c => { heard.push(c); });
  queues.push(q);
  return { q, heard };
}
const command = (request: string): NewDelivery => ({
  deliveryId: `hub:ep1:${request}`, kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: request, queuedAt: T0,
});
const states = (heard: QueueChange[]) => heard.map(c => c.view.state);

describe("putting a delivery", () => {
  it("writes its row, asks the fleet, and keeps the fleet's state; the same id again queues nothing", async () => {
    const { q } = queue();
    const r = await q.put(command("r1"), "status please");
    expect(r).toMatchObject({ ok: true, row: { deliveryId: "hub:ep1:r1", state: "queued" }, view: { state: "queued", reason: null } });
    expect(fleet.deliveryCalls).toEqual([{ id: "hub:ep1:r1", lane: "manager", workerId: null, text: "status please" }]);
    expect(await q.put(command("r1"), "status please")).toMatchObject({ ok: true });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("waits as long as it is told (a message's 24 hours from when it was written), else the fleet's 24 hours", async () => {
    const { q } = queue();
    await q.put(command("r1"), "now");
    await q.put(command("r2"), "written an hour ago", 23 * 3_600_000);
    const wait = (id: string) => { const d = fleet.deliveries.get(id)?.delivery; return d ? d.notAfter - d.queuedAt : null; };
    expect([wait("hub:ep1:r1"), wait("hub:ep1:r2")]).toEqual([24 * 3_600_000, 23 * 3_600_000]);
  });

  it("a refusal queues nothing and leaves no row", async () => {
    const { q } = queue();
    await q.put(command("r0"), "the fleet now knows the manager's node");
    await fleet.setStatus("pc", "offline");
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "node_offline" });
    expect(store.managerDelivery("hub:ep1:r1")).toBeNull();
  });

  it("an answer lost after the fleet stored it: uncertain, its row kept 'sending'; the same id again finds it, once", async () => {
    const { q } = queue();
    fleet.loseDeliveryAnswers(1);
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "uncertain" });
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("sending");
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true, row: { state: "queued" } });
    expect(fleet.deliveries.size).toBe(1);
  });

  it("an answer lost, but the fleet's event said it is queued: it is", async () => {
    const { q } = queue();
    await q.start();
    fleet.loseDeliveryAnswers(1);
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true, row: { state: "queued" }, view: { state: "queued" } });
  });

  it("a repeat of an attempt still sending is uncertain when the fleet can't be reached, and the row stays", async () => {
    const { q } = queue();
    fleet.loseDeliveryAnswers(1);
    await q.put(command("r1"), "x");
    await fleet.close();                                                    // the repeat never reaches the fleet
    expect(await q.put(command("r1"), "x")).toEqual({ ok: false, problem: "uncertain" });
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("sending");
    fleet = await startFakeFleet({ nodes: [] });                             // for afterEach
  });
});

describe("following deliveries", () => {
  it("hears each change once, from the fleet's events, and keeps the row's state", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    fleet.moveDelivery("hub:ep1:r1", { waiting: { reason: "menu_open", since: T0 } });
    await until(() => heard.some(c => c.view.reason === "menu_open"));
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    // The fleet's event of its queueing may come before the answer to put(): heard as any change.
    expect(heard.map(c => [c.view.state, c.view.reason]).filter(([s, r]) => s !== "queued" || r !== null))
      .toEqual([["queued", "menu_open"], ["typed", null], ["delivered", null]]);
    expect(heard.at(-1)?.view.at).toBe(T0 + 9);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
    const count = heard.length;
    await q.poll();                                                          // asked again: nothing new to hear
    expect(heard).toHaveLength(count);
  });

  it("a sending row the fleet never stored is dropped when asked, so it does not stay in doubt", async () => {
    const { q } = queue();
    await q.start();
    // Older than the fleet's wait for the node, plus slack, and the manager's node is online: a 404 now means the node never stored it.
    store.saveManagerDelivery({ ...command("r1"), state: "sending", updatedAt: T0 - SENDING_DROP_AFTER_MS - 1 });
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r1")).toBeNull();
  });

  it("a poll while put() is still waiting does not drop the row, and the later delivered event is applied", async () => {
    let now = T0;
    const id = "hub:ep1:race";
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const listeners: ((d: Delivery) => void)[] = [];
    const queued: Delivery = { id, node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: T0, notAfter: T0 + 86_400_000 };
    const delivered: Delivery = { ...queued, state: "delivered", deliveredAt: T0 + 9 };
    const deliveries: Deliveries = {
      async deliver() { await gate; return { ok: true, delivery: queued }; },
      async get() { return null; },
      async cancel() { return { ok: false, unknown: true }; },
      subscribe(on) { listeners.push(on); return () => { listeners.length = 0; }; },
      async stickyLanes() { return ["manager"]; },
      async laneNodeOnline() { return true; },
    };
    const q = new ManagerQueue({ store, deliveries, lane: "manager", on: true, now: () => now, pollMs: 60_000 });
    const heard: QueueChange[] = [];
    q.subscribe(c => { heard.push(c); });
    queues.push(q);
    await q.start();
    const putting = q.put({ ...command("race"), deliveryId: id }, "status please");
    await until(() => store.managerDelivery(id)?.state === "sending");
    now = T0 + 60_000;                                                 // past the client's delivery timeout, and put() is still waiting
    await q.poll();
    const kept = store.managerDelivery(id)?.state;
    release();
    const result = await putting;
    expect(kept).toBe("sending");
    expect(result).toMatchObject({ ok: true, row: { deliveryId: id, state: "queued" } });
    expect(store.managerDelivery(id)).not.toBeNull();
    for (const hear of listeners) hear(delivered);
    expect(store.managerDelivery(id)?.state).toBe("delivered");
    expect(heard.some(c => c.row.deliveryId === id && c.view.state === "delivered")).toBe(true);
  });

  it("a put the client gives up on at 7s is kept by a poll at 10s, and the later delivery event is applied", async () => {
    let now = T0;
    const id = "hub:ep1:slow";
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const listeners: ((d: Delivery) => void)[] = [];
    const delivered: Delivery = { id, node: "pc", target: { lane: "manager" }, state: "delivered", queuedAt: T0, notAfter: T0 + 86_400_000, deliveredAt: T0 + 12_000 };
    const deliveries: Deliveries = {
      async deliver() { await gate; return { ok: false, inDoubt: true }; },
      async get() { return null; },
      async cancel() { return { ok: false, unknown: true }; },
      subscribe(on) { listeners.push(on); return () => { listeners.length = 0; }; },
      async stickyLanes() { return ["manager"]; },
      async laneNodeOnline() { return true; },
    };
    const q = new ManagerQueue({ store, deliveries, lane: "manager", on: true, now: () => now, pollMs: 60_000 });
    const heard: QueueChange[] = [];
    q.subscribe(c => { heard.push(c); });
    queues.push(q);
    await q.start();
    const putting = q.put({ ...command("slow"), deliveryId: id }, "status please");
    await until(() => store.managerDelivery(id)?.state === "sending");
    now = T0 + 7_000;                                                  // the client gives up here: put() leaves the in-flight set
    release();
    expect(await putting).toEqual({ ok: false, problem: "uncertain" });
    expect(store.managerDelivery(id)?.state).toBe("sending");
    now = T0 + 10_000;                                                 // the node is still answering; the fleet has no mirror yet
    await q.poll();
    expect(store.managerDelivery(id)?.state).toBe("sending");
    for (const hear of listeners) hear(delivered);
    expect(store.managerDelivery(id)?.state).toBe("delivered");
    expect(heard.some(c => c.row.deliveryId === id && c.view.state === "delivered")).toBe(true);
  });

  // The app gives up on a POST after its attempt timeout and sends it again under the same request
  // id, so a second put() of one delivery may start while the first still waits on the fleet. The first one's answer
  // (in doubt, or refused) must not leave the row unguarded: neither its own refusal nor a poll may drop it while the
  // second put() waits, and the second answer is followed.
  it.each([
    { first: { ok: false, inDoubt: true } as const, says: { ok: false, problem: "uncertain" } },
    { first: { ok: false, refused: "node_offline" } as const, says: { ok: false, problem: "node_offline" } },
  ])("a put sent again while the first still waits keeps its row through the first answer ($says.problem) and a poll", async ({ first, says }) => {
    let now = T0;
    const id = "hub:ep1:again";
    const gates: (() => void)[] = [];
    const mirrored = new Map<string, Delivery>();
    let calls = 0;
    const deliveries: Deliveries = {
      async deliver(d) {
        const n = ++calls;
        await new Promise<void>(r => { gates[n] = r; });
        if (n === 1) return first;                                                 // the first: the fleet's wait passed
        const x: Delivery = { id: d.id, node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: now, notAfter: now + 86_400_000 };
        mirrored.set(d.id, x);                                                     // the second: the node stored it
        return { ok: true, delivery: x };
      },
      async get(i) { return mirrored.get(i) ?? null; },
      async cancel() { return { ok: false, unknown: true }; },
      subscribe() { return () => {}; },
      async stickyLanes() { return ["manager"]; },
      async laneNodeOnline() { return true; },
    };
    const q = new ManagerQueue({ store, deliveries, lane: "manager", on: true, now: () => now, pollMs: 60_000 });
    queues.push(q);
    await q.start();
    const putting = q.put({ ...command("again"), deliveryId: id }, "status please");
    await until(() => calls === 1);
    now = T0 + 15_000;                                                             // the app sends it again
    const again = q.put({ ...command("again"), deliveryId: id }, "status please");
    await until(() => calls === 2);
    gates[1]?.();
    expect(await putting).toEqual(says);
    expect(store.managerDelivery(id)?.state).toBe("sending");
    now = T0 + SENDING_DROP_AFTER_MS + 1_000;                                      // old enough to drop, but still in flight
    await q.poll();
    expect(store.managerDelivery(id)?.state).toBe("sending");
    gates[2]?.();
    expect(await again).toMatchObject({ ok: true, row: { deliveryId: id, state: "queued" }, view: { state: "queued" } });
    expect(store.managerDelivery(id)?.state).toBe("queued");
  });

  it("a 404 keeps a sending row that is still young, or whose node is offline", async () => {
    const { q } = queue();
    await q.start();
    store.saveManagerDelivery({ ...command("r-young"), state: "sending", updatedAt: T0 });
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r-young")?.state).toBe("sending");
    store.saveManagerDelivery({ ...command("r-away"), state: "sending", updatedAt: T0 - SENDING_DROP_AFTER_MS - 1 });
    await fleet.setStatus("pc", "offline");
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r-away")?.state).toBe("sending");
  });

  it("an event missed (sent while the hub wasn't listening) is found by asking", async () => {
    const { q, heard } = queue({ pollMs: 50 });
    await q.start();
    await q.put(command("r1"), "x");
    fleet.quietDeliveries(true);
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    expect(heard.at(-1)?.view).toMatchObject({ state: "delivered", at: T0 + 9 });
  });

  // Review (fleet-clients branch) #5: one delivery whose body the client can't read (a mismatch, not the fleet gone) must
  // not stop the round: the rows after it are still asked about.
  it("a delivery the fleet answers in a shape the hub can't read doesn't stop the round: the rows after it are followed", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    await q.put(command("r2"), "y");
    fleet.quietDeliveries(true);
    fleet.moveDelivery("hub:ep1:r1", { notAfter: "soon" as unknown as number });     // the fleet's body for r1 no longer reads
    fleet.moveDelivery("hub:ep1:r2", { state: "delivered", deliveredAt: T0 + 9 });
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r2")?.state).toBe("delivered");
    expect(heard.filter(c => c.row.deliveryId === "hub:ep1:r2").at(-1)?.view.state).toBe("delivered");   // heard, as the poll found it
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("queued");                   // r1 stays as it was, asked again next round
  });

  it("an older word never moves a delivery back (negative control)", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => heard.some(c => c.view.state === "delivered"));
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 });  // a stale event, after the final one
    await new Promise(r => setTimeout(r, 100));
    expect(states(heard).filter(s => s !== "queued")).toEqual(["delivered"]);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
  });

  it("a held delivery's one retype is shown as typed", async () => {
    const { q, heard } = queue();
    await q.start();
    await q.put(command("r1"), "x");
    fleet.moveDelivery("hub:ep1:r1", { state: "held" });
    await until(() => heard.some(c => c.view.state === "held"));
    fleet.moveDelivery("hub:ep1:r1", { state: "typed", typedAt: T0 + 5 }); // the node's one retype after an interrupt
    await new Promise(r => setTimeout(r, 100));
    expect(states(heard).filter(s => s !== "queued")).toEqual(["held", "typed"]);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("typed");
    expect(q.view("hub:ep1:r1")?.state).toBe("typed");
  });

  it("a listener that fails leaves the row as it was, and the next round hears it again", async () => {
    const { q } = queue();
    let fail = true;
    const heard: string[] = [];
    q.subscribe(c => { if (fail) throw new Error("the board's store is busy"); heard.push(c.view.state); });
    vi.spyOn(log, "error").mockImplementation(() => {});
    await q.put(command("r1"), "x");
    fleet.quietDeliveries(true);
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    await q.poll();
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("queued");
    fail = false;
    await q.poll();
    expect(heard).toEqual(["delivered"]);
    expect(store.managerDelivery("hub:ep1:r1")?.state).toBe("delivered");
  });

  it("a hub restart follows what it had queued: a change made while it was down is heard at start", async () => {
    const first = queue();
    await first.q.put(command("r1"), "x");
    first.q.stop();
    fleet.moveDelivery("hub:ep1:r1", { state: "delivered", deliveredAt: T0 + 9 });
    const second = queue();
    await second.q.start();
    expect(states(second.heard)).toEqual(["delivered"]);
    expect(second.q.view("hub:ep1:r1")).toMatchObject({ state: "delivered" });
  });
});

describe("an answer's id", () => {
  const answer = (id: string): NewDelivery => ({ ...command("r9"), deliveryId: id, kind: "answer", escalationId: "ny-7" });
  it("is its key; again after a given-up one, the key with ~2, ~3; never a new one while one may be queued", async () => {
    const { q } = queue();
    const key = "answer:ny-7:m1:option:ship";
    expect(q.idFor(key)).toBe(`hub:${key}`);
    await q.put(answer(`hub:${key}`), "[tap ny-7] ship (Ship it)");
    expect(q.idFor(key)).toBe(`hub:${key}`);
    fleet.moveDelivery(`hub:${key}`, { state: "given_up", why: "expired" });
    await q.poll();
    expect(q.idFor(key)).toBe(`hub:${key}~2`);
    await q.put(answer(`hub:${key}~2`), "[tap ny-7] ship (Ship it)");
    fleet.moveDelivery(`hub:${key}~2`, { state: "given_up", why: "expired" });
    await q.poll();
    expect(q.idFor(key)).toBe(`hub:${key}~3`);
  });

  // Review (fleet-clients branch) #12: the last attempt is the one with the highest number, whatever the clock said:
  // ordered by queued_at and then by id as text, "~10" sorts before "~2" when their times are equal (or a clock stepped
  // back), and a new id would be taken while "~10" may still be queued.
  it("the last attempt is the highest-numbered one: never a new id while \"~10\" may be queued, though \"~9\" was given up", () => {
    const { q } = queue();
    const key = "answer:ny-7:m1:option:ship";
    const base = `hub:${key}`;
    const row = (id: string, state: "given_up" | "queued", queuedAt: number) =>
      store.saveManagerDelivery({ ...answer(id), queuedAt, state, updatedAt: T0 });
    row(base, "given_up", T0);
    for (let n = 2; n <= 9; n++) row(`${base}~${n}`, "given_up", T0);
    row(`${base}~10`, "queued", T0);                                        // the same millisecond as the others
    expect(q.idFor(key)).toBe(`${base}~10`);
    expect(store.answerDelivery("ny-7", T0)?.deliveryId).toBe(`${base}~10`); // the answer's latest attempt, as the card reads it
    store.setManagerDeliveryState(`${base}~10`, "given_up", T0);
    expect(q.idFor(key)).toBe(`${base}~11`);
    row(`${base}~11`, "queued", T0 - 60_000);                              // a clock stepped back a minute
    expect(q.idFor(key)).toBe(`${base}~11`);
  });

  it("after the oldest given-up attempt is pruned, the next id is past the one that remains", async () => {
    const { q } = queue();
    const key = "answer:ny-7:m1:option:hold";
    const base = `hub:${key}`;
    const day = 24 * 3_600_000;
    await q.put(answer(base), "[tap ny-7] hold (Hold)");
    fleet.moveDelivery(base, { state: "given_up", why: "expired" });
    await q.put(answer(`${base}~2`), "[tap ny-7] hold (Hold)");
    fleet.moveDelivery(`${base}~2`, { state: "given_up", why: "expired" });
    await q.poll();
    store.setManagerDeliveryState(base, "given_up", T0 - 8 * day);          // day 1, gone at a restart on day 8.5
    store.setManagerDeliveryState(`${base}~2`, "given_up", T0 - 2 * day);   // day 6, still inside the 7 days
    const later = queue();
    await later.q.start();
    expect(store.managerDelivery(base)).toBeNull();
    expect(store.managerDelivery(`${base}~2`)?.state).toBe("given_up");
    expect(later.q.idFor(key)).toBe(`${base}~3`);
  });
});

describe("cancelling one (the principal's cancel of a waiting message, ruling 83; a withdrawn answer)", () => {
  it("withdraws one still queued: given up, cancelled; one typed already goes on; one the fleet never had is unknown", async () => {
    const { q, heard } = queue();
    await q.put(command("r1"), "one");
    await q.put(command("r2"), "two");
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: T0 + 5 });
    expect(await q.cancel("hub:ep1:r1")).toMatchObject({ ok: true, view: { state: "given_up", reason: null, why: "cancelled" } });
    expect(heard.map(c => [c.row.deliveryId, c.view.state])).toContainEqual(["hub:ep1:r1", "given_up"]);
    expect(await q.cancel("hub:ep1:r2")).toEqual({ ok: false, problem: "already_typed" });
    expect(fleet.deliveries.get("hub:ep1:r2")?.delivery.state).toBe("typed");
    expect(await q.cancel("hub:ep1:r9")).toEqual({ ok: false, problem: "unknown" });
  });
});

describe("the switch off (spec §9.1; step 2's rollback, §13)", () => {
  // Review (fleet-clients branch) #8: the hub serves only once these cancels are answered (none may be typed after it
  // types directly), and each may wait as long as the fleet waits for its node: one after another, N of them would hold
  // the start N times as long.
  it("cancels every delivery still queued at once: a fleet slow to answer holds the start for one answer, not one per delivery", async () => {
    const on = queue();
    for (const r of ["r1", "r2", "r3"]) await on.q.put(command(r), r);
    on.q.stop();
    fleet.delayCancels(700);
    const off = queue({ on: false });
    const t0 = Date.now();
    await off.q.start();
    expect(Date.now() - t0).toBeLessThan(1400);                              // one after another: 2100 ms and more
    expect([...fleet.cancels].sort()).toEqual(["hub:ep1:r1", "hub:ep1:r2", "hub:ep1:r3"]);
    expect(["r1", "r2", "r3"].map(r => fleet.deliveries.get(`hub:ep1:${r}`)?.delivery.state)).toEqual(["given_up", "given_up", "given_up"]);
  });

  it("cancels what is still queued, first, and follows what was typed already to its end", async () => {
    const on = queue();
    await on.q.put(command("r1"), "one");
    await on.q.put(command("r2"), "two");
    fleet.moveDelivery("hub:ep1:r2", { state: "typed", typedAt: T0 + 5 });
    on.q.stop();
    const off = queue({ on: false });
    await off.q.start();
    // Both rows still said queued (the typing happened while no hub listened): the one typed is refused already_typed.
    expect([...fleet.cancels].sort()).toEqual(["hub:ep1:r1", "hub:ep1:r2"]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery).toMatchObject({ state: "given_up", why: "cancelled" });
    expect(fleet.deliveries.get("hub:ep1:r2")?.delivery).toMatchObject({ state: "typed" });
    expect(off.heard.map(c => [c.row.deliveryId, c.view.state])).toEqual(expect.arrayContaining([["hub:ep1:r1", "given_up"], ["hub:ep1:r2", "typed"]]));
    fleet.moveDelivery("hub:ep1:r2", { state: "delivered", deliveredAt: T0 + 9 });
    await until(() => off.heard.some(c => c.row.deliveryId === "hub:ep1:r2" && c.view.state === "delivered"));
  });

  it("a row still 'sending' whose delivery the fleet never had is dropped (its cancel is 404, ruling 56)", async () => {
    store.saveManagerDelivery({ ...command("r9"), state: "sending", updatedAt: T0 });
    await queue({ on: false }).q.start();
    expect(fleet.cancels).toEqual(["hub:ep1:r9"]);
    expect(store.managerDelivery("hub:ep1:r9")).toBeNull();
  });

  it("on, nothing is cancelled at start (negative control)", async () => {
    const first = queue();
    await first.q.put(command("r1"), "one");
    first.q.stop();
    await queue({ on: true }).q.start();
    expect(fleet.cancels).toEqual([]);
  });
});

describe("the manager's window and the fleet's sticky names (Review Focus 5)", () => {
  const warnings = () => {
    const said: string[] = [];
    vi.spyOn(log, "warn").mockImplementation(m => { said.push(m); });
    return said;
  };
  it("a window the fleet doesn't keep sticky is said once at start, and still delivered", async () => {
    await fleet.close();
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: "boss", cwd: "/w/m", screen: "❯ " } }))], stickyLanes: ["manager"] });
    const said = warnings();
    const { q } = queue({ lane: "boss" });
    await q.start();
    await q.poll();
    expect(said.filter(m => m.includes("stickyLanes"))).toHaveLength(1);
    expect(said[0]).toContain('"boss"');
    expect(await q.put(command("r1"), "x")).toMatchObject({ ok: true });
  });
  it("a sticky window, or a fleet that can't be asked, says nothing (negative control)", async () => {
    const said = warnings();
    await queue().q.start();
    expect(said.filter(m => m.includes("stickyLanes"))).toEqual([]);
  });
});
