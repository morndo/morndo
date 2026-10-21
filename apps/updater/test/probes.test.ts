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
let fleet: Server;
let hubAnswer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, 200, full());
let fleetAnswer: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, 200, full());

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  hub = createServer((req, res) => hubAnswer(req, res));
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", resolve));
  hubPort = (hub.address() as AddressInfo).port;
  fleet = createServer((req, res) => fleetAnswer(req, res));
  await new Promise<void>(resolve => fleet.listen(join(scratch, FLEET_SOCK), resolve));
});
beforeEach(() => {
  hubAnswer = (_req, res) => reply(res, 200, full());
  fleetAnswer = (_req, res) => reply(res, 200, full());
});
afterAll(async () => {
  for (const s of [hub, fleet]) { s.close(); s.closeAllConnections(); }
  rmSync(scratch, { recursive: true, force: true });
});

const probes = (o: { nodeStatus?: string; timeoutMs?: number; hubUrl?: string } = {}) =>
  new ServiceProbes({
    hubUrl: o.hubUrl ?? `http://127.0.0.1:${hubPort}`,
    fleetSocket: join(scratch, FLEET_SOCK),
    nodeStatus: o.nodeStatus ?? join(scratch, "no-such-status.json"),
    timeoutMs: o.timeoutMs ?? 2_000,
  });

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
