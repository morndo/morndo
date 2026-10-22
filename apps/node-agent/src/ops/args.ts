// The arguments of every op, as this node acts on them (spec §5.3, §8; plan Contracts, "The agent parses as the fleet
// does"): first OP_ARGS[op], the schema the fleet checked them with (strict, with LIMITS; an unknown field is dropped,
// never passed on), then only what this node alone can judge. This is where a path is opened and text is typed, so the
// checks hold even against a fleet that is wrong or compromised. Each checker returns the typed arguments, or null for
// `bad_args`.
// Fleet clients (spec §4, §5; plan Contracts, protocol): pane.keys takes literal `data` or key `names` from KEY_NAMES,
// exactly one of them; pane.capture at most LIMITS.captureMaxLines lines; a delivery as RECONCILIATION.md ruling 7 has it:
// its id at most LIMITS.maxDeliveryId characters, no control character, no trailing `#<digits>`; its ttlMs at most 7 days;
// exactly one target.
import { KEY_NAMES, LIMITS, OP_ARGS, parseBody, type OpArgs, type OpName } from "@morndo/protocol";

// C0 control characters and DEL (a function, not a regular expression with control characters: the lint rule).
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// The hook relay's own copies are named by 32 hex digits (relay-files.ts): any other ref is none of this node's.
export const RELAY_REF = /^[0-9a-f]{32}$/;
// lane.start's account and resume id become arguments of the launcher's command (`{account}`, `--resume <id>`): checked
// once more here, as OP_ARGS has them, right before they reach a command line, so neither can ever pass as a flag.
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !hasControl(v);

const KEYS: ReadonlySet<string> = new Set<string>(KEY_NAMES);
// pane.keys: literal text, or key names from the allow-list; never both, never neither, never an empty list.
const oneKind = (a: OpArgs["pane.keys"]): boolean =>
  a.names === undefined ? a.data !== undefined : a.data === undefined && a.names.length > 0 && a.names.every(n => KEYS.has(n));
// `#<digits>` at the end is the retype's key (`<id>#2`), never a delivery's id.
const deliveryId = (id: string): boolean => id.length > 0 && id.length <= LIMITS.maxDeliveryId && !hasControl(id) && !/#\d+$/.test(id);

type Checkers = { [O in OpName]: (a: unknown) => OpArgs[O] | null };
// OP_ARGS[op], then the node's own check of what came out.
const decoded = <O extends OpName>(op: O, node: (a: OpArgs[O]) => boolean = () => true) => (a: unknown): OpArgs[O] | null => {
  const v = parseBody(OP_ARGS[op], a) as OpArgs[O] | null;
  return v !== null && node(v) ? v : null;
};

export const CHECK: Checkers = {
  "inventory.get": decoded("inventory.get"),
  "pane.captureMany": decoded("pane.captureMany"),
  "pane.capture": decoded("pane.capture", a => Number.isInteger(a.lines) && a.lines >= 1 && a.lines <= LIMITS.captureMaxLines),
  "pane.frame": decoded("pane.frame"),
  "pane.keys": decoded("pane.keys", oneKind),
  "pane.send": decoded("pane.send"),
  "op.status": decoded("op.status", a => validKey(a.key)),
  "transcript.size": decoded("transcript.size"),
  "transcript.read": decoded("transcript.read"),
  "transcript.locate": decoded("transcript.locate"),
  "file.stat": decoded("file.stat", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.get": decoded("file.get", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.put": decoded("file.put", a => !hasControl(a.name)),
  "lane.start": decoded("lane.start", a => (a.account === undefined || ACCOUNT.test(a.account)) && (a.resume === undefined || RESUME_ID.test(a.resume))),
  "lane.stop": decoded("lane.stop"),
  "lane.deliver": decoded("lane.deliver", a => deliveryId(a.id) && ("lane" in a.target) !== ("workerId" in a.target)
    && (a.ttlMs === undefined || (Number.isSafeInteger(a.ttlMs) && a.ttlMs >= 1 && a.ttlMs <= LIMITS.deliveryKeepMs))),
  "delivery.cancel": decoded("delivery.cancel", a => deliveryId(a.id)),
  "worktree.list": decoded("worktree.list"),
  "worktree.add": decoded("worktree.add"),
  "memory.sync": decoded("memory.sync"),
  "job.cancel": decoded("job.cancel"),
  "job.notice": decoded("job.notice"),
  "job.noticeResult": decoded("job.noticeResult"),
  "connections.priority": decoded("connections.priority"),
  "connections.role": decoded("connections.role"),
  "connections.revoke": decoded("connections.revoke"),
  "connections.narrow": decoded("connections.narrow"),
  // Updates §5.4: the arguments as the fleet checked them (a Version). This node has no handler for the op yet —
  // the executor answers unknown_op for it — and never announces CAP_UPDATE, so the fleet sends it none.
  "update.apply": decoded("update.apply"),
};
