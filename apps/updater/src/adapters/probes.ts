// The RoleProbe adapter (design §4.6 probe-hub, probe-fleet, probe-node; §6.3, §6.4): every service is asked from
// outside itself — the hub over HTTP on this machine only, the fleet over its Unix socket, the agent from the
// status.json it rewrites on every health tick and every change — and decoded with the wire's own schemas.
// Anything short of the full answer reads as silence, and silence is not quiet (§6.3): a service the probe cannot
// vouch for is never guessed quiet, and a health answer without the version is no judgement at all (§6.4). The
// hub's URL must be loopback: through the network proxy its answer carries `ready` only, and this probe exists to
// read the machine's own word.
import { request, type RequestOptions } from "node:http";
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
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

// One HTTP exchange, whole and inside `timeoutMs`, or null: a service that does not answer within the wall has
// not answered (§6.4), and a probe never throws on a service that is down — that is what null is for.
const exchange = (o: RequestOptions, timeoutMs: number): Promise<{ status: number; body: string } | null> =>
  new Promise(resolve => {
    let settled = false;
    let overdue: ReturnType<typeof setTimeout> | null = null;
    const answer = (r: { status: number; body: string } | null): void => {
      if (settled) return;
      settled = true;
      if (overdue !== null) clearTimeout(overdue);
      resolve(r);
    };
    const req = request(o, res => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      res.on("data", (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > ANSWER_CAP) { answer(null); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => answer({ status: res.statusCode ?? 0, body: decodeText.decode(Buffer.concat(chunks)) }));
      res.on("error", () => answer(null));
    });
    overdue = setTimeout(() => { answer(null); req.destroy(); }, timeoutMs);
    req.on("error", () => answer(null));
    req.end();
  });

export class ServiceProbes implements RoleProbe {
  readonly #hub: URL;
  readonly #fleetSocket: string;
  readonly #agentStatusPath: string;
  readonly #timeoutMs: number;

  constructor(o: { hubUrl: string; fleetSocket: string; nodeStatus: string; timeoutMs?: number }) {
    const hub = new URL(o.hubUrl);
    // §6.4 reads the hub on this machine; a URL anywhere else is a wiring mistake, refused before anything dials.
    if (hub.hostname !== "127.0.0.1" && hub.hostname !== "localhost") {
      throw new Error(`${o.hubUrl}: the hub's health is read on this machine (127.0.0.1), not there`);
    }
    this.#hub = hub;
    this.#fleetSocket = o.fleetSocket;
    this.#agentStatusPath = o.nodeStatus;
    this.#timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    return health === null ? null : { service: s, version: health.version, checks: { ready: health.ready } };
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
