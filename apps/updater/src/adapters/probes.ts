// The RoleProbe adapter (design §4.6 probe-hub, probe-fleet, probe-node; §6.3, §6.4): every service is asked from
// outside itself — the hub over HTTP on this machine only, the fleet over its Unix socket, the agent from the
// status.json it rewrites on every health tick and every change — and decoded with the wire's own schemas.
// Anything short of the full answer reads as silence, and silence is not quiet (§6.3): a service the probe cannot
// vouch for is never guessed quiet, and a health answer without the version is no judgement at all (§6.4). The
// hub's URL must be loopback: through the network proxy its answer carries `ready` only, and this probe exists to
// read the machine's own word.
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, statSync } from "node:fs";
import type { HealthReport, SafePointReport, UpdateService } from "@morndo/domain";
import {
  NodeStatusHealth, ServiceHealth, parseBody,
  type NodeStatusHealth as NodeStatusDoc, type ServiceHealth as ServiceHealthDoc,
} from "@morndo/protocol";
import type { RoleProbe } from "../application/ports.ts";

// A health answer is small — the wire caps in-flight work at 100 items — so the exchange is capped at the same
// 64 KiB every signed document is (§10.2 step 5): a host that answers endlessly answers nothing.
const ANSWER_CAP = 64 * 1024;
// The agent rewrites status.json on every health tick; a file this old describes a writer that is not writing,
// and its word about what is in flight is stale (§6.3: blockers are work in flight, now).
const STATUS_MAX_AGE_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;

const decodeText = new TextDecoder();
const blockersOf = (inFlight: readonly { kind: string; id: string }[]): string[] =>
  inFlight.map(i => `${i.kind} ${i.id}`);

// A pid names a live writer or it names nobody: signal 0 asks without sending anything. EPERM still names a
// process (one this user may not signal); ESRCH names none.
export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

// One HTTP exchange, whole and inside `timeoutMs`, or null: a service that does not answer within the wall has
// not answered (§6.4), and a probe never throws on a service that is down — that is what null is for.
// `secure` selects node:https with Node's own certificate checks (rejectUnauthorized stays true). A caller never
// turns them off: a TLS failure is an answer of null, the same as a timeout.
const exchange = (o: RequestOptions & { secure?: boolean }, timeoutMs: number): Promise<{ status: number; body: string } | null> =>
  new Promise(resolve => {
    let settled = false;
    let overdue: ReturnType<typeof setTimeout> | null = null;
    const answer = (r: { status: number; body: string } | null): void => {
      if (settled) return;
      settled = true;
      if (overdue !== null) clearTimeout(overdue);
      resolve(r);
    };
    const { secure, ...options } = o;
    const req = (secure === true ? httpsRequest : httpRequest)(
      secure === true ? { ...options, rejectUnauthorized: true } : options,
      res => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        res.on("data", (chunk: Uint8Array) => {
          size += chunk.byteLength;
          if (size > ANSWER_CAP) { answer(null); req.destroy(); return; }
          chunks.push(chunk);
        });
        res.on("end", () => answer({ status: res.statusCode ?? 0, body: decodeText.decode(Buffer.concat(chunks)) }));
        res.on("error", () => answer(null));
      },
    );
    overdue = setTimeout(() => { answer(null); req.destroy(); }, timeoutMs);
    req.on("error", () => answer(null));
    req.end();
  });

// The owner path (C4-6), named on the hub's report only, and only when the probe was built with it. `origin` is
// the https address MORNDO_ORIGIN names (http solely for localhost or 127.0.0.1). No origin: that check is not named.
export type OwnerPath = { origin?: string; managerLane?: boolean };

// https, or http on localhost or 127.0.0.1. Anything else is refused before a probe dials it.
export const ownerOriginAllowed = (origin: string): boolean => {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.hostname === "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
};

export class ServiceProbes implements RoleProbe {
  readonly #hub: URL;
  readonly #fleetSocket: string;
  readonly #agentStatusPath: string;
  readonly #timeoutMs: number;
  readonly #owner: { origin: URL | null; managerLane: boolean } | null;

  constructor(o: { hubUrl: string; fleetSocket: string; nodeStatus: string; timeoutMs?: number; ownerPath?: OwnerPath }) {
    const hub = new URL(o.hubUrl);
    // §6.4 reads the hub on this machine; a URL anywhere else is a wiring mistake, refused before anything dials.
    if (hub.hostname !== "127.0.0.1" && hub.hostname !== "localhost") {
      throw new Error(`${o.hubUrl}: the hub's health is read on this machine (127.0.0.1), not there`);
    }
    this.#hub = hub;
    this.#fleetSocket = o.fleetSocket;
    this.#agentStatusPath = o.nodeStatus;
    this.#timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (o.ownerPath === undefined) {
      this.#owner = null;
    } else if (o.ownerPath.origin !== undefined && !ownerOriginAllowed(o.ownerPath.origin)) {
      throw new Error(`${o.ownerPath.origin}: an origin is https, or http on localhost or 127.0.0.1`);
    } else {
      this.#owner = {
        origin: o.ownerPath.origin === undefined ? null : new URL(o.ownerPath.origin),
        managerLane: o.ownerPath.managerLane !== false,
      };
    }
  }

  // The service's word that it has seen hold.json (`held`, from its HoldWatch). A service from before that word says
  // nothing, which is no acknowledgement: the apply then waits it out and defers (§6.2 step 3).
  async seesHold(s: UpdateService): Promise<boolean | null> {
    const doc = s === "node" ? this.#agentStatus() : await this.#serviceHealth(s);
    return doc === null || doc.held === undefined ? null : doc.held;
  }

  async safePoint(s: UpdateService): Promise<SafePointReport | null> {
    if (s === "node") {
      const status = this.#agentStatus();
      // An older agent's status file says nothing about work in flight; that is no word, never quiet (§6.3).
      if (status === null || !("inFlight" in status)) return null;
      return { service: s, blockers: blockersOf(status.inFlight) };
    }
    const health = await this.#serviceHealth(s);
    return health === null ? null : { service: s, blockers: blockersOf(health.inFlight) };
  }

  async health(s: UpdateService): Promise<HealthReport | null> {
    if (s === "node") {
      const status = this.#agentStatus();
      return status === null
        ? null
        : { service: s, version: status.version, checks: { ready: status.ready, fleet_online: status.state === "online" } };
    }
    const health = await this.#serviceHealth(s);
    if (health === null) return null;
    const checks: Record<string, boolean> = { ready: health.ready };
    // The owner path is the hub's, and only after the hub itself answered: no report is still no_report (§6.4).
    if (s === "hub" && this.#owner !== null) {
      checks.owner_app_served = await this.#ownerAppServed();
      if (this.#owner.origin !== null) checks.owner_origin_ready = await this.#ownerOriginReady(this.#owner.origin);
      if (this.#owner.managerLane) checks.owner_manager_lane = await this.#ownerManagerLane();
    }
    return { service: s, version: health.version, checks };
  }

  // GET / on the hub's own loopback host and port. 200 with a body is the app; 503 (not built), anything else,
  // a timeout or a hub that is gone is a failed check — never a throw.
  async #ownerAppServed(): Promise<boolean> {
    try {
      const answer = await exchange({
        hostname: this.#hub.hostname,
        port: this.#hub.port === "" ? 80 : Number(this.#hub.port),
        path: "/",
        method: "GET",
      }, this.#timeoutMs);
      return answer !== null && answer.status === 200 && answer.body.length > 0;
    } catch { return false; }
  }

  // GET <origin>/api/health on the origin's own scheme. `ready: true` at 200 is the only pass.
  async #ownerOriginReady(origin: URL): Promise<boolean> {
    try {
      const secure = origin.protocol === "https:";
      const answer = await exchange({
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port === "" ? (secure ? 443 : 80) : Number(origin.port),
        path: "/api/health",
        method: "GET",
        secure,
      }, this.#timeoutMs);
      if (answer === null || answer.status !== 200) return false;
      const value: unknown = JSON.parse(answer.body);
      return typeof value === "object" && value !== null && (value as { ready?: unknown }).ready === true;
    } catch { return false; }
  }

  // The manager's window: the lane exists and is not in conflict, and its node is online (§5.1 status).
  async #ownerManagerLane(): Promise<boolean> {
    try {
      const lane = await this.#fleetGet("/v1/lanes/manager");
      if (lane === null || lane.status !== 200) return false;
      const doc: unknown = JSON.parse(lane.body);
      if (typeof doc !== "object" || doc === null) return false;
      const { conflict, node } = doc as { conflict?: unknown; node?: unknown };
      if (conflict !== false || typeof node !== "string" || node === "") return false;
      const nodes = await this.#fleetGet("/v1/nodes");
      if (nodes === null || nodes.status !== 200) return false;
      const rows: unknown = JSON.parse(nodes.body);
      if (!Array.isArray(rows)) return false;
      const listed = rows.find(row =>
        typeof row === "object" && row !== null && (row as { name?: unknown }).name === node);
      return listed !== undefined && (listed as { status?: unknown }).status === "online";
    } catch { return false; }
  }

  #fleetGet(path: string): Promise<{ status: number; body: string } | null> {
    return exchange({
      socketPath: this.#fleetSocket,
      path,
      method: "GET",
      headers: { "x-morndo-client": "updater" },
    }, this.#timeoutMs);
  }

  // The hub's and the fleet's own answer, decoded by the strict schema: a ready-only shape (the proxy's) or any
  // other is null — no version means no judgement (§6.4).
  async #serviceHealth(s: "hub" | "fleet"): Promise<ServiceHealthDoc | null> {
    const options: RequestOptions = s === "hub"
      ? {
        hostname: this.#hub.hostname,
        port: this.#hub.port === "" ? 80 : Number(this.#hub.port),
        path: "/api/health",
        method: "GET",
      }
      : { socketPath: this.#fleetSocket, path: "/v1/health", method: "GET" };
    const answer = await exchange(options, this.#timeoutMs);
    if (answer === null || answer.status !== 200) return null;
    let value: unknown;
    try { value = JSON.parse(answer.body); } catch { return null; }
    return parseBody(ServiceHealth, value);
  }

  // The agent's status file: fresh (the agent rewrites it constantly), the shape the wire knows, and a writer
  // that still lives — a file from a dead or hung agent describes a machine that no longer exists.
  #agentStatus(): NodeStatusDoc | null {
    let text: string;
    let rewrittenAt: number;
    try {
      text = readFileSync(this.#agentStatusPath, "utf8");
      rewrittenAt = statSync(this.#agentStatusPath).mtimeMs;
    } catch { return null; }
    if (Date.now() - rewrittenAt > STATUS_MAX_AGE_MS) return null;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return null; }
    const status = parseBody(NodeStatusHealth, raw);
    if (status === null) return null;
    const pid = (raw as { pid?: unknown }).pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return null;
    return status;
  }
}
