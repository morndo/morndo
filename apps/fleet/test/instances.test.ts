// The instance rules (spec 5.2): one live instance per node. The same instanceId replaces its older connection; a
// different one while the old is live makes the fleet ping the old one: a pong refuses the newcomer with 4409 and one
// alert, no pong within 3 s (LIMITS.instancePongMs) lets it in and terminates the old one (a half-open socket or a hung
// agent can't lock its node out), and the wait never holds another node. A different one is accepted at once once the
// old closed or missed its sweep pong. The flap test (spec 9): two instances with one key for 5 minutes. The ping
// interval runs on fake timers (setInterval only); sockets, the instance check and everything else run for real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS } from "@morndo/protocol";
import type { FleetEvent } from "../src/application/events.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { until } from "./helpers/until.ts";

afterEach(() => { vi.useRealTimers(); });
const settle = () => new Promise(r => setTimeout(r, 5));       // real time for the sockets between fake ticks
const statuses = (events: FleetEvent[], node: string) => events.filter(e => e.t === "status" && e.node === node).map(e => (e.body as { status: string }).status);

describe("one live instance per node", () => {
  it("the same instance reconnecting replaces its older connection, with the next epoch and no alert", async () => {
    const fleet = await startTestFleet();
    const first = await fleet.online("pc");
    const again = fleet.agent({ node: "pc", key: first.key, instanceId: first.instanceId, streamId: first.streamId });
    const r = await again.connect();
    expect(r).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect((await first.closed).code).toBe(1000);
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: first.instanceId, epoch: 2 });
    expect(fleet.connections.status("pc")).toBe("online");
    expect(fleet.audit.alerts(0)).toEqual([]);
  });

  it("a different instance while one is live is refused with 4409 and one alert (also an event); the live one keeps serving", async () => {
    const fleet = await startTestFleet();
    const alerts: FleetEvent[] = [];
    fleet.events.subscribe(e => { if (e.t === "alert") alerts.push(e); });
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });          // a cloned VM: the same key, its own instance
    const started = performance.now();
    expect(await b.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.conflict } });
    expect(performance.now() - started).toBeLessThan(LIMITS.instancePongMs);   // a answered the check's ping: no 3 s wait
    expect(await b.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.conflict } });
    expect(fleet.audit.of("alert.instance_conflict")).toHaveLength(1);
    expect(fleet.audit.of("alert.instance_conflict")[0]?.detail).toEqual({ live: a.instanceId, refused: b.instanceId, source: "127.0.0.1" });
    expect(alerts).toEqual([{ t: "alert", node: "pc", body: fleet.audit.recentAlerts()[0] }]);
    expect(alerts[0]?.body).toMatchObject({ node: "pc", kind: "instance_conflict", detail: { live: a.instanceId, refused: b.instanceId } });
    expect(a.open).toBe(true);
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true });
  });

  it("an old connection that misses the instance check's ping (half-open) gives way: the new instance is in within about 3 s", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // the old process hung, or its socket is half-open
    const b = fleet.agent({ node: "pc", key: a.key });
    const started = performance.now();
    expect(await b.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });   // negative control: without the check, 4409
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(LIMITS.instancePongMs - 50);
    expect(waited).toBeLessThan(LIMITS.instancePongMs + 1500);
    expect((await a.closed).code).toBe(1006);                                        // terminated, not closed politely
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: b.instanceId, epoch: 2 });
    expect(fleet.audit.of("alert.instance_conflict")).toEqual([]);
    expect(fleet.audit.of("conn.replaced").map(e => e.detail)).toEqual([{ old: a.instanceId, new: b.instanceId, source: "127.0.0.1" }]);
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true, store: b.streamId });
  });

  it("a node revoked while its newcomer waits for the instance check is refused with 4403, never welcomed or admitted", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // the old connection never answers the check
    const b = fleet.agent({ node: "pc", key: a.key });
    const connecting = b.connect();
    await until(() => fleet.connections.liveInstance("pc") !== null && b.inbox.some(m => m.t === "challenge"), 2000);
    await new Promise(r => setTimeout(r, 300));                      // the proof is in and the check is pending
    fleet.nodes.revoke("pc");
    fleet.connections.revoke("pc");                                  // what the route and the sweep do
    expect(await connecting).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });   // negative control: without the re-check, a welcome
    expect(b.inbox.some(m => m.t === "welcome")).toBe(false);
    expect(fleet.audit.of("conn.admitted").map(e => e.detail.instanceId)).toEqual([a.instanceId]);
    expect(fleet.audit.of("conn.refused").map(e => [e.node, e.detail.reason])).toEqual([["pc", "unknown_node"]]);
    expect(fleet.connections.status("pc")).toBe("offline");
    expect(fleet.connections.liveInstance("pc")).toBeNull();
  });

  it("waiting for one node's instance check holds no other node", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);
    const b = fleet.agent({ node: "pc", key: a.key });
    const checking = b.connect();                                                   // waits up to 3 s for a's pong
    await new Promise(r => setTimeout(r, 200));
    const started = performance.now();
    const mac = await fleet.online("mac");
    expect(await fleet.connections.request("mac", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(mac.open).toBe(true);
    expect((await checking).ok).toBe(true);
  });

  it("a different instance is accepted once the old connection closed", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });
    expect((await b.connect()).ok).toBe(false);
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(await b.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect(fleet.connections.liveInstance("pc")?.instanceId).toBe(b.instanceId);
  });

  it("a different instance is accepted once the old one missed its pong: online, stale, offline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // a frozen process: the socket stays, pongs stop
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping
    await settle();
    expect(fleet.connections.status("pc")).toBe("online");
    vi.advanceTimersByTime(LIMITS.pingMs);                          // no pong: stale, terminated
    expect((await a.closed).code).toBe(1006);
    // The agent may see its socket close before the fleet's close handler runs: wait for the fleet's view.
    await until(() => statuses(seen, "pc").length === 3);
    expect(statuses(seen, "pc")).toEqual(["online", "stale", "offline"]);
    const b = fleet.agent({ node: "pc", key: a.key });
    expect((await b.connect()).ok).toBe(true);
  });
});

describe("flapping (spec 9)", () => {
  it("two instances with one key for 5 minutes: exactly one connected, one alert, no op failures on the connected one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });
    const pongs = vi.spyOn(fleet.connections, "pong");
    const refusals: number[] = [];
    const failures: unknown[] = [];
    let ops = 0;
    // a answers every ping: the sweep's every 15 s, and each instance check b's hello causes.
    const answered = (second: number) => Math.floor(second / (LIMITS.pingMs / 1000)) + refusals.length;
    for (let second = 1; second <= 300; second++) {
      vi.advanceTimersByTime(1000);
      if (second % (LIMITS.pingMs / 1000) === 0) await until(() => pongs.mock.calls.length === answered(second));
      if (second % 10 === 0) { const r = await b.connect(); refusals.push(r.ok ? 0 : r.closed.code); }   // b retries every 10 s
      if (second % 5 === 0) {
        const o = await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 });
        ops++;
        if (!o.ok) failures.push(o.error);
      }
      await settle();
    }
    expect(refusals).toEqual(Array.from({ length: 30 }, () => CLOSE.conflict));
    expect({ ops, failures }).toEqual({ ops: 60, failures: [] });
    expect(a.open).toBe(true);
    expect(a.inbox.filter(m => m.t === "welcome")).toHaveLength(1);       // never replaced, never reconnected
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: a.instanceId, epoch: 1 });
    expect(fleet.audit.of("alert.instance_conflict")).toHaveLength(1);
    expect(pongs).toHaveBeenCalledTimes(20 + 30);                    // every sweep ping and every instance check, answered
  });
});
