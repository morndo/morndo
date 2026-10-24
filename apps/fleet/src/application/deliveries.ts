// Deliveries through the fleet (fleet clients spec §4.6, §8): a client's message to a lane, stored on the lane's node
// (its delivery queue, op lane.deliver) and typed there once the lane can take it. The fleet routes, mirrors and alerts;
// it never keeps the text.
// - Routing. An id the mirror knows goes to the node that stored it, which answers its current state, or id_conflict
//   for other content (a lane that moved to another node never gets the same delivery twice). Otherwise a worker ID goes
//   to its node; a lane name through the lane registry: a name in conflict is refused lane_conflict; a sticky name
//   (config stickyLanes) whose window is gone goes to the node that last reported it (sticky_lanes), where it waits
//   (no_pane); any other unknown name is refused no_pane. The node is sent { lane, sticky } or { workerId }: it binds a
//   non-sticky name to the lane's current session itself (§4.1). A node offline refuses node_offline (Requests): nothing
//   is queued where it can't be stored. All of these are executed: no.
// - The mirror (lane_deliveries): the latest state each node reported, from ev.delivery (latest wins: the messages of one
//   connection arrive in order) and from the answers to lane.deliver and delivery.cancel. An answer can be older than an
//   event processed before it (both may come in one read of the socket), so an answer only fills a row that isn't there
//   yet or brings a final state; and a final state is never replaced by another. `stale` while the node isn't online.
//   Each change is a `delivery` event on /v1/events; a delivery's first final state is audited (delivery.final).
// - delivery_waiting: a delivery still queued, typed or held after 2, 15 and 60 minutes (LIMITS.deliveryAlertMs, from
//   its queuedAt on the node's clock; a node's offset beyond 2 s raises clock_offset) raises one alert per threshold,
//   counted in the row (`alerted`) so a restart doesn't raise one again. A stale row is skipped until its node reports.
//   A scan that finds several thresholds crossed at once raises the highest only. Its detail: { id, lane | workerId, state,
//   reason, minutes } (reconciliation ruling 25). One waiting `earlier` (behind another delivery to its lane) raises none:
//   the one ahead of it raises them for the lane, so a draft that holds ten messages is one alert, not ten (#64). It
//   raises its own once it is first in line.
// - draft_stashed: a delivery that first reports `stashed` (its node put the lane's unsent draft away so it could go in,
//   #64) raises one, with { id, lane | workerId, since, at, chars, copy }; the row keeps it, so a node's report again or a
//   restart raises none.
// - The audit: every POST and cancel (delivery.post, delivery.cancel: the id, the target, the client, the outcome) and
//   each delivery's first final state; never the text.
// - Rows go LIMITS.deliveryKeepMs (7 days) after their last change, on start and hourly.
import {
  FINAL_DELIVERY_STATES as FINAL, LIMITS, OP_ARGS, parseBody, parseWorkerId,
  type Delivery, type DeliveryState, type DeliveryTarget, type OpError, type OpResult, type Pane,
} from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { LaneDeliveriesStore } from "../adapters/lane-deliveries-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { StickyLanesStore } from "../adapters/sticky-lanes-store.ts";
import type { Connections } from "./connections.ts";
import type { EventHub } from "./events.ts";
import type { LaneRegistry } from "./lane-registry.ts";
import { opError } from "./requests.ts";

export type DeliveryRequest = { id: string; text: string; ttlMs?: number } & ({ lane: string } | { workerId: string });
export type Answer = { ok: true; delivery: Delivery } | { ok: false; error: OpError };
export type Mirrored = Delivery & { stale: boolean };

export const ALERT_SCAN_MS = 10_000;
export const LIST_MAX = 1000;                             // GET /v1/deliveries: the newest 1000 of the last 7 days
export const DELIVERY_OP_TIMEOUT_MS = LIMITS.deliveryOpTimeoutMs;
const PRUNE_EVERY_MS = 3_600_000;

export class Deliveries {
  #store: LaneDeliveriesStore;
  #sticky: StickyLanesStore;
  #stickyLanes: readonly string[];
  #lanes: LaneRegistry;
  #connections: Connections;
  #audit: Audit;
  #events: EventHub;
  #log: Logger;
  #now: () => number;
  #stickySeen = new Map<string, string>();               // sticky name → the node last written to sticky_lanes
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(p: {
    store: LaneDeliveriesStore; sticky: StickyLanesStore; stickyLanes: readonly string[]; lanes: LaneRegistry; connections: Connections;
    audit: Audit; events: EventHub; log: Logger; now?: () => number;
  }) {
    this.#store = p.store;
    this.#sticky = p.sticky;
    this.#stickyLanes = p.stickyLanes;
    this.#lanes = p.lanes;
    this.#connections = p.connections;
    this.#audit = p.audit;
    this.#events = p.events;
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
  }

  get stickyLanes(): readonly string[] { return this.#stickyLanes; }

  start(): void {
    this.#safely("removing old deliveries", () => this.prune());
    this.#timers.push(
      setInterval(() => this.#safely("the delivery_waiting scan", () => this.scanAlerts()), ALERT_SCAN_MS),
      setInterval(() => this.#safely("removing old deliveries", () => this.prune()), PRUNE_EVERY_MS),
    );
  }

  stop(): void { for (const t of this.#timers.splice(0)) clearInterval(t); }

  async post(req: DeliveryRequest, client: string, actor = "client"): Promise<Answer> {
    const target: DeliveryTarget = "lane" in req ? { lane: req.lane, sticky: this.#stickyLanes.includes(req.lane) } : { workerId: req.workerId };
    const args = { id: req.id, target, text: req.text, ...(req.ttlMs === undefined ? {} : { ttlMs: req.ttlMs }) };
    let node: string | null = null;
    let answer: Answer;
    if (parseBody(OP_ARGS["lane.deliver"], args) === null) answer = { ok: false, error: opError("bad_args", "an id, a target or a text that doesn't fit lane.deliver") };
    else {
      const routed = this.#route(req);
      if ("error" in routed) answer = { ok: false, error: routed.error };
      else {
        node = routed.node;
        const out = await this.#connections.request(node, "lane.deliver", args, { timeoutMs: DELIVERY_OP_TIMEOUT_MS });
        if (!out.ok) answer = { ok: false, error: out.error };
        else {
          const { delivery } = out.result as OpResult["lane.deliver"];
          if (delivery.id !== req.id) answer = this.#notThatDelivery(node, req.id, delivery.id);
          else {
            this.#mirror(node, delivery, "answer");
            answer = { ok: true, delivery };
          }
        }
      }
    }
    this.#audited("delivery.post", node, { id: req.id, target: "lane" in req ? { lane: req.lane } : { workerId: req.workerId }, client, outcome: answer.ok ? answer.delivery.state : answer.error.code }, actor);
    return answer;
  }

  // null: no delivery of that id is known to the fleet (GET /v1/deliveries/<id> would be 404 too).
  async cancel(id: string, client: string, actor = "client"): Promise<Answer | null> {
    const row = this.#store.get(id);
    if (!row) return null;
    const out = await this.#connections.request(row.node, "delivery.cancel", { id }, { timeoutMs: DELIVERY_OP_TIMEOUT_MS });
    let answer: Answer;
    if (!out.ok) answer = { ok: false, error: out.error };
    else {
      const { delivery } = out.result as OpResult["delivery.cancel"];
      if (delivery.id !== id) answer = this.#notThatDelivery(row.node, id, delivery.id);
      else {
        this.#mirror(row.node, delivery, "answer");
        answer = { ok: true, delivery };
      }
    }
    this.#audited("delivery.cancel", row.node, { id, client, outcome: answer.ok ? answer.delivery.state : answer.error.code }, actor);
    return answer;
  }

  get(id: string): { delivery: Delivery; stale: boolean } | null {
    const row = this.#store.get(id);
    return row ? { delivery: row.delivery, stale: this.#stale(row.node) } : null;
  }

  list(q: { lane?: string; state?: DeliveryState } = {}): Mirrored[] {
    return this.#store.list({ since: this.#now() - LIMITS.deliveryKeepMs, limit: LIST_MAX, ...q }).map(r => ({ ...r.delivery, stale: this.#stale(r.node) }));
  }

  // ev.delivery from `node` (agent-session.ts: the delivery's own node, checked).
  fromNode(node: string, d: Delivery): void { this.#mirror(node, d, "event"); }

  // True when `id` is already another node's row. Logged and audited; the row is not moved. The session drops the event
  // and stays connected: the node replays its deliveries after every welcome, so a close would come back on each one.
  heldByOther(node: string, id: string): boolean {
    const owner = this.#store.get(id)?.node;
    if (owner === undefined || owner === node) return false;
    this.#foreign(node, id, owner);
    return true;
  }

  // Each inventory: the sticky names this node reports a window of are now its own (sticky_lanes).
  inventory(node: string, panes: Pane[]): void {
    for (const name of new Set(panes.map(p => p.window))) {
      if (!this.#stickyLanes.includes(name) || this.#stickySeen.get(name) === node) continue;
      this.#sticky.set(name, node, this.#now());
      this.#stickySeen.set(name, node);
    }
  }

  scanAlerts(): void {
    const now = this.#now();
    const thresholds = LIMITS.deliveryAlertMs;
    for (const row of this.#store.open(thresholds.length)) {
      if (this.#stale(row.node) || row.delivery.waiting?.reason === "earlier") continue;
      const age = now - row.delivery.queuedAt;
      let level = row.alerted;
      while (level < thresholds.length && age >= (thresholds[level] ?? Infinity)) level++;
      if (level === row.alerted) continue;
      this.#store.setAlerted(row.id, level);
      const d = row.delivery;
      this.#audit.alert("delivery_waiting", row.node, {
        id: d.id, ...d.target, state: d.state, reason: d.waiting?.reason ?? null, minutes: (thresholds[level - 1] ?? 0) / 60_000,
      });
    }
  }

  prune(): number { return this.#store.prune(this.#now() - LIMITS.deliveryKeepMs); }

  #route(req: DeliveryRequest): { node: string } | { error: OpError } {
    const known = this.#store.get(req.id);
    if (known) return { node: known.node };
    if ("workerId" in req) {
      const ref = parseWorkerId(req.workerId);
      return ref ? { node: ref.node } : { error: opError("bad_args", `not a worker ID: ${JSON.stringify(req.workerId)}`) };
    }
    const r = this.#lanes.resolve(req.lane);
    if (r.kind === "ok") return { node: r.node };
    if (r.kind === "conflict") return { error: opError("lane_conflict", `more than one window is named ${JSON.stringify(req.lane)}; rename one, or address it by worker ID`) };
    const last = this.#stickyLanes.includes(req.lane) ? this.#sticky.get(req.lane) : null;
    if (last) return { node: last.node };
    return { error: opError("no_pane", `no lane named ${JSON.stringify(req.lane)}`) };
  }

  #mirror(node: string, d: Delivery, from: "event" | "answer"): void {
    const before = this.#store.get(d.id);
    const final = FINAL.has(d.state);
    if (before && before.node !== node) { this.#foreign(node, d.id, before.node); return; }   // never re-home a row
    if (before) {
      if (FINAL.has(before.delivery.state) && (!final || before.node !== node)) return;   // a final state stays
      if (from === "answer" && !final) return;                                         // an event may have said more since
      if (before.node === node && JSON.stringify(before.delivery) === JSON.stringify(d)) return;
    }
    this.#store.upsert(node, d, this.#now());
    if (d.stashed !== undefined && before?.delivery.stashed === undefined) {
      const { at, since, chars, copy } = d.stashed;
      try { this.#audit.alert("draft_stashed", node, { id: d.id, ...d.target, since, at, chars, copy }); }
      catch (e) { this.#log.error(`audit: the draft_stashed alert of ${d.id} could not be recorded`, e); }
    }
    if (final && !(before && FINAL.has(before.delivery.state))) {
      this.#audited("delivery.final", node, { id: d.id, state: d.state, ...(d.why === undefined ? {} : { why: d.why }) });
    }
    this.#events.emit({ t: "delivery", node, body: { ...d, stale: this.#stale(node) } satisfies Mirrored });
  }

  #foreign(node: string, id: string, owner: string): void {
    this.#log.warn(`deliveries: ${node} reported ${id}, which ${owner} holds`);
    this.#audited("delivery.foreign", node, { id, owner });
  }

  // The node answered about a different id than the one asked. Nothing is mirrored: that answer is not this delivery.
  #notThatDelivery(node: string, asked: string, answered: string): Answer {
    this.#log.warn(`deliveries: ${node} answered ${asked} with ${answered}`);
    this.#audited("delivery.foreign", node, { id: asked, answered });
    return { ok: false, error: opError("id_conflict", `the node answered ${answered}, not ${asked}`) };
  }

  #stale(node: string): boolean { return this.#connections.status(node) !== "online"; }

  // The outcome is the client's whatever the audit can take (fleet.db busy or full): logged instead, never the text.
  #audited(action: string, node: string | null, detail: Record<string, unknown>, actor = "client"): void {
    try { this.#audit.record(actor, action, node, detail); }
    catch (e) { this.#log.error(`audit: ${action} could not be recorded (fleet.db busy or full?): ${JSON.stringify(detail)}`, e); }
  }

  #safely(what: string, f: () => void): void {
    try { f(); } catch (e) { this.#log.error(`deliveries: ${what} failed (fleet.db busy or full?); trying again later`, e); }
  }
}
