// What a caller on the worker socket may do (T-440). Pure: the socket that accepted the connection chooses the scope,
// and this says yes or no for one op or one delivery. A no is the whole answer — nothing is sent to a node. Any op
// not listed is closed. Reasons name the worker socket and never the caller's text, keystrokes or arguments.
import { parseWorkerId, type OpName } from "@morndo/protocol";
import type { Target } from "./router.ts";

export type WorkerScope = { protectedLanes: ReadonlySet<string>; startNodes: ReadonlySet<string> };
export type WorkerLook = {
  nameOfWorker(workerId: string): string | null;   // null: no node's latest inventory lists it
  nodeOfLane(name: string): string | null;         // null: the name is not one resolved lane
};
export type WorkerVerdict = { ok: true } | { ok: false; reason: string };

const READ_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "inventory.get", "pane.captureMany", "pane.frame", "pane.capture", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "worktree.list",
]);
const PLACE_OPS: ReadonlySet<OpName> = new Set<OpName>(["lane.start", "worktree.add", "file.put"]);
const PANE_WRITE: ReadonlySet<OpName> = new Set<OpName>(["pane.send", "pane.keys"]);

const closed = (what: string, why: string): WorkerVerdict => ({ ok: false, reason: `${what} is not allowed on the worker socket: ${why}` });

// The node a placement addresses: the one named, the one in the worker ID, or the lane's node. Null when that can't be said.
function placeNode(target: Target, look: WorkerLook): string | null {
  if ("node" in target) return target.node;
  if ("workerId" in target) return parseWorkerId(target.workerId)?.node ?? null;
  return look.nodeOfLane(target.lane);
}

// A pane write is refused when it names a protected lane, or a worker ID no inventory lists. The lane can be the
// target, args.workerId's window, or args.expect.window — any one of them is enough.
function paneWhy(scope: WorkerScope, target: Target, args: Record<string, unknown>, look: WorkerLook): string | null {
  const named: string[] = [];
  if ("lane" in target) named.push(target.lane);
  const expect = args.expect;
  if (typeof expect === "object" && expect !== null && !Array.isArray(expect)) {
    const window = (expect as { window?: unknown }).window;
    if (typeof window === "string") named.push(window);
  }
  if (named.some(name => scope.protectedLanes.has(name))) return "it addresses a protected lane";
  const ids: string[] = [];
  if ("workerId" in target) ids.push(target.workerId);
  if (typeof args.workerId === "string") ids.push(args.workerId);
  for (const id of ids) {
    const name = look.nameOfWorker(id);
    if (name === null) return "that pane is in no node's inventory";
    if (scope.protectedLanes.has(name)) return "it addresses a protected lane";
  }
  return null;
}

export function workerOpVerdict(scope: WorkerScope, req: { target: Target; op: OpName; args: Record<string, unknown> }, look: WorkerLook): WorkerVerdict {
  if (READ_OPS.has(req.op)) return { ok: true };
  if (PANE_WRITE.has(req.op)) {
    const why = paneWhy(scope, req.target, req.args, look);
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
    return { ok: true };
  }
  if (req.op === "job.cancel" || req.op === "job.noticeResult") return { ok: true };
  return closed(req.op, "it is closed to the worker socket");
}

// A delivery, posted or cancelled: a protected lane (named, or the lane of the worker ID) or an unknown one is refused.
export function workerDeliveryVerdict(scope: WorkerScope, req: { lane?: string; workerId?: string }, look: WorkerLook): WorkerVerdict {
  return deliveryWhy(scope, req, look, "a delivery");
}

export function workerDeliveryCancelVerdict(scope: WorkerScope, target: { lane?: string; workerId?: string }, look: WorkerLook): WorkerVerdict {
  return deliveryWhy(scope, target, look, "cancelling a delivery");
}

function deliveryWhy(scope: WorkerScope, req: { lane?: string; workerId?: string }, look: WorkerLook, what: string): WorkerVerdict {
  if (req.lane !== undefined) {
    if (scope.protectedLanes.has(req.lane)) return closed(what, "that lane is protected");
    if (look.nodeOfLane(req.lane) === null) return closed(what, "that lane is unknown");
  }
  if (req.workerId !== undefined) {
    const name = look.nameOfWorker(req.workerId);
    if (name === null) return closed(what, "that pane is in no node's inventory");
    if (scope.protectedLanes.has(name)) return closed(what, "that lane is protected");
  }
  if (req.lane === undefined && req.workerId === undefined) return closed(what, "that lane is unknown");
  return { ok: true };
}
