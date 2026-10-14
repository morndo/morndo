// The hub as `morndo serve` runs it with a fleet (fleet-clients §9.1): the manager's queue is on by default; with
// MORNDO_MANAGER_QUEUE=off, a delivery still queued from before is cancelled at start; and a manager window the fleet
// doesn't keep sticky is said once in the log at start (plan.md Review Focus 5). The real hub as a child process on port
// 0 and a temporary home, against the fake fleet on a real Unix socket. Never the owner's hub, fleet or ports.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let dir: string;
let fleet: FakeFleet;
let child: ChildProcess | null = null;
let out = "";
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-queue-main-"));
  out = "";
});
afterEach(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(r => child?.once("exit", r)); }
  child = null;
  await fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fleetWith(window: string) {
  fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", memoryBackend({ "%0": { name: window, cwd: "/w/m", screen: "❯ ", sessionId: "s-m" } }))], stickyLanes: ["manager"] });
}
// `morndo serve` until it says it listens.
async function serve(env: Record<string, string>) {
  const e: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: "0", MORNDO_FLEET_SOCKET: fleet.socketPath, MORNDO_POLL_MS: "200", ...env };
  delete e.MORNDO_PUSH_CONTACT;
  if (env.MORNDO_MANAGER_QUEUE === undefined) delete e.MORNDO_MANAGER_QUEUE;
  child = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  await until(() => out.includes("morndo hub on"), 20_000);
}

describe("morndo serve with a fleet: the manager's queue", () => {
  it("on by default; a window the fleet keeps sticky says nothing of it", async () => {
    await fleetWith("manager");
    await serve({});
    expect(out.match(/manager queue: on\n/g)).toHaveLength(1);
    expect(out).not.toContain("stickyLanes");
  });

  it("a manager window the fleet doesn't keep sticky is said once at start (Review Focus 5)", async () => {
    await fleetWith("boss");
    await serve({ MORNDO_MANAGER_WINDOW: "boss" });
    expect(out.match(/the manager's window is "boss" \(MORNDO_MANAGER_WINDOW\), but the fleet's stickyLanes is \["manager"\]/g)).toHaveLength(1);
  });

  it("off: a delivery still queued from before is cancelled at start, and new answers are typed directly", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    await new (await import("@morndo/fleet-client")).FleetClient(fleet.socketPath).deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    await serve({ MORNDO_MANAGER_QUEUE: "off" });
    expect(fleet.cancels).toEqual(["hub:ep1:r1"]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery).toMatchObject({ state: "given_up", why: "cancelled" });
    expect(out.match(/manager queue: off \(MORNDO_MANAGER_QUEUE\)\n/g)).toHaveLength(1);
  });

  // Off, the hub types directly once it serves, so it serves only after every cancel at start is
  // answered (spec §9.1); a node slow to answer delivery.cancel delays the start, never the order.
  it("off: the hub serves only once its cancels at start are answered, from a slow node too", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    await new (await import("@morndo/fleet-client")).FleetClient(fleet.socketPath).deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    fleet.delayCancels(1500);
    await serve({ MORNDO_MANAGER_QUEUE: "off" });
    expect(fleet.cancels).toEqual(["hub:ep1:r1"]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery, out).toMatchObject({ state: "given_up", why: "cancelled" });
  });

  it("on, the same delivery is left queued (negative control)", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    await new (await import("@morndo/fleet-client")).FleetClient(fleet.socketPath).deliver({ id: "hub:ep1:r1", lane: "manager", text: "status please" });
    await serve({});
    expect(fleet.cancels).toEqual([]);
    expect(fleet.deliveries.get("hub:ep1:r1")?.delivery.state).toBe("queued");
  });
});

// Review (fleet-clients branch) #8: with the queue on, nothing has to happen before the hub serves; the first round of
// asking the fleet (a read it may be slow to answer) runs while the hub already serves.
describe("morndo serve with a fleet slow to answer the queue's reads", () => {
  it("serves at once: HTTP answers while the queue's first read of the fleet is still waiting", async () => {
    await fleetWith("manager");
    const store = new Store(dir);
    store.saveManagerDelivery({ deliveryId: "hub:ep1:r1", kind: "command", escalationId: null, ask: null, choice: null, endpointId: "ep1", sessionId: "s1", requestId: "r1", queuedAt: 1, state: "queued", updatedAt: Date.now() });
    store.close();
    fleet.holdDeliveryReads(true);
    const port = await new Promise<number>(resolve => {
      const s = createServer().listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
    });
    const e: NodeJS.ProcessEnv = { ...process.env, MORNDO_HOME: dir, MORNDO_PORT: String(port), MORNDO_FLEET_SOCKET: fleet.socketPath, MORNDO_POLL_MS: "200" };
    delete e.MORNDO_PUSH_CONTACT;
    delete e.MORNDO_MANAGER_QUEUE;
    child = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    let served = 0;
    for (const end = Date.now() + 20_000; !served && Date.now() < end;) {
      try { await fetch(`http://127.0.0.1:${port}/api/escalations`); served = Date.now(); }
      catch { await new Promise(r => setTimeout(r, 50)); }
    }
    // The queue's first read goes out after its sticky check, a round trip of its own, so it may reach the fleet after
    // the first answer over HTTP: wait for it rather than assume the order.
    let read = fleet.deliveryReads.find(r => r.id === "hub:ep1:r1");
    for (const end = Date.now() + 10_000; !read && Date.now() < end;) {
      await new Promise(r => setTimeout(r, 50));
      read = fleet.deliveryReads.find(r => r.id === "hub:ep1:r1");
    }
    expect(read, out).toBeDefined();
    expect(served, out).toBeGreaterThan(0);
    // The client gives up on that read after 5 s; a hub that waits for it serves no sooner.
    expect(served - (read?.at ?? 0), out).toBeLessThan(2500);
  });
});
