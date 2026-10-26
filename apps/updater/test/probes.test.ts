// The role probes' contract (design §4.6 RoleProbe; §6.3, §6.4): every service is asked from outside itself — the
// hub over HTTP on this machine only, the fleet over its Unix socket, the agent from the status.json it rewrites —
// and decoded with the wire's own schemas. Anything short of the full answer reads as silence, and silence is not
// quiet (§6.3): null for the safe point, null for the health, never a guess. The servers here are the test's own
// (a hub on 127.0.0.1:0, a fleet on a socket under the test's throwaway directory) and the status files are written
// the agent's way, with this process as the live writer.
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceProbes } from "../src/adapters/probes.ts";

const V = "0.5.0";                                 // a made-up target Version
const FLEET_SOCK = "fleet.sock";

const reply = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

// The hub's and the fleet's own answer (PR 0): version, schema, ready, and what is in flight.
const full = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: V, schema: 3, ready: true, inFlight: [], ...over });

// The agent's status.json (node-agent status-file.ts): its own fields plus the updater's.
const statusDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  state: "online", since: Date.now(), connEpoch: 7, lastClose: null, retryInMs: null,
  node: "node-a", instanceId: "i-9", pid: process.pid, spoolDepth: 0, drops: 0,
  version: V, ready: true, inFlight: [],
  ...over,
});
const statusFile = (name: string, doc: Record<string, unknown>): string => {
  const path = join(scratch, name);
  writeFileSync(path, `${JSON.stringify(doc)}\n`);
  return path;
};

let scratch = "";
let hub: Server;
let hubPort = 0;
let origin: Server;
let originPort = 0;
let fleet: Server;
let hubAnswer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, 200, full());
let originAnswer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, 200, JSON.stringify({ ready: true }));
let fleetAnswer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, 200, full());

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  hub = createServer((req, res) => hubAnswer(req, res));
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", resolve));
  hubPort = (hub.address() as AddressInfo).port;
  origin = createServer((req, res) => originAnswer(req, res));
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  originPort = (origin.address() as AddressInfo).port;
  fleet = createServer((req, res) => fleetAnswer(req, res));
  await new Promise<void>(resolve => fleet.listen(join(scratch, FLEET_SOCK), resolve));
});
beforeEach(() => {
  hubAnswer = (_req, res) => reply(res, 200, full());
  originAnswer = (_req, res) => reply(res, 200, JSON.stringify({ ready: true }));
  fleetAnswer = (_req, res) => reply(res, 200, full());
});
afterAll(async () => {
  for (const s of [hub, origin, fleet]) { s.close(); s.closeAllConnections(); }
  rmSync(scratch, { recursive: true, force: true });
});

const probes = (o: { nodeStatus?: string; timeoutMs?: number; hubUrl?: string } = {}) =>
  new ServiceProbes({
    hubUrl: o.hubUrl ?? `http://127.0.0.1:${hubPort}`,
    fleetSocket: join(scratch, FLEET_SOCK),
    nodeStatus: o.nodeStatus ?? join(scratch, "no-such-status.json"),
    timeoutMs: o.timeoutMs ?? 2_000,
  });

// The owner path (C4-6): the same hub and fleet, plus an origin the test serves over http on 127.0.0.1.
const ownerProbes = (o: {
  origin?: string; timeoutMs?: number; hubUrl?: string; fleetSocket?: string; nodeStatus?: string; managerLane?: boolean;
} = {}) =>
  new ServiceProbes({
    hubUrl: o.hubUrl ?? `http://127.0.0.1:${hubPort}`,
    fleetSocket: o.fleetSocket ?? join(scratch, FLEET_SOCK),
    nodeStatus: o.nodeStatus ?? join(scratch, "no-such-status.json"),
    timeoutMs: o.timeoutMs ?? 2_000,
    ownerPath: {
      ...(o.origin !== undefined ? { origin: o.origin } : {}),
      ...(o.managerLane !== undefined ? { managerLane: o.managerLane } : {}),
    },
  });

const originUrl = (): string => `http://127.0.0.1:${originPort}`;

const page = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "content-type": "text/html" });
  res.end(body);
};

// A hub whose health is the wire's shape and whose pages are a non-empty document.
const hubUp = (appStatus = 200, appBody = "<p>app</p>"): void => {
  hubAnswer = (req, res) => {
    if ((req.url ?? "").split("?")[0] === "/") { page(res, appStatus, appBody); return; }
    reply(res, 200, full());
  };
};

const laneDoc = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: "manager", node: "n1", workerId: "m-1", conflict: false, ...over });

const nodesDoc = (rows: readonly { name: string; status: string }[] = [{ name: "n1", status: "online" }]): string =>
  JSON.stringify(rows.map(row => ({ ...row, health: null, agent: V })));

// The fleet's health, plus the two owner-path reads, each named so a test can bend one.
const fleetUp = (o: { laneStatus?: number; laneBody?: string; nodesStatus?: number; nodesBody?: string; seen?: string[] } = {}): void => {
  fleetAnswer = (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const client = req.headers["x-morndo-client"];
    o.seen?.push(`${url} ${typeof client === "string" ? client : ""}`);
    if (url === "/v1/lanes/manager") return reply(res, o.laneStatus ?? 200, o.laneBody ?? laneDoc());
    if (url === "/v1/nodes") return reply(res, o.nodesStatus ?? 200, o.nodesBody ?? nodesDoc());
    reply(res, 200, full());
  };
};

describe("the hub probe (§6.3, §6.4)", () => {
  it("reads the safe point and the health from GET /api/health", async () => {
    let asked = "";
    hubAnswer = (req, res) => { asked = req.url ?? ""; reply(res, 200, full({ inFlight: [{ kind: "command", id: "c-7" }] })); };
    const p = probes();
    expect(await p.safePoint("hub")).toEqual({ service: "hub", blockers: ["command c-7"] });
    expect(await p.health("hub")).toEqual({ service: "hub", version: V, checks: { ready: true } });
    expect(asked).toBe("/api/health");
    hubAnswer = (_req, res) => reply(res, 200, full());          // nothing in flight any more
    expect(await p.safePoint("hub")).toEqual({ service: "hub", blockers: [] });
  });

  it("a ready-only answer, the proxy's shape, is no answer: no version, no judgement", async () => {
    hubAnswer = (_req, res) => reply(res, 200, JSON.stringify({ ready: true }));
    const p = probes();
    expect(await p.safePoint("hub")).toBeNull();
    expect(await p.health("hub")).toBeNull();
  });

  it("garbage, a wrong shape and a non-200 are no answer", async () => {
    const p = probes();
    for (const body of ["not json{", "{}", JSON.stringify({ version: 1, schema: 3, ready: true, inFlight: [] })]) {
      hubAnswer = (_req, res) => reply(res, 200, body);
      expect(await p.safePoint("hub"), body).toBeNull();
      expect(await p.health("hub"), body).toBeNull();
    }
    hubAnswer = (_req, res) => reply(res, 500, full());
    expect(await p.safePoint("hub")).toBeNull();
    expect(await p.health("hub")).toBeNull();
  });

  it("a hub that does not answer within the wall is no answer", async () => {
    hubAnswer = () => { /* it never answers */ };
    const p = probes({ timeoutMs: 60 });
    expect(await p.safePoint("hub")).toBeNull();
    expect(await p.health("hub")).toBeNull();
  });

  it("a hub that is down is no answer, not a failure", async () => {
    const gone = createServer();
    await new Promise<void>(resolve => gone.listen(0, "127.0.0.1", resolve));
    const port = (gone.address() as AddressInfo).port;
    gone.close();
    await new Promise<void>(resolve => gone.once("close", resolve));
    const p = probes({ hubUrl: `http://127.0.0.1:${port}` });
    expect(await p.safePoint("hub")).toBeNull();
    expect(await p.health("hub")).toBeNull();
  });

  it("refuses a hub anywhere but this machine", () => {
    for (const hubUrl of ["http://10.0.0.5:8790", "http://hub.example.invalid:8790", "https://morndo.example.invalid"]) {
      expect(() => probes({ hubUrl }), hubUrl).toThrow(/loopback|127\.0\.0\.1/);
    }
    expect(() => probes({ hubUrl: "http://localhost:8790" })).not.toThrow();
  });
});

describe("the fleet probe (§6.3, §6.4)", () => {
  it("reads the safe point and the health from GET /v1/health on its socket", async () => {
    let asked = "";
    fleetAnswer = (req, res) => { asked = req.url ?? ""; reply(res, 200, full({ inFlight: [{ kind: "lane.stop", id: "lane-9" }] })); };
    const p = probes();
    expect(await p.safePoint("fleet")).toEqual({ service: "fleet", blockers: ["lane.stop lane-9"] });
    expect(await p.health("fleet")).toEqual({ service: "fleet", version: V, checks: { ready: true } });
    expect(asked).toBe("/v1/health");
  });

  it("garbage over the socket is no answer", async () => {
    fleetAnswer = (_req, res) => reply(res, 200, "{}");
    const p = probes();
    expect(await p.safePoint("fleet")).toBeNull();
    expect(await p.health("fleet")).toBeNull();
  });

  it("a fleet that does not answer is no answer, while the others still answer", async () => {
    fleetAnswer = () => { /* never answers */ };
    const p = probes({ timeoutMs: 100 });
    expect(await p.safePoint("fleet")).toBeNull();
    expect(await p.health("fleet")).toBeNull();
    expect(await p.health("hub")).not.toBeNull();
  });
});

describe("the hold acknowledgement (§6.2 step 3)", () => {
  it("reads `held` from each service's own answer: true, false, and an older service's missing field is no acknowledgement", async () => {
    // The hub and the fleet: the same ServiceHealth shape over their own doors.
    for (const answer of [true, false, undefined]) {
      hubAnswer = (_req, res) => reply(res, 200, full(answer === undefined ? {} : { held: answer }));
      fleetAnswer = (_req, res) => reply(res, 200, full(answer === undefined ? {} : { held: answer }));
      const p = probes();
      expect(await p.seesHold("hub"), `hub held ${String(answer)}`).toBe(answer ?? null);
      expect(await p.seesHold("fleet"), `fleet held ${String(answer)}`).toBe(answer ?? null);
    }
    // The agent: the same word inside status.json.
    for (const answer of [true, false, undefined]) {
      const doc = statusDoc(answer === undefined ? {} : { held: answer });
      const p = probes({ nodeStatus: statusFile(`held-${String(answer)}.json`, doc) });
      expect(await p.seesHold("node"), `node held ${String(answer)}`).toBe(answer ?? null);
    }
  });

  it("no answer is no acknowledgement, for any of the three: silence is not consent", async () => {
    hubAnswer = () => { /* it never answers */ };
    fleetAnswer = () => { /* it never answers */ };
    const p = probes({ timeoutMs: 60 });             // nodeStatus defaults to a file that is not there
    expect(await p.seesHold("hub")).toBeNull();
    expect(await p.seesHold("fleet")).toBeNull();
    expect(await p.seesHold("node")).toBeNull();
  });
});

describe("the node probe (§6.3, §6.4)", () => {
  it("reads the safe point and the health from status.json", async () => {
    const p = probes({ nodeStatus: statusFile("good.json", statusDoc({ inFlight: [{ kind: "pane.send", id: "d-4" }] })) });
    expect(await p.safePoint("node")).toEqual({ service: "node", blockers: ["pane.send d-4"] });
    expect(await p.health("node")).toEqual({ service: "node", version: V, checks: { ready: true, fleet_online: true } });
  });

  it("names the fleet connection in the health checks", async () => {
    const p = probes({ nodeStatus: statusFile("backoff.json", statusDoc({ state: "backoff" })) });
    const report = await p.health("node");
    expect(report).toMatchObject({ service: "node", checks: { ready: true, fleet_online: false } });
  });

  it("an older agent's status file, with no inFlight, is silence for the safe point — not quiet — and still answers for health", async () => {
    const { inFlight: _none, ...without } = statusDoc();
    const p = probes({ nodeStatus: statusFile("older.json", without) });
    expect(await p.safePoint("node")).toBeNull();
    expect(await p.health("node")).toMatchObject({ service: "node", version: V });
  });

  it("a status file whose writer is dead is no answer", async () => {
    // A child that already exited and was reaped: its pid names nobody.
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    expect(dead.pid).toBeTruthy();
    const p = probes({ nodeStatus: statusFile("dead.json", statusDoc({ pid: dead.pid as number })) });
    expect(await p.safePoint("node")).toBeNull();
    expect(await p.health("node")).toBeNull();
  });

  it("a status file not rewritten for two minutes is no answer, whoever wrote it", async () => {
    const path = statusFile("stale.json", statusDoc());
    const ago = new Date(Date.now() - 3 * 60_000);
    utimesSync(path, ago, ago);                     // the agent rewrites it on every health tick; this one stopped
    const p = probes({ nodeStatus: path });
    expect(await p.safePoint("node")).toBeNull();
    expect(await p.health("node")).toBeNull();
  });

  it("no file, or one that is not the agent's shape, is no answer", async () => {
    const p = probes();
    expect(await p.safePoint("node")).toBeNull();
    const shapeless = probes({ nodeStatus: statusFile("shapeless.json", { pid: process.pid, ready: true }) });
    expect(await shapeless.safePoint("node")).toBeNull();
    expect(await shapeless.health("node")).toBeNull();
  });
});

describe("the owner path on the control plane (C4-6, §6.4)", () => {
  it("the hub's report carries the owner-path checks when they are configured", async () => {
    const seen: string[] = [];
    hubUp();
    fleetUp({ seen });
    const p = ownerProbes({ origin: originUrl() });
    expect(await p.health("hub")).toEqual({
      service: "hub", version: V,
      checks: { ready: true, owner_app_served: true, owner_origin_ready: true, owner_manager_lane: true },
    });
    expect(seen).toContain("/v1/lanes/manager updater");
    expect(seen).toContain("/v1/nodes updater");
  });

  it("owner_app_served is false when the hub answers 503 for the app", async () => {
    hubUp(503, JSON.stringify({ error: "web app not built" }));
    fleetUp();
    const p = ownerProbes({ origin: originUrl() });
    const report = await p.health("hub");
    expect(report).not.toBeNull();
    expect(report?.checks.ready).toBe(true);
    expect(report?.checks.owner_app_served).toBe(false);
  });

  it("owner_app_served is false when the hub answers 200 with an empty body", async () => {
    hubUp(200, "");
    fleetUp();
    const report = await ownerProbes({ origin: originUrl() }).health("hub");
    expect(report?.checks.ready).toBe(true);
    expect(report?.checks.owner_app_served).toBe(false);
  });

  it("owner_origin_ready is false when the origin does not answer, answers 503 or says ready false", async () => {
    hubUp();
    fleetUp();
    originAnswer = () => { /* it never answers */ };
    const silent = ownerProbes({ origin: originUrl(), timeoutMs: 80 });
    expect((await silent.health("hub"))?.checks.owner_origin_ready).toBe(false);

    originAnswer = (_req, res) => reply(res, 503, JSON.stringify({ ready: true }));
    const down = ownerProbes({ origin: originUrl() });
    expect((await down.health("hub"))?.checks.owner_origin_ready).toBe(false);

    originAnswer = (_req, res) => reply(res, 200, JSON.stringify({ ready: false }));
    const notReady = ownerProbes({ origin: originUrl() });
    expect((await notReady.health("hub"))?.checks.owner_origin_ready).toBe(false);
  });

  it("owner_origin_ready is absent when no origin is configured", async () => {
    hubUp();
    fleetUp();
    const report = await ownerProbes().health("hub");
    expect(report?.checks.owner_app_served).toBe(true);
    expect(report?.checks.owner_manager_lane).toBe(true);
    expect(report?.checks).not.toHaveProperty("owner_origin_ready");
  });

  it("owner_manager_lane is false when the fleet has no manager lane, a conflicting one, or its node offline or unlisted", async () => {
    hubUp();
    const cases: { name: string; laneStatus?: number; laneBody?: string; nodesBody?: string }[] = [
      { name: "no such lane", laneStatus: 404, laneBody: JSON.stringify({ error: "no_such_lane" }) },
      { name: "conflict", laneBody: laneDoc({ conflict: true, workerId: null }) },
      { name: "offline", nodesBody: nodesDoc([{ name: "n1", status: "offline" }]) },
      { name: "stale", nodesBody: nodesDoc([{ name: "n1", status: "stale" }]) },
      { name: "unlisted", nodesBody: nodesDoc([{ name: "n2", status: "online" }]) },
    ];
    for (const c of cases) {
      fleetUp({
        ...(c.laneStatus !== undefined ? { laneStatus: c.laneStatus } : {}),
        ...(c.laneBody !== undefined ? { laneBody: c.laneBody } : {}),
        ...(c.nodesBody !== undefined ? { nodesBody: c.nodesBody } : {}),
      });
      const report = await ownerProbes({ origin: originUrl() }).health("hub");
      expect(report, c.name).not.toBeNull();
      expect(report?.checks.owner_manager_lane, c.name).toBe(false);
    }
    const closed = ownerProbes({ origin: originUrl(), fleetSocket: join(scratch, "no-such-fleet.sock"), timeoutMs: 300 });
    expect((await closed.health("hub"))?.checks.owner_manager_lane).toBe(false);
  });

  it("the fleet's and the node's reports never carry the owner-path checks", async () => {
    hubUp();
    fleetUp();
    const p = ownerProbes({ origin: originUrl(), nodeStatus: statusFile("owner-node.json", statusDoc()) });
    for (const service of ["fleet", "node"] as const) {
      const report = await p.health(service);
      expect(report, service).not.toBeNull();
      expect(Object.keys(report?.checks ?? {}).some(name => name.startsWith("owner_")), service).toBe(false);
    }
  });

  it("a probe built without the owner path never adds the checks", async () => {
    hubUp();
    fleetUp();
    const report = await probes().health("hub");
    expect(report).toEqual({ service: "hub", version: V, checks: { ready: true } });
  });

  it("an origin that is neither https nor local http is refused at construction", () => {
    for (const origin of ["http://10.0.0.5:8790", "http://hub.example.invalid", "ftp://127.0.0.1/app", "not a url"]) {
      expect(() => ownerProbes({ origin }), origin).toThrow(/https|127\.0\.0\.1|localhost/);
    }
    expect(() => ownerProbes({ origin: "https://morndo.example.invalid" })).not.toThrow();
    expect(() => ownerProbes({ origin: "http://127.0.0.1:8790" })).not.toThrow();
    expect(() => ownerProbes({ origin: "http://localhost:8790" })).not.toThrow();
  });

  it("a hub that does not answer has no report even with the owner path configured", async () => {
    hubAnswer = () => { /* it never answers */ };
    fleetUp();
    const p = ownerProbes({ origin: originUrl(), timeoutMs: 60 });
    expect(await p.health("hub")).toBeNull();
  });
});
