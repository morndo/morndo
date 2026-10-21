// Liveness and what the fleet watches on a live connection (spec 5.2, 5.4, 8): pings, the revocation re-check, the
// per-node rate limit (hook events exempt), the source-address alert and the clock-offset alert; and the audit's
// 90-day retention, on start and daily.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS } from "@morndo/protocol";
import { sourceOf } from "../src/adapters/agent-endpoint.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { AUDIT_PRUNE_EVERY_MS } from "../src/serve.ts";
import type { FleetEvent } from "../src/application/events.ts";
import { health } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { until } from "./helpers/until.ts";

afterEach(() => { vi.useRealTimers(); });

describe("liveness", () => {
  it("an agent that answers pings stays online for 5 minutes, and last_seen moves", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.online("pc");
    const firstSeen = fleet.nodes.active("pc")?.lastSeenAt ?? 0;
    const pongs = vi.spyOn(fleet.connections, "pong");
    for (let i = 1; i <= 20; i++) {
      vi.advanceTimersByTime(LIMITS.pingMs);
      await until(() => pongs.mock.calls.length === i);              // each ping answered before the next sweep
    }
    expect(a.open).toBe(true);
    expect(seen.filter(e => e.t === "status").map(e => (e.body as { status: string }).status)).toEqual(["online"]);
    expect(fleet.nodes.active("pc")?.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
  });

  it("a revocation written to fleet.db while connected closes the connection with 4403 within one interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    fleet.nodes.revoke("pc");                                       // what `morndo-fleet node revoke` writes
    vi.advanceTimersByTime(LIMITS.pingMs);
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect(fleet.connections.status("pc")).toBe("offline");
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: "node_offline" } });
  });

  it("reports inventory and health as events and in the node list", async () => {
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => { if (e.t !== "run") seen.push(e); });                // a lane's Run: runs.test.ts
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api" }]);
    a.health(health({ load1: 1.25 }));
    await vi.waitFor(() => expect(seen.map(e => e.t)).toEqual(["status", "inventory", "health"]));
    // An agent that sends no session state (one from before it): the fleet reads both as null (fleet clients §5).
    expect(seen[1]).toEqual({ t: "inventory", node: "pc", body: { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api", status: null, pid: null }], invVersion: 2 } });
    expect(fleet.connections.list()).toEqual([{ name: "pc", status: "online", health: expect.objectContaining({ load1: 1.25 }), agent: "test-agent/1", commit: null }]);
  });
});

describe("per-node rate limit", () => {
  it("a flood of inventory or health closes with 1008 and an alert; a flood of hook events does not (replay is exempt)", async () => {
    const fleet = await startTestFleet({ agentLimits: { capacity: 20, refillPerSecond: 1 } });
    const hooks = await fleet.online("pc");
    for (let seq = 1; seq <= 300; seq++) hooks.hook(seq);
    hooks.health();
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    expect(hooks.open).toBe(true);
    const flood = await fleet.online("mac");
    for (let i = 0; i < 50; i++) flood.health();                     // negative control: the limit does bite
    expect((await flood.closed).code).toBe(1008);
    expect(fleet.audit.of("alert.rate_limited").map(e => e.node)).toEqual(["mac"]);
    await vi.waitFor(() => expect(fleet.connections.status("mac")).toBe("offline"));
  });
});

describe("the source address (spec 8)", () => {
  it("is the TCP peer, or the X-Forwarded-For Tailscale Serve sets when the peer is this machine", () => {
    const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    expect(sourceOf(req("127.0.0.1"))).toBe("127.0.0.1");
    expect(sourceOf(req("127.0.0.1", "100.64.0.7"))).toBe("100.64.0.7");
    expect(sourceOf(req("::1", "100.64.0.7, 10.0.0.1"))).toBe("100.64.0.7");
    expect(sourceOf(req("100.64.0.9", "1.2.3.4"))).toBe("100.64.0.9");            // only a local proxy is believed
  });

  it("alerts when a node's source changes, not on its first connection or the same source again", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    expect(fleet.nodes.active("pc")?.lastSource).toBe("127.0.0.1");
    await a.close();
    expect((await a.connect()).ok).toBe(true);
    expect(fleet.audit.of("alert.source_changed")).toEqual([]);
    await a.close();
    expect((await a.connect({ headers: { "x-forwarded-for": "100.64.0.7" } })).ok).toBe(true);
    expect(fleet.audit.of("alert.source_changed").map(e => e.detail)).toEqual([{ from: "127.0.0.1", to: "100.64.0.7" }]);
  });
});

describe("audit retention (90 days)", () => {
  it("rows older than 90 days go when the service starts, and once a day while it runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 1_800_000_000_000;
    const dir = tempDir();
    const db = openFleetDb(join(dir, "fleet.db"));
    const before = new Audit(db, { now: () => now });
    before.record("cli", "node.add", "old");
    before.alert("dead_letter", "old", {});
    db.close();
    now += LIMITS.auditKeepMs + 1;
    const fleet = await startTestFleet({ dir, now: () => now });
    expect(fleet.audit.recent()).toEqual([]);                                       // on start
    fleet.audit.record("cli", "node.add", "pc");
    now += LIMITS.auditKeepMs + 1;
    expect(fleet.audit.recent()).toHaveLength(1);
    vi.advanceTimersByTime(AUDIT_PRUNE_EVERY_MS);                                    // daily
    expect(fleet.audit.recent()).toEqual([]);
  });
});

describe("the node's clock (spec 5.4)", () => {
  it("an agent 10 s off raises one alert; back in step re-arms it", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const healthSeen = (n: number) => vi.waitFor(() => expect(fleet.connections.latest("pc").health?.drops).toBe(n));
    a.health(health({ wallClock: Date.now() + 10_000, drops: 1 }));
    await healthSeen(1);
    a.health(health({ wallClock: Date.now() + 10_000, drops: 2 }));
    await healthSeen(2);
    expect(fleet.audit.of("alert.clock_offset")).toHaveLength(1);
    expect(fleet.audit.of("alert.clock_offset")[0]?.detail.offsetMs).toBeGreaterThan(9000);
    a.health(health({ wallClock: Date.now(), drops: 3 }));
    await healthSeen(3);
    a.health(health({ wallClock: Date.now() - 10_000, drops: 4 }));
    await healthSeen(4);
    expect(fleet.audit.of("alert.clock_offset")).toHaveLength(2);
  });
});
