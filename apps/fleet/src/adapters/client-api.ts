// The client API (spec 5.6): HTTP and WebSocket on a Unix socket only, for the hub, kira and `lanes`. Every route is
// under /v<N>/ with N the current or the previous API version; GET /v1/caps lists them.
//   GET  /v1/caps                      { api: number[] }
//   GET  /v1/nodes                     [{ name, status, health, agent }]
//   POST /v1/nodes/<name>/revoke       closes the node's connection, drops its lanes (the console's `node revoke`)
//   GET  /v1/lanes                     [{ name, node, workerId, conflict }]
//   GET  /v1/lanes/<lane name>         one lane; the name URL-encoded as one path segment
//   GET  /v1/alerts                    Alert[]: the latest 500, oldest first
//   GET  /v1/jobs                      { jobs, stale } filtered by node, lane and state; stale while a named node is offline
//   GET  /v1/jobs/<node>/<id>         { job, stale } or 404. A job is the pair (node, id).
//   POST /v1/op                        { workerId | node | lane, op, args, key?, timeoutMs? } → the outcome, always as
//                                      { ok, result, invVersion, store, storeSeq } or { ok: false, error: OpError, store,
//                                      storeSeq } (store and storeSeq null when nothing was sent; storeSeq null from an
//                                      agent that sends none; 415: not JSON). The client names itself in
//                                      x-morndo-client (a-z, at most 16), for the audit of side-effecting ops.
//   GET  /v1/files/<node>/<ref|path>   the file, streamed; the ref or path URL-encoded as one path segment
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert" | "job", node, body }; a
//                                      client more than eventsBufferBytes behind is closed with 1013 (it reconnects
//                                      and gets the current state first)
// The path is split on "/" before any segment is decoded, so a name or path holding "/" (as %2F) stays one segment
// (Review Focus 1). Over a Unix socket the server listens with node:http's listen(path)
// (https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenpath-backlog-callback, read 2026-10-06).
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { CLIENT_API, JobsQuerySchema, LIMITS, NODE_NAME, parseBody, parseWorkerId, type JobView, type JobsQuery } from "@morndo/protocol";
import { Flight, productVersion } from "@morndo/service-kit";
import type { Connections } from "../application/connections.ts";
import type { EventHub, FleetEvent } from "../application/events.ts";
import type { JobMirror } from "../application/job-mirror.ts";
import type { LaneRegistry } from "../application/lane-registry.ts";
import { SIDE_EFFECT_OPS, opError, type Outcome } from "../application/requests.ts";
import type { Router } from "../application/router.ts";
import type { Audit } from "./audit.ts";
import { streamFile } from "./files-route.ts";
import type { Logger } from "./log.ts";
import type { NodesStore } from "./nodes-store.ts";
import { parseOpBody } from "./op-body.ts";
import { clearStaleSocket, prepareSocketDir } from "./socket-dir.ts";
import { SCHEMA_VERSION } from "./migrations.ts";

export const API_VERSIONS = [CLIENT_API - 1, CLIENT_API].filter(v => v >= 1);
// How long a stopping service lets the requests it is answering finish before it closes every connection left (B6 S1).
// The ops in flight are answered at once (Connections.stop() settles them first); this bounds a file still streaming.
export const CLOSE_DRAIN_MS = 2000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type ClientApiDeps = {
  router: Router; connections: Connections; lanes: LaneRegistry; nodes: NodesStore; audit: Audit; events: EventHub; jobs: JobMirror; log: Logger;
  eventsBufferBytes?: number;
  updates?: { schema?: number; held: () => boolean; flight: Flight };
};
export type ClientApi = { close(): Promise<void> };

const CLIENT = /^[a-z]{1,16}$/;
// The client that asks, as it names itself; anything else is "unknown" (the socket is the owner's anyway, spec 8).
const clientOf = (req: IncomingMessage): string => {
  const h = req.headers["x-morndo-client"];
  return typeof h === "string" && CLIENT.test(h) ? h : "unknown";
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

// A body that isn't JSON, by its content type or its content, is 415 (RFC 9110 §15.5.16: the format problem "might be
// due to the request's indicated Content-Type ... or as a result of inspecting the data directly", read 2026-10-06);
// one over LIMITS.maxPayload is 413.
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send the body as JSON, with content-type application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxPayload) throw new HttpError(413, `the body is over ${LIMITS.maxPayload} bytes`);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new HttpError(415, "the body is not JSON"); }
}

function jobsQuery(url: string | undefined): JobsQuery {
  const params = new URL(url ?? "/", "http://fleet").searchParams;
  const raw: Record<string, string> = {};
  for (const key of ["node", "lane", "state"] as const) {
    const value = params.get(key);
    if (value) raw[key] = value;
  }
  const parsed = parseBody(JobsQuerySchema, raw);
  if (!parsed) throw new HttpError(400, "bad query");
  return parsed;
}

// The route's segments after the version, each decoded once; null when the version isn't one this service speaks.
function segments(url: string | undefined): string[] | null {
  const raw = (url ?? "/").split("?")[0] ?? "/";
  let parts: string[];
  try { parts = raw.split("/").slice(1).map(s => decodeURIComponent(s)); } catch { throw new HttpError(400, "bad URL encoding"); }
  const version = /^v(\d+)$/.exec(parts[0] ?? "");
  if (!version || !API_VERSIONS.includes(Number(version[1]))) return null;
  return parts.slice(1);
}

// Cancel follows the job. A lane or a worker still reaches the node that owns that id; the token stays in the
// args, and only that token's lane may cancel, which the owning node checks.
function jobOwner(d: ClientApiDeps, id: string, target: { node: string } | { lane: string } | { workerId: string }): JobView | null {
  if ("node" in target) return d.jobs.get(target.node, id);
  const rows = d.jobs.find(id);
  if ("lane" in target) {
    const named = rows.filter(job => job.lane === target.lane);
    if (named.length === 1) return named[0] ?? null;
    const lane = d.lanes.get(target.lane);
    if (lane && !lane.conflict) {
      const on = rows.filter(job => job.node === lane.node);
      if (on.length === 1) return on[0] ?? null;
    }
    return null;
  }
  const ref = parseWorkerId(target.workerId);
  if (!ref) return null;
  const on = rows.filter(job => job.node === ref.node);
  if (on.length === 1) return on[0] ?? null;
  return rows.length === 1 ? rows[0] ?? null : null;
}

export async function startClientApi(socketPath: string, d: ClientApiDeps): Promise<ClientApi> {
  prepareSocketDir(socketPath);
  await clearStaleSocket(socketPath);
  const eventsBufferBytes = d.eventsBufferBytes ?? LIMITS.eventsBufferBytes;

  const flight = d.updates?.flight ?? new Flight();
  const held = d.updates?.held ?? (() => false);
  const schema = d.updates?.schema ?? SCHEMA_VERSION;
  // A revocation still runs during a hold (RL9). Every other side effect is refused before it is sent.
  function heldRefusal(op: Parameters<Router["op"]>[1]): { status: number; outcome: Outcome } | null {
    if (held() && SIDE_EFFECT_OPS.has(op) && op !== "connections.revoke") {
      return { status: 503, outcome: { ok: false, error: opError("updating", "the fleet is not taking new work while it updates"), store: null, storeSeq: null } };
    }
    return null;
  }
  async function runOp(target: Parameters<Router["op"]>[0], op: Parameters<Router["op"]>[1], args: Parameters<Router["op"]>[2], o: Parameters<Router["op"]>[3]): Promise<{ status: number; outcome: Outcome }> {
    const refusal = heldRefusal(op);
    if (refusal) return refusal;
    const end = SIDE_EFFECT_OPS.has(op) ? flight.begin({ kind: op, id: o?.key ?? op }) : null;
    try { return { status: 200, outcome: await d.router.op(target, op, args, o) }; }
    finally { end?.(); }
  }
  const answerOp = (res: ServerResponse, ran: { status: number; outcome: Outcome }) =>
    json(res, ran.status, ran.outcome, ran.status === 503 ? { "Retry-After": "1" } : {});

  async function route(req: IncomingMessage, res: ServerResponse, s: string[]): Promise<void> {
    const method = req.method ?? "GET";
    const [first, second, third] = s;
    if (method === "GET" && s.length === 1 && first === "health") {
      return json(res, 200, { version: productVersion(), schema, ready: true, inFlight: flight.list() });
    }
    if (method === "GET" && s.length === 1 && first === "caps") return json(res, 200, { api: API_VERSIONS });
    if (method === "GET" && s.length === 1 && first === "nodes") return json(res, 200, d.connections.list());
    if (method === "POST" && s.length === 3 && first === "nodes" && third === "revoke") {
      const name = second ?? "";
      if (!NODE_NAME.test(name)) throw new HttpError(400, "not a node name");
      const revoked = d.nodes.revoke(name);
      if (revoked) d.audit.record("client", "node.revoke", name, { client: clientOf(req) });
      d.connections.revoke(name);                                     // closes it, and its lanes go (serve.ts)
      return json(res, 200, { ok: true, revoked });
    }
    if (method === "GET" && s.length === 1 && first === "lanes") return json(res, 200, d.lanes.list());
    if (method === "GET" && s.length === 2 && first === "lanes") {
      const lane = d.lanes.get(second ?? "");
      return lane ? json(res, 200, lane) : json(res, 404, { error: "no_such_lane" });
    }
    if (method === "GET" && s.length === 1 && first === "alerts") return json(res, 200, d.audit.recentAlerts());
    if (method === "GET" && s.length === 1 && first === "jobs") {
      const q = jobsQuery(req.url);
      const jobs = d.jobs.list(q);
      const nodes = jobs.map(job => job.node);
      if (q.node !== undefined) nodes.push(q.node);
      return json(res, 200, { jobs, stale: d.jobs.stale(nodes) });
    }
    if (method === "GET" && s.length === 3 && first === "jobs") {
      const job = d.jobs.get(second ?? "", third ?? "");
      return job ? json(res, 200, { job, stale: d.jobs.stale([job.node]) }) : json(res, 404, { error: "no_such_job" });
    }
    if (method === "POST" && s.length === 1 && first === "op") {
      // Every answer here has the op's shape, refusals of the body included: clients read the body, not the status.
      let body: unknown;
      try { body = await readJson(req); }
      catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return json(res, e.status, { ok: false, error: opError(e.status === 413 ? "too_large" : "bad_args", e.message), store: null, storeSeq: null });
      }
      const parsed = parseOpBody(body);
      if (!parsed.ok) return json(res, 400, { ok: false, error: opError("bad_args", parsed.message), store: null, storeSeq: null });
      const b = parsed.body;
      // Cancel follows the job, not the node the caller named. The token stays in the args the owning node checks.
      if (b.op === "job.noticeResult") {
        const id = typeof b.args.id === "string" ? b.args.id : "";
        const notice = b.args.notice === "commented" || b.args.notice === "given_up" ? b.args.notice : null;
        const node = "node" in b.target ? b.target.node : "";
        if (!notice || !node) return json(res, 200, { ok: false, error: opError("bad_args", "missing"), store: null, storeSeq: null });
        const refusal = heldRefusal(b.op);
        if (refusal) return answerOp(res, refusal);
        const stored = d.jobs.report(node, id, notice);
        if (!stored) return json(res, 200, { ok: false, error: opError("denied", "missing"), store: null, storeSeq: null });
        const ran = await runOp({ node: stored.node }, b.op, { id, notice }, {
          client: clientOf(req), ...(b.key === undefined ? {} : { key: b.key }), ...(b.timeoutMs === undefined ? {} : { timeoutMs: b.timeoutMs }),
        });
        if (ran.outcome.ok) d.jobs.holdNotice(stored.node, stored.id, notice);
        return answerOp(res, ran);
      }
      if (b.op === "job.cancel") {
        const id = typeof b.args.id === "string" ? b.args.id : "";
        const owned = jobOwner(d, id, b.target);
        if (!owned) return json(res, 200, { ok: false, error: opError("denied", "missing"), store: null, storeSeq: null });
        return answerOp(res, await runOp({ node: owned.node }, b.op, b.args, {
          client: clientOf(req), ...(b.key === undefined ? {} : { key: b.key }), ...(b.timeoutMs === undefined ? {} : { timeoutMs: b.timeoutMs }),
        }));
      }
      return answerOp(res, await runOp(b.target, b.op, b.args, {
        client: clientOf(req), ...(b.key === undefined ? {} : { key: b.key }), ...(b.timeoutMs === undefined ? {} : { timeoutMs: b.timeoutMs }),
      }));
    }
    if (method === "GET" && s.length === 3 && first === "files") return streamFile(res, d.router, second ?? "", third ?? "");
    throw new HttpError(404, "no such route");
  }

  // Each request is handled to its end here, with its own catch, so the promise is dropped on purpose.
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const s = segments(req.url);
      if (s === null) return json(res, 404, { error: "unsupported_api", api: API_VERSIONS });
      await route(req, res, s);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) d.log.error(`client API: ${req.method ?? "?"} failed`, e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
      else res.destroy();
    }
  }

  // WS /v1/events: every registered node's status first, then each online node's latest inventory and health, then
  // each event as it happens. A client that doesn't read keeps its events in our memory (ws's bufferedAmount): past
  // eventsBufferBytes it is closed with 1013 and unsubscribed, and gets the current state again when it reconnects.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    let s: string[] | null;
    try { s = segments(req.url); } catch { s = null; }
    if (!s || s.length !== 1 || s[0] !== "events") { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      let unsubscribe = () => {};
      const send = (e: FleetEvent) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > eventsBufferBytes) {
          unsubscribe();
          d.log.warn(`events socket: a client is ${ws.bufferedAmount} bytes behind; closing it (1013)`);
          ws.close(1013, "too far behind; reconnect for the current state");
          return;
        }
        ws.send(JSON.stringify(e));
      };
      const nodes = d.connections.list();
      for (const n of nodes) send({ t: "status", node: n.name, body: { status: n.status } });
      for (const n of nodes.filter(x => x.status === "online")) {
        const latest = d.connections.latest(n.name);
        if (latest.inventory) send({ t: "inventory", node: n.name, body: latest.inventory });
        if (latest.health) send({ t: "health", node: n.name, body: latest.health });
      }
      for (const job of d.jobs.snapshot()) send({ t: "job", node: job.node, body: job });
      unsubscribe = d.events.subscribe(send);
      ws.on("error", e => d.log.warn(`events socket: ${e.message}`));
      ws.on("close", () => { clients.delete(ws); unsubscribe(); });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  return {
    // server.close() stops accepting and closes the idle connections; one still answering (a POST /v1/op whose outcome
    // Connections.stop() has just settled) keeps its socket until its reply is written, so the client gets the outcome
    // and its store instead of "socket hang up", and is closed as soon as it is idle again (closeIdleConnections, every
    // 20 ms). Whatever is still open after CLOSE_DRAIN_MS is closed then by closeAllConnections(), which takes "active
    // connections connected to this server which are sending a request or waiting for a response" too, called after
    // server.close() as the docs recommend (https://nodejs.org/docs/latest-v24.x/api/http.html#servercloseallconnections,
    // read 2026-10-07).
    close: () => new Promise<void>(resolve => {
      for (const ws of clients) ws.terminate();
      wss.close();
      const reap = setInterval(() => server.closeIdleConnections(), 20);
      const drain = setTimeout(() => server.closeAllConnections(), CLOSE_DRAIN_MS);
      server.close(() => {
        clearInterval(reap);
        clearTimeout(drain);
        try { unlinkSync(socketPath); } catch { /* already gone */ }
        resolve();
      });
      server.closeIdleConnections();
    }),
  };
}
