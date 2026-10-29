// lane.deliver and delivery.cancel (fleet clients spec §4.1–4.3; plan Contracts): the fleet's ops onto this node's
// deliverer.
// - lane.deliver reads the inventory within its poll interval (a lane started a moment ago is known), then the deliverer
//   validates, binds and stores the delivery, synced, before the answer goes out: `queued` is a promise the sender may
//   stop retrying on.
// - Its id is its idempotency, so it carries no key (not in KEYED_OPS); its typing runs under that id as a done key inside
//   the agent.
// - Deliveries are typed through pane.send, so a node whose policy doesn't allow pane.send refuses lane.deliver (`denied`)
//   rather than queue what it would never type.
// - Both run one at a time per delivery id: a repeat waits for the first to be stored, and answers what was stored.
import type { Policy } from "../config.ts";
import type { Deliverer, PaneView } from "../deliveries/deliverer.ts";
import { effect, fail, ok, type OpTable } from "./executor.ts";

export function deliveryOps(d: { deliverer: () => Deliverer; panes: PaneView; policy: Policy }): Pick<OpTable, "lane.deliver" | "delivery.cancel"> {
  return {
    "lane.deliver": effect(a => `delivery:${a.id}`, async (a, ctx) => {
      if (!d.policy.ops.includes("pane.send")) return fail("denied", "deliveries are typed through pane.send, which this node's policy does not allow");
      // A refresh that throws (tmux killed mid list-panes) stored nothing. Answer executed "no", not the executor's
      // "maybe": the sender must not hold the delivery in doubt.
      try { await d.panes.refresh(); }
      catch { return { ok: false, error: { code: "internal", executed: "no", message: "the node's panes could not be read; nothing was queued" } }; }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const r = await d.deliverer().enqueue(a);
      return "code" in r ? { ok: false, error: r } : ok<"lane.deliver">(r);
    }),
    "delivery.cancel": effect(a => `delivery:${a.id}`, async a => {
      const r = d.deliverer().cancel(a.id);
      return "code" in r ? { ok: false, error: r } : ok<"delivery.cancel">(r);
    }),
  };
}
