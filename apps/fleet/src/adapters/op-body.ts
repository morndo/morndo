// The body of POST /v1/op (spec 5.6, the Contracts' client API): { workerId | node | lane (exactly one), op, args,
// key?, timeoutMs? }; an expectation travels inside args, as OpArgs has it. Checked here for shape only; the op's own
// arguments are checked by the router against OP_ARGS (bad_args, nothing sent), and again by the agent. Unknown fields, a
// top-level `expect` among them, are refused, so a client's typo never routes somewhere unintended.
import type { OpName } from "@morndo/protocol";
import type { Target } from "../application/router.ts";
import { MAX_TIMEOUT_MS } from "../application/router.ts";

export type OpBody = { target: Target; op: OpName; args: Record<string, unknown>; key?: string; timeoutMs?: number };

// Every op once: a Record over the union, so an op the protocol adds fails to compile here until listed.
// `agent` ops are fleet-internal. job.notice is one: the mirror sends it to an agent session. A client cannot post it.
const OPS: Record<OpName, "client" | "agent"> = {
  "inventory.get": "client", "pane.captureMany": "client", "pane.frame": "client", "pane.keys": "client", "pane.send": "client", "op.status": "client",
  "transcript.size": "client", "transcript.read": "client", "transcript.locate": "client", "file.stat": "client", "file.get": "client", "file.put": "client",
  "lane.start": "client", "lane.stop": "client", "worktree.list": "client", "worktree.add": "client", "job.cancel": "client", "job.notice": "agent", "job.noticeResult": "client",
  "connections.priority": "client", "connections.role": "client", "connections.revoke": "client", "connections.narrow": "client",
  // fleet clients: a delivery goes through /v1/deliveries; client-api.ts refuses lane.deliver and delivery.cancel here
  "pane.capture": "client", "lane.deliver": "client", "delivery.cancel": "client",
};
const FIELDS = new Set(["node", "workerId", "lane", "op", "args", "key", "timeoutMs"]);
// A client's namespace, a colon, then printable ASCII (spec 5.3: keys are namespaced by client, e.g. "hub:", "kira:"):
// the protocol's key (^[a-z]+:, at most 512 characters), narrowed to at most 256.
const KEY = /^[a-z]{1,16}:[\x21-\x7e]{1,239}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseOpBody(v: unknown): { ok: true; body: OpBody } | { ok: false; message: string } {
  const no = (message: string) => ({ ok: false as const, message });
  if (!isObject(v)) return no("the body must be a JSON object");
  const extra = Object.keys(v).filter(k => !FIELDS.has(k));
  if (extra.length) return no(`unknown fields: ${extra.join(", ")}`);
  const targets = (["node", "workerId", "lane"] as const).filter(k => v[k] !== undefined);
  if (targets.length !== 1) return no("name exactly one of node, workerId or lane");
  const t = targets[0] ?? "node";
  const value = v[t];
  if (typeof value !== "string" || value === "" || value.length > 1000) return no(`${t} must be a non-empty string`);
  const target: Target = t === "node" ? { node: value } : t === "workerId" ? { workerId: value } : { lane: value };
  if (typeof v.op !== "string" || OPS[v.op as OpName] !== "client") return no(`unknown op: ${JSON.stringify(v.op)}`);
  if (!isObject(v.args)) return no("args must be an object");
  if (v.key !== undefined && (typeof v.key !== "string" || !KEY.test(v.key))) return no("key must be <client>:<printable ASCII>, the client a-z, at most 256 characters");
  if (v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || (v.timeoutMs as number) < 1 || (v.timeoutMs as number) > MAX_TIMEOUT_MS)) {
    return no(`timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return {
    ok: true,
    body: {
      target, op: v.op as OpName, args: v.args,
      ...(v.key === undefined ? {} : { key: v.key as string }),
      ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs as number }),
    },
  };
}
