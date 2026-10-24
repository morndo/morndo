// What a caller on the worker socket may do (T-440). Pure: the socket that accepted the connection chooses the scope,
// and this says yes or no for one op or one delivery. A no is the whole answer — nothing is sent to a node. Any op
// not listed is closed. A write that changes a lane, and a read of files, is limited to nodes in startNodes. A
// protected lane is refused everywhere, writes and peeks alike, and an unknown pane is refused. Reasons name the
// worker socket and never the caller's text, keystrokes or arguments.
import { parseWorkerId, type OpName } from "@morndo/protocol";
import type { Target } from "./router.ts";

export type WorkerScope = { protectedLanes: ReadonlySet<string>; startNodes: ReadonlySet<string> };
export type WorkerLook = {
  nameOfWorker(workerId: string): string | null;   // null: no node's latest inventory lists it
  nodeOfLane(name: string): string | null;         // null: the name is not one resolved lane
};
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
      if (scope.protectedLanes.has(pane.name)) return "it addresses a protected lane";
      const node = look.nodeOfLane(pane.name);
      if (node === null) return "that lane is unknown";
      nodes.push(node);
      continue;
    }
    const name = look.nameOfWorker(pane.id);
    if (name === null) return "that pane is in no node's inventory";
    if (scope.protectedLanes.has(name)) return "it addresses a protected lane";
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
      if (scope.protectedLanes.has(pane.name)) return "it addresses a protected lane";
      if (look.nodeOfLane(pane.name) === null) return "that lane is unknown";
      continue;
    }
    const name = look.nameOfWorker(pane.id);
    if (name === null) return "that pane is in no node's inventory";
    if (scope.protectedLanes.has(name)) return "it addresses a protected lane";
  }
  return null;
}

// captureMany keeps the worker IDs whose pane is known and not protected, in the order given, and drops the rest.
function visibleWorkerIds(scope: WorkerScope, ids: unknown, look: WorkerLook): string[] {
  if (!Array.isArray(ids)) return [];
  const kept: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const name = look.nameOfWorker(id);
    if (name !== null && !scope.protectedLanes.has(name)) kept.push(id);
  }
  return kept;
}

export function workerOpVerdict(scope: WorkerScope, req: { target: Target; op: OpName; args: Record<string, unknown> }, look: WorkerLook): WorkerVerdict {
  if (req.op === "inventory.get" || req.op === "op.status") return { ok: true };
  if (req.op === "pane.captureMany") return { ok: true, args: { ...req.args, workerIds: visibleWorkerIds(scope, req.args.workerIds, look) } };
  if (PEEK_OPS.has(req.op)) {
    const why = peekWhy(scope, req.target, req.args, look);
    return why === null ? { ok: true } : closed(req.op, why);
  }
  if (FILE_OPS.has(req.op)) {
    const node = placeNode(req.target, look);
    if (node === null || !scope.startNodes.has(node)) return closed(req.op, "that node is not one the worker socket may read");
    return { ok: true };
  }
  if (PANE_WRITE.has(req.op)) {
    const why = writeWhy(scope, req.target, req.args, look);
    return why === null ? { ok: true } : closed(req.op, why);
  }
  if (PLACE_OPS.has(req.op)) {
    if (req.op === "lane.start" && typeof req.args.name === "string" && scope.protectedLanes.has(req.args.name)) return closed(req.op, "that lane name is protected");
    const node = placeNode(req.target, look);
    if (node === null || !scope.startNodes.has(node)) return closed(req.op, "that node is not one the worker socket may place work on");
    return { ok: true };
  }
  if (req.op === "lane.stop") {
    if (typeof req.args.name === "string" && scope.protectedLanes.has(req.args.name)) return closed(req.op, "that lane name is protected");
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
    if (scope.protectedLanes.has(req.lane)) return closed(what, "that lane is protected");
    const node = look.nodeOfLane(req.lane);
    if (node === null) return closed(what, "that lane is unknown");
    if (!scope.startNodes.has(node)) return closed(what, "that node is not one the worker socket may place work on");
  }
  if (req.workerId !== undefined) {
    const name = look.nameOfWorker(req.workerId);
    if (name === null) return closed(what, "that pane is in no node's inventory");
    if (scope.protectedLanes.has(name)) return closed(what, "that lane is protected");
    const node = parseWorkerId(req.workerId)?.node ?? null;
    if (node === null || !scope.startNodes.has(node)) return closed(what, "that node is not one the worker socket may place work on");
  }
  return { ok: true };
}
