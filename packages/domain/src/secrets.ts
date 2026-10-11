// Secrets (ADR-0022; design §3): Secret requests on the hub, Secrets on each node, and the two domain services for the
// rules that span many aggregates: Request admission (SR1, SR10) and the Fingerprint ledger (SC2). Pure: the clock is
// the `now` argument (ms). No value exists in this context, only keyed fingerprints computed outside it. docs/domain.md
// gives the Layer of each invariant; only the domain and domain-service ones are decided here.
import { LANE_NAME } from "./board.ts";
import type { Actor } from "./connections.ts";
import { err, ok, type Result } from "./shared.ts";

const DAY = 86_400_000;
const REFERENCE = /^secret:\/\/([a-z0-9][a-z0-9-]{0,39})\/([a-z0-9][a-z0-9._-]{0,63})$/;
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const NODE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const KEYED_FINGERPRINT = /^[0-9a-f]{12}$/;
export const SHAPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DESTINATION_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// A C0 or C1 control character, or DEL: plain text has none.
function hasControl(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    const n = t.charCodeAt(i);   // every control character is one UTF-16 unit
    if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) return true;
  }
  return false;
}
export const PURPOSE_MAX = 300;
export const REQUEST_TTL_MS = 7 * DAY;
export const REQUEST_LIMITS = { laneOpen: 5, laneDay: 20, nodeOpen: 20, nodeDay: 100, waiters: 20 } as const;
export const SECRET_EXPIRY_LEADS = [["7d", 7 * DAY], ["2d", 2 * DAY], ["1d", DAY]] as const;
export const DESTINATIONS_MAX = 10;
export const USE_REFUSED = 77;

export const USE_MODES = ["exec", "file", "helper", "inject"] as const;
export const REQUEST_KINDS = ["new", "access", "rotate", "renew"] as const;
// The kinds a store answers: an access request is granted, never stored (SR8).
export const STORED_KINDS = ["new", "rotate", "renew"] as const;
export const REQUEST_STATES = ["open", "stored", "granted", "rejected", "withdrawn", "expired"] as const;
export const SECRET_STATUSES = ["active", "disabled", "revoked"] as const;
export type UseMode = (typeof USE_MODES)[number];
export type RequestKind = (typeof REQUEST_KINDS)[number];
export type RequestState = (typeof REQUEST_STATES)[number];
export type SecretStatus = (typeof SECRET_STATUSES)[number];

// ---- References (§3.6)

export type Reference = { scope: string; name: string };

export function parseReference(text: string): Reference | null {
  const m = REFERENCE.exec(text);
  return m && m[1] !== undefined && m[2] !== undefined ? { scope: m[1], name: m[2] } : null;
}
export const formatReference = (r: Reference): string => `secret://${r.scope}/${r.name}`;

// ---- Grants

export type GrantSubject = { kind: "lane"; lane: string } | { kind: "workspace"; workspace: string } | { kind: "node" };
export type GrantEnd = { kind: "open" } | { kind: "at"; at: number } | { kind: "lane-end" };
export type SecretGrant = { subject: GrantSubject; modes: readonly UseMode[]; until: GrantEnd };
export type Caller = { lane: string | null; workspace: string | null };

function subjectOk(s: GrantSubject): boolean {
  if (s.kind === "lane") return LANE_NAME.test(s.lane);
  if (s.kind === "workspace") return WORKSPACE_NAME.test(s.workspace);
  return s.kind === "node";
}
// No item twice. The wire checks lengths and items on their own and refines with this, so a refusal names only what failed.
export const eachOnce = (items: readonly string[]) => new Set(items).size === items.length;
// A Grant's modes: at least one, each known, each once.
export const modesOk = (modes: readonly UseMode[]) =>
  modes.length > 0 && eachOnce(modes) && modes.every(m => (USE_MODES as readonly string[]).includes(m));
function grantOk(g: SecretGrant): boolean {
  const untilOk = g.until.kind === "open" || g.until.kind === "lane-end" || (g.until.kind === "at" && Number.isFinite(g.until.at));
  return subjectOk(g.subject) && modesOk(g.modes) && untilOk;
}
const sameSubject = (a: GrantSubject, b: GrantSubject): boolean =>
  a.kind === b.kind && (a.kind !== "lane" || (b.kind === "lane" && a.lane === b.lane))
  && (a.kind !== "workspace" || (b.kind === "workspace" && a.workspace === b.workspace));
const sameEnd = (a: GrantEnd, b: GrantEnd) => a.kind === b.kind && (a.kind !== "at" || (b.kind === "at" && a.at === b.at));
const sameGrant = (a: SecretGrant, b: SecretGrant) =>
  sameSubject(a.subject, b.subject) && sameEnd(a.until, b.until) && a.modes.length === b.modes.length && a.modes.every(m => b.modes.includes(m));
const admits = (s: GrantSubject, c: Caller) =>
  s.kind === "node" || (s.kind === "lane" && c.lane === s.lane) || (s.kind === "workspace" && c.workspace === s.workspace);
const ended = (u: GrantEnd, now: number) => u.kind === "at" && now >= u.at;

// ---- Secret requests (hub; §3.3)

export type Waiter = { lane: string | null; workspace: string | null; purpose: string; at: number };
// Who a waiter is: its lane, or without one its workspace. Both are named, so a call can't fall back to "no workspace".
export type WaiterKey = { lane: string | null; workspace: string | null };
export type RequestAnswer = { kind: "stored" | "granted" | "rejected"; at: number; command: string; reason: string | null };
export type SecretRequest = {
  id: string; node: string; reference: string; kind: RequestKind; state: RequestState; openedAt: number;
  openedBy: string | null; waiting: readonly Waiter[]; proposed: SecretGrant; version: number; answer: RequestAnswer | null;
};
export type RequestAsk = {
  node: string; reference: string; kind: RequestKind; waiter: Omit<Waiter, "at">; proposed: SecretGrant;
};
export type RequestEvent =
  | { type: "SecretRequested"; request: string; node: string; reference: string; kind: RequestKind; at: number }
  | { type: "SecretRequestJoined"; request: string; lane: string | null; workspace: string | null; at: number }
  | { type: "SecretRequestLeft"; request: string; lane: string | null; workspace: string | null; at: number }
  | { type: "SecretRequestWithdrawn"; request: string; lane: string | null; workspace: string | null; at: number }
  | { type: "SecretRequestStored"; request: string; reference: string; nodes: readonly string[]; version: number; at: number; command: string }
  | { type: "SecretRequestGranted"; request: string; at: number; command: string }
  | { type: "SecretRequestRejected"; request: string; at: number; command: string; reason: string | null }
  | { type: "SecretRequestExpired"; request: string; at: number };
export type RequestProblem = "bad_reference" | "bad_purpose" | "bad_grant" | "bad_node" | "bad_lane" | "bad_workspace" | "principal"
  | "answered" | "expired" | "changed" | "kind" | "node" | "not_waiting" | "open" | "full" | "expiry";
export type RequestRefusal = { problem: RequestProblem };
export type RequestChange = { request: SecretRequest; events: readonly RequestEvent[] };
export type RequestLimit = "lane-open" | "lane-day" | "node-open" | "node-day" | "request-waiters";
export type Admission = { kind: "open" } | { kind: "join"; request: string } | { kind: "refuse"; limit: RequestLimit };

const refuseRequest = (problem: RequestProblem): Result<never, RequestRefusal> => err({ problem });
// Plain text: 1 to `max` characters and no control character. The wire uses the same rule.
export const plainText = (t: string, max: number) => t.length >= 1 && t.length <= max && !hasControl(t);
const textOk = (t: string) => plainText(t, PURPOSE_MAX);

function waiterProblem(w: Omit<Waiter, "at">): RequestProblem | null {
  if (w.lane !== null && !LANE_NAME.test(w.lane)) return "bad_lane";
  if (w.workspace !== null && !WORKSPACE_NAME.test(w.workspace)) return "bad_workspace";
  return textOk(w.purpose) ? null : "bad_purpose";
}

// A waiter is its lane; a caller without a lane is its workspace, and no workspace counts as one (docs/domain.md).
const sameWaiter = (w: WaiterKey, lane: string | null, workspace: string | null) =>
  lane !== null ? w.lane === lane : w.lane === null && w.workspace === workspace;
// SR10: a request holds at most `waiters` waiters, so joins can't grow its card or move its version without end.
const full = (req: SecretRequest) => req.waiting.length >= REQUEST_LIMITS.waiters;

// Request admission (SR1, SR10): over the node's requests, open and those opened in the last day. The store holds a
// unique index on (node, Reference) over open requests and runs this and the insert in one write transaction.
export function admitRequest(requests: readonly SecretRequest[], ask: RequestAsk, now: number): Admission {
  const mine = requests.filter(r => r.node === ask.node);
  const open = mine.filter(r => r.state === "open");
  const lane = ask.waiter.lane;
  const holds = lane === null ? 0 : open.filter(r => r.waiting.some(w => w.lane === lane)).length;
  const same = open.find(r => r.reference === ask.reference);
  if (same) {
    if (lane !== null && !same.waiting.some(w => w.lane === lane) && holds >= REQUEST_LIMITS.laneOpen) return { kind: "refuse", limit: "lane-open" };
    if (full(same) && !same.waiting.some(w => sameWaiter(w, lane, ask.waiter.workspace))) return { kind: "refuse", limit: "request-waiters" };
    return { kind: "join", request: same.id };
  }
  const today = (r: SecretRequest) => r.openedAt > now - DAY;
  if (lane !== null && holds >= REQUEST_LIMITS.laneOpen) return { kind: "refuse", limit: "lane-open" };
  if (lane !== null && mine.filter(r => r.openedBy === lane && today(r)).length >= REQUEST_LIMITS.laneDay) return { kind: "refuse", limit: "lane-day" };
  if (open.length >= REQUEST_LIMITS.nodeOpen) return { kind: "refuse", limit: "node-open" };
  if (mine.filter(today).length >= REQUEST_LIMITS.nodeDay) return { kind: "refuse", limit: "node-day" };
  return { kind: "open" };
}

export function openRequest(ask: RequestAsk, id: string, now: number): Result<RequestChange, RequestRefusal> {
  if (!NODE_LABEL.test(ask.node)) return refuseRequest("bad_node");
  if (parseReference(ask.reference) === null) return refuseRequest("bad_reference");
  const w = waiterProblem(ask.waiter);
  if (w) return refuseRequest(w);
  if (!grantOk(ask.proposed)) return refuseRequest("bad_grant");
  const request: SecretRequest = {
    id, node: ask.node, reference: ask.reference, kind: ask.kind, state: "open", openedAt: now, openedBy: ask.waiter.lane,
    waiting: [{ ...ask.waiter, at: now }], proposed: ask.proposed, version: 1, answer: null,
  };
  return ok({ request, events: [{ type: "SecretRequested", request: id, node: ask.node, reference: ask.reference, kind: ask.kind, at: now }] });
}

export function joinRequest(req: SecretRequest, waiter: Omit<Waiter, "at">, now: number): Result<RequestChange, RequestRefusal> {
  if (req.state !== "open") return refuseRequest("answered");
  const w = waiterProblem(waiter);
  if (w) return refuseRequest(w);
  // A repeat by the same waiter changes nothing (SR1).
  if (req.waiting.some(x => sameWaiter(x, waiter.lane, waiter.workspace))) return ok({ request: req, events: [] });
  if (full(req)) return refuseRequest("full");
  const request = { ...req, waiting: [...req.waiting, { ...waiter, at: now }], version: req.version + 1 };
  return ok({ request, events: [{ type: "SecretRequestJoined", request: req.id, lane: waiter.lane, workspace: waiter.workspace, at: now }] });
}

// A withdrawal names its waiter: a lane, or for a caller without one, its workspace.
export function withdrawRequest(req: SecretRequest, waiter: WaiterKey, now: number): Result<RequestChange, RequestRefusal> {
  if (req.state !== "open") return refuseRequest("answered");
  const { lane, workspace } = waiter;
  const at = req.waiting.findIndex(w => sameWaiter(w, lane, workspace));
  const gone = req.waiting[at];
  if (!gone) return refuseRequest("not_waiting");
  if (req.waiting.length > 1) {
    const request = { ...req, waiting: req.waiting.filter((_, i) => i !== at), version: req.version + 1 };
    // The events name the waiter as the request recorded it.
    return ok({ request, events: [{ type: "SecretRequestLeft", request: req.id, lane: gone.lane, workspace: gone.workspace, at: now }] });
  }
  const event: RequestEvent = { type: "SecretRequestWithdrawn", request: req.id, lane: gone.lane, workspace: gone.workspace, at: now };
  return ok({ request: { ...req, state: "withdrawn" }, events: [event] });
}

export function expireRequest(req: SecretRequest, now: number): Result<RequestChange, RequestRefusal> {
  if (req.state !== "open") return refuseRequest("answered");
  if (now < req.openedAt + REQUEST_TTL_MS) return refuseRequest("open");
  return ok({ request: { ...req, state: "expired" }, events: [{ type: "SecretRequestExpired", request: req.id, at: now }] });
}

// SR4 and SR6: one answer, from the principal, to the version it saw, before the request expired.
export function checkAnswer(req: SecretRequest, seen: number, command: string, now: number): RequestProblem | null {
  if (!command) return "principal";
  if (req.state !== "open") return "answered";
  if (now >= req.openedAt + REQUEST_TTL_MS) return "expired";
  return seen === req.version ? null : "changed";
}

export type Answer = { seen: number; command: string };

export function answerRejected(req: SecretRequest, a: Answer & { reason: string | null }, now: number): Result<RequestChange, RequestRefusal> {
  const p = checkAnswer(req, a.seen, a.command, now);
  if (p) return refuseRequest(p);
  if (a.reason !== null && !textOk(a.reason)) return refuseRequest("bad_purpose");
  const request: SecretRequest = { ...req, state: "rejected", answer: { kind: "rejected", at: now, command: a.command, reason: a.reason } };
  return ok({ request, events: [{ type: "SecretRequestRejected", request: req.id, at: now, command: a.command, reason: a.reason }] });
}

export function answerGranted(req: SecretRequest, a: Answer, now: number): Result<RequestChange, RequestRefusal> {
  const p = checkAnswer(req, a.seen, a.command, now);
  if (p) return refuseRequest(p);
  if (req.kind !== "access") return refuseRequest("kind");
  const request: SecretRequest = { ...req, state: "granted", answer: { kind: "granted", at: now, command: a.command, reason: null } };
  return ok({ request, events: [{ type: "SecretRequestGranted", request: req.id, at: now, command: a.command }] });
}

// SR8: Stored only once the requester's node confirmed; `version` is the Secret's version there, `expiry` the Expiry the
// store named. A renew is answered only by a store that names a later Expiry, since a Rotation keeps one that has passed.
export function answerStored(
  req: SecretRequest, a: Answer & { reference: string; version: number; nodes: readonly string[]; expiry?: number | null }, now: number,
): Result<RequestChange, RequestRefusal> {
  const p = checkAnswer(req, a.seen, a.command, now);
  if (p) return refuseRequest(p);
  if (req.kind === "access") return refuseRequest("kind");
  const renews = a.expiry !== undefined && a.expiry !== null && Number.isFinite(a.expiry) && a.expiry > now;
  if (req.kind === "renew" && !renews) return refuseRequest("expiry");
  if (parseReference(a.reference) === null) return refuseRequest("bad_reference");
  if (!a.nodes.includes(req.node) || !Number.isSafeInteger(a.version) || a.version < 1) return refuseRequest("node");
  const request: SecretRequest = { ...req, state: "stored", answer: { kind: "stored", at: now, command: a.command, reason: null } };
  return ok({
    request,
    events: [{ type: "SecretRequestStored", request: req.id, reference: a.reference, nodes: [...a.nodes], version: a.version, at: now, command: a.command }],
  });
}

// ---- Secrets on a node (§3.4)

export type SecretVersion = { number: number; fingerprint: string; storedAt: number; command: string; retiredAt: number | null };
export type Secret = {
  reference: string; status: SecretStatus; current: SecretVersion | null; versions: readonly SecretVersion[];
  grants: readonly SecretGrant[]; destinations: readonly string[]; expiry: number | null; shape: string | null;
  warned: readonly string[];
};
export type LedgerEntry = { reference: string; version: number; fingerprint: string; state: "current" | "retired" | "revoked" };
export type UseOutcome = "exited" | "failed" | "lost";
export const USE_REFUSAL_REASONS = ["missing", "disabled", "revoked", "no_value", "expired", "not_granted", "mode"] as const;
export type UseRefusalReason = (typeof USE_REFUSAL_REASONS)[number];
export type SecretEvent =
  | { type: "SecretStored"; reference: string; version: number; at: number; command: string; sameAs: readonly string[] }
  | { type: "SecretRotated"; reference: string; version: number; at: number; command: string; sameAs: readonly string[] }
  | { type: "SecretTransferred"; reference: string; version: number; at: number; command: string; from: string; sameAs: readonly string[] }
  | { type: "SecretDisabled"; reference: string; at: number }
  | { type: "SecretEnabled"; reference: string; at: number; command: string }
  | { type: "SecretRevoked"; reference: string; version: number; at: number; command: string }
  | { type: "SecretDeleted"; reference: string; at: number; command: string }
  | { type: "SecretExpired"; reference: string; at: number }
  | { type: "ExpiryWarned"; reference: string; at: number; lead: string }
  | { type: "ExpiryChanged"; reference: string; at: number; command: string | null }
  | { type: "GrantAdded"; reference: string; at: number; command: string | null; subject: GrantSubject }
  | { type: "GrantRemoved"; reference: string; at: number; command: string | null; subject: GrantSubject }
  | { type: "GrantEnded"; reference: string; at: number; subject: GrantSubject }
  | { type: "DestinationsChanged"; reference: string; at: number; command: string | null }
  | { type: "SecretUsed"; reference: string; version: number; at: number; use: string; mode: UseMode; lane: string | null; workspace: string | null }
  | { type: "UseRefused"; reference: string; at: number; reason: UseRefusalReason; mode: UseMode; lane: string | null; workspace: string | null }
  | { type: "UseEnded"; reference: string; at: number; use: string; outcome: UseOutcome };
export type SecretDirectory = { held: readonly Secret[]; ledger: readonly LedgerEntry[]; events: readonly SecretEvent[] };
export type SecretProblem = UseRefusalReason | "principal" | "bad_reference" | "bad_fingerprint" | "bad_grant"
  | "bad_destination" | "bad_shape" | "bad_node" | "expiry" | "earlier" | "same" | "renew_expiry";
export type SecretRefusal = { problem: SecretProblem; directory?: SecretDirectory };
// `shape`: the new value's shape id, null when it matches none, left out when the store doesn't say (a Rotation keeps it).
export type StoreInput = {
  reference: string; fingerprint: string; shape?: string | null; grants: readonly SecretGrant[];
  expiry: number | null; destinations: readonly string[];
};

export const emptySecretDirectory = (): SecretDirectory => ({ held: [], ledger: [], events: [] });
export const findSecret = (dir: SecretDirectory, reference: string): Secret | null =>
  dir.held.find(s => s.reference === reference) ?? null;
const refuse = (problem: SecretProblem): Result<never, SecretRefusal> => err({ problem });
const commandOf = (actor: Actor) => (actor.kind === "principal" && actor.command ? actor.command : null);

// The Fingerprint ledger (SC2): every version's keyed fingerprint on the node, revoked ones included. The store keeps
// unique indexes on the Reference and on (Reference, keyed fingerprint), and runs this and the insert in one transaction.
export type LedgerCheck = { kind: "accept"; sameAs: readonly string[] } | { kind: "refuse"; reason: "revoked" | "earlier" };
export function checkFingerprint(ledger: readonly LedgerEntry[], reference: string, fingerprint: string): LedgerCheck {
  if (ledger.some(e => e.fingerprint === fingerprint && e.state === "revoked")) return { kind: "refuse", reason: "revoked" };
  if (ledger.some(e => e.reference === reference && e.fingerprint === fingerprint)) return { kind: "refuse", reason: "earlier" };
  const sameAs = [...new Set(ledger.filter(e => e.fingerprint === fingerprint && e.state === "current" && e.reference !== reference).map(e => e.reference))];
  return { kind: "accept", sameAs };
}

// Destinations: at most ten hosts, each once, each a lower-case host name.
export const hostsOk = (hosts: readonly string[]) =>
  hosts.length <= DESTINATIONS_MAX && eachOnce(hosts) && hosts.every(h => DESTINATION_HOST.test(h));

function inputProblem(input: StoreInput): SecretProblem | null {
  if (parseReference(input.reference) === null) return "bad_reference";
  if (!KEYED_FINGERPRINT.test(input.fingerprint)) return "bad_fingerprint";
  if (typeof input.shape === "string" && !SHAPE_ID.test(input.shape)) return "bad_shape";
  if (!input.grants.every(grantOk)) return "bad_grant";
  if (!hostsOk(input.destinations)) return "bad_destination";
  if (input.expiry !== null && !Number.isFinite(input.expiry)) return "expiry";
  return null;
}

type Placed = { secret: Secret; ledger: readonly LedgerEntry[]; version: number; sameAs: readonly string[]; expiryChanged: boolean };

// SC9: only a later Expiry clears the warnings, whoever sets it; none at all counts as later. A store keeps the old
// Expiry when it names none, so for a store this means one named and later.
const clearsWarnings = (before: number | null, after: number | null) => before !== null && (after === null || after > before);

// A store under a new Reference creates the Secret; under an existing one it is a Rotation, which keeps its Grants and
// Destinations, and its Expiry unless it names one (docs/domain.md, "Expiry on a Rotation or a transfer"). A named Expiry
// replaces the old one and clears the warnings only when later; a store never removes one. A named shape, none included,
// replaces the old one, so nothing looks for a format the value no longer has. The ledger decides first.
function place(dir: SecretDirectory, input: StoreInput, command: string, at: number): Result<Placed, SecretRefusal> {
  const p = inputProblem(input);
  if (p) return refuse(p);
  const check = checkFingerprint(dir.ledger, input.reference, input.fingerprint);
  if (check.kind === "refuse") return refuse(check.reason);
  const before = findSecret(dir, input.reference);
  // The ledger outlives a Delete, so numbering continues from it: (Reference, version) names one value forever. The
  // Secret's own versions count too, so a ledger that lacks them can't make a number come round again.
  const numbers = [...dir.ledger.filter(e => e.reference === input.reference).map(e => e.version), ...(before?.versions.map(v => v.number) ?? [])];
  const number = Math.max(0, ...numbers) + 1;
  const fresh: SecretVersion = { number, fingerprint: input.fingerprint, storedAt: at, command, retiredAt: null };
  const ledger = [
    ...dir.ledger.map(e => e.reference === input.reference && e.state === "current" ? { ...e, state: "retired" as const } : e),
    { reference: input.reference, version: number, fingerprint: input.fingerprint, state: "current" as const },
  ];
  const secret: Secret = before
    ? {
        ...before, status: before.status === "revoked" ? "active" : before.status, current: fresh,
        shape: input.shape === undefined ? before.shape : input.shape,
        expiry: input.expiry ?? before.expiry,
        warned: clearsWarnings(before.expiry, input.expiry ?? before.expiry) ? [] : before.warned,
        versions: [...before.versions.map(v => v.retiredAt === null ? { ...v, retiredAt: at } : v), fresh],
      }
    : {
        reference: input.reference, status: "active", current: fresh, versions: [fresh], grants: [...input.grants],
        destinations: [...input.destinations], expiry: input.expiry, shape: input.shape ?? null, warned: [],
      };
  const expiryChanged = before !== null && input.expiry !== null && input.expiry !== before.expiry;
  return ok({ secret, ledger, version: number, sameAs: check.sameAs, expiryChanged });
}

function withSecret(dir: SecretDirectory, secret: Secret, events: readonly SecretEvent[], ledger = dir.ledger): SecretDirectory {
  const exists = dir.held.some(s => s.reference === secret.reference);
  return {
    held: exists ? dir.held.map(s => s.reference === secret.reference ? secret : s) : [...dir.held, secret],
    ledger, events: [...dir.events, ...events],
  };
}

const expiryEvent = (changed: boolean, reference: string, at: number, command: string): SecretEvent[] =>
  changed ? [{ type: "ExpiryChanged", reference, at, command }] : [];

export function storeSecret(dir: SecretDirectory, input: StoreInput, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  const command = commandOf(actor);
  if (!command) return refuse("principal");
  const rotation = findSecret(dir, input.reference) !== null;
  const placed = place(dir, input, command, at);
  if (!placed.ok) return placed;
  const { secret, ledger, version, sameAs, expiryChanged } = placed.value;
  const event: SecretEvent = { type: rotation ? "SecretRotated" : "SecretStored", reference: input.reference, version, at, command, sameAs };
  return ok(withSecret(dir, secret, [event, ...expiryEvent(expiryChanged, input.reference, at, command)], ledger));
}

// A store that answers a renew request (secrets.store names its kind; design §5.3, step 6). The node holds the Expiry, so
// it decides here, before anything is stored: a renew names an Expiry later than now and than the current one. Anything
// else is refused as renew_expiry, and the request stays open (SR8). Decided on T-80 (review round 4).
export function renewSecret(dir: SecretDirectory, input: StoreInput, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  if (!commandOf(actor)) return refuse("principal");
  const current = findSecret(dir, input.reference)?.expiry ?? null;
  const later = input.expiry !== null && input.expiry > at && (current === null || input.expiry > current);
  if (!later) return refuse("renew_expiry");
  return storeSecret(dir, input, actor, at);
}

// SC11: the target stores a transferred value as its own Secret, through its own ledger.
export function receiveTransfer(dir: SecretDirectory, input: StoreInput & { from: string }, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  const command = commandOf(actor);
  if (!command) return refuse("principal");
  if (!NODE_LABEL.test(input.from)) return refuse("bad_node");
  const placed = place(dir, input, command, at);
  if (!placed.ok) return placed;
  const { secret, ledger, version, sameAs, expiryChanged } = placed.value;
  const event: SecretEvent = { type: "SecretTransferred", reference: input.reference, version, at, command, from: input.from, sameAs };
  return ok(withSecret(dir, secret, [event, ...expiryEvent(expiryChanged, input.reference, at, command)], ledger));
}

// SC11: a transfer starts from a Secret that could be used now, and carries the Grants that haven't ended.
export function transferable(secret: Secret | null, now: number): Result<Secret, { problem: UseRefusalReason }> {
  const p = statusProblem(secret, now);
  if (p || !secret) return err({ problem: p ?? "missing" });
  return ok(secret);
}
export const transferGrants = (secret: Secret, now: number): SecretGrant[] => secret.grants.filter(g => !ended(g.until, now));

// ---- Widening, by effect (SC7)

function endCovers(b: GrantEnd, a: GrantEnd): boolean {
  if (b.kind === "open") return true;
  if (a.kind === "open") return false;
  if (b.kind === "at" && a.kind === "at") return a.at <= b.at;
  return b.kind === "lane-end" && a.kind === "lane-end";
}
const subjectCovers = (b: GrantSubject, a: GrantSubject) => b.kind === "node" || sameSubject(a, b);
const covered = (g: SecretGrant, before: readonly SecretGrant[]) =>
  before.some(b => subjectCovers(b.subject, g.subject) && g.modes.every(m => b.modes.includes(m)) && endCovers(b.until, g.until));

export function secretWidens(before: Secret, after: Secret): boolean {
  if (before.status !== "active" && after.status === "active") return true;
  if (before.expiry !== null && (after.expiry === null || after.expiry > before.expiry)) return true;
  if (after.destinations.some(h => !before.destinations.includes(h))) return true;
  return after.grants.some(g => !covered(g, before.grants));
}

function change(dir: SecretDirectory, reference: string, actor: Actor, next: (s: Secret) => Result<Secret, SecretRefusal>,
  event: (s: Secret, command: string | null) => SecretEvent): Result<SecretDirectory, SecretRefusal> {
  const before = findSecret(dir, reference);
  if (!before) return refuse("missing");
  const after = next(before);
  if (!after.ok) return after;
  const command = commandOf(actor);
  if (secretWidens(before, after.value) && !command) return refuse("principal");
  return ok(withSecret(dir, after.value, [event(after.value, command)]));
}

export function grantSecret(dir: SecretDirectory, reference: string, grant: SecretGrant, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  if (!grantOk(grant)) return refuse("bad_grant");
  return change(dir, reference, actor, s => {
    if (s.grants.some(g => sameGrant(g, grant))) return refuse("same");
    const others = s.grants.filter(g => !sameSubject(g.subject, grant.subject));
    return ok({ ...s, grants: [...others, grant] });
  }, (_, command) => ({ type: "GrantAdded", reference, at, command, subject: grant.subject }));
}

export function ungrantSecret(dir: SecretDirectory, reference: string, subject: GrantSubject, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  return change(dir, reference, actor, s => {
    if (!s.grants.some(g => sameSubject(g.subject, subject))) return refuse("missing");
    return ok({ ...s, grants: s.grants.filter(g => !sameSubject(g.subject, subject)) });
  }, (_, command) => ({ type: "GrantRemoved", reference, at, command, subject }));
}

export function setSecretExpiry(dir: SecretDirectory, reference: string, expiry: number | null, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  if (expiry !== null && !Number.isFinite(expiry)) return refuse("expiry");
  return change(dir, reference, actor, s => {
    if (s.expiry === expiry) return refuse("same");
    return ok({ ...s, expiry, warned: clearsWarnings(s.expiry, expiry) ? [] : s.warned });
  }, (_, command) => ({ type: "ExpiryChanged", reference, at, command }));
}

export function setDestinations(dir: SecretDirectory, reference: string, hosts: readonly string[], actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  if (!hostsOk(hosts)) return refuse("bad_destination");
  return change(dir, reference, actor, s => {
    if (s.destinations.length === hosts.length && s.destinations.every(h => hosts.includes(h))) return refuse("same");
    return ok({ ...s, destinations: [...hosts] });
  }, (_, command) => ({ type: "DestinationsChanged", reference, at, command }));
}

export function disableSecret(dir: SecretDirectory, reference: string, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  return change(dir, reference, actor, s => {
    if (s.status === "revoked") return refuse("revoked");
    if (s.status === "disabled") return refuse("same");
    return ok({ ...s, status: "disabled" });
  }, () => ({ type: "SecretDisabled", reference, at }));
}

export function enableSecret(dir: SecretDirectory, reference: string, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  return change(dir, reference, actor, s => {
    if (s.status === "revoked") return refuse("revoked");
    if (s.status === "active") return refuse("same");
    return ok({ ...s, status: "active" });
  }, (_, command) => ({ type: "SecretEnabled", reference, at, command: command ?? "" }));
}

// SC8: Revoke destroys the current value on this node and keeps the Reference, its history and its Grants.
export function revokeSecret(dir: SecretDirectory, reference: string, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  const command = commandOf(actor);
  if (!command) return refuse("principal");
  const s = findSecret(dir, reference);
  if (!s) return refuse("missing");
  if (s.status === "revoked" || !s.current) return refuse("revoked");
  const version = s.current.number;
  const secret: Secret = { ...s, status: "revoked", current: null, versions: s.versions.map(v => v.retiredAt === null ? { ...v, retiredAt: at } : v) };
  const ledger = dir.ledger.map(e => e.reference === reference && e.state === "current" ? { ...e, state: "revoked" as const } : e);
  return ok(withSecret(dir, secret, [{ type: "SecretRevoked", reference, version, at, command }], ledger));
}

// SC8: Delete removes the Reference and its Grants. The ledger keeps its versions, so a revoked value stays refused.
export function deleteSecret(dir: SecretDirectory, reference: string, actor: Actor, at: number): Result<SecretDirectory, SecretRefusal> {
  const command = commandOf(actor);
  if (!command) return refuse("principal");
  if (!findSecret(dir, reference)) return refuse("missing");
  return ok({
    held: dir.held.filter(s => s.reference !== reference),
    ledger: dir.ledger.map(e => e.reference === reference && e.state === "current" ? { ...e, state: "retired" as const } : e),
    events: [...dir.events, { type: "SecretDeleted", reference, at, command }],
  });
}

// Grants that end: removed, each with one GrantEnded. One pass, one new directory.
function endGrants(dir: SecretDirectory, ends: (g: SecretGrant) => boolean, at: number): SecretDirectory {
  const events: SecretEvent[] = [];
  const held = dir.held.map(s => {
    const gone = s.grants.filter(ends);
    if (gone.length === 0) return s;
    for (const g of gone) events.push({ type: "GrantEnded", reference: s.reference, at, subject: g.subject });
    return { ...s, grants: s.grants.filter(g => !gone.includes(g)) };
  });
  return events.length === 0 ? dir : { ...dir, held, events: [...dir.events, ...events] };
}

// A lane's "until the lane ends" Grants end when the node sees its pane close.
export const endLaneGrants = (dir: SecretDirectory, lane: string, at: number): SecretDirectory =>
  endGrants(dir, g => g.subject.kind === "lane" && g.subject.lane === lane && g.until.kind === "lane-end", at);

// A Grant with an end time ends once that time has come. The gate already refuses it (SC3); this keeps the list and the
// audit true. The node's timer runs it with the expiry sweep (design §16, PR 6).
export const endTimedGrants = (dir: SecretDirectory, now: number): SecretDirectory => endGrants(dir, g => ended(g.until, now), now);

// ---- The use gate (SC3)

function statusProblem(secret: Secret | null, now: number): UseRefusalReason | null {
  if (!secret) return "missing";
  if (secret.status === "disabled") return "disabled";
  if (secret.status === "revoked") return "revoked";
  if (!secret.current) return "no_value";
  if (secret.expiry !== null && now >= secret.expiry) return "expired";
  return null;
}

// Default deny. In order: status active, a current version, now before Expiry, a live Grant that admits the caller,
// then the mode. The first failure is the refusal.
export function useGate(secret: Secret | null, caller: Caller, mode: UseMode, now: number): Result<SecretGrant, { problem: UseRefusalReason }> {
  const p = statusProblem(secret, now);
  if (p || !secret) return err({ problem: p ?? "missing" });
  const live = secret.grants.filter(g => admits(g.subject, caller) && !ended(g.until, now));
  if (live.length === 0) return err({ problem: "not_granted" });
  const grant = live.find(g => g.modes.includes(mode));
  return grant ? ok(grant) : err({ problem: "mode" });
}

// A Use, recorded; a refusal is recorded too (SC4's order, record before the vault opens, is the application's).
export function useSecret(dir: SecretDirectory, reference: string, caller: Caller, mode: UseMode, use: string, now: number): Result<SecretDirectory, SecretRefusal> {
  const secret = findSecret(dir, reference);
  const gate = useGate(secret, caller, mode, now);
  if (!gate.ok) {
    const event: SecretEvent = { type: "UseRefused", reference, at: now, reason: gate.error.problem, mode, lane: caller.lane, workspace: caller.workspace };
    return err({ problem: gate.error.problem, directory: { ...dir, events: [...dir.events, event] } });
  }
  const version = secret?.current?.number ?? 0;
  return ok({ ...dir, events: [...dir.events, { type: "SecretUsed", reference, version, at: now, use, mode, lane: caller.lane, workspace: caller.workspace }] });
}

export const endUse = (dir: SecretDirectory, reference: string, use: string, outcome: UseOutcome, at: number): SecretDirectory =>
  ({ ...dir, events: [...dir.events, { type: "UseEnded", reference, at, use, outcome }] });

// SC9: each lead warns once; at Expiry the Secret is marked expired once. A later Expiry clears the marks. One pass,
// one new directory.
export function secretExpirySweep(dir: SecretDirectory, now: number): SecretDirectory {
  const events: SecretEvent[] = [];
  const held = dir.held.map(s => {
    if (s.expiry === null || s.status === "revoked") return s;
    const expiry = s.expiry;
    const leads = SECRET_EXPIRY_LEADS.filter(([label, ms]) => now >= expiry - ms && !s.warned.includes(label)).map(([label]) => label);
    const expired = now >= expiry && !s.warned.includes("expired");
    if (leads.length === 0 && !expired) return s;
    for (const lead of leads) events.push({ type: "ExpiryWarned", reference: s.reference, at: now, lead });
    if (expired) events.push({ type: "SecretExpired", reference: s.reference, at: now });
    return { ...s, warned: [...s.warned, ...leads, ...(expired ? ["expired"] : [])] };
  });
  return events.length === 0 ? dir : { ...dir, held, events: [...dir.events, ...events] };
}
