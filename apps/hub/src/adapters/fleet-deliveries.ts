// The hub's port onto the fleet's delivery queue (fleet-clients §4, §8, §9.1; ADR-0014), over @morndo/fleet-client.
// - A refusal (FleetOpFailed with executed "no") queued nothing: its code. One with executed "maybe" is in doubt.
// - A request that never reached the fleet (FleetUnavailable, reached false: no socket, refused) queued nothing either:
//   "node_offline", as the fleet's own refusal while a node is away reads (spec §10: "new ones are refused").
// - One the fleet took and never answered (FleetUnavailable reached, or an answer that isn't the client API's) may have
//   been queued: in doubt. The same id again (spec §4.1) answers what became of it.
// - A cancel of an id the fleet doesn't know (cancelDelivery's null, its 404; ruling 56) is `unknown`, nothing in doubt.
// - Events: the fleet's `delivery` messages, each the latest state of one delivery (spec §4.4); `onOpen` after every
//   (re)subscription, since one sent meanwhile isn't replayed.
import { FleetMismatch, FleetOpFailed, FleetUnavailable, type FleetClient } from "@morndo/fleet-client";
import type { Delivery } from "@morndo/protocol";
import type { CancelAnswer, DeliverAnswer, Deliveries } from "../application/ports.ts";

const STATES = new Set<string>(["queued", "typed", "held", "delivered", "uncertain", "given_up"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A delivery's shape, as far as the hub reads it; anything else in an event is never guessed at.
export const isDelivery = (v: unknown): v is Delivery =>
  isRecord(v) && typeof v.id === "string" && typeof v.node === "string" && typeof v.state === "string" && STATES.has(v.state)
  && typeof v.queuedAt === "number" && typeof v.notAfter === "number";

// What a deliver's or a cancel's failure says: refused (nothing happened), or in doubt.
function failed(e: unknown): DeliverAnswer {
  if (e instanceof FleetOpFailed) return e.error.executed === "no" ? { ok: false, refused: e.error.code } : { ok: false, inDoubt: true };
  if (e instanceof FleetUnavailable) return e.reached ? { ok: false, inDoubt: true } : { ok: false, refused: "node_offline" };
  if (e instanceof FleetMismatch) return { ok: false, inDoubt: true };
  throw e;
}
const answered = (d: unknown): DeliverAnswer => (isDelivery(d) ? { ok: true, delivery: d } : { ok: false, inDoubt: true });

export function fleetDeliveries(client: FleetClient): Deliveries {
  return {
    async deliver(d) {
      try { return answered(await client.deliver({ id: d.id, lane: d.lane, text: d.text, ...(d.ttlMs === undefined ? {} : { ttlMs: d.ttlMs }) })); }
      catch (e) { return failed(e); }
    },
    async cancel(id): Promise<CancelAnswer> {
      try {
        const d = await client.cancelDelivery(id);
        return d === null ? { ok: false, unknown: true } : answered(d);
      } catch (e) { return failed(e); }
    },
    // One answer that isn't a delivery's (FleetMismatch, or a body of another shape) is about this delivery only:
    // "unreadable". The fleet not answering at all is "unavailable" (review #5).
    async get(id) {
      try {
        const d = await client.delivery(id);
        return d === null ? null : isDelivery(d) ? d : "unreadable";
      } catch (e) { return e instanceof FleetMismatch ? "unreadable" : "unavailable"; }
    },
    subscribe(on, onOpen) {
      return client.events(e => { if (e.t === "delivery" && isDelivery(e.body)) on(e.body); }, { onOpen });
    },
    async stickyLanes() {
      try { return (await client.caps()).stickyLanes; } catch { return null; }
    },
    async laneNodeOnline(lane) {
      try {
        const [lanes, nodes] = await Promise.all([client.lanes(), client.nodes()]);
        const name = lanes.find(l => l.name === lane)?.node;
        if (!name) return null;
        const node = nodes.find(n => n.name === name);
        return node ? node.status === "online" : null;
      } catch { return null; }
    },
  };
}
