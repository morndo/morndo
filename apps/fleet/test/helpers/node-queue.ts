// A node's delivery queue as a fake agent answers it (fleet clients spec §4.3; the real one is the agent's, Tasks 4 to 6):
// lane.deliver stores a delivery `queued` on the node's clock and answers it, the same id again answers what is stored;
// delivery.cancel gives up a queued one and refuses a typed one (already_typed). Every other op gets a minimal valid
// result. `deliveryOf` builds a Delivery for ev.delivery.
import type { Delivery, OpArgs } from "@morndo/protocol";
import { validResult, type FakeAgent } from "./fake-agent.ts";

export const T0 = 1_800_000_000_000;

export const deliveryOf = (node: string, id: string, over: Partial<Delivery> = {}): Delivery =>
  ({ id, node, target: { lane: "api" }, state: "queued", queuedAt: T0, notAfter: T0 + 86_400_000, ...over });

export function nodeQueue(a: FakeAgent, o: { queuedAt?: () => number } = {}): Map<string, Delivery> {
  const stored = new Map<string, Delivery>();
  a.answer = req => {
    if (req.op === "lane.deliver") {
      const args = req.args as OpArgs["lane.deliver"];
      const at = o.queuedAt?.() ?? T0;
      const target = "lane" in args.target ? { lane: args.target.lane } : { workerId: args.target.workerId };
      const d = stored.get(args.id) ?? deliveryOf(a.node, args.id, { target, queuedAt: at, notAfter: at + (args.ttlMs ?? 86_400_000) });
      stored.set(args.id, d);
      return { ok: true, result: { delivery: d } };
    }
    if (req.op === "delivery.cancel") {
      const d = stored.get((req.args as OpArgs["delivery.cancel"]).id);
      if (!d) return { ok: false, error: { code: "bad_args", executed: "no", message: "no such delivery" } };
      if (d.state !== "queued") return { ok: false, error: { code: "already_typed", executed: "no", message: "already typed" } };
      const cancelled: Delivery = { ...d, state: "given_up", why: "cancelled" };
      stored.set(d.id, cancelled);
      return { ok: true, result: { delivery: cancelled } };
    }
    return { ok: true, result: validResult(req.op, a.node) };
  };
  return stored;
}
