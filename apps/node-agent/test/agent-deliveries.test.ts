// The agent's deliveries over its connection (fleet clients spec §4.4), against the scripted fake fleet: every change of
// a delivery as ev.delivery, and after every (re)connect the state of each delivery not final plus the final ones of the
// still kept (7 days). The deliveries are put in agent.db before the agent starts, as a restart finds them. And a hook arriving at
// the relay kicks the deliverer (RECONCILIATION.md ruling 60).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Delivery } from "@morndo/protocol";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { DeliveryStore } from "../src/deliveries/store.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
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
const deliveries = (from = 0) => fleet.received.slice(from).filter(r => r.msg.t === "ev.delivery").map(r => r.msg.delivery as Delivery);

describe("ev.delivery (spec §4.4)", () => {
  it("sends each change, and after every welcome the open deliveries and the finals still kept", async () => {
    const T = Date.now();
    const adb = openAgentDb(config.dbPath);
    const clock = { now: T - 2 * 3_600_000 };
    const store = new DeliveryStore(adb.db, () => clock.now, "pc");
    const api = { lane: "api", sticky: false } as const;
    store.store({ id: "hub:old", target: api, text: "old", ttlMs: 60_000, boundSession: null });
    store.update("hub:old", { state: "given_up", why: "expired" });                 // final two hours ago
    clock.now = T - 30 * 60_000;
    store.store({ id: "hub:recent", target: api, text: "recent", ttlMs: 60_000, boundSession: null });
    store.update("hub:recent", { state: "delivered", deliveredAt: clock.now });      // final half an hour ago
    clock.now = T;
    store.store({ id: "hub:open", target: { lane: "manager", sticky: true }, text: "for the manager", ttlMs: 86_400_000, boundSession: null });
    adb.close();
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    // The change its first round makes: no manager window, so it waits there (no_pane).
    expect(await until(() => deliveries().some(d => d.id === "hub:open" && d.waiting?.reason === "no_pane"))).toBe(true);
    expect(await until(() => deliveries().some(d => d.id === "hub:recent"))).toBe(true);
    // A final from before the last hour still has to reach the mirror: an outage longer than an hour otherwise leaves it typed there.
    expect(await until(() => deliveries().some(d => d.id === "hub:old"))).toBe(true);
    expect(deliveries().find(d => d.id === "hub:old")).toMatchObject({ state: "given_up" });
    const cut = fleet.received.length;
    fleet.closeAgent(1011, "fleet restart");
    expect(await until(() => ["hub:open", "hub:recent", "hub:old"].every(id => deliveries(cut).some(d => d.id === id)))).toBe(true);
    expect(deliveries(cut).find(d => d.id === "hub:open")).toMatchObject({ node: "pc", state: "queued", waiting: { reason: "no_pane" }, target: { lane: "manager" } });
    expect(deliveries(cut).find(d => d.id === "hub:recent")).toMatchObject({ state: "delivered" });
    expect(deliveries(cut).find(d => d.id === "hub:old")).toMatchObject({ state: "given_up" });
    expect(fleet.malformed).toEqual([]);
  });

  it("kicks the deliverer when a hook arrives, so a receipt or a lane's change is acted on at once (ruling 60)", async () => {
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    const reasons: string[] = [];
    const kick = agent.deliverer.kick.bind(agent.deliverer);
    agent.deliverer.kick = reason => { reasons.push(reason); kick(reason); };
    expect((await post("/hook/stop", { session_id: "3c4d5e6f-0000-4000-8000-000000000001" })).status).toBe(200);
    expect(await until(() => reasons.includes("hook"))).toBe(true);
  });
});
