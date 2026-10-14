// The fleet client's additions for fleet clients (docs/design/fleet-clients/README.md §8; plan.md Contracts,
// "packages/fleet-client" and "Client API routes"): its name, the capabilities' sticky lanes, deliveries, lane events, and
// the delivery and lane events. Against a stub of those routes on a real Unix socket (the fleet's own come with Tasks 8
// and 9): it answers each request as the Contracts' table says and records what it was asked. Synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { Alert, Delivery, LaneEvent } from "@morndo/protocol";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, type FleetEvent } from "../src/index.ts";

type Seen = { method: string; path: string; client: string; body: unknown };
type Answer = ({ status: number; body: unknown } | { status: number; raw: string }) & { delayMs?: number };
let dir: string;
let seen: Seen[];
let answer: (s: Seen) => Answer | "hangup";
let frames: unknown[];
let close: () => Promise<void>;

const D: Delivery = { id: "hub:answer:e1:t1:option:1", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: 1_791_460_800_000, notAfter: 1_791_547_200_000 };
const E: LaneEvent = { v: 1, t: "lane", seq: 7, event: "finished", node: "pc", window: "api", lane: "api", sessionId: "s1", at: 1_791_460_801_000, status: "done", firstLine: "STATUS: DONE", bg: 0, crons: 0 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-client-"));
  seen = [];
  frames = [];
  answer = () => ({ status: 404, body: { error: "no such route" } });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const s: Seen = { method: req.method ?? "", path: req.url ?? "", client: String(req.headers["x-morndo-client"] ?? ""), body: text ? JSON.parse(text) : null };
      seen.push(s);
      const a = answer(s);
      if (a === "hangup") { req.socket.destroy(); return; }               // the request arrived, and no answer leaves
      const write = () => {
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end("raw" in a ? a.raw : JSON.stringify(a.body));
      };
      if (a.delayMs === undefined) write();
      else setTimeout(write, a.delayMs);                                   // a node slow to answer, the fleet still waiting
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    seen.push({ method: "WS", path: req.url ?? "", client: String(req.headers["x-morndo-client"] ?? ""), body: null });
    for (const f of frames) ws.send(JSON.stringify(f));
  }));
  await new Promise<void>(resolve => server.listen(join(dir, "fleet.sock"), () => resolve()));
  close = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  };
});
afterEach(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});
const client = (o?: { client?: string }) => new FleetClient(join(dir, "fleet.sock"), o);
async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`not within ${ms} ms`); await new Promise(r => setTimeout(r, 20)); }
}

describe("the client's name (§8)", () => {
  it("is hub unless given, and every request carries it: reads, a delivery, the events socket", async () => {
    answer = s => (s.path === "/v1/caps" ? { status: 200, body: { api: [1] } } : { status: 200, body: { ok: true, delivery: D } });
    await client().caps();
    const kira = client({ client: "kira" });
    await kira.caps();
    await kira.deliver({ id: "kira:tg:1:42", lane: "manager", text: "hi" });
    const stop = kira.events(() => {});
    await until(() => seen.some(s => s.method === "WS"));
    stop();
    expect(seen.map(s => `${s.method} ${s.client}`)).toEqual(["GET hub", "GET kira", "POST kira", "WS kira"]);
  });
  it("a name that isn't a-z, at most 16 letters, is refused at once (negative control)", () => {
    for (const name of ["", "Kira", "kira!", "k-1", "abcdefghijklmnopq", "hub\r\nx-evil: 1"]) expect(() => client({ client: name }), JSON.stringify(name)).toThrow(TypeError);
    expect(() => client({ client: "abcdefghijklmnop" })).not.toThrow();
  });
});

describe("the capabilities (§8, Review Focus 5)", () => {
  it("list the sticky lanes; a fleet from before them makes none sticky", async () => {
    answer = () => ({ status: 200, body: { api: [1], stickyLanes: ["manager"] } });
    expect(await client().caps()).toEqual({ api: [1], stickyLanes: ["manager"] });
    answer = () => ({ status: 200, body: { api: [1] } });
    expect(await client().caps()).toEqual({ api: [1], stickyLanes: [] });
  });
  it("sticky lanes that aren't a list of names are a mismatch (negative control)", async () => {
    for (const stickyLanes of ["manager", [1], null]) {
      answer = () => ({ status: 200, body: { api: [1], stickyLanes } });
      await expect(client().caps(), JSON.stringify(stickyLanes)).rejects.toBeInstanceOf(FleetMismatch);
    }
  });
});

describe("deliver (POST /v1/deliveries)", () => {
  it("posts the id, the lane or the worker ID, the text and the duration, and answers the stored delivery", async () => {
    answer = () => ({ status: 200, body: { ok: true, delivery: D } });
    expect(await client().deliver({ id: D.id, lane: "manager", text: "Answer: ship it", ttlMs: 60_000 })).toEqual(D);
    await client().deliver({ id: "lanes:k1", workerId: "pc.3fa2c1d0.12", text: "hi" });
    expect(seen.map(s => [s.method, s.path, s.body])).toEqual([
      ["POST", "/v1/deliveries", { id: D.id, lane: "manager", text: "Answer: ship it", ttlMs: 60_000 }],
      ["POST", "/v1/deliveries", { id: "lanes:k1", workerId: "pc.3fa2c1d0.12", text: "hi" }],
    ]);
  });
  it("a refusal throws FleetOpFailed with the fleet's error, whatever the status", async () => {
    for (const [status, code] of [[409, "id_conflict"], [409, "lane_conflict"], [409, "no_session"], [404, "no_pane"], [503, "node_offline"], [400, "bad_args"]] as const) {
      answer = () => ({ status, body: { ok: false, error: { code, executed: "no", message: code } } });
      const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
      expect(e, code).toBeInstanceOf(FleetOpFailed);
      expect((e as FleetOpFailed).error, code).toEqual({ code, executed: "no", message: code });
    }
  });
  it("an answer that isn't a delivery's leaves it in doubt: FleetUnavailable, reached; the same id may be sent again (negative control)", async () => {
    for (const a of [{ status: 200, body: { ok: true } }, { status: 200, body: { ok: true, delivery: { ...D, state: "lost" } } }, { status: 502, raw: "<html>bad gateway</html>" }] as Answer[]) {
      answer = () => a;
      const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
      expect(e, JSON.stringify(a).slice(0, 50)).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    }
  });
  it("no socket: FleetUnavailable, not reached: nothing was queued", async () => {
    const e = await new FleetClient(join(dir, "missing.sock")).deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
    expect((e as FleetUnavailable).reached).toBe(false);
  });
  it("an uncertain refusal is the fleet's own word that it may have run: FleetOpFailed, executed maybe", async () => {
    answer = () => ({ status: 200, body: { ok: false, error: { code: "uncertain", executed: "maybe", message: "the connection to the node dropped" } } });
    const e = await client().deliver({ id: "hub:x", lane: "manager", text: "t" }).catch((x: unknown) => x);
    expect((e as FleetOpFailed).error).toEqual({ code: "uncertain", executed: "maybe", message: "the connection to the node dropped" });
  });
});

describe("the delivery ops are never sent through op() (the fleet refuses them on /v1/op)", () => {
  it("op() throws for lane.deliver and delivery.cancel and sends nothing (negative control)", async () => {
    const c = client();
    await expect(c.op({ lane: "manager" }, "lane.deliver" as never, { id: "hub:x", target: { lane: "manager", sticky: true }, text: "t" } as never)).rejects.toThrow(TypeError);
    await expect(c.op({ node: "pc" }, "delivery.cancel" as never, { id: "hub:x" } as never)).rejects.toThrow("cancelDelivery");
    expect(seen).toEqual([]);
  });
});

describe("a delivery's state (GET /v1/deliveries)", () => {
  it("one by its id, the id one path segment however it's written; none is null", async () => {
    answer = s => (s.path.startsWith("/v1/deliveries/hub") ? { status: 200, body: { delivery: D, stale: true } } : { status: 404, body: { error: "no such delivery" } });
    expect(await client().delivery("hub:a/b ü#1")).toEqual({ ...D, stale: true });
    expect(seen[0]?.path).toBe("/v1/deliveries/hub%3Aa%2Fb%20%C3%BC%231");
    expect(await client().delivery("kira:gone")).toBeNull();
  });
  it("the list, by lane and state, each with whether its node is offline", async () => {
    answer = () => ({ status: 200, body: { deliveries: [{ ...D, stale: false }] } });
    expect(await client().deliveries({ lane: "fix: a/b", state: "queued" })).toEqual([{ ...D, stale: false }]);
    expect(await client().deliveries()).toEqual([{ ...D, stale: false }]);
    expect(seen.map(s => s.path)).toEqual(["/v1/deliveries?lane=fix%3A+a%2Fb&state=queued", "/v1/deliveries"]);
  });
  it("an answer of another shape is a mismatch, a 5xx is unavailable (negative controls)", async () => {
    for (const body of [{ delivery: D }, { delivery: { ...D, target: {} }, stale: false }, []]) {
      answer = () => ({ status: 200, body });
      await expect(client().delivery("hub:x"), JSON.stringify(body).slice(0, 40)).rejects.toBeInstanceOf(FleetMismatch);
    }
    answer = () => ({ status: 200, body: { deliveries: [D] } });
    await expect(client().deliveries()).rejects.toBeInstanceOf(FleetMismatch);
    answer = () => ({ status: 500, body: { error: "internal error" } });
    await expect(client().delivery("hub:x")).rejects.toBeInstanceOf(FleetUnavailable);
  });
});

describe("in doubt: the request went out and no answer came (ruling 49)", () => {
  const calls = (c: FleetClient) => [() => c.deliver({ id: "hub:x", lane: "manager", text: "t" }), () => c.cancelDelivery("hub:x"), () => c.delivery("hub:x")];
  it("deliver, cancelDelivery and delivery: the connection dropped after the request is FleetUnavailable, reached (negative control)", async () => {
    answer = () => "hangup";
    for (const call of calls(client())) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    }
    expect(seen.map(s => s.method)).toEqual(["POST", "POST", "GET"]);
  });
  it("nothing left this process (no socket there): FleetUnavailable, not reached, for each", async () => {
    for (const call of calls(new FleetClient(join(dir, "missing.sock")))) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(false);
    }
  });
});

// Review (fleet-clients branch) #1: the fleet waits up to LIMITS.deliveryOpTimeoutMs (15 s) for the node's answer to
// lane.deliver and delivery.cancel; a client that gives up sooner reports a delivery that went fine as in doubt.
describe("deliver and cancelDelivery wait as long as the fleet waits for the node", () => {
  it("an answer after 9 s (the node slow, the fleet within its 15 s) is the answer, not FleetUnavailable", async () => {
    const cancelled: Delivery = { ...D, state: "given_up", why: "cancelled" };
    answer = s => (s.path === "/v1/deliveries" ? { status: 200, body: { ok: true, delivery: D }, delayMs: 9000 }
      : { status: 200, body: { ok: true, delivery: cancelled }, delayMs: 9000 });
    const c = client();
    const [delivered, gone] = await Promise.allSettled([
      c.deliver({ id: D.id, lane: "manager", text: "hi" }), c.cancelDelivery(D.id),
    ]);
    expect(delivered).toEqual({ status: "fulfilled", value: D });
    expect(gone).toEqual({ status: "fulfilled", value: cancelled });
  }, 30_000);
});

describe("cancelDelivery (POST /v1/deliveries/<id>/cancel)", () => {
  it("answers the delivery given up; one already typed is refused already_typed", async () => {
    const cancelled: Delivery = { ...D, state: "given_up", why: "cancelled" };
    answer = () => ({ status: 200, body: { ok: true, delivery: cancelled } });
    expect(await client().cancelDelivery("hub:a/b")).toEqual(cancelled);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/v1/deliveries/hub%3Aa%2Fb/cancel" });
    answer = () => ({ status: 409, body: { ok: false, error: { code: "already_typed", executed: "no", message: "typed already" } } });
    const e = await client().cancelDelivery("hub:x").catch((x: unknown) => x);
    expect((e as FleetOpFailed).error.code).toBe("already_typed");
  });
  it("one the fleet doesn't know is null, as delivery(id) answers; another 404 leaves it in doubt (negative control)", async () => {
    answer = () => ({ status: 404, body: { error: "no_such_delivery" } });
    expect(await client().cancelDelivery("kira:gone")).toBeNull();
    answer = () => ({ status: 404, body: { error: "no such route" } });
    const e = await client().cancelDelivery("kira:gone").catch((x: unknown) => x);
    expect((e as FleetUnavailable).reached).toBe(true);
  });
});

describe("lane events (GET /v1/lane-events)", () => {
  it("reads on from a sequence, oldest first", async () => {
    answer = () => ({ status: 200, body: { events: [E, { ...E, seq: 8, event: "answered", status: undefined }] } });
    expect((await client().laneEvents(7)).map(e => [e.seq, e.event])).toEqual([[7, "finished"], [8, "answered"]]);
    await client().laneEvents();
    expect(seen.map(s => s.path)).toEqual(["/v1/lane-events?since=7", "/v1/lane-events"]);
  });
  it("an event of another shape is a mismatch (negative control)", async () => {
    answer = () => ({ status: 200, body: { events: [{ ...E, event: "started" }] } });
    await expect(client().laneEvents()).rejects.toBeInstanceOf(FleetMismatch);
  });
});

describe("the events socket: deliveries, lane events and the new alerts", () => {
  it("passes on a delivery's state and a lane event with their bodies checked, and leaves out a malformed one (negative control)", async () => {
    frames = [
      { t: "delivery", node: "pc", body: { ...D, state: "delivered", deliveredAt: 2, stale: false } },
      { t: "delivery", node: "pc", body: { ...D, state: "lost", stale: false } },
      { t: "lane", node: "pc", body: E },
      { t: "lane", node: "pc", body: { ...E, seq: 0 } },
      { t: "status", node: "pc", body: { status: "online" } },
    ];
    const got: FleetEvent[] = [];
    const warned: string[] = [];
    const stop = new FleetClient(join(dir, "fleet.sock"), { log: { warn: m => warned.push(m), error: m => warned.push(m) } }).events(e => got.push(e));
    await until(() => got.some(e => e.t === "status"));
    stop();
    expect(got).toEqual([
      { t: "delivery", node: "pc", body: { ...D, state: "delivered", deliveredAt: 2, stale: false } },
      { t: "lane", node: "pc", body: E },
      { t: "status", node: "pc", body: { status: "online" } },
    ]);
    expect(warned).toHaveLength(2);
  });
  it("keeps the alerts delivery_waiting and subscriber_lagging", async () => {
    const waiting: Alert = { id: 1, at: 1, node: "pc", kind: "delivery_waiting", detail: { id: D.id, state: "queued", reason: "menu_open", minutes: 2 } };
    const lagging: Alert = { id: 2, at: 2, node: null, kind: "subscriber_lagging", detail: { subscriber: "kira", oldestMs: 61_000 } };
    answer = () => ({ status: 200, body: [waiting, lagging] });
    expect(await client().alerts()).toEqual([waiting, lagging]);
  });
});
