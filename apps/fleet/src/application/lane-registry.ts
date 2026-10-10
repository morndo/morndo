// The fleet-wide lane registry (spec 4, ADR-0012 decision 11), built from each node's inventory (window names are
// lane names). A name belongs to the first node that registered it. When more than one window claims a name, on two
// nodes or on one, the name is in conflict for all of them and routing by it stops until only one window claims it.
// A node that goes offline keeps its claims (its lanes show offline through the node's status); only its own next
// inventory, or its revocation, releases them. After a restart, a persisted owner keeps its name until it reports.
// Names are stored and compared exactly as tmux reports them (spaces, unicode, dots, slashes); routing to a pane always
// goes by its worker ID, never by splitting a name (Review Focus 1).
// A name going into conflict, or out of it, is a `conflict` event { name, nodes }: the nodes whose windows claim it
// while it is in conflict, [] once it is not; going into conflict is also a lane_conflict alert, after the event.
import type { Pane } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { LaneRow, LanesStore } from "../adapters/lanes-store.ts";
import type { EventHub } from "./events.ts";

export type Lane = { name: string; node: string; workerId: string | null; conflict: boolean };
export type Claim = { node: string; workerId: string };
export type Resolved = { kind: "ok"; node: string; workerId: string } | { kind: "none" } | { kind: "conflict"; claims: Claim[] };

const laneOf = (r: LaneRow): Lane => ({ name: r.name, node: r.node, workerId: r.workerId, conflict: r.conflict });

export class LaneRegistry {
  #store: LanesStore;
  #events: EventHub;
  #audit: Audit;
  #now: () => number;
  #claims = new Map<string, Map<string, string[]>>();    // node → lane name → worker IDs, from its latest inventory
  #since = new Map<string, number>();                     // `${node}\n${name}` → the order its claim was first seen
  #order = 0;

  constructor(p: { store: LanesStore; events: EventHub; audit: Audit; activeNodes: string[]; now?: () => number }) {
    this.#store = p.store;
    this.#events = p.events;
    this.#audit = p.audit;
    this.#now = p.now ?? Date.now;
    this.#store.keepOnly(p.activeNodes);
  }

  inventory(node: string, panes: Pane[]): void {
    const next = new Map<string, string[]>();
    for (const pane of panes) next.set(pane.window, [...(next.get(pane.window) ?? []), pane.workerId]);
    const before = this.#claims.get(node) ?? new Map<string, string[]>();
    this.#claims.set(node, next);
    for (const name of before.keys()) if (!next.has(name)) this.#since.delete(`${node}\n${name}`);
    for (const name of next.keys()) if (!this.#since.has(`${node}\n${name}`)) this.#since.set(`${node}\n${name}`, ++this.#order);
    // The names it held before, those it holds now, and those stored as its own (its first report after a restart).
    for (const name of new Set([...before.keys(), ...next.keys(), ...this.#store.namesOf(node)])) this.#recompute(name);
  }

  // A revoked node: its claims and its lanes go; another claimant of one of its names becomes the owner.
  dropNode(node: string): void {
    const names = new Set([...(this.#claims.get(node)?.keys() ?? []), ...this.#store.namesOf(node)]);
    this.#claims.delete(node);
    for (const name of names) {
      this.#since.delete(`${node}\n${name}`);
      const row = this.#store.get(name);
      if (row?.node === node) this.#store.delete(name);
      this.#recompute(name, row);
    }
  }

  list(): Lane[] { return this.#store.all().map(laneOf); }

  get(name: string): Lane | null {
    const r = this.#store.get(name);
    return r ? laneOf(r) : null;
  }

  resolve(name: string): Resolved {
    const r = this.#store.get(name);
    if (!r) return { kind: "none" };
    if (r.conflict || r.workerId === null) return { kind: "conflict", claims: this.#claimsOf(name, r) };
    return { kind: "ok", node: r.node, workerId: r.workerId };
  }

  #claimsOf(name: string, row: LaneRow | null): Claim[] {
    const claims: Claim[] = [];
    for (const [node, names] of this.#claims) for (const workerId of names.get(name) ?? []) claims.push({ node, workerId });
    if (row && !this.#claims.has(row.node)) claims.unshift({ node: row.node, workerId: row.workerId ?? "" });   // not reported yet
    return claims;
  }

  // `before`: the name's row before the change, when it was already removed (a revocation); else the stored one.
  #recompute(name: string, before?: LaneRow | null): void {
    const row = this.#store.get(name);
    const prev = before === undefined ? row : before;
    const was = prev?.conflict ?? false;
    const claims = this.#claimsOf(name, row);
    if (claims.length === 0) {
      if (row) this.#store.delete(name);
      if (was && prev) this.#conflict(name, prev.node, false, []);
      return;
    }
    const keeps = row !== null && claims.some(c => c.node === row.node);
    const owner = keeps && row ? row.node : this.#earliest(name, claims);
    const mine = claims.filter(c => c.node === owner);
    const unreported = row !== null && row.node === owner && !this.#claims.has(owner);
    const next: LaneRow = {
      name, node: owner,
      workerId: unreported ? row.workerId : mine.length === 1 ? (mine[0]?.workerId ?? null) : null,
      registeredAt: keeps && row ? row.registeredAt : this.#now(),
      conflict: claims.length > 1,
    };
    if (!row || row.node !== next.node || row.workerId !== next.workerId || row.conflict !== next.conflict || row.registeredAt !== next.registeredAt) this.#store.upsert(next);
    if (next.conflict !== was) this.#conflict(name, owner, next.conflict, claims);
  }

  #earliest(name: string, claims: Claim[]): string {
    const order = (node: string) => this.#since.get(`${node}\n${name}`) ?? Number.MAX_SAFE_INTEGER;
    return [...claims].sort((a, b) => order(a.node) - order(b.node))[0]?.node ?? "";
  }

  #conflict(name: string, owner: string, conflict: boolean, claims: Claim[]): void {
    this.#events.emit({ t: "conflict", node: owner, body: { name, nodes: conflict ? [...new Set(claims.map(c => c.node))] : [] } });
    if (conflict) this.#audit.alert("lane_conflict", owner, { name, claims });
  }
}
