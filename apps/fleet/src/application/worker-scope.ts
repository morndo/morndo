// What a caller on the worker socket may do (T-440). Pure: the socket that accepted the connection chooses the scope,
// and this says yes or no for one op or one delivery. A no is the whole answer — nothing is sent to a node. Any op
// not listed is closed. A write that changes a lane, and a read of files, is limited to nodes in startNodes. A
// protected lane is refused everywhere, writes and peeks alike, and an unknown pane is refused. A pane seen under a
// protected name stays protected after its window is renamed, and a file of its session, project directory or working
// directory is refused on a start node. What a worker is shown of such a lane drops the words. Reasons name the
// worker socket and never the caller's text, keystrokes or arguments.
import { parseWorkerId, type OpName, type Pane } from "@morndo/protocol";
import type { Target } from "./router.ts";

export type WorkerScope = { protectedLanes: ReadonlySet<string>; startNodes: ReadonlySet<string> };
export type WorkerLook = {
  nameOfWorker(workerId: string): string | null;   // null: no node's latest inventory lists it
  nodeOfLane(name: string): string | null;         // null: the name is not one resolved lane
  workerOfLane(name: string): string | null;       // null: the name is not one resolved lane
  isProtectedWorker(id: string): boolean;          // the worker ID is a protected lane's pane, a renamed one included
  isProtectedPath(node: string, path: string): boolean;
};
// What to leave out of a worker's view. A lane name, a worker ID, or a session.
export type Hide = { lane(name: string | null): boolean; worker(id: string): boolean; session(id: string): boolean };
export type WorkerVerdict = { ok: true; args?: Record<string, unknown> } | { ok: false; reason: string };

const PEEK_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.capture", "pane.frame"]);
const FILE_OPS: ReadonlySet<OpName> = new Set<OpName>(["file.stat", "file.get", "worktree.list"]);
const PLACE_OPS: ReadonlySet<OpName> = new Set<OpName>(["lane.start", "worktree.add", "file.put"]);
const PANE_WRITE: ReadonlySet<OpName> = new Set<OpName>(["pane.send", "pane.keys"]);

const closed = (what: string, why: string): WorkerVerdict => ({ ok: false, reason: `${what} is not allowed on the worker socket: ${why}` });

// The node a placement addresses: the one named, the one in the worker ID, or the lane's node. Null when that can't be said.
function placeNode(target: Target, look: WorkerLook): string | null {
  if ("node" in target) return target.node;
  if ("workerId" in target) return parseWorkerId(target.workerId)?.node ?? null;
  return look.nodeOfLane(target.lane);
}

type NamedPane = { kind: "lane"; name: string } | { kind: "worker"; id: string };

// Every pane a request names: the target's lane, the target's worker ID, args.workerId, and args.expect.window.
function panesOf(target: Target, args: Record<string, unknown>): NamedPane[] {
  const panes: NamedPane[] = [];
  if ("lane" in target) panes.push({ kind: "lane", name: target.lane });
  if ("workerId" in target) panes.push({ kind: "worker", id: target.workerId });
  if (typeof args.workerId === "string") panes.push({ kind: "worker", id: args.workerId });
  const expect = args.expect;
  if (typeof expect === "object" && expect !== null && !Array.isArray(expect)) {
    const window = (expect as { window?: unknown }).window;
    if (typeof window === "string") panes.push({ kind: "lane", name: window });
  }
  return panes;
}

// A lane name is protected when the scope lists it, or when the pane that name resolves to is already a protected worker
// (its window was renamed away from the protected name).
function laneProtected(scope: WorkerScope, name: string, look: WorkerLook): boolean {
  if (scope.protectedLanes.has(name)) return true;
  const id = look.workerOfLane(name);
  return id !== null && look.isProtectedWorker(id);
}

// A pane write names at least one pane. Each lane name is protected or unresolved, each worker ID is missing from
// every inventory or names a protected lane, or any named node (the target's, the one inside a worker ID, the lane's)
// sits outside startNodes: any one of those refuses the write.
function writeWhy(scope: WorkerScope, target: Target, args: Record<string, unknown>, look: WorkerLook): string | null {
  const panes = panesOf(target, args);
  if (panes.length === 0) return "it names no pane";
  const nodes: (string | null)[] = [];
  if ("node" in target) nodes.push(target.node);
  for (const pane of panes) {
    if (pane.kind === "lane") {
      if (laneProtected(scope, pane.name, look)) return "it addresses a protected lane";
      const node = look.nodeOfLane(pane.name);
      if (node === null) return "that lane is unknown";
      nodes.push(node);
      continue;
    }
    const name = look.nameOfWorker(pane.id);
    if (name === null) return "that pane is in no node's inventory";
    if (look.isProtectedWorker(pane.id)) return "it addresses a protected lane";
    nodes.push(parseWorkerId(pane.id)?.node ?? null);
  }
  if (nodes.some(node => node === null || !scope.startNodes.has(node))) return "that node is not one the worker socket may place work on";
  return null;
}

// A peek is allowed on any node, for a pane whose name is known and not protected. The same names are checked as a
// write: the target's lane, args.workerId, and args.expect.window. A protected name or a worker ID in no inventory
// refuses it. Which node the pane is on is not the question.
function peekWhy(scope: WorkerScope, target: Target, args: Record<string, unknown>, look: WorkerLook): string | null {
  const panes = panesOf(target, args);
  if (panes.length === 0) return "it names no pane";
  for (const pane of panes) {
    if (pane.kind === "lane") {
      if (laneProtected(scope, pane.name, look)) return "it addresses a protected lane";
      if (look.nodeOfLane(pane.name) === null) return "that lane is unknown";
      continue;
    }
    const name = look.nameOfWorker(pane.id);
    if (name === null) return "that pane is in no node's inventory";
    if (look.isProtectedWorker(pane.id)) return "it addresses a protected lane";
  }
  return null;
}

// captureMany keeps the worker IDs whose pane is known and not protected, in the order given, and drops the rest.
function visibleWorkerIds(ids: unknown, look: WorkerLook): string[] {
  if (!Array.isArray(ids)) return [];
  const kept: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const name = look.nameOfWorker(id);
    if (name !== null && !look.isProtectedWorker(id)) kept.push(id);
  }
  return kept;
}

export function workerOpVerdict(scope: WorkerScope, req: { target: Target; op: OpName; args: Record<string, unknown> }, look: WorkerLook): WorkerVerdict {
  if (req.op === "inventory.get" || req.op === "op.status") return { ok: true };
  if (req.op === "pane.captureMany") return { ok: true, args: { ...req.args, workerIds: visibleWorkerIds(req.args.workerIds, look) } };
  if (PEEK_OPS.has(req.op)) {
    const why = peekWhy(scope, req.target, req.args, look);
    return why === null ? { ok: true } : closed(req.op, why);
  }
  if (FILE_OPS.has(req.op)) {
    const node = placeNode(req.target, look);
    if (node === null || !scope.startNodes.has(node)) return closed(req.op, "that node is not one the worker socket may read");
    if (typeof req.args.path === "string" && look.isProtectedPath(node, req.args.path)) return closed(req.op, "that path belongs to a protected lane");
    if (req.op === "worktree.list" && typeof req.args.repo === "string" && look.isProtectedPath(node, req.args.repo)) return closed(req.op, "that path belongs to a protected lane");
    return { ok: true };
  }
  if (PANE_WRITE.has(req.op)) {
    const why = writeWhy(scope, req.target, req.args, look);
    return why === null ? { ok: true } : closed(req.op, why);
  }
  if (PLACE_OPS.has(req.op)) {
    if (req.op === "lane.start" && typeof req.args.name === "string" && laneProtected(scope, req.args.name, look)) return closed(req.op, "that lane name is protected");
    const node = placeNode(req.target, look);
    if (node === null || !scope.startNodes.has(node)) return closed(req.op, "that node is not one the worker socket may place work on");
    return { ok: true };
  }
  if (req.op === "lane.stop") {
    if (typeof req.args.name === "string" && laneProtected(scope, req.args.name, look)) return closed(req.op, "that lane name is protected");
    const node = placeNode(req.target, look);
    if (node === null || !scope.startNodes.has(node)) return closed(req.op, "that node is not one the worker socket may place work on");
    return { ok: true };
  }
  if (req.op === "job.cancel") return { ok: true };
  return closed(req.op, "it is closed to the worker socket");
}

// A delivery, posted or cancelled: a protected lane, an unknown one, or one whose node is outside startNodes is refused.
// A worker ID is refused the same way: missing from every inventory, a protected lane, or a node outside startNodes.
export function workerDeliveryVerdict(scope: WorkerScope, req: { lane?: string; workerId?: string }, look: WorkerLook): WorkerVerdict {
  return deliveryWhy(scope, req, look, "a delivery");
}

export function workerDeliveryCancelVerdict(scope: WorkerScope, target: { lane?: string; workerId?: string }, look: WorkerLook): WorkerVerdict {
  return deliveryWhy(scope, target, look, "cancelling a delivery");
}

function deliveryWhy(scope: WorkerScope, req: { lane?: string; workerId?: string }, look: WorkerLook, what: string): WorkerVerdict {
  if (req.lane === undefined && req.workerId === undefined) return closed(what, "that lane is unknown");
  if (req.lane !== undefined) {
    if (laneProtected(scope, req.lane, look)) return closed(what, "that lane is protected");
    const node = look.nodeOfLane(req.lane);
    if (node === null) return closed(what, "that lane is unknown");
    if (!scope.startNodes.has(node)) return closed(what, "that node is not one the worker socket may place work on");
  }
  if (req.workerId !== undefined) {
    const name = look.nameOfWorker(req.workerId);
    if (name === null) return closed(what, "that pane is in no node's inventory");
    if (look.isProtectedWorker(req.workerId)) return closed(what, "that lane is protected");
    const node = parseWorkerId(req.workerId)?.node ?? null;
    if (node === null || !scope.startNodes.has(node)) return closed(what, "that node is not one the worker socket may place work on");
  }
  return { ok: true };
}

function sessionHidden(id: unknown, hide: Hide): boolean {
  return typeof id === "string" && id !== "" && hide.session(id);
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

// A string as itself; null, or a field the event doesn't carry, as null.
function named(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// A protected pane keeps its name, status and process. The same object comes back for a pane that is not protected.
export function redactPanes<T extends Pane>(panes: readonly T[], hide: Hide): T[] {
  return panes.map(pane => {
    if (hide.lane(pane.window) || hide.worker(pane.workerId) || sessionHidden(pane.sessionId, hide)) {
      const bare: Pane = { workerId: pane.workerId, window: pane.window, cwd: "", status: pane.status, pid: pane.pid };
      return bare as T;
    }
    return pane;
  });
}

// A delivery to a protected lane (named, by worker ID, or by a protected session) keeps its id, node, target and state
// and loses the session it bound and the draft it stashed. Any other delivery is the same object.
export function redactDelivery<T extends { target: { lane: string } | { workerId: string }; sessionId?: string; stashed?: unknown }>(d: T, hide: Hide): T {
  const target = d.target;
  const protectedTarget = "lane" in target ? hide.lane(target.lane) : hide.worker(target.workerId);
  if (!protectedTarget && !sessionHidden(d.sessionId, hide)) return d;
  const out: Record<string, unknown> = { ...d };
  delete out.sessionId;
  delete out.stashed;
  return out as T;
}

// The alert a stashed draft raised carries the path of its copy and its length: for a protected lane they go. Any other
// alert is the same object.
export function redactAlert<T extends { kind: string; detail: Record<string, unknown> }>(a: T, hide: Hide): T {
  if (a.kind !== "draft_stashed") return a;
  const lane = named(a.detail.lane);
  const workerId = named(a.detail.workerId);
  if (!((lane !== null && hide.lane(lane)) || (workerId !== null && hide.worker(workerId)))) return a;
  const detail = { ...a.detail };
  delete detail.copy;
  delete detail.chars;
  return { ...a, detail };
}

// An inventory event loses the protected panes' words. A run, lane or usage event of a protected lane is dropped, a
// delivery or a stash alert of one loses its session and its draft. Every other event is the same object.
export function redactEvent<E extends { t: string; node: string; body: unknown }>(e: E, hide: Hide): E | null {
  if (e.t === "inventory") {
    const body = asRecord(e.body);
    if (body === null || !Array.isArray(body.panes)) return e;
    return { ...e, body: { ...body, panes: redactPanes(body.panes as Pane[], hide) } };
  }
  if (e.t === "delivery") {
    const body = asRecord(e.body);
    if (body === null || typeof body.target !== "object" || body.target === null) return e;
    return { ...e, body: redactDelivery(body as { target: { lane: string } | { workerId: string } }, hide) };
  }
  if (e.t === "alert") {
    const body = asRecord(e.body);
    if (body === null || typeof body.kind !== "string") return e;
    const detail = asRecord(body.detail);
    return detail === null ? e : { ...e, body: redactAlert({ ...body, kind: body.kind, detail }, hide) };
  }
  if (e.t === "usage") {
    const body = asRecord(e.body);
    if (body !== null && (hide.lane(named(body.lane)) || hide.lane(named(body.window)) || sessionHidden(body.sessionId, hide))) return null;
    return e;
  }
  if (e.t === "run" || e.t === "lane") {
    const body = asRecord(e.body);
    if (body !== null) {
      const lane = hide.lane(named(body.lane));
      const session = sessionHidden(body.sessionId, hide);
      if (e.t === "run" && (lane || session)) return null;
      if (e.t === "lane" && (lane || hide.lane(named(body.window)) || session)) return null;
    }
  }
  return e;
}

export function visibleRuns<T extends { lane: string | null; sessionId?: string | null }>(runs: readonly T[], hide: Hide): T[] {
  return runs.filter(run => !hide.lane(run.lane) && !sessionHidden(run.sessionId, hide));
}

export function visibleLaneWatch<T extends { window: string | null }>(entries: readonly T[], hide: Hide): T[] {
  return entries.filter(entry => !hide.lane(entry.window));
}

export function visibleLaneEvents<T extends { lane: string | null; window: string | null; sessionId?: string | null }>(events: readonly T[], hide: Hide): T[] {
  return events.filter(event => !hide.lane(event.lane) && !hide.lane(event.window) && !sessionHidden(event.sessionId, hide));
}
