// HTTP + WebSocket adapter. Translates requests into application-service calls; holds no domain rules itself.
// Hardening per ADR-0004: Origin checks on every state change and upgrade, __Host- cookie, proxy identity gate,
// CSP with hashes of the app's inline scripts, small bodies, rate limits on the passkey endpoints.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { hostname } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { CONVERSATION_CAP, LONGEST_SESSION_MS, STAY_CHOICES, STEP_UP_CHOICES, formatFingerprint, type BoardActor, type FeedEvent, type Transcription } from "@morndo/domain";
import { Flight, HoldWatch, productStamp } from "@morndo/service-kit";
import { catchUp } from "../application/catchup.ts";
import { chats, digest } from "../application/chats.ts";
import type { PresenceService } from "../application/presence-service.ts";
import type { Config } from "../config.ts";
import type { HubIdentity } from "./identity.ts";
import type { Store } from "./store.ts";
import type { AccessService, Authenticated } from "../application/access-service.ts";
import type { ObservationService, OlderResult } from "../application/observation-service.ts";
import type { SendResult, SteeringService } from "../application/steering-service.ts";
import type { EscalationService } from "../application/escalation-service.ts";
import type { RemoteService, Viewer } from "../application/remote-service.ts";
import type { ReadingService } from "../application/reading-service.ts";
import type { NotificationService } from "../application/notification-service.ts";
import { queuedCommand, type ManagerQueue } from "../application/manager-queue.ts";
import type { EnginesService } from "../application/engines-service.ts";
import type { ConnectionsPageService } from "../application/connections-page.ts";
import type { BoardService } from "../application/board-service.ts";
import type { ProofService } from "../application/proof-service.ts";
import type { AgentAccess } from "../application/agent-access.ts";
import type { JobsService } from "../application/jobs-service.ts";
import type { AlertsService } from "../application/alerts-service.ts";
import type { UsageService } from "../application/usage-service.ts";
import type { TranscriptionService } from "../application/transcription-service.ts";
import type { BriefService } from "../application/brief-service.ts";
import type { MemoryService } from "../application/memory-service.ts";
import type { UpdatesCommandOutcome, UpdatesService } from "../application/updates-service.ts";
import { BRIEF_TEMPLATE } from "./brief-template.ts";
import { bridgeDesktop } from "./rfb.ts";
import { servingHeaders, type Files } from "./files.ts";
import type { Inbox } from "./uploads.ts";
import { MAX_UPLOAD_BYTES, unreachable } from "@morndo/domain";
import {
  AnswerBody, BoardActionBody, BoardCreateBody, CancelBody, ClientFeedFrames, ClientTerminalFrames, EnginesSaveBody, IdentityProveBody,
  LinkDecisionBody, LIMITS as PROTO_LIMITS, MemoryInvalidateBody, MemoryRememberBody, NarrowCommand, PairCheckBody, PairOptionsBody, PasskeyVerifyBody, PolicyBody, PriorityCommand, PushSubscriptionBody,
  RevokeCommand, RoleCommand, SendBody, TranscriptionCancelBody, TranscriptionCreateBody, UPLOAD_NAME_HEADER, UpdatesApplyBody, UpdatesResumeBody, UpdatesRollbackBody, UsageForgetBody, UsageLeaseBody, UsageLimitBody, UsagePoolBody, UsageReadingsBody, UsageReportBody, UsageSeatClearBody,
  decode, isWorkerOrLegacyId, parseBody, type CommandKind, type FrameOf, type Output, type Schema,
} from "@morndo/protocol";
import { log } from "./log.ts";
import { SCHEMA_VERSION } from "./migrations.ts";
import { redactFeed, redactResponse } from "./view-redact.ts";
import { RateLimiter, takeAll, type BucketConfig, type Taken } from "./rate-limit.ts";

const COOKIE = "__Host-morndo";
const MAX_BODY = 64 * 1024;
// A Note's own limits are characters (MEMORY_LIMITS): 20,000 of them can be 120 KB as JSON that escapes every character
// (\uXXXX), so a Note's body gets room for that, and no more.
const MEMORY_MAX_BODY = 160 * 1024;
// A send's text is at most PROTO_LIMITS.maxMessageText characters, each one escaped \uXXXX in JSON (the same reasoning
// as MEMORY_MAX_BODY), plus the body's other fields.
const SEND_MAX_BODY = PROTO_LIMITS.maxMessageText * 6 + 16 * 1024;
// The terminal view's frames: asked every 80 ms; while they are unavailable, at most every 2 s (streamTerminal).
const FRAME_POLL_MS = 80;
const FRAME_BACKOFF_MAX_MS = 2000;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2",
};

class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) { super(message); this.status = status; this.headers = headers; }
}

// Rate limits (ADR-0008, A6): token buckets, refused with 429 and Retry-After in whole seconds, rounded up.
export type Limits = Record<"passkeyPerCaller" | "passkeyGlobal" | "commands" | "uploads" | "feedFrames" | "linkRequests" | "linkPolls" | "engineReads" | "agentCalls" | "agentRefusals" | "transcriptions", BucketConfig>;
export const LIMITS: Limits = {
  passkeyPerCaller: { capacity: 10, refillPerSecond: 1 / 6 },      // pairing and login: 10 at once, then 10 a minute per caller
  passkeyGlobal: { capacity: 60, refillPerSecond: 1 },             // and a looser ceiling for everyone together
  commands: { capacity: 30, refillPerSecond: 0.5 },                // sends and answers: 30 at once, then 30 a minute per Endpoint
  uploads: { capacity: 60, refillPerSecond: 1 },                   // images: 60 a minute per Endpoint, as before
  feedFrames: { capacity: 100, refillPerSecond: 20 },              // the app sends a few a minute; a flood closes with 1008
  // Phase E: Link requests are unauthenticated: 5 at once per caller, then one a minute (and at most 3 open, AC11);
  // a waiting device asks every 2 s for up to 10 minutes.
  linkRequests: { capacity: 5, refillPerSecond: 1 / 60 },
  linkPolls: { capacity: 60, refillPerSecond: 1 },
  // ADR-0013: a look at the Engines page runs the engine CLI 3 + N times: 10 at once, then 10 a minute per Endpoint, in
  // its own bucket, so reloading it never spends the commands a device answers and sends with.
  engineReads: { capacity: 10, refillPerSecond: 1 / 6 },
  // ADR-0015: the agents' board calls, per token (a lane lists the board often, and one worker token may serve many
  // lanes), and refused ones per caller address, so a guessed token is slow to try.
  agentCalls: { capacity: 120, refillPerSecond: 2 },
  agentRefusals: { capacity: 20, refillPerSecond: 1 / 6 },
  // ADR-0021: an ask costs a probe and a queue slot behind runs that hold half the cores: 30 at once, then 30 a
  // minute per Endpoint, as commands are. Spent whatever the plugin answers, so a looping client spends its own
  // bucket and not the machine's queue alone (the queue cap is the second door).
  transcriptions: { capacity: 30, refillPerSecond: 0.5 },
};
const limited = (t: Taken) => {
  if (!t.ok) throw new HttpError(429, "rate_limited", { "Retry-After": String(t.retryAfterSeconds) });
};

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

// The file's own name, percent-encoded so a quote or a newline in it can't become another header. Empty when the
// client didn't send one (an image paste): the inbox then accepts an image by its bytes alone.
function uploadName(req: IncomingMessage): string {
  const raw = req.headers[UPLOAD_NAME_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return "";
  try { return decodeURIComponent(v).slice(0, 200); }
  catch { return ""; }
}

// A raw body up to `max` bytes (a file the principal pastes); more is refused while it streams.
async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "too_big");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

// A JSON body decoded with its protocol schema (ADR-0008, A2): 400 "bad_request" before any service sees it.
async function readBody<S extends Schema>(req: IncomingMessage, schema: S, max = MAX_BODY): Promise<Output<S>> {
  const v = parseBody(schema, await readJson(req, max));
  if (v === null) throw new HttpError(400, "bad_request");
  return v;
}

async function readJson(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

// SvelteKit's static build bootstraps with an inline script; allow exactly that script by hash, nothing else inline.
function cspFor(html: string): string {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`);
  return [
    "default-src 'self'", `script-src 'self' ${hashes.join(" ")}`.trim(), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'",
    "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
  ].join("; ");
}

// One URL path segment, percent-decoded once (the URL's pathname keeps the escapes it came with), or null: a malformed
// escape (decodeURIComponent throws a URIError) or a segment that decodes to "/" or "\0", which would be another path
// once joined. A path is split into its segments first and never decoded whole: decoding it whole turned a stray "%"
// into a URIError, a 500 (GET /%, and every signed-in request that got as far as the send route, /api/workers/%/send
// among them), and an escaped "/" into a separator.
function decodeSegment(segment: string): string | null {
  let s: string;
  try { s = decodeURIComponent(segment); } catch { return null; }
  return s.includes("/") || s.includes("\0") ? null : s;
}

// A worker id from one URL path segment (the app sends encodeURIComponent(id), so "%1" travels as "%251"): the fleet's
// `<node>.<server>.<pane>` or a legacy `%N` (packages/protocol worker-id.ts), else null.
export function workerIdFromSegment(segment: string): string | null {
  const id = decodeSegment(segment);
  return id !== null && isWorkerOrLegacyId(id) ? id : null;
}

function transcriptionView(row: Transcription) {
  return {
    id: row.id, recording: row.recording, language: row.language, state: row.state,
    position: row.position, reason: row.reason, outcome: row.outcome, problem: row.problem, text: row.text,
  };
}

// 127.0.0.1, ::1, and IPv4-mapped ::ffff:127.0.0.1. A missing address is not this machine.
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const host = address.split("%")[0] ?? "";
  if (host === "127.0.0.1" || host === "::1") return true;
  return host === "::ffff:127.0.0.1";
}

// Full version, schema and in-flight only for a session, or for this machine before any proxy identity.
// A missing identity header is not enough: a tagged device or a public request gets ready only.
export function healthDetail(opts: { remoteAddress: string | undefined; proxyLogin: string | undefined; authenticated: boolean }): "full" | "ready" {
  if (opts.authenticated) return "full";
  const viaProxy = typeof opts.proxyLogin === "string" && opts.proxyLogin.length > 0;
  if (!viaProxy && isLoopbackAddress(opts.remoteAddress)) return "full";
  return "ready";
}

export function startHttp(p: {
  config: Config; identity: HubIdentity; access: AccessService; observation: ObservationService; steering: SteeringService; escalations: EscalationService;
  remote: RemoteService; store: Store; files?: Files | null; inbox?: Inbox | null; limits?: Limits; now?: () => number; heartbeatMs?: number;
  reading?: ReadingService | null;
  updates?: { schema?: number; holdPath?: string; now?: () => number };
  presence?: PresenceService | null;                                        // ADR-0011: his last activity per device
  push?: { publicKey: Buffer; notifications: NotificationService } | null;   // web push (phase F); null: off
  engines?: EnginesService | null;                                          // ADR-0013: the Engines page; null: not connected
  updatesService?: UpdatesService | null;                                   // updates §8.1 (PR 6c): every machine's Version; null: no fleet and no CLI
  connections?: ConnectionsPageService | null;                              // ADR-0018: LLM connections; null: no home set
  board?: { service: BoardService; agents: AgentAccess; proof?: ProofService } | null;   // ADR-0015: the board (proof: ADR-0035, B13; absent: briefs are not seeded); null: off
  usage?: UsageService | null;                                              // ADR-0016: the accounts' usage; null: off
  queue?: ManagerQueue | null;                                              // the manager's delivery queue (fleet-clients §9.1); null without a fleet
  jobs?: JobsService | null;                                                // the fleet's job mirror; null: off
  alerts?: AlertsService | null;                                            // the fleet's alerts in the app; null: no fleet
  transcription?: TranscriptionService | null;                              // ADR-0021; null: the plugin is not wired
  briefs?: BriefService | null;                                             // ADR-0023: decision briefs; null: off
  memory?: { service: MemoryService; agents: AgentAccess } | null;          // ADR-0031: Memory's agent door, board or not; null: off
}) {
  const { config, identity, access, observation, steering, escalations, remote } = p;
  const files = p.files ?? null;
  const inbox = p.inbox ?? null;
  const limits = p.limits ?? LIMITS;
  const clock = p.now ?? Date.now;
  const buckets = {
    passkeyPerCaller: new RateLimiter(limits.passkeyPerCaller, clock), passkeyGlobal: new RateLimiter(limits.passkeyGlobal, clock),
    commands: new RateLimiter(limits.commands, clock), uploads: new RateLimiter(limits.uploads, clock), feedFrames: new RateLimiter(limits.feedFrames, clock),
    linkRequests: new RateLimiter(limits.linkRequests, clock), linkPolls: new RateLimiter(limits.linkPolls, clock),
    engineReads: new RateLimiter(limits.engineReads, clock),
    agentCalls: new RateLimiter(limits.agentCalls, clock), agentRefusals: new RateLimiter(limits.agentRefusals, clock),
    transcriptions: new RateLimiter(limits.transcriptions, clock),
  };
  // Who is asking, for the per-caller buckets: the proxy's identity header (the person on the private network), else the
  // remote address. Never a header a caller could pick freely when the proxy doesn't set one: only the proxy's own.
  const callerOf = (req: IncomingMessage) => {
    const login = req.headers["tailscale-user-login"];
    return typeof login === "string" && login ? `login:${login}` : `addr:${req.socket.remoteAddress ?? "?"}`;
  };
  const microphone = () => p.transcription?.allowsMicrophone() ? "microphone=(self)" : "microphone=()";
  const flight = new Flight();
  const watch = new HoldWatch({
    path: p.updates?.holdPath ?? join(config.dataDir, "hold.json"),
    service: "hub",
    ...(p.updates?.now ? { now: p.updates.now } : {}),
    onStale: message => log.warn(message),
  });
  watch.start();
  let draining = false;
  const heldNow = () => watch.held || draining;
  const schemaVersion = p.updates?.schema ?? SCHEMA_VERSION;
  // A write, other than a revocation, a narrowing or a sign-in, is refused while hold.json names the hub (RL9).
  const refusesWhenHeld = (method: string, path: string) => {
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
    if (path.endsWith("/revoke") || path.endsWith("/narrow")) return false;
    if (path === "/api/login/options" || path === "/api/login/verify" || path === "/api/logout") return false;
    if (path.startsWith("/api/stepup/") || path.startsWith("/api/identity")) return false;
    return true;
  };

  const secureHeaders = () => ({
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": `camera=(), ${microphone()}, geolocation=(), payment=()`,
  });

  const proxyOk = (req: IncomingMessage) => {
    if (!config.requireProxyIdentity) return true;
    const login = req.headers["tailscale-user-login"];
    if (typeof login !== "string" || !login) return false;             // absent for tagged devices and Funnel
    return !config.principalLogin || login === config.principalLogin;
  };
  const originOk = (req: IncomingMessage) => req.headers.origin === config.origin;
  // A check the app makes on its own (a poll, not the principal acting) says so, and doesn't keep the Session from
  // going idle (AC5; review M3).
  const auth = (req: IncomingMessage) => access.authenticate(cookieValue(req, COOKIE), req.headers["x-morndo-background"] !== "1");
  // A session gets the full check. So does a request that never passed a proxy and whose socket is loopback.
  // A missing identity header is not loopback: a tagged device or a public request gets ready only (design section 6.4).
  function health(req: IncomingMessage, res: ServerResponse) {
    const login = req.headers["tailscale-user-login"];
    const detail = healthDetail({
      remoteAddress: req.socket.remoteAddress,
      proxyLogin: typeof login === "string" ? login : undefined,
      authenticated: auth(req) !== null,
    });
    if (detail === "ready") return json(res, 200, { ready: true });
    return json(res, 200, { ...productStamp(), schema: schemaVersion, ready: true, held: watch.held, inFlight: flight.list() });
  }

  // Every JSON body, including GET /api/escalations and an answer, is redacted here (ADR-0018 §6.2). Each names the
  // database's store (RL10, §11.5), so a device can stamp each Command with the hub store it saw before its first
  // attempt and a restored hub — another store — answers it uncertain instead of typing it twice.
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, path = "") => {
    res.writeHead(status, { ...secureHeaders(), "Content-Type": "application/json", "Cache-Control": "no-store", "Morndo-Store": p.store.storeId, ...extra });
    res.end(JSON.stringify(redactResponse(path, body)));
  };
  const setCookie = (secret: string) =>
    `${COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(LONGEST_SESSION_MS / 1000)}`;   // the hub enforces the policy's real limits
  const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  // A send's answer, to a worker or to the manager by its role: a repeat of one already typed or queued is 200 with where
  // it stands; a refusal is 403 (a fresh passkey first), 404 (no such window) or 409.
  const sent = (res: ServerResponse, r: SendResult) => {
    if (r.ok) return json(res, 200, r);
    if (r.problem === "duplicate") return json(res, 200, { error: "duplicate", ok: true, at: r.at, ...(r.delivery ? { delivery: r.delivery } : {}) });
    return json(res, r.problem === "step_up" ? 403 : r.problem === "no_pane" ? 404 : 409, { error: r.problem });
  };

  const deviceView = (a: Authenticated | null) => (e: ReturnType<AccessService["devices"]>[number]) => ({
    id: e.id, name: e.name, pairedAt: e.pairedAt, lastSeenAt: e.lastSeenAt, revokedAt: e.revokedAt, current: a?.endpoint.id === e.id,
  });

  // ADR-0015: the agents' side of the board. No cookie, no Origin, no proxy identity: a bearer token issued from the
  // console is the whole identity (agent-access.ts), and a worker token says which lane it acts as (X-Morndo-Lane).
  // A refusal spends the caller's refusal bucket; a call spends the token's.
  const boardProblemStatus = (problem: string) =>
    problem === "unknown" ? 404 : problem === "step_up" ? 403 : problem === "not_allowed" || problem === "not_yours" ? 403 : problem === "changed" || problem === "one_doing" || problem === "same" || problem === "not_live" || problem === "proof_not_green" || problem === "too_many" || problem === "no_commit" ? 409 : 400;
  const boardAnswer = (res: ServerResponse, r: ReturnType<BoardService["act"]>) =>
    r.ok ? json(res, 200, { task: r.task, event: r.event }) : json(res, boardProblemStatus(r.problem), { error: r.problem, ...(r.other ? { other: r.other } : {}), ...(r.from ? { from: r.from } : {}), ...(r.detail ? { detail: r.detail } : {}) });

  // An updates command's answer (updates §8.1): 403 a step-up too old, 409 the refusal with the fleet's own words
  // (its code when the fleet refused), 503 what couldn't be asked. The routes stay thin (round 2, R4): every look
  // and every gate is the service's, so a refused command never costs a round trip first. A rollback that needs
  // §11.4's word answers 409 with what it would drop (review round 1), so the screen can ask for the word.
  const updatesAnswer = (res: ServerResponse, r: UpdatesCommandOutcome) => {
    if (r.ok) return json(res, 200, { ok: true });
    const status = r.problem === "step_up" ? 403 : r.problem === "unavailable" ? 503 : 409;
    const error = r.problem === "refused" ? r.code : r.problem;
    if (r.problem === "step_up") return json(res, status, { error });
    return json(res, status, r.problem === "needs_word" ? { error, message: r.message, restores: r.restores } : { error, message: r.message });
  };

  // ADR-0023: file, restate, list and close a decision brief. Same door as the board (a bearer token, no cookie).
  const briefStatus = (problem: string) =>
    problem === "unknown" ? 404 : problem === "not_allowed" ? 403 : problem === "ref_taken" || problem === "too_many_open" ? 409 : 400;
  async function readBriefBody(req: IncomingMessage): Promise<{ kind: "markdown"; text: string } | { kind: "json"; value: unknown }> {
    const type = req.headers["content-type"] ?? "";
    if (type.startsWith("text/markdown")) return { kind: "markdown", text: (await readRaw(req, MAX_BODY)).toString("utf8") };
    if (type.startsWith("application/json")) return { kind: "json", value: await readJson(req) };
    throw new HttpError(415, "send markdown or JSON");
  }
  function briefAnswer(res: ServerResponse, r: { ok: false; problem: string } | { ok: "filed"; id: string; version: number; warnings: unknown[] } | { ok: "dry"; warnings: unknown[] } | { ok: "refused"; problems: unknown[] } | { ok: true }) {
    if (r.ok === "filed") return json(res, 201, { id: r.id, version: r.version, warnings: r.warnings });
    if (r.ok === "dry") return json(res, 200, { dry: true, warnings: r.warnings });
    if (r.ok === "refused") return json(res, 422, { error: "brief_refused", problems: r.problems, warnings: [] });
    if (r.ok === true) return json(res, 200, r);
    return json(res, briefStatus(r.problem), { error: r.problem });
  }
  async function agentDecisions(req: IncomingMessage, res: ServerResponse, path: string, method: string, actor: Parameters<BriefService["file"]>[1]) {
    const briefs = p.briefs;
    if (!briefs) return json(res, 404, { error: "briefs_off" });
    const q = new URL(req.url ?? "/", "http://hub").searchParams;
    if (path === "/api/agent/decisions/template" && method === "GET") {
      res.writeHead(200, { ...secureHeaders(), "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" });
      res.end(BRIEF_TEMPLATE);
      return;
    }
    if (path === "/api/agent/decisions" && method === "GET") {
      const listed = briefs.list(actor, { open: q.get("open") === "1", drafts: q.get("drafts") === "1" });
      return listed.ok ? json(res, 200, { requests: listed.requests }) : json(res, briefStatus(listed.problem), { error: listed.problem });
    }
    if (path === "/api/agent/decisions" && method === "POST") return briefAnswer(res, briefs.file(await readBriefBody(req), actor, q.get("dry") === "1"));
    const one = /^\/api\/agent\/decisions\/([A-Za-z0-9_-]{1,32})(?:\/(withdraw|settle|forward|decline))?$/.exec(path);
    if (!one) throw new HttpError(404, "no such route");
    const id = one[1] ?? "";
    const action = one[2];
    if (!action && method === "GET") {
      const shown = briefs.show(actor, id);
      return shown.ok ? json(res, 200, { request: shown.request }) : json(res, briefStatus(shown.problem), { error: shown.problem });
    }
    if (!action && method === "PUT") return briefAnswer(res, briefs.restate(id, await readBriefBody(req), actor, q.get("dry") === "1"));
    if (method !== "POST" || !action) throw new HttpError(404, "no such route");
    if (action === "forward") return briefAnswer(res, briefs.forward(actor, id));
    const body = await readJson(req);
    if (action === "decline") return briefAnswer(res, briefs.decline(actor, id, typeof body.why === "string" ? body.why : ""));
    if (action === "withdraw") return briefAnswer(res, briefs.withdraw(actor, id, typeof body.why === "string" ? body.why : ""));
    return briefAnswer(res, briefs.settle(actor, id, typeof body.note === "string" ? body.note : null));
  }

  // Who an agent call is from (agent-access.ts), or null once the refusal is answered. Each call spends the token's
  // bucket; a refusal the caller's.
  function agentCaller(req: IncomingMessage, res: ServerResponse, agents: AgentAccess) {
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : null;
    const laneHeader = req.headers["x-morndo-lane"];
    // A caller that has spent its refusals is turned away before any token is looked up (guessing costs nothing).
    limited(buckets.agentRefusals.peek(callerOf(req)));
    const who = agents.authenticate(bearer, typeof laneHeader === "string" ? laneHeader : null);
    if (!who.ok) {
      // A token that isn't one spends the caller's refusals; a real token without its lane is that token's own
      // misconfiguration, charged to the token, so the answer stays "which lane?" rather than "too many calls".
      if (who.token) limited(buckets.agentCalls.take(who.token.id));
      else limited(buckets.agentRefusals.take(callerOf(req)));
      json(res, who.refused === "lane_needed" || who.refused === "bad_name" ? 400 : 401, { error: who.refused });
      return null;
    }
    limited(buckets.agentCalls.take(who.token.id));
    return who;
  }

  // ADR-0031: Memory's side of the agent door (docs/design/memory/README.md, "Agent door"), on the board's tokens and
  // buckets, whether the board is on or off. Provenance is the token and the lane it names (M3), never the body.
  const memoryStatus = (problem: string) =>
    problem === "not_found" ? 404 : problem === "not_principal" || problem === "not_yours" ? 403
      : problem === "invalidated" || problem.startsWith("already_") || problem === "mismatch" ? 409 : 400;
  const memoryAnswer = (res: ServerResponse, r: ReturnType<MemoryService["note"]>, status = 200) =>
    r.ok ? json(res, status, { note: r.note }) : json(res, memoryStatus(r.problem), { error: r.problem });
  async function agentMemory(req: IncomingMessage, res: ServerResponse, path: string, method: string, service: MemoryService, actor: BoardActor) {
    if (path === "/api/agent/memory/search" && method === "GET") {
      const q = new URL(req.url ?? "/", "http://hub").searchParams;
      const found = service.search({ q: q.get("q"), scope: q.get("scope"), kind: q.get("kind"), limit: q.get("limit") });
      return found.ok ? json(res, 200, { notes: found.notes }) : json(res, 400, { error: found.problem });
    }
    if (path === "/api/agent/memory/notes" && method === "POST") return memoryAnswer(res, service.remember(actor, await readBody(req, MemoryRememberBody, MEMORY_MAX_BODY)), 201);
    const one = /^\/api\/agent\/memory\/notes\/(N-\d{1,9})(\/invalidate)?$/.exec(path);
    if (one && !one[2] && method === "GET") return memoryAnswer(res, service.note(actor, one[1] ?? ""));
    if (one && one[2] && method === "POST") return memoryAnswer(res, service.invalidate(actor, one[1] ?? "", (await readBody(req, MemoryInvalidateBody)).reason));
    throw new HttpError(404, "no such route");
  }

  async function agentApi(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (path.startsWith("/api/agent/memory/")) {
      if (!p.memory) return json(res, 404, { error: "memory_off" });
      const who = agentCaller(req, res, p.memory.agents);
      return who ? agentMemory(req, res, path, method, p.memory.service, who.actor) : undefined;
    }
    if (!p.board) return json(res, 404, { error: "board_off" });
    const who = agentCaller(req, res, p.board.agents);
    if (!who) return;
    const { service } = p.board;
    if (path === "/api/agent/whoami" && method === "GET") return json(res, 200, { actor: who.actor, token: { id: who.token.id, name: who.token.name, role: who.token.role, scopes: who.token.scopes } });
    if (path.startsWith("/api/agent/decisions")) return agentDecisions(req, res, path, method, who.actor);
    // A job grant (ADR-0017 §6). The body names the lane, the class and a directory hash. It has no command.
    if (path === "/api/agent/jobs/grant" && method === "POST") {
      const body = await readJson(req);
      if ("command" in body || "argv" in body) throw new HttpError(400, "bad_request");
      const lane = typeof body.lane === "string" ? body.lane : "";
      if (who.actor.kind === "principal" || lane !== who.actor.name) return json(res, 403, { error: "not_yours" });
      return json(res, 200, { ok: true, lane: who.actor.name, hash: who.token.secretHash });
    }
    // ADR-0016: a session's status-line report, for the account X-Morndo-Account names (none: the default account).
    if (path === "/api/agent/usage" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      const accountHeader = req.headers["x-morndo-account"];
      const r = p.usage.report(await readBody(req, UsageReportBody), typeof accountHeader === "string" ? accountHeader : null, who.actor);
      return r.ok ? json(res, 200, { account: r.account }) : json(res, 400, { error: r.problem });
    }
    // A usage reading a source posts (U14): the windows it can see now, or the one reason it cannot. The status line
    // has its own route above; a reading that names it is refused.
    if (path === "/api/agent/usage/readings" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      // A plain worker token is counted once per reading it posts that is accepted (warn, the default) or refused for
      // want of the scope (enforce, which stores nothing). A body the hub cannot read is not counted.
      const unbound = who.token.role !== "manager" && !who.token.scopes.includes("usage-pool");
      if (unbound && (p.config.usageReadingsGate ?? "warn") === "enforce") {
        p.board.agents.noteUnbound(who.token.id);
        return json(res, 403, { error: "scope_required", message: "usage readings need a manager token or a worker token with the usage-pool scope (morndo agent-token new <name> --role worker --scope usage-pool)" });
      }
      const accountHeader = req.headers["x-morndo-account"];
      const r = p.usage.reading(await readBody(req, UsageReadingsBody), typeof accountHeader === "string" ? accountHeader : null, who.actor);
      if (unbound && r.ok) p.board.agents.noteUnbound(who.token.id);
      return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { error: r.problem });
    }
    // A node's ask for a lease before a rationed read (S5, plan 4.4, U16): granted with an opaque id and its expiry,
    // fresh with the capture time the caller may use instead of spawning, or denied with one reason and a wait. The
    // answer leaks nothing else — not which node holds a live lease, not why a reading is fresh. The route is a
    // manager's or the pool's (fix round 2026-10-24, finding 1, the limit route's rule): a worker token without the
    // usage-pool scope is refused, and the lease granted is bound to the asking token's id.
    if (path === "/api/agent/usage/lease" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      if (who.token.role !== "manager" && !who.token.scopes.includes("usage-pool")) return json(res, 403, { error: "not_allowed" });
      const body = await readBody(req, UsageLeaseBody);
      const g = p.usage.leases.grant(body.account, body.source, body.node ?? null, who.token.id);
      if (g.status === "granted") return json(res, 200, { status: "granted", lease_id: g.id, expires_at: Math.floor(g.expiresAt / 1000) });
      if (g.status === "fresh") return json(res, 200, { status: "fresh", captured_at: Math.floor(g.capturedAt / 1000) });
      return json(res, 200, { status: "denied", reason: g.reason, retry_after_s: Math.ceil(g.retryAfterMs / 1000) });
    }
    // A seat's limit hit as any source reports it (U9). The reply says only that it was taken: the agent door leaks
    // nothing of the seat or any state. The route is a manager's or the pool's (PR #127, finding 2): a manager-role
    // token, or one holding the usage-pool scope. A worker token without the scope stays refused — a lane's own
    // failures reach the hub through the fleet tap, which needs no token.
    if (path === "/api/agent/usage/limit" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      if (who.token.role !== "manager" && !who.token.scopes.includes("usage-pool")) return json(res, 403, { error: "not_allowed" });
      const body = await readBody(req, UsageLimitBody);
      const accountHeader = req.headers["x-morndo-account"];
      const account = body.account ?? (typeof accountHeader === "string" ? accountHeader : null);
      const r = p.usage.noteLimit({
        account,
        kind: body.kind,
        backAt: typeof body.back_at === "number" ? body.back_at * 1000 : null,
        by: body.by,
        at: typeof body.at === "number" ? body.at * 1000 : null,
        fix: body.fix, hint: body.hint,
      });
      return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { error: r.problem });
    }
    // The pool's own word on a seat (U15): a token with the usage-pool scope only — a role is not the scope, so the
    // manager's token is refused without it too. The reply says only that it was taken.
    if (path === "/api/agent/usage/pool" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      if (!who.token.scopes.includes("usage-pool")) return json(res, 403, { error: "scope_required" });
      const body = await readBody(req, UsagePoolBody);
      const r = p.usage.poolSeat({
        account: body.account, action: body.action,
        ...(body.state === undefined ? {} : { state: body.state }),
        why: body.why ?? null,
        backAt: typeof body.back_at === "number" ? body.back_at * 1000 : null,
        at: typeof body.at === "number" ? body.at * 1000 : null,
        by: body.by,
      });
      return r.ok ? json(res, 200, { ok: true }) : json(res, 400, { error: r.problem });
    }
    if (path === "/api/agent/board" && method === "GET") {
      // ADR-0035 step 4: the agents' board read carries each task in review's proof line beside the board itself; the
      // principal's own routes answer without it.
      const v = service.view();
      return json(res, 200, { ...v, ...(p.board.proof ? { proof: p.board.proof.lines(v.tasks) } : {}) });
    }
    if (path === "/api/agent/board/tasks" && method === "POST") return boardAnswer(res, service.create(await readBody(req, BoardCreateBody), who.actor));
    const task = /^\/api\/agent\/board\/tasks\/(T-\d{1,9})$/.exec(path);
    if (task && method === "GET") {
      const t = service.task(task[1] ?? "");
      return t ? json(res, 200, { ...t, ...(p.board.proof ? { proof: p.board.proof.view(task[1] ?? "") } : {}) }) : json(res, 404, { error: "unknown" });
    }
    if (task && method === "POST") {
      const body = await readBody(req, BoardActionBody);
      // B13 (ADR-0035): a brief is filed through the proof service, which seeds its references as rows to check; every
      // other action is the board's own. Without the service wired, a brief is the board's alone.
      if (body.action === "brief" && p.board.proof) return boardAnswer(res, await p.board.proof.file(task[1] ?? "", body.brief, who.actor));
      return boardAnswer(res, await service.actChecked(task[1] ?? "", body, who.actor));
    }
    throw new HttpError(404, "no such route");
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const method = req.method ?? "GET";
    if (path.startsWith("/api/agent/")) return agentApi(req, res, path);
    if (method !== "GET" && method !== "HEAD" && !originOk(req)) throw new HttpError(403, "origin not allowed");

    if (path === "/api/identity" && method === "GET") {
      return json(res, 200, { fingerprint: identity.fingerprint, display: formatFingerprint(identity.fingerprint), publicKey: identity.publicKeyRaw.toString("base64url") }, {}, path);
    }
    if (path === "/api/identity/prove" && method === "POST") {
      const nonce = Buffer.from((await readBody(req, IdentityProveBody)).nonce, "base64url");
      if (nonce.length < 16 || nonce.length > 64) throw new HttpError(400, "nonce must be 16-64 bytes");
      const signature = identity.sign(Buffer.concat([Buffer.from("morndo-hub-identity:"), nonce]));
      return json(res, 200, { signature: signature.toString("base64url") }, {}, path);
    }
    // The pairing page's look at its link isn't a passkey ceremony: it is limited like a poll (below), so loading the
    // page doesn't spend the passkey attempts (a wrong typed code still does, on /api/pair/options).
    if ((path.startsWith("/api/pair/") && path !== "/api/pair/check") || path.startsWith("/api/login/")) {
      // The caller's own bucket and the shared ceiling together: one caller spending its attempts never spends anyone
      // else's, and a refusal by the ceiling never spends the caller's own (review L6).
      limited(takeAll([[buckets.passkeyPerCaller, callerOf(req)], [buckets.passkeyGlobal, "all"]]));
    }
    if (path === "/api/pair/check" && method === "POST") {
      limited(buckets.linkPolls.take(callerOf(req)));
      const r = access.tokenInfo((await readBody(req, PairCheckBody)).token);
      return "refused" in r ? json(res, 400, { error: r.refused }, {}, path) : json(res, 200, r, {}, path);
    }
    // Phase E (AC11): a device not yet paired asks to be added, then asks with its own secret whether it was.
    if (path === "/api/link" && method === "POST") {
      limited(takeAll([[buckets.linkRequests, callerOf(req)], [buckets.passkeyGlobal, "all"]]));
      const login = req.headers["tailscale-user-login"];
      const r = access.requestLink(typeof login === "string" && login ? login.slice(0, 200) : null);
      return "refused" in r ? json(res, 409, { error: r.refused }) : json(res, 200, r);
    }
    const link = /^\/api\/link\/([0-9a-f-]{36})(?:\/(details|approve|deny|cancel))?$/.exec(path);
    if (link && (!link[2] || link[2] === "cancel") && (method === "GET" || link[2] === "cancel")) {
      limited(buckets.linkPolls.take(callerOf(req)));
      const secret = req.headers["x-morndo-link-secret"];
      if (typeof secret !== "string") return json(res, 404, { error: "unknown" });
      if (link[2] === "cancel") {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        const c = access.cancelLink(link[1] ?? "", secret);
        return !c ? json(res, 404, { error: "unknown" }) : "ok" in c ? json(res, 200, c) : json(res, 409, { error: c.refused });
      }
      const r = access.collectLink(link[1] ?? "", secret);
      return r ? json(res, 200, r) : json(res, 404, { error: "unknown" });     // unknown and a wrong secret look the same
    }
    if (path === "/api/pair/options" && method === "POST") {
      const body = await readBody(req, PairOptionsBody);
      const r = await access.pairOptions(body.token, (body.name ?? "").slice(0, 40), body.code ?? null);
      return "refused" in r ? json(res, 400, { error: r.refused }, {}, path) : json(res, 200, r, {}, path);
    }
    if (path === "/api/pair/verify" && method === "POST") {
      const body = await readBody(req, PasskeyVerifyBody);
      const r = await access.pairVerify(body.flowId, body.response as never);
      if ("refused" in r) return json(res, 400, { error: r.refused });
      return json(res, 200, { endpoint: { id: r.endpoint.id, name: r.endpoint.name }, fingerprint: identity.fingerprint }, { "Set-Cookie": setCookie(r.cookieSecret) }, path);
    }
    if (path === "/api/login/options" && method === "POST") return json(res, 200, await access.loginOptions(), {}, path);
    if (path === "/api/login/verify" && method === "POST") {
      const body = await readBody(req, PasskeyVerifyBody);
      const r = await access.loginVerify(body.flowId, body.response as never);
      if ("refused" in r) return json(res, 401, { error: r.refused }, {}, path);
      return json(res, 200, { endpoint: { id: r.endpoint.id, name: r.endpoint.name } }, { "Set-Cookie": setCookie(r.cookieSecret) }, path);
    }

    const a = auth(req);
    if (!a) return json(res, 401, { error: "signed_out" }, { "Set-Cookie": clearCookie });
    if (path === "/api/me" && method === "GET") {
      await p.transcription?.refresh();
      return json(res, 200, {
        endpoint: { id: a.endpoint.id, name: a.endpoint.name, pairedAt: a.endpoint.pairedAt },
        session: { startedAt: a.session.startedAt, verifiedAt: a.session.verifiedAt },
        policy: access.policy(),
        office: config.officeName ?? hostname(),
        desktop: remote.desktop() !== null,
        // The links follow the probe, not merely whether MORNDO_ENGINES is set: a missing or too-old CLI hides them.
        engines: p.engines ? (await p.engines.ready().then(why => why === null, () => false)) : false,
        connections: p.connections != null,
        transcription: p.transcription ? p.transcription.me() : false,
        // The Updates screen (updates §8.2): this hub has it when it runs with a fleet. Said here so no page probes
        // /api/updates for a 404 (CI's web e2e: every page logged it as a console error, review of #114).
        updates: p.updatesService != null,
      });
    }
    if (path === "/api/logout" && method === "POST") {
      access.signOut(a.session);
      return json(res, 200, { ok: true }, { "Set-Cookie": clearCookie });
    }
    if (path === "/api/devices" && method === "GET") return json(res, 200, access.devices().map(deviceView(a)));
    // Phase F (N4): the hub's VAPID key for the browser to subscribe with, and this device's one subscription.
    if (path === "/api/push/key" && method === "GET") {
      if (!p.push) return json(res, 404, { error: "push_off" });
      return json(res, 200, { key: p.push.publicKey.toString("base64url"), subscribed: p.push.notifications.subscribed(a.endpoint.id) }, {}, path);
    }
    if (path === "/api/push/subscription" && (method === "POST" || method === "DELETE")) {
      if (!p.push) return json(res, 404, { error: "push_off" });
      if (method === "DELETE") { p.push.notifications.unsubscribe(a.endpoint.id); return json(res, 200, { ok: true }); }
      const body = await readBody(req, PushSubscriptionBody);
      const r = p.push.notifications.subscribe(a.endpoint.id, { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth });
      return "ok" in r ? json(res, 200, r) : json(res, 400, { error: r.refused });
    }
    // Phase E (AC10): "Add a device" here: a pairing token this Endpoint issues, after a fresh passkey check.
    if (path === "/api/devices/add" && method === "POST") {
      const r = access.issueEndpointToken(a);
      if (!("refused" in r)) return json(res, 200, r);
      return json(res, r.refused === "step_up" ? 403 : r.refused === "ended" ? 401 : 409, { error: r.refused });
    }
    const added = /^\/api\/devices\/add\/([0-9a-f-]{36})(\/cancel)?$/.exec(path);
    if (added && !added[2] && method === "GET") {
      const r = access.addedWith(a, added[1] ?? "");
      return r ? json(res, 200, r) : json(res, 404, { error: "unknown" });
    }
    if (added?.[2] && method === "POST") {
      const r = access.withdrawEndpointToken(a, added[1] ?? "");
      return r === "not_yours" ? json(res, 409, { error: r }) : json(res, 200, { withdrawn: r === "withdrawn" });
    }
    if (link?.[2] === "details" && method === "GET") {
      const r = access.linkDetails(link[1] ?? "");
      return r ? json(res, 200, r) : json(res, 404, { error: "unknown" });
    }
    if ((link?.[2] === "approve" || link?.[2] === "deny") && method === "POST") {
      const body = await readBody(req, LinkDecisionBody);
      const identity = body.fingerprint && body.proof ? { pinned: body.fingerprint, proof: body.proof } : null;
      const r = access.decideLink(a, link[1] ?? "", link[2] === "approve", identity, body.code ?? null);
      if ("ok" in r) return json(res, 200, r);
      return json(res, r.refused === "step_up" ? 403 : r.refused === "unknown" ? 404 : r.refused === "ended" ? 401 : r.refused === "no_identity" || r.refused === "code_needed" ? 400 : 409, { error: r.refused });
    }
    if (path === "/api/policy" && method === "GET") {
      return json(res, 200, { policy: access.policy(), choices: { stay: Object.keys(STAY_CHOICES), stepUp: Object.keys(STEP_UP_CHOICES) } });
    }
    if (path === "/api/policy" && method === "POST") {
      const body = await readBody(req, PolicyBody);
      const r = access.setPolicy(a, { stay: body.stay, stepUp: body.stepUp } as never);
      return "refused" in r ? json(res, r.refused === "step_up" ? 403 : 400, { error: r.refused }) : json(res, 200, r);
    }
    if (path === "/api/stepup/options" && method === "POST") return json(res, 200, await access.stepUpOptions(a), {}, path);
    if (path === "/api/stepup/verify" && method === "POST") {
      const body = await readBody(req, PasskeyVerifyBody);
      const r = await access.stepUpVerify(a, body.flowId, body.response as never);
      return "refused" in r ? json(res, 401, { error: r.refused }, {}, path) : json(res, 200, r, {}, path);
    }
    // Sending into a worker, named by its worker id or a legacy pane id (one segment, percent-decoded once). Any other
    // segment is no route; a %N a fleet hub doesn't hold reaches steering and is no pane, as an older app's outbox
    // expects (ADR-0012).
    const send = /^\/api\/workers\/([^/]+)\/send$/.exec(path);
    const sendTo = send ? workerIdFromSegment(send[1] ?? "") : null;
    if (send && sendTo === null) throw new HttpError(404, "no such route");
    if (sendTo !== null && method === "POST") {
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, SendBody, SEND_MAX_BODY);
      return sent(res, await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name, body.createdAt, body.again === true, body.hubStore));
    }
    // The manager by its role: its window, or, while it has none, the fleet's queue for its sticky lane (steering).
    if (path === "/api/manager/send" && method === "POST") {
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, SendBody, SEND_MAX_BODY);
      return sent(res, await steering.sendToManager(a, body.text, body.requestId, body.uploads ?? [], body.createdAt, body.again === true, body.hubStore));
    }
    // The principal's cancel of one of his messages to the manager still waiting in the fleet's queue (ruling 83; spec
    // §9.1): 200 with where it stands now (given up, cancelled), 409 only when it is too late (already typed), 404 for
    // no such message of his. A refusal that is not too late (the node offline, a timeout, busy) is 503: the app keeps
    // Cancel, and a later try can still withdraw it.
    if (path === "/api/manager/cancel" && method === "POST") {
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, CancelBody);
      const r = await steering.cancel(a, body.requestId);
      if (r.ok) return json(res, 200, r);
      const status = r.problem === "unknown" ? 404 : r.problem === "already_typed" ? 409 : 503;
      return json(res, status, { error: r.problem });
    }
    // A file an agent sent or the principal attached: the hub's copy, by id only (files.ts), never as a page of this origin.
    const file = /^\/api\/files\/([0-9a-f]{32})$/.exec(path);
    if (file && (method === "GET" || method === "HEAD")) {
      const f = files?.get(file[1] ?? "");
      if (!f) return json(res, 404, { error: "no_such_file" });
      const download = new URL(req.url ?? "/", "http://hub").searchParams.get("download") === "1";
      res.writeHead(200, { ...secureHeaders(), ...servingHeaders(f.meta, download) });
      if (method === "HEAD") return res.end();
      createReadStream(f.file).on("error", () => res.destroy()).pipe(res);
      return;
    }
    // An image the principal pasted or attached (S1): saved for a worker to open; sending it is a separate Command.
    if (path === "/api/uploads" && method === "POST") {
      if (!inbox) throw new HttpError(404, "no such route");
      limited(buckets.uploads.take(a.endpoint.id));
      await p.transcription?.refresh();
      const r = await inbox.save(await readRaw(req, MAX_UPLOAD_BYTES), a.endpoint.id, uploadName(req), p.transcription?.capability());
      if (!r.ok) {
        if (r.error === "too_many") return json(res, 503, { error: r.error }, { "Retry-After": "60" });
        return json(res, r.error === "too_big" ? 413 : 415, { error: r.error });
      }
      return json(res, 200, { id: r.value.id, name: r.value.path.split("/").pop(), size: r.value.size, mime: r.value.mime });
    }
    const tx = /^\/api\/transcriptions(?:\/([A-Za-z0-9][A-Za-z0-9:_-]{0,199})(\/cancel)?)?$/.exec(path);
    if (tx && (method === "GET" || method === "POST")) {
      if (!p.transcription) return json(res, 404, { error: "transcription_off" });
      await p.transcription.refresh();
      const id = tx[1];
      if (!id && method === "POST") {
        limited(buckets.transcriptions.take(a.endpoint.id));
        if (!p.transcription.allowsMicrophone()) return json(res, 404, { error: "transcription_off" });
        const body = await readBody(req, TranscriptionCreateBody);
        // The endpoint is part of the ask: an upload another device made is not this caller's recording (S2).
        const created = await p.transcription.request({ ...body, caller: { endpointId: a.endpoint.id } });
        if (!created.ok) {
          if (created.error === "unreadable") return json(res, 404, { error: created.error });
          // The live-row cap is the whole machine's queue, not this caller's bucket (that one is already 429).
          // 503 is a temporary overload. Retry-After matches the queue's minute sweep, so a client waits
          // instead of treating the body as a malformed request.
          if (created.error === "too_many") return json(res, 503, { error: created.error }, { "Retry-After": "60" });
          return json(res, 400, { error: created.error });
        }
        return json(res, 200, transcriptionView(created.value));
      }
      // A row that exists still answers with the plugin gone: its text stays readable (design §6). An unknown id with
      // no ready plugin is the feature being off, not a missing row.
      const off = () => !p.transcription?.capability().present;
      if (id && !tx[2] && method === "GET") {
        const row = p.transcription.get(id, { endpointId: a.endpoint.id });
        return row ? json(res, 200, transcriptionView(row)) : off()
          ? json(res, 404, { error: "transcription_off" })
          : json(res, 404, { error: "unknown" });
      }
      if (id && tx[2] === "/cancel" && method === "POST") {
        await readBody(req, TranscriptionCancelBody);
        const cancelled = p.transcription.cancel(id, { endpointId: a.endpoint.id });
        return cancelled.ok ? json(res, 200, transcriptionView(cancelled.value)) : off()
          ? json(res, 404, { error: "transcription_off" })
          : json(res, 404, { error: "unknown" });
      }
    }
    if (path === "/api/escalations" && method === "GET") return json(res, 200, escalations.seenBy(a.endpoint.id));
    const answer = /^\/api\/escalations\/([A-Za-z0-9_-]{1,80})\/answer$/.exec(path);
    if (answer && method === "POST") {
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, AnswerBody);
      const choice = "key" in body ? { kind: "option" as const, key: body.key } : { kind: "words" as const, text: body.text };
      const r = await escalations.answer(a, answer[1] ?? "", choice, body.requestId, body.seen);
      if (r.ok) return json(res, 200, r);
      const status = r.problem === "step_up" ? 403 : r.problem === "unknown" || r.problem === "no_pane" ? 404 : 409;
      return json(res, status, { error: r.problem, item: r.item });
    }
    // ADR-0013: which provider and model does each role's work. Reading is a look; saving is a Command (AC7) and goes
    // through the engine layer's CLI. 503 with its words when the CLI can't answer.
    if (path === "/api/engines" && (method === "GET" || method === "POST")) {
      if (!p.engines) return json(res, 404, { error: "engines_off" });
      if (method === "GET") {
        // A look runs the CLI 3 + N times: its own bucket, never the commands' (verify round, finding 3).
        limited(buckets.engineReads.take(a.endpoint.id));
        const r = await p.engines.view();
        return r.ok ? json(res, 200, r.view) : json(res, 503, { error: r.problem, message: r.message });
      }
      limited(buckets.commands.take(a.endpoint.id));
      const r = await p.engines.save(a, await readBody(req, EnginesSaveBody));
      if (r.ok) return json(res, 200, r.view);
      const { ok: _, problem, ...rest } = r;
      const status = problem === "step_up" ? 403 : problem === "changed" || problem === "refused" ? 409 : problem === "unavailable" || problem === "unsupported" ? 503 : 400;
      return json(res, status, { error: problem, ...rest });
    }
    // ADR-0018: the LLM connections page. A role save goes through the connections routing service. Widening needs step-up.
    if (path === "/api/connections" && method === "GET") {
      if (!p.connections) return json(res, 404, { error: "connections_off" });
      limited(buckets.engineReads.take(a.endpoint.id));
      return json(res, 200, await p.connections.view());
    }
    const connectionCommand = /^\/api\/connections\/(priority|role|revoke|narrow)$/.exec(path);
    if (connectionCommand && method === "POST") {
      if (!p.connections) return json(res, 404, { error: "connections_off" });
      limited(buckets.commands.take(a.endpoint.id));
      const kind = connectionCommand[1] as CommandKind;
      const schema = kind === "priority" ? PriorityCommand : kind === "role" ? RoleCommand : kind === "revoke" ? RevokeCommand : NarrowCommand;
      const result = await p.connections.run(a, kind, await readBody(req, schema));
      if (result.ok) return json(res, 200, result.view);
      const status = result.problem === "step_up" ? 403 : result.problem === "conflict" ? 409 : 400;
      return json(res, status, { error: result.problem });
    }
    // Updates §8.1 (PR 6c): the owner's one screen over every machine's Version. Reading is a look; each command is
    // a Command (AC7), the fleet's refusal 409 with the fleet's own words, what can't be asked 503.
    if (path === "/api/updates" && method === "GET") {
      if (!p.updatesService) return json(res, 404, { error: "updates_off" });
      limited(buckets.engineReads.take(a.endpoint.id));
      return json(res, 200, await p.updatesService.view());
    }
    if (path === "/api/updates/apply" && method === "POST") {
      if (!p.updatesService) return json(res, 404, { error: "updates_off" });
      limited(buckets.commands.take(a.endpoint.id));
      // Thin on purpose (round 2, R4): the service gates the command before any look — the unknown-machine check
      // rides behind it, on the fleet's own node list alone — so a stale step-up answers without a round trip.
      const body = await readBody(req, UpdatesApplyBody);
      return updatesAnswer(res, await p.updatesService.apply(a, body.machine, body.version));
    }
    if (path === "/api/updates/rollback" && method === "POST") {
      if (!p.updatesService) return json(res, 404, { error: "updates_off" });
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, UpdatesRollbackBody);
      return updatesAnswer(res, await p.updatesService.rollback(a, body.machine, body.word));
    }
    if (path === "/api/updates/resume" && method === "POST") {
      if (!p.updatesService) return json(res, 404, { error: "updates_off" });
      limited(buckets.commands.take(a.endpoint.id));
      return updatesAnswer(res, await p.updatesService.resume(a, (await readBody(req, UpdatesResumeBody)).version));
    }
    // ADR-0016: the accounts' usage, a look.
    if (path === "/api/usage" && method === "GET") return p.usage ? json(res, 200, p.usage.view()) : json(res, 404, { error: "usage_off" });
    // The principal's own forget of a usage source (AT-23): the account, and the source to drop; without a source,
    // the whole account. A Command like the others: limited, and the principal's session only.
    if (path === "/api/usage/forget" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, UsageForgetBody);
      return json(res, 200, { forgotten: p.usage.forget(body.account, body.source, body.node) });
    }
    // The principal looked at usage (S5, AT-45): marks every account somebody now wants read — the same demand a
    // feed hello raises. A Command like the forget above, limited the same; the reads themselves stay leased.
    if (path === "/api/usage/look" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      limited(buckets.commands.take(a.endpoint.id));
      p.usage.look();
      return json(res, 200, { ok: true });
    }
    // The principal's own clear of a seat (U17): the pool's word or the hub's derived one, or both. A Command like
    // the others: limited, and the principal's session only — an agent token never reaches here.
    if (path === "/api/usage/seat/clear" && method === "POST") {
      if (!p.usage) return json(res, 404, { error: "usage_off" });
      limited(buckets.commands.take(a.endpoint.id));
      const body = await readBody(req, UsageSeatClearBody);
      return json(res, 200, { cleared: p.usage.clearSeat(body.account, body.owner) });
    }
    // The fleet's job mirror: the list and the counts beside each node. A look.
    if (path === "/api/jobs" && method === "GET") {
      if (!p.jobs) return json(res, 404, { error: "jobs_off" });
      const q = new URL(req.url ?? "/", "http://hub").searchParams;
      if (q.get("hidden") === "1" || q.has("before")) return json(res, 200, p.jobs.page(q.get("before")));
      return json(res, 200, p.jobs.view());
    }
    // ADR-0031 (M8): the console's one-time approval code, minted in the app for one Note that waits. A Command under
    // step-up, like the approval itself; the code is said once here and never logged or stored but its hash — the
    // console spends it (`morndo memory approve <id>`, the code read from stdin). No body to read. Not an agent route: only a session
    // reaches it (the agents' door has no such path).
    const approvalCode = /^\/api\/memory\/notes\/(N-\d{1,9})\/approval-code$/.exec(path);
    if (approvalCode && method === "POST") {
      if (!p.memory) return json(res, 404, { error: "memory_off" });
      limited(buckets.commands.take(a.endpoint.id));
      const r = p.memory.service.issueApprovalCode(a, approvalCode[1] ?? "");
      if (r.ok) return json(res, 200, { code: r.code, expiresAt: r.expiresAt });
      return json(res, r.problem === "step_up" ? 403 : r.problem === "not_found" ? 404 : 409, { error: r.problem });
    }
    // ADR-0015: the board. Reading is a look; a change is a Command (AC7).
    if (path.startsWith("/api/board")) {
      if (!p.board) return json(res, 404, { error: "board_off" });
      const { service } = p.board;
      if (path === "/api/board" && method === "GET") return json(res, 200, service.view());
      const task = /^\/api\/board\/tasks\/(T-\d{1,9})$/.exec(path);
      if (task && method === "GET") {
        const t = service.task(task[1] ?? "");
        return t ? json(res, 200, { ...t, ...(p.board.proof ? { proof: p.board.proof.view(task[1] ?? "") } : {}) }) : json(res, 404, { error: "unknown" });
      }
      if ((path === "/api/board/tasks" || task) && method === "POST") {
        limited(buckets.commands.take(a.endpoint.id));
        const actor = service.principal(a);
        if ("problem" in actor) return json(res, 403, { error: actor.problem });
        if (task) {
          const body = await readBody(req, BoardActionBody);
          if (body.action === "brief" && p.board.proof) return boardAnswer(res, await p.board.proof.file(task[1] ?? "", body.brief, actor));
          return boardAnswer(res, await service.actChecked(task[1] ?? "", body, actor));
        }
        return boardAnswer(res, service.create(await readBody(req, BoardCreateBody), actor));
      }
      throw new HttpError(404, "no such route");
    }
    const revoke = /^\/api\/devices\/([\w-]{1,64})\/revoke$/.exec(path);
    if (revoke && method === "POST") {
      const done = access.revokeFrom(a, revoke[1] ?? "");
      if (typeof done === "object") return json(res, 403, { error: done.refused });
      const self = revoke[1] === a.endpoint.id;
      return json(res, done ? 200 : 404, { ok: done }, self ? { "Set-Cookie": clearCookie } : {});
    }
    throw new HttpError(404, "no such route");
  }

  let cachedIndex: { html: string; csp: string; file: string; mtimeMs: number } | null = null;
  async function staticFile(req: IncomingMessage, res: ServerResponse, path: string) {
    const root = normalize(config.webDir);
    // Each segment decoded on its own (decodeSegment); a path with one that doesn't decode is no file, and the app shell
    // answers it, as any path the app doesn't know.
    const segments = path.split("/").map(decodeSegment);
    const candidate = segments.every((s): s is string => s !== null) ? normalize(join(root, ...segments)) : null;
    const inside = candidate !== null && (candidate === root || candidate.startsWith(root + sep));
    const isFile = inside && existsSync(candidate) && statSync(candidate).isFile();
    if (isFile && extname(candidate) !== ".html") {
      const immutable = path.startsWith("/_app/immutable/");
      res.writeHead(200, {
        ...secureHeaders(), "Content-Type": TYPES[extname(candidate)] ?? "application/octet-stream",
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        ...(path === "/service-worker.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      return res.end(req.method === "HEAD" ? undefined : readFileSync(candidate));
    }
    // Every page is the app shell (SPA fallback); its CSP allows exactly its own inline bootstrap. Read again after a
    // rebuild, so the shell never points at assets the build replaced.
    // The document's Permissions-Policy is what gates the microphone. It is served from the last probe, and a
    // refresh runs behind the response so a slow probe never holds the page. The next document sees what it found.
    // A probe that throws is logged here: a dropped rejection is an unhandledRejection, and that exits the hub.
    void p.transcription?.refresh()?.catch(e => log.warn("transcription: probe failed", e));
    const file = ["200.html", "index.html"].map(f => join(root, f)).find(f => existsSync(f));
    if (!file) throw new HttpError(503, "web app not built: run `npm run build`");
    const mtimeMs = statSync(file).mtimeMs;
    if (!cachedIndex || cachedIndex.file !== file || cachedIndex.mtimeMs !== mtimeMs) {
      const html = readFileSync(file, "utf8");
      cachedIndex = { html, csp: cspFor(html), file, mtimeMs };
    }
    res.writeHead(200, { ...secureHeaders(), "Content-Type": TYPES[".html"] ?? "text/html", "Cache-Control": "no-cache", "Content-Security-Policy": cachedIndex.csp });
    res.end(req.method === "HEAD" ? undefined : cachedIndex.html);
  }

  // Every request is handled to the end here (its own catch), so the promise is dropped on purpose.
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const path = new URL(req.url ?? "/", "http://hub").pathname;
      if (path === "/api/health" && (req.method === "GET" || req.method === "HEAD")) return health(req, res);
      // The agents' routes carry their own identity (a bearer token), and a lane on another node reaches the hub through
      // the proxy as a tagged device, with no identity header (ADR-0012 decision 4).
      if (!path.startsWith("/api/agent/") && !proxyOk(req)) throw new HttpError(403, "not from the principal's network identity");
      if (path.startsWith("/api/")) {
        const method = req.method ?? "GET";
        if (refusesWhenHeld(method, path) && heldNow()) throw new HttpError(503, "updating", { "Retry-After": "1" });
        const end = refusesWhenHeld(method, path) ? flight.begin({ kind: "http", id: `${method} ${path}` }) : null;
        try { return await api(req, res, path); }
        finally { end?.(); }
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      await staticFile(req, res, path);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error(`${req.method ?? "?"} request failed`, e);            // no URL: it may be what failed to parse
      if (!res.headersSent) json(res, status, { error: status === 500 ? "internal error" : (e as Error).message }, e instanceof HttpError ? e.headers : {});
      else res.end();
    }
  }

  // ---- live feed over WebSocket (ws README: noServer + authenticate in "upgrade"; ping/pong heartbeat)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  type Conn = { id: string; ws: WebSocket; auth: Authenticated; cookie: string; watching: string | null; alive: boolean };
  const conns = new Set<Conn>();

  server.on("upgrade", (req, socket, head) => {
    const deny = (code: number, text: string) => { socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); socket.destroy(); };
    socket.on("error", () => socket.destroy());
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://hub"); } catch { return deny(400, "Bad Request"); }   // e.g. "//[": a throw here would end the hub
    if ((url.pathname === "/api/terminal" || url.pathname === "/api/desktop") && heldNow()) return deny(503, "Service Unavailable");
    if (url.pathname === "/api/terminal" || url.pathname === "/api/desktop") return upgradeRemote(req, socket, head, url, deny);
    if (url.pathname !== "/api/feed") return deny(404, "Not Found");
    if (!proxyOk(req) || !originOk(req)) return deny(403, "Forbidden");
    const cookie = cookieValue(req, COOKIE) ?? "";
    const a = access.authenticate(cookie);
    if (!a) return deny(401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, ws => {
      const conn: Conn = { id: randomUUID(), ws, auth: a, cookie, watching: null, alive: true };
      conns.add(conn);
      // Transcript and screen views blank API-key shapes on the way out (ADR-0018 §6.2). The terminal socket does not.
      const send = (m: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(redactFeed(m))); };
      const sendHistory = (worker: string, messages = observation.history(worker)) => {
        const info = observation.session(worker);
        send({ t: "history", worker, messages, session: info ? { name: info.name, cwd: info.cwd, version: info.version } : null });
      };
      const unsubscribe = observation.subscribe({
        events: (events: FeedEvent[]) => send({ t: "events", events }),
        screen: (worker, text, at) => send({ t: "screen", worker, text, at }),
        messages: (worker, messages) => send({ t: "messages", worker, messages }),
        history: (worker, messages) => sendHistory(worker, messages),
        attachments: (worker, message, attachments) => send({ t: "attachments", worker, message, attachments }),
        // Whether the fleet answers, each time that changes (fleet core §7); the app shows "Fleet unavailable".
        fleet: status => send({ t: "fleet", available: status === "ok" }),
        watching: () => conn.watching,
      });
      // Each connection hears where every Decision stands for its own endpoint: "here" only for the device whose
      // request accepted it (seenBy), never the hub-level record.
      const unsubscribeBoard = escalations.subscribe(board => send({ t: "decisions", ...escalations.seenBy(conn.auth.endpoint.id, board) }));
      const unsubscribeTasks = p.board?.service.subscribe(b => send({ t: "board", ...b })) ?? (() => false);
      const unsubscribeUsage = p.usage?.subscribe(v => send({ t: "usage", ...v })) ?? (() => false);
      // Where this device's messages to the manager stand in the fleet's queue (fleet-clients §9.1): each change, by
      // request id; never another device's.
      const unsubscribeQueue = p.queue?.subscribe(c => {
        if (c.row.kind === "command" && c.row.endpointId === conn.auth.endpoint.id) send({ t: "deliveries", items: [queuedCommand(c.row, c.view)] });
      }) ?? (() => false);
      const unsubscribeJobs = p.jobs?.subscribe(v => send({ t: "jobs", ...v })) ?? (() => false);
      const unsubscribeAlerts = p.alerts?.subscribe(items => send({ t: "alerts", items })) ?? (() => false);
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
      let olderDone: Promise<void> = Promise.resolve();
      // Read marks and mute (phase D): every change, from any device, to every feed.
      const unsubscribeReading = p.reading?.subscribe(e => send(e)) ?? (() => false);
      // ws closes the socket itself on a bad frame (too big, invalid UTF-8, unknown opcode), then emits 'error';
      // without a listener that emit would end the hub. Logged without the payload.
      ws.on("error", e => log.warn(`feed socket: ${e.message}`));
      ws.on("pong", () => { conn.alive = true; });
      ws.on("close", () => { conns.delete(conn); unsubscribe(); unsubscribeBoard(); unsubscribeTasks(); unsubscribeUsage(); unsubscribeJobs(); unsubscribeAlerts(); unsubscribeQueue(); unsubscribeReading(); p.push?.notifications.left(conn.id); p.presence?.left(conn.id); });
      // Every frame is decoded (ADR-0008, A2): malformed closes with 1003, a type this hub doesn't know is ignored.
      ws.on("message", raw => {
        if (!buckets.feedFrames.take(conn.id).ok) return ws.close(1008, "too many messages");
        const d = decode(ClientFeedFrames, raw);
        if (d.kind === "malformed") return ws.close(1003, "bad message");
        if (d.kind === "unknown") return;
        const m = d.frame;
        // A frame's own work can throw (read marks, mute and seen links write to the database, which can be busy): the
        // connection closes and the app reconnects, never an uncaught exception that ends the hub (whole-branch review L5).
        try { onFeedFrame(m); }
        catch (e) { log.error(`feed socket: a ${m.t} frame failed, closing`, e); ws.close(1011, "internal error"); }
      });
      // What the read models of catch-up, the chat list and the digest read: the roster, each history, the marks, mute.
      const feedSources = () => ({
        workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name })),
        history: (id: string) => observation.history(id, CONVERSATION_CAP),
        reads: () => p.reading?.state().reads ?? {},
        muted: () => p.reading?.state().muted ?? [],
      });
      const onFeedFrame = (m: FrameOf<typeof ClientFeedFrames>) => {
        switch (m.t) {
          case "hello": {
            const r = m.epoch !== undefined && m.cursor !== undefined ? observation.feed.since(m.epoch, m.cursor) : { kind: "resync" as const };
            if (r.kind === "events") send({ t: "events", events: r.events, caughtUp: true });
            else send({ t: "snapshot", ...observation.snapshot() });
            send({ t: "fleet", available: observation.fleet() === "ok" });   // a resumed feed may have missed a change
            send({ t: "decisions", ...escalations.seenBy(conn.auth.endpoint.id) });
            if (p.board) send({ t: "board", ...p.board.service.view() });   // ADR-0015: whole, after every hello
            if (p.usage) send({ t: "usage", ...p.usage.view() });           // ADR-0016: every account, after every hello
            p.usage?.look();                                                // S5 (AT-45): somebody is looking — mark the demand
            if (p.queue) send({ t: "deliveries", items: p.queue.commandsOf(conn.auth.endpoint.id) });   // all of the last day
            send({ t: "manager", queue: steering.managerQueue });           // whether a message waits for it while it has no window
            if (p.alerts) send({ t: "alerts", ...p.alerts.view() });        // the fleet's latest alerts, after every hello
            if (p.jobs) send({ t: "jobs", ...p.jobs.view() });               // the fleet mirror, after every hello
            if (p.reading) send(p.reading.state());           // all marks and mutes: they may have moved while away
            if (p.reading) send({ t: "caught_up", at: p.reading.caughtUpAt() });   // ADR-0009, C7
            for (const l of access.unseenLinks(conn.auth.endpoint.id)) send({ t: "linked", ...l });   // AC13, while away
            if (m.layout && p.presence) p.presence.hello(conn.id, conn.auth.endpoint.id, m.layout);
            if (p.presence) send({ t: "presence", elsewhere: p.presence.elsewhere(conn.auth.endpoint.id, conn.id) });   // ADR-0011, H4
            break;
          }
          case "read":
            p.reading?.read(m.conversation, m.at);
            break;
          case "mute":
            p.reading?.mute(m.conversation, m.muted);
            break;
          case "linked_seen":
            access.seeLinks(conn.auth.endpoint.id, m.at);
            break;
          case "older": {
            // Read from the transcript, which may be on another node: async, so outside this handler's try. A page that
            // fails is answered as missing (the app says it couldn't load it), and nothing here may reject unhandled:
            // exitOnCrash would end the hub (ADR-0008, A5).
            const { worker, before } = m;
            olderDone = olderDone
              .then(() => observation.older(worker, before))
              .catch((e: unknown): OlderResult => {
                log.warn(`feed socket: older page of ${worker} failed`, e);
                return { messages: [], done: false, missing: true };
              })
              .then(page => send({ t: "older", worker, before, messages: page.messages, done: page.done, ...(page.missing ? { missing: true } : {}) }))
              .catch((e: unknown) => { log.error("feed socket: answering an older page failed, closing", e); ws.close(1011, "internal error"); });
            break;
          }
          case "details": {
            const info = observation.session(m.worker);
            send({ t: "details", worker: m.worker, session: info ? { name: info.name, cwd: info.cwd, version: info.version } : null });
            break;
          }
          case "watch": {
            conn.watching = m.worker;
            const text = conn.watching ? observation.screen(conn.watching) : undefined;
            if (conn.watching && text !== undefined) send({ t: "screen", worker: conn.watching, text, at: Date.now() });
            if (conn.watching) sendHistory(conn.watching);
            break;
          }
          // Catch-up (ADR-0009): what is new since the Read marks, for every conversation or the one asked for (C5);
          // and the end of a run (C7). Neither moves a mark or touches an Escalation (C6).
          case "catchup": {
            const conversations = catchUp(feedSources(), m.worker);
            send({ t: "catchup", ...(m.worker ? { only: m.worker } : {}), conversations });
            break;
          }
          case "caught_up":
            p.reading?.caughtUp(m.at);
            break;
          case "ping":
            send({ t: "pong", n: m.n });                     // the app's liveness check (ADR-0008, phase B)
            break;
          case "visible":
            p.push?.notifications.attending(conn.id, m.v);   // N3: while he is attending on a device, no push goes
            p.presence?.attending(conn.id, conn.auth.endpoint.id, m.v);   // H4: when he was last active on this device
            break;
          // ADR-0011: the chat list (H1), the digest since he left (H5), and when he was last active elsewhere (H4).
          // Read only, as catch-up: no mark moves, no Escalation is touched.
          case "chats":
            send({ t: "chats", chats: chats(feedSources()) });
            break;
          case "digest":
            send({ t: "digest", since: m.since, conversations: digest(feedSources(), m.since) });
            break;
          case "presence":
            send({ t: "presence", elsewhere: p.presence?.elsewhere(conn.auth.endpoint.id, conn.id) ?? null });
            break;
          default:
            unreachable(m);
        }
      };
    });
  });

  // ---- watching and controlling a worker's terminal or the desktop (AC9), each on its own WebSocket
  const remoteWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  type RemoteConn = { ws: WebSocket; viewer: Viewer; cookie: string; lapsed: boolean; alive: boolean; stop: () => void };
  const remoteConns = new Set<RemoteConn>();
  // `use`: the principal acted on this connection (terminal keys), as opposed to the hub's own sweep (AC5 idle).
  const holds = (c: RemoteConn, use = true) => {
    const h = remote.holds(c.viewer, access.authenticate(c.cookie, use));
    if (h === "ended") c.ws.close(4401, "session ended");
    else if (h === "lapsed") { c.lapsed = true; c.ws.close(4403, "control lapsed"); }
    return h === "ok";
  };

  function upgradeRemote(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, url: URL, deny: (code: number, text: string) => void) {
    if (!proxyOk(req) || !originOk(req)) return deny(403, "Forbidden");
    const cookie = cookieValue(req, COOKIE) ?? "";
    const a = access.authenticate(cookie);
    if (!a) return deny(401, "Unauthorized");
    const control = url.searchParams.get("control") === "1";
    const target = url.pathname === "/api/desktop" ? { kind: "desktop" as const } : { kind: "terminal" as const, workerId: url.searchParams.get("pane") ?? "" };
    const r = remote.open(a, target, control);
    if (!r.ok) return deny(r.refused === "step_up" ? 403 : r.refused === "ended" ? 401 : 404, r.refused);
    remoteWss.handleUpgrade(req, socket, head, ws => {
      const conn: RemoteConn = { ws, viewer: r.viewer, cookie, lapsed: false, alive: true, stop: () => {} };
      remoteConns.add(conn);
      ws.on("pong", () => { conn.alive = true; });
      // Anything the browser sends proves it's there too: a pong can wait behind megabytes of desktop frames on a slow
      // link (review L5).
      ws.on("message", () => { conn.alive = true; });
      ws.on("error", e => log.warn(`${target.kind} socket: ${e.message}`));   // as on the feed: ws closes it itself
      ws.on("close", () => { remoteConns.delete(conn); conn.stop(); remote.closed(conn.viewer, conn.lapsed ? "lapsed" : "released"); });
      const desktop = remote.desktop();
      if (target.kind === "desktop" && desktop) void bridgeDesktop(ws, desktop, control, why => { if (why !== "browser left") log.warn(`desktop: ${why}`); }, use => holds(conn, use));
      else if (target.kind === "terminal") conn.stop = streamTerminal(conn, target.workerId);
    });
  }

  // Frames of one pane while it changes (polled every 80 ms, sent only when different); keys only under control.
  // While its frames are unavailable (its fleet node offline or slow, the fleet unreachable), the view asks less often:
  // 160 ms after the first such answer, twice as long after each one more, at most every 2 s; the first frame that comes
  // back puts it back to every tick at once, and keys typed through ask at once too (the follow-up to final review M5:
  // an open view asked an offline node every 80 ms).
  function streamTerminal(conn: RemoteConn, pane: string): () => void {
    const { ws } = conn;
    let last = "";
    let busy = false;
    let stopped = false;
    let backoff = 0;                                         // ms between asks while unavailable; 0: every tick
    let askAt = 0;                                           // performance.now() before which a tick doesn't ask
    const send = (m: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    // Both run outside any caller that would catch: a throw here would be an unhandled rejection, which ends the hub
    // (ADR-0008, A5). A failed frame closes this connection (1011); failed keys are reported on it. A frame that is only
    // unavailable for now (a fleet node offline or slow, the fleet unreachable) keeps it open; a pane gone closes it (4404).
    const tick = async (now = false) => {
      if (busy || stopped) return;
      if (!now && performance.now() < askAt) return;      // backing off: its node couldn't answer a moment ago
      busy = true;
      try {
        const f = await remote.terminal.frame(pane);
        if (f === "unavailable") {                         // its node can't answer now: kept open, asked again later (M5)
          backoff = Math.min(backoff === 0 ? FRAME_POLL_MS * 2 : backoff * 2, FRAME_BACKOFF_MAX_MS);
          askAt = performance.now() + backoff;
          return;
        }
        backoff = 0;
        askAt = 0;
        if (!f) { ws.close(4404, "pane gone"); return; }
        const json = JSON.stringify(f);
        if (json !== last) { last = json; send({ t: "frame", ...f }); }
      } catch (e) {
        log.warn(`terminal ${pane}: frame failed, closing`, e);
        stopped = true;
        ws.close(1011, "terminal unavailable");
      } finally { busy = false; }
    };
    const onKeys = async (raw: unknown) => {
      const d = decode(ClientTerminalFrames, raw);
      if (d.kind === "malformed") return ws.close(1003, "bad message");
      if (d.kind === "unknown") return;
      const m = d.frame;
      if (!conn.viewer.grant) return ws.close(4403, "keys need control");
      if (!holds(conn)) return;
      // "uncertain": the node may have typed them (the connection dropped while they were out), so the app says "may have
      // been typed", never "refused" (fleet core §3.1); keystrokes are never retried.
      let typed: boolean | "uncertain" = false;
      try { typed = await remote.terminal.keys(pane, m.data); }
      catch (e) { log.warn(`terminal ${pane}: keys failed`, e); }
      if (typed === "uncertain") send({ t: "error", error: "keys_uncertain" });
      else if (!typed) send({ t: "error", error: "keys_refused" });
      setTimeout(() => void tick(typed === true), 25);
    };
    send({ t: "mode", control: conn.viewer.grant !== null });
    void tick();
    const timer = setInterval(() => void tick(), FRAME_POLL_MS);
    // One key message at a time, in the order they came: each is its own tmux command, and two at once land out of
    // order on a busy machine ("echo" typed as "ehco", seen on 2 CPUs).
    let keysDone: Promise<void> = Promise.resolve();
    ws.on("message", raw => {
      keysDone = keysDone.then(() => onKeys(raw)).catch((e: unknown) => { log.error(`terminal ${pane}: message handler failed`, e); ws.close(1011, "internal error"); });
    });
    return () => { stopped = true; clearInterval(timer); };
  }
  const remoteSweep = setInterval(() => { for (const c of remoteConns) holds(c, false); }, 5000);

  // Heartbeat, and re-check each connection's session so expiry and revocation from the console also cut it. Every
  // socket is pinged, the terminal's and the desktop's too (ADR-0008, phase B): one that didn't answer the previous
  // ping is gone (a phone that slept, a dropped network) and is terminated rather than streamed into.
  const sweep = setInterval(() => {
    for (const c of conns) {
      if (!access.authenticate(c.cookie, false)) { c.ws.close(4401, "session ended"); continue; }
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
    for (const c of remoteConns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, p.heartbeatMs ?? 15_000);
  // AC13: a device added from an Endpoint or a Link request: every live feed is told.
  access.onLinked(e => { for (const c of conns) if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(redactFeed({ t: "linked", ...e }))); });
  access.onRevoked(id => {
    for (const c of conns) if (c.auth.endpoint.id === id) c.ws.close(4401, "device revoked");
    for (const c of remoteConns) holds(c, false);           // AC4: its terminal and desktop connections end too
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(config.port, "127.0.0.1");
  return {
    server,
    ready,
    flight,
    idle: (timeoutMs = 10_000) => { draining = true; return flight.idle(timeoutMs); },
    close: () => new Promise<void>(resolve => {
      watch.stop();
      clearInterval(sweep); clearInterval(remoteSweep);
      for (const c of conns) c.ws.terminate();
      for (const c of remoteConns) c.ws.terminate();
      wss.close(); remoteWss.close(); server.close(() => resolve());
      // close() alone waits for a connection that hasn't sent its request yet (a browser's preconnect) until Node's
      // 60 s header timeout, so stopping the service hung a minute; at shutdown every connection goes
      // (https://nodejs.org/api/http.html#servercloseallconnections, Node 18.2+).
      server.closeAllConnections();
    }),
  };
}
