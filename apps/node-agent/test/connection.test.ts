// The connection against a scripted fake fleet (spec §5.2, §9 "real agent against a scripted fake fleet"): mutual
// authentication, welcome, every close code (4409's retry every 5 minutes on fake timers), reconnect with the same
// instanceId, the ping watchdog (35 s by default), and the refusal of a plain ws:// URL to another machine.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { FleetConnection, UNSUPPORTED_RETRY_MS, type ConnectionOptions, type Welcomed } from "../src/conn/connection.ts";
import { formatStatus, type ConnStatus } from "../src/conn/status-file.ts";
import { createNodeKey, fleetPublicKey, type NodeKey } from "../src/identity.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { captureLog, until, wait } from "./helpers.ts";

// UUIDs, as the protocol's Hello requires (the fake fleet closes 1008 on a hello that doesn't fit).
// The version the product is: the root package.json's, read here directly, so the assertion checks the version the agent
// reports against the file it is meant to come from, not against the function the agent itself calls.
const ROOT_VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8")) as { version: string }).version;

const INSTANCE = randomUUID();
const STREAM = randomUUID();
let fleet: FakeFleet;
let key: NodeKey;
const conns: FleetConnection[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet();
  key = createNodeKey();
  fleet.trust("pc", key.publicKey);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of conns.splice(0)) await c.stop();
  await fleet.close();
});
// Real I/O (the sockets) still runs under fake timers; this waits for it without moving fake time (setImmediate is
// not faked by the toFake lists below).
const settle = async (f: () => boolean) => { for (let i = 0; i < 20_000 && !f(); i++) await new Promise(r => setImmediate(r)); return f(); };

function connect(over: Partial<ConnectionOptions> = {}) {
  const welcomes: Welcomed[] = [];
  const statuses: ConnStatus[] = [];
  const logged = captureLog();
  const fleetKey = fleetPublicKey(fleet.fleetKey);
  if (!fleetKey) throw new Error("the fake fleet's key does not parse");
  const conn = new FleetConnection({
    url: fleet.url, node: "pc", instanceId: INSTANCE, streamId: STREAM, fleetKey, nodeKey: key,
    caps: ["inventory.get"], claudeVersion: () => "2.1.286", log: logged.log,
    onWelcome: w => { welcomes.push(w); }, onRequest: () => {}, onBadRequest: () => {}, onAck: () => {}, onDown: () => {},
    onStatus: s => { statuses.push(s); }, retry: { baseMs: 20, capMs: 100 }, ...over,
  });
  conns.push(conn);
  conn.start();
  return { conn, welcomes, statuses, lines: logged.lines };
}
const hellos = () => fleet.received.filter(r => r.msg.t === "hello").map(r => r.msg);

describe("handshake", () => {
  it("authenticates both ways and goes online with the fleet's welcome", async () => {
    fleet.script.welcome = { connEpoch: 7, ackSeq: 3, streamKnown: true };
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    expect(c.welcomes).toEqual([{ connEpoch: 7, ackSeq: 3, streamKnown: true }]);
    expect(c.conn.status().connEpoch).toBe(7);
    expect(hellos()[0]).toMatchObject({
      v: 1, t: "hello", node: "pc", instanceId: INSTANCE, streamId: STREAM, proto: [1],
      agent: { version: ROOT_VERSION }, claude: { version: "2.1.286" }, caps: ["inventory.get"],
    });
    expect(String(hellos()[0]?.clientNonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);   // 32 random bytes
    expect(fleet.received.some(r => r.msg.t === "proof")).toBe(true);          // the fake verified it, or it closes 4401
  });

  it("never proves anything to a fleet whose signature doesn't match the pinned key, and keeps dialing", async () => {
    fleet.script.tamperSig = true;
    const c = connect();
    expect(await until(() => fleet.connections() >= 3)).toBe(true);
    expect(fleet.received.some(r => r.msg.t === "proof")).toBe(false);
    expect(c.statuses.some(s => s.state === "online")).toBe(false);
    expect(c.lines.join("\n")).toMatch(/signature does not match/);
    fleet.script.tamperSig = false;                                           // negative control: the same fleet, signing right
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
  });
});

describe("close codes", () => {
  for (const code of [4401, 4403]) {
    it(`${code}: stops dialing`, async () => {
      fleet.script.welcome = code;
      const c = connect();
      expect(await until(() => c.conn.status().state === "refused")).toBe(true);
      await wait(400);                                                        // 20 backoff periods
      expect(fleet.connections()).toBe(1);
      expect(c.conn.status().lastClose?.code).toBe(code);
    });
  }

  it("4409: says conflict in status, and doesn't dial again within the backoff", async () => {
    fleet.script.welcome = 4409;
    const c = connect();
    expect(await until(() => c.conn.status().state === "conflict")).toBe(true);
    await wait(400);                                                        // 20 backoff periods
    expect(fleet.connections()).toBe(1);
    const s = c.conn.status();
    expect(s.retryInMs).toBeGreaterThan(200_000);                           // 5 minutes ± 20 % away
    const text = formatStatus({ node: "pc", fleetUrl: fleet.url }, { ...s, node: "pc", instanceId: INSTANCE, pid: process.pid, spoolDepth: 0, drops: 0, inFlight: [] });
    expect(text).toMatch(/conflict: another agent with this node's key is connected \(4409\)\. This one tries again every 5 minutes/);
    expect(text).toMatch(/retry in\s+\d+ s/);
  });

  it("4409: tries again every 5 minutes ± 20 % (LIMITS.conflictRetryMs) and stays in conflict meanwhile (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fleet.script.welcome = 4409;
    const draws = [0, 1];                                                   // the shortest wait, then the longest
    const c = connect({ retry: { baseMs: 20, capMs: 100, random: () => draws.shift() ?? 0.5 } });
    expect(await settle(() => c.conn.status().state === "conflict")).toBe(true);
    expect(c.conn.status().retryInMs).toBe(0.8 * LIMITS.conflictRetryMs);
    await vi.advanceTimersByTimeAsync(0.8 * LIMITS.conflictRetryMs - 1);
    expect(fleet.connections()).toBe(1);
    expect(c.conn.status().state).toBe("conflict");
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => fleet.connections() === 2 && fleet.closes.length === 2)).toBe(true);
    expect(await settle(() => c.conn.status().state === "conflict" && c.conn.status().retryInMs === 1.2 * LIMITS.conflictRetryMs)).toBe(true);
    expect(c.statuses.map(s => s.state)).toEqual(["connecting", "conflict", "conflict"]);   // never refused or in backoff, and conflict while it asks again
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
  });

  it("4426: waits the long retry, not the backoff", async () => {
    expect(UNSUPPORTED_RETRY_MS).toBe(3_600_000);                            // hourly, in production
    fleet.script.welcome = 4426;
    const c = connect({ unsupportedRetryMs: 500 });
    expect(await until(() => c.conn.status().state === "unsupported")).toBe(true);
    await wait(250);
    expect(fleet.connections()).toBe(1);
    expect(await until(() => fleet.connections() === 2, 2000)).toBe(true);
  });

  it("an ordinary close dials again with backoff, as the same instance", async () => {
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    fleet.closeAgent(1011, "restart");
    expect(await until(() => c.welcomes.length === 2)).toBe(true);
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
    expect(hellos()[0]?.clientNonce).not.toBe(hellos()[1]?.clientNonce);       // a fresh nonce per connection
  });

  it("drop() cuts the live socket: the fleet sees it close without a close frame, and the agent dials again", async () => {
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    c.conn.drop();
    expect(await until(() => fleet.closes.some(x => x.conn === 1))).toBe(true);
    expect(fleet.closes.find(x => x.conn === 1)?.code).toBe(1006);           // cut, not closed
    expect(await until(() => c.welcomes.length === 2)).toBe(true);
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
  });
});

describe("ping watchdog", () => {
  it("waits LIMITS.agentPingTimeoutMs by default: 50 s, three of the fleet's 15 s pings and slack (fake timers)", async () => {
    expect(LIMITS.agentPingTimeoutMs).toBe(50_000);
    expect(LIMITS.agentPingTimeoutMs).toBeGreaterThan(3 * LIMITS.pingMs);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const c = connect();                                                    // no pingTimeoutMs: the default
    expect(await settle(() => c.conn.status().state === "online")).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMITS.agentPingTimeoutMs - 1);       // armed when the socket opened
    expect(fleet.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => fleet.closes.some(x => x.conn === 1))).toBe(true);
    expect(c.lines.join("\n")).toMatch(/no ping from the fleet for 50 s/);
  });
  it("terminates a fleet that sends no pings, and dials again", async () => {
    const c = connect({ pingTimeoutMs: 300 });                               // the fake fleet pings only when told to
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    expect(await until(() => fleet.connections() >= 2, 3000)).toBe(true);
    expect(c.lines.join("\n")).toMatch(/no ping from the fleet/);
  });
  it("keeps a fleet that pings (negative control)", async () => {
    fleet.script.pingMs = 100;
    const c = connect({ pingTimeoutMs: 300 });
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    await wait(1000);
    expect(fleet.connections()).toBe(1);
    expect(c.conn.status().state).toBe("online");
  });
});

describe("the ping watchdog after this process's own stall (T-532)", () => {
  it("a watchdog that fires late because the agent was busy reads the pings that waited before it gives up", async () => {
    fleet.script.pingMs = 100;
    const c = connect({ pingTimeoutMs: 300 });
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    await wait(250);
    const end = Date.now() + 800;
    while (Date.now() < end) { /* the agent's only thread is busy for 0.8 s, longer than the 0.3 s watchdog */ }
    await wait(1000);
    expect(c.lines.join("\n")).not.toMatch(/no ping from the fleet/);
    expect(fleet.connections()).toBe(1);
    expect(c.conn.status().state).toBe("online");
  });
});

describe("the fleet's URL (plan Contracts, fleetUrlOk)", () => {
  it("refuses a plain ws:// URL to another machine and never dials it", async () => {
    // 0.0.0.0 reaches this machine's fake fleet if dialed, but its host is not a loopback name.
    const plain = fleet.url.replace("127.0.0.1", "0.0.0.0");
    expect(() => connect({ url: plain })).toThrow(/wss:\/\/, or ws:\/\/ to this machine/);
    await wait(300);
    expect(fleet.connections()).toBe(0);
  });
});

describe("status text", () => {
  it("shows jobs disabled by a config error, with the reason", () => {
    const text = formatStatus({ node: "pc", fleetUrl: "ws://127.0.0.1/agent" }, {
      state: "online", since: Date.now(), connEpoch: 1, lastClose: null, retryInMs: null,
      node: "pc", instanceId: INSTANCE, pid: process.pid, spoolDepth: 0, drops: 0, inFlight: [],
      jobs: "disabled by config error: policy.json: jobs.classes.default: limit must be a whole number from 1 to 1000",
    });
    expect(text).toMatch(/jobs\s+disabled by config error: policy\.json: jobs\.classes\.default: limit/);
  });
});

describe("sending", () => {
  it("refuses before welcome and over 512 KiB", async () => {
    fleet.script.hello = 1011;
    const c = connect();
    expect(c.conn.send({ v: 1, t: "proof", sig: "x" })).toBe(false);
    fleet.script.hello = "challenge";
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    const big = { v: 1, t: "ev.health", health: { pad: "x".repeat(600 * 1024) } } as const;
    expect(c.conn.send(big as never)).toBe(false);
    expect(c.lines.join("\n")).toMatch(/not sending a ev\.health message/);
  });
});
