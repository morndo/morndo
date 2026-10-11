// Every op the fleet asks of this node (spec §5.3), through one place that applies the rules they share:
// - the op must be known (`unknown_op`) and allowed by the node's policy (`denied`), its arguments must fit
//   (`bad_args`, args.ts: OP_ARGS first, as the fleet checked them), a keyed op (KEYED_OPS) must carry a key, and any
//   other op must carry none (`bad_args`, as at the fleet);
// - reads run at once and never wait for side effects;
// - side effects run one at a time per queue key (pane, lane, upload, repository), in arrival order, under a deadline
//   that starts when the request arrives (deadline.ts); when it passes before the side effect starts, the answer is
//   `timeout`, not executed;
// - keyed side effects use two-phase done keys (done-keys.ts): looked up first inside the queue (so a duplicate waits
//   for the original and gets its outcome), `started` before the side effect, `done` after it, released on any
//   refusal that says `executed: "no"`, kept `started` when the outcome is unknown. The key's hash covers only what
//   decides the effect (done-keys.ts, EFFECT_FIELDS); a repeat whose hash differs is `uncertain`: that key's op may
//   have run. A store that fails before `started` is committed answers internal with executed "no": nothing ran.
// Each op's own module calls `ctx.ready()` immediately before its side effect: the deadline's last check.
// `afterStarted` runs right after a keyed op's `started` is committed (the test hook dropAfterStarted cuts the connection
// there); when it answers true, the op runs on and its reply says `discarded`, for agent.ts never to send.
import { ERROR_EXECUTED, KEYED_OPS, type ErrorCode, type OpArgs, type OpError, type OpName, type OpResult } from "@morndo/protocol";
import { Flight } from "@morndo/service-kit";
import { isOpName } from "../config.ts";
import type { Logger } from "../log.ts";
import { CHECK, validKey } from "./args.ts";
import { startDeadline, type Deadline } from "./deadline.ts";
import { argsHash, type DoneKeys, type Prior } from "./done-keys.ts";
import { SerialQueue } from "./serial-queue.ts";

export type Failure = { ok: false; error: OpError };
export type Outcome<O extends OpName> = { ok: true; result: OpResult[O] } | Failure;
export type EffectContext = { ready(): OpError | null; remainingMs(): number };
export type ReadOp<O extends OpName> = { kind: "read"; run(args: OpArgs[O]): Promise<Outcome<O>> };
export type EffectOp<O extends OpName> = { kind: "effect"; queue(args: OpArgs[O]): string; run(args: OpArgs[O], ctx: EffectContext): Promise<Outcome<O>> };
export type OpTable = { [O in OpName]?: ReadOp<O> | EffectOp<O> };
export type Request = { id: string; op: string; args: unknown; timeoutMs: number; key?: string };
export type Reply = { id: string; invVersion: number; discarded?: true } & ({ ok: true; result: unknown } | { ok: false; error: OpError });

export const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, error: { code, executed: ERROR_EXECUTED[code], message } });
export const ok = <O extends OpName>(result: OpResult[O]): Outcome<O> => ({ ok: true, result });
export const read = <O extends OpName>(run: (args: OpArgs[O]) => Promise<Outcome<O>>): ReadOp<O> => ({ kind: "read", run });
export const effect = <O extends OpName>(queue: (args: OpArgs[O]) => string, run: (args: OpArgs[O], ctx: EffectContext) => Promise<Outcome<O>>): EffectOp<O> =>
  ({ kind: "effect", queue, run });

type AnyOutcome = { ok: true; result: unknown } | Failure;
type Answered = AnyOutcome & { discarded?: true };
type AnyOp = { kind: "read"; run(args: unknown): Promise<AnyOutcome> }
  | { kind: "effect"; queue(args: unknown): string; run(args: unknown, ctx: EffectContext): Promise<AnyOutcome> };

export type ExecutorDeps = {
  ops: OpTable;
  allowed: ReadonlySet<OpName>;
  doneKeys: DoneKeys;
  invVersion: () => number;
  log: Logger;
  now?: () => number;
  afterStarted?: (key: string) => boolean;
  held?: () => boolean;
  flight?: Flight;
};

export class OpExecutor {
  #d: ExecutorDeps;
  #queue = new SerialQueue();

  constructor(d: ExecutorDeps) { this.#d = d; }

  async handle(req: Request): Promise<Reply> {
    const deadline = startDeadline(req.timeoutMs, this.#d.now);
    let out: Answered;
    try { out = await this.#outcome(req, deadline); }
    catch (e) {
      this.#d.log.error(`op ${isOpName(req.op) ? req.op : "?"} failed`, e);
      out = fail("internal", "the node failed while running the op");
    }
    return { id: req.id, invVersion: this.#d.invVersion(), ...out };
  }

  async #outcome(req: Request, deadline: Deadline): Promise<Answered> {
    if (!isOpName(req.op)) return fail("unknown_op", `this node has no op ${JSON.stringify(String(req.op).slice(0, 40))}`);
    const op = req.op;
    if (!this.#d.allowed.has(op)) return fail("denied", `this node's policy does not allow ${op}`);
    const entry = this.#d.ops[op] as AnyOp | undefined;
    if (!entry) return fail("unknown_op", `this node has no ${op}`);
    const args = (CHECK[op] as (a: unknown) => unknown)(req.args);
    if (args === null) return fail("bad_args", `arguments that don't fit ${op}`);
    const keyed = KEYED_OPS.has(op);
    if (keyed && !validKey(req.key)) return fail("bad_args", `${op} needs a key`);
    if (!keyed && req.key !== undefined) return fail("bad_args", `${op} takes no key`);
    if (entry.kind === "read") return entry.run(args);
    return this.#effect(op, entry, args, keyed ? req.key : undefined, deadline);
  }

  #effect(op: OpName, entry: Extract<AnyOp, { kind: "effect" }>, args: unknown, key: string | undefined, deadline: Deadline): Promise<Answered> {
    const keys = this.#d.doneKeys;
    const hash = key === undefined ? "" : argsHash(op, args);
    return this.#queue.run(entry.queue(args), async () => {
      if (key !== undefined) {
        let prior: Prior;
        try { prior = keys.lookup(key, hash); }
        catch (e) { return this.#keysFailed(op, e); }
        if (prior.state === "done") return { ok: true, result: prior.outcome };
        if (prior.state === "started") return fail("uncertain", "an earlier attempt with this key started, and its outcome is not known");
        if (prior.state === "mismatch") return fail("uncertain", "this key was used with other arguments: its op may have run");
      }
      if (this.#d.held?.() && op !== "connections.revoke") return fail("updating", "this node is not taking new work while it updates");
      if (deadline.expired()) return fail("timeout", "the deadline passed before the op could start");
      if (key !== undefined) {
        let started: boolean;
        try { started = keys.start(key, hash); }
        catch (e) { return this.#keysFailed(op, e); }
        if (!started) return fail("uncertain", "an attempt with this key is already recorded");
      }
      const end = (this.#d.flight ?? new Flight()).begin({ kind: op, id: key ?? op });
      try {
        const discarded = key !== undefined && this.#d.afterStarted?.(key) === true;
        const ctx: EffectContext = {
          ready: () => (deadline.expired() ? fail("timeout", "the deadline passed before the side effect").error : null),
          remainingMs: () => deadline.remainingMs(),
        };
        let out: AnyOutcome;
        try { out = await entry.run(args, ctx); }
        catch (e) {
          this.#d.log.error(`op ${op} failed while acting`, e);
          out = fail("internal", "the node failed while running the op; it may have acted");    // "maybe": the key stays started
        }
        if (key !== undefined) {
          if (out.ok) keys.finish(key, out.result);
          else if (out.error.executed === "no") keys.release(key);
        }
        return discarded ? { ...out, discarded } : out;
      } finally { end(); }
    });
  }

  // The done-keys store failed before `started` was committed (a full disk, an I/O error): the side effect never began,
  // so the answer is internal with executed "no", and the caller may release the send instead of holding it in doubt.
  #keysFailed(op: OpName, e: unknown): Failure {
    this.#d.log.error(`op ${op}: the done keys could not be read or written; nothing was run`, e);
    return { ok: false, error: { code: "internal", executed: "no", message: "the node could not record the op's key (a full disk?); nothing was run" } };
  }
}
