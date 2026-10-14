// Routing a client's op to a node (spec 5.3, 5.6): by worker ID (its node is in the ID), by node, or by lane name
// (through the registry; a name in conflict is never routed: lane_conflict). A worker ID is routed whatever the
// registry says of its window's name: the caller picked that pane, and the node checks the expectation. For a lane,
// the pane ops get the lane's worker ID, and pane.send and pane.keys get the expectation args.expect = { server,
// window: lane } unless the caller gave one, so a reused or renamed pane refuses with no_pane instead of receiving the
// text. The caller's key and timeout pass through unchanged, and its args (an expectation travels inside them, as OpArgs
// has it) once OP_ARGS[op] has checked them, as the agent will (a field it doesn't know is dropped; args that don't fit
// are bad_args, not executed, nothing sent); a keyed op without a key, a key on an op that takes none, an expectation on
// an op that takes none, and lane.start of a name registered anywhere in the fleet, or whose own lane.start is still in
// flight (name_taken), are refused before anything is sent. The name stays reserved from a lane.start until the node refused it (executed:
// no), or, once it answered, until the registry holds the name (at most RESERVE_AFTER_START_MS).
// Every side-effecting op (KEYED_OPS and pane.keys) is audited as op.<name>: the target, the key's namespace, the
// outcome and the client that asked; never its text, keystrokes or bytes. The outcome is the client's whatever the audit
// can take: a row fleet.db refuses (busy past its timeout, or full) is logged with what it would have said, and never
// takes the outcome's place (B6 V21; OWASP Logging Cheat Sheet: "Ensure failures in the logging processes/systems do
// not prevent the application from otherwise running", read 2026-10-07).
import { KEYED_OPS, LIMITS, NODE_NAME, OP_ARGS, parseBody, parseWorkerId, type OpName } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { Logger } from "../adapters/log.ts";
import type { Connections } from "./connections.ts";
import type { LaneRegistry } from "./lane-registry.ts";
import { SIDE_EFFECT_OPS, failed, type Outcome } from "./requests.ts";

export type Target = { workerId: string } | { node: string } | { lane: string };
// client: the client that asks (the client API's x-morndo-client header), for the audit.
export type OpOptions = { key?: string; timeoutMs?: number; client?: string; audit?: boolean };

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
// How long a name stays reserved after its lane.start was answered, for the node's next inventory to report it.
export const RESERVE_AFTER_START_MS = 10_000;
const PANE_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.frame", "pane.keys", "pane.send", "pane.capture"]);
// lane.stop's "exit" waits up to LIMITS.laneStopWaitMs for the window to close (fleet clients spec §5): its default
// deadline leaves it that long plus the usual 15 s.
const DEFAULT_TIMEOUT_OF: { readonly [O in OpName]?: number } = { "lane.stop": LIMITS.laneStopWaitMs + DEFAULT_TIMEOUT_MS };
const EXPECT_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.keys", "pane.send"]);

export class Router {
  #connections: Connections;
  #lanes: LaneRegistry;
  #audit: Audit;
  #log: Logger | null;
  #mono: () => number;
  #starting = new Map<string, number | null>();          // lane name → reserved until (mono); null while in flight

  constructor(p: { connections: Connections; lanes: LaneRegistry; audit: Audit; log?: Logger; mono?: () => number }) {
    this.#connections = p.connections;
    this.#lanes = p.lanes;
    this.#audit = p.audit;
    this.#log = p.log ?? null;
    this.#mono = p.mono ?? (() => performance.now());
  }

  async op(target: Target, op: OpName, args: Record<string, unknown>, o: OpOptions = {}): Promise<Outcome> {
    const routed = this.#route(target, op, args, o);
    const out = await routed.outcome;
    if (SIDE_EFFECT_OPS.has(op) && o.audit !== false) this.#audited(op, routed.node, target, o, out);
    return out;
  }

  // The op's audit row; one fleet.db can't take is logged with its detail (no text, keystrokes or bytes are in it).
  #audited(op: OpName, node: string | null, target: Target, o: OpOptions, out: Outcome): void {
    const detail = {
      target, keyNs: o.key === undefined ? null : o.key.slice(0, o.key.indexOf(":")), outcome: out.ok ? "ok" : out.error.code, client: o.client ?? "unknown",
    };
    try { this.#audit.record("client", `op.${op}`, node, detail); }
    catch (e) { this.#log?.error(`audit: op.${op} on ${node ?? "?"} could not be recorded (fleet.db busy or full?): ${JSON.stringify(detail)}`, e); }
  }

  #route(target: Target, op: OpName, args: Record<string, unknown>, o: OpOptions): { node: string | null; outcome: Promise<Outcome> } {
    const refuse = (o2: Outcome, node: string | null = null) => ({ node, outcome: Promise.resolve(o2) });
    let node: string;
    let workerId: string | null = null;
    let lane: string | null = null;
    if ("workerId" in target) {
      const ref = parseWorkerId(target.workerId);
      if (!ref) return refuse(failed("bad_args", `not a worker ID: ${JSON.stringify(target.workerId)}`));
      node = ref.node;
      workerId = target.workerId;
    } else if ("node" in target) {
      if (!NODE_NAME.test(target.node)) return refuse(failed("bad_args", `not a node name: ${JSON.stringify(target.node)}`));
      node = target.node;
    } else {
      const r = this.#lanes.resolve(target.lane);
      if (r.kind === "none") return refuse(failed("no_pane", `no lane named ${JSON.stringify(target.lane)}`));
      if (r.kind === "conflict") return refuse(failed("lane_conflict", `more than one window is named ${JSON.stringify(target.lane)}; rename one, or address it by worker ID`));
      node = r.node;
      workerId = r.workerId;
      lane = target.lane;
    }
    const a: Record<string, unknown> = { ...args };
    if (workerId !== null && PANE_OPS.has(op)) {
      if (a.workerId === undefined) a.workerId = workerId;
      else if (a.workerId !== workerId) return refuse(failed("bad_args", "args.workerId is not the target's worker"), node);
    }
    if (a.expect !== undefined && !EXPECT_OPS.has(op)) return refuse(failed("bad_args", "expect applies to pane.send and pane.keys only"), node);
    if (lane !== null && workerId !== null && EXPECT_OPS.has(op) && a.expect === undefined) {
      a.expect = { server: parseWorkerId(workerId)?.server ?? "", window: lane };
    }
    if (KEYED_OPS.has(op) && o.key === undefined) return refuse(failed("bad_args", `${op} needs a key, so a retry can never act twice`), node);
    if (!KEYED_OPS.has(op) && o.key !== undefined) return refuse(failed("bad_args", `${op} takes no key`), node);
    // The op's own arguments, with the worker and expectation filled in, against the schema the agent decodes them with
    // (spec 5.3): what doesn't fit is refused here and never sent; what fits is sent as checked, so a field OP_ARGS
    // doesn't know never reaches the node.
    const checked = parseBody(OP_ARGS[op], a) as Record<string, unknown> | null;
    if (checked === null) return refuse(failed("bad_args", `arguments that don't fit ${op}`), node);
    const timeoutMs = Math.min(o.timeoutMs ?? DEFAULT_TIMEOUT_OF[op] ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const send = () => this.#connections.request(node, op, checked, { timeoutMs, ...(o.key === undefined ? {} : { key: o.key }) });
    if (op !== "lane.start" || typeof checked.name !== "string") return { node, outcome: send() };
    // Lane names are fleet-wide (spec 4): only the fleet sees every node's names, so it refuses a taken one here, and
    // one whose start is under way (two starts of one name on two nodes would both be sent otherwise).
    const name = checked.name;
    const taken = this.#lanes.get(name);
    if (taken) return refuse(failed("name_taken", `a lane named ${JSON.stringify(taken.name)} is registered on node ${taken.node}`), node);
    if (this.#reserved(name)) return refuse(failed("name_taken", `a lane named ${JSON.stringify(name)} is being started`), node);
    this.#starting.set(name, null);
    return {
      node,
      outcome: send().then(out => {
        if (!out.ok && out.error.executed === "no") this.#starting.delete(name);
        else this.#starting.set(name, this.#mono() + RESERVE_AFTER_START_MS);
        return out;
      }),
    };
  }

  #reserved(name: string): boolean {
    const until = this.#starting.get(name);
    if (until === undefined) return false;
    if (until === null || this.#mono() < until) return true;
    this.#starting.delete(name);
    return false;
  }
}
