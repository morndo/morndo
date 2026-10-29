// T-532: the disk sync that makes a keyed op's `started` durable runs off the event loop. On a saturated disk a sync
// took over 12 s on the owner's PC while the agent's only thread waited in it, so the fleet's pings went unanswered and
// the node dropped offline. Here the sync is held for 20 s: the agent keeps answering pings, and the op's answer still
// waits until the sync is done (a keyed op is acknowledged only once its record is durable).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, wait, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true }, pingMs: 250 });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  await t.kill();
  home.cleanup();
});

describe("a disk sync off the event loop (T-532)", () => {
  it("keeps answering the fleet's pings while a keyed op's sync takes 20 s, and answers the op only after it", async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let syncs = 0;
    const { agent } = await runAgent(config, { walSync: async () => { syncs += 1; await held; } });
    stops.push(async () => { release(); await agent.stop(); });
    await fleet.waitFor(m => m.t === "ev.inventory");
    const links = fleet.connections();                                                  // the join's socket counts too
    const from = fleet.pongs.length;
    fleet.send({ t: "req", id: "k1", op: "lane.stop", args: { name: "nothing-here" }, timeoutMs: 60_000, key: "hub:k1" });
    await wait(20_000);
    expect(syncs).toBeGreaterThanOrEqual(1);
    expect(fleet.received.some(r => r.msg.t === "res" && r.msg.id === "k1")).toBe(false);   // not durable yet: no answer
    expect(agent.status().inFlight).toContainEqual({ kind: "lane.stop", id: "hub:k1" });  // a stop or an updater waits for it
    const pongs = fleet.pongs.slice(from);
    expect(pongs.length).toBeGreaterThanOrEqual(60);                                    // one ping every 250 ms for 20 s
    const gaps = pongs.slice(1).map((at, i) => at - (pongs[i] ?? at));
    expect(Math.max(...gaps)).toBeLessThan(2000);                                       // the loop never stalled
    expect(fleet.connections()).toBe(links);                                            // no drop, no dial again
    release();
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "k1", 10_000))
      .toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" }, storeSeq: 1 });
  }, 60_000);

  it("answers a keyed op whose sync never ends within the bound, executed no, and keeps the link (T-532)", async () => {
    const { agent } = await runAgent(config, { walSync: () => new Promise<void>(() => {}), walSyncTimeoutMs: 1000 });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    const links = fleet.connections();
    const t0 = Date.now();
    fleet.send({ t: "req", id: "k2", op: "lane.stop", args: { name: "nothing-here" }, timeoutMs: 60_000, key: "hub:k2" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "k2", 10_000)).toMatchObject({ ok: false, error: { code: "internal", executed: "no" } });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(agent.status().inFlight).toEqual([]);                                        // nothing left waiting on the disk
    expect(fleet.connections()).toBe(links);
  }, 60_000);

  it("replays after a welcome only once a sync covers what it sends (T-532)", async () => {
    const adb = openAgentDb(config.dbPath);                                             // a cancelled delivery from an earlier run
    const store = new DeliveryStore(adb.db, Date.now, "pc", async () => {});
    await store.store({ id: "hub:r1", target: { lane: "later", sticky: true }, text: "for later", ttlMs: 3_600_000, boundSession: null });
    store.update("hub:r1", { state: "given_up", why: "cancelled" });
    adb.close();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const { agent } = await runAgent(config, { walSync: () => held });
    stops.push(async () => { release(); await agent.stop(); });
    await fleet.waitFor(m => m.t === "ev.inventory");
    await wait(1500);
    const replayed = () => fleet.received.some(r => r.msg.t === "ev.delivery" && (r.msg.delivery as { id: string }).id === "hub:r1");
    expect(replayed()).toBe(false);                                                     // not before the sync lands
    release();
    await fleet.waitFor(m => m.t === "ev.delivery" && (m.delivery as { id: string }).id === "hub:r1", 10_000);
  }, 60_000);

  it("answers a delivery queued only once its row is synced, while the pings go on (T-532)", async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let holding = false;
    const { agent } = await runAgent(config, { walSync: () => (holding ? held : Promise.resolve()) });
    stops.push(async () => { release(); await agent.stop(); });
    await fleet.waitFor(m => m.t === "ev.inventory");
    holding = true;
    const from = fleet.pongs.length;
    fleet.send({ t: "req", id: "d1", op: "lane.deliver", args: { id: "hub:d1", target: { lane: "later", sticky: true }, text: "for later" }, timeoutMs: 60_000 });
    await wait(3000);
    expect(fleet.received.some(r => r.msg.t === "res" && r.msg.id === "d1")).toBe(false);
    expect(fleet.pongs.length - from).toBeGreaterThanOrEqual(8);                       // one ping every 250 ms
    release();
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "d1", 10_000)).toMatchObject({ ok: true, result: { delivery: { id: "hub:d1", state: "queued" } } });
  }, 60_000);
});
