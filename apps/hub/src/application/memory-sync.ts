// Memory's skills to every node (ADR-0031, docs/design/memory/README.md "Sync"): the hub renders the bundle and sends
// it to each online node through one typed op, memory.sync, in parts (FL14: no command, no path). Each part's key is
// `hub:memory:<version>:<part>`, so a part sent again is answered from the node's done keys, never applied twice
// (fleet core §5.3). A node is sent the bundle when its version differs from the last one the node took whole, when it
// comes back online, and every 30 minutes. A node whose policy denies the op is left alone for an hour. Nothing here
// throws out of a round: the loop logs and tries again on its next tick.
import { LIMITS, type OpArgs, type OpError, type OpResult } from "@morndo/protocol";
import { log as hubLog, type Logger } from "../adapters/log.ts";
import type { MemoryStore } from "../adapters/memory-store.ts";
import type { Bundle, MemoryService } from "./memory-service.ts";

// What the sync needs of the fleet's client (FleetClient has it): the nodes and their status, and one op to a node.
export type MemoryFleet = {
  nodes(): Promise<{ name: string; status: "online" | "stale" | "offline" }[]>;
  op(target: { node: string }, op: "memory.sync", args: OpArgs["memory.sync"], opts: { key: string; timeoutMs?: number }): Promise<
    { ok: true; result: OpResult["memory.sync"] } | { ok: false; error: OpError }>;
};
export type SyncOutcome = "synced" | "current" | "offline" | "denied" | "failed";

export const SYNC_EVERY_MS = 60_000;
export const RESEND_MS = 30 * 60_000;
export const DENIED_RETRY_MS = 60 * 60_000;
// A part is at most LIMITS.memoryPartBytes of skills the node writes to disk, in as many folders as its policy names.
const OP_TIMEOUT_MS = 15_000;
// The node said no for good: its policy doesn't allow the op (denied), or its agent is from before Memory and doesn't
// know it (unknown_op). Asking every minute would change neither.
const REFUSED = new Set<string>(["denied", "unknown_op"]);

export class MemorySync {
  #service: MemoryService;
  #store: MemoryStore;
  #fleet: MemoryFleet;
  #now: () => number;
  #log: Pick<Logger, "info" | "warn" | "error">;
  #seen = new Map<string, string>();                 // node → its status at the previous round
  #refusedUntil = new Map<string, number>();         // node → when to ask again after a refusal
  // Per node, the version whose sending last failed and how often: the next attempt's keys (see #send).
  #tries = new Map<string, { version: string; n: number }>();
  #running = false;

  constructor(p: { service: MemoryService; store: MemoryStore; fleet: MemoryFleet; now?: () => number; log?: Pick<Logger, "info" | "warn" | "error"> }) {
    this.#service = p.service; this.#store = p.store; this.#fleet = p.fleet; this.#now = p.now ?? Date.now; this.#log = p.log ?? hubLog;
  }

  // The loop's round, every SYNC_EVERY_MS. A round still running when the next is due is not doubled.
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try { await this.push(); }
    catch (e) { this.#log.warn("memory: a sync round failed; the next one tries again", e); }
    finally { this.#running = false; }
  }

  // One round. `force` (the console's `morndo memory sync`) sends to every online node now, whatever it last took and
  // whatever it refused. The version sent, its parts, and each node's outcome by name.
  async push(o: { force?: boolean } = {}): Promise<{ version: string; parts: number; outcomes: Map<string, SyncOutcome> }> {
    const outcomes = new Map<string, SyncOutcome>();
    const nodes = await this.#fleet.nodes();
    const bundle = this.#service.bundle();
    const pushed = { version: bundle.version, parts: bundle.parts.length, outcomes };
    if (bundle.parts.length > LIMITS.memoryPartsMax) {
      this.#log.error(`memory: the skills need ${bundle.parts.length} parts, more than the ${LIMITS.memoryPartsMax} a sync takes; nothing was sent`);
      for (const n of nodes) outcomes.set(n.name, "failed");
      return pushed;
    }
    await Promise.all(nodes.map(async node => { outcomes.set(node.name, await this.#round(node, bundle, o.force === true)); }));
    return pushed;
  }

  async #round(node: { name: string; status: string }, bundle: Bundle, force: boolean): Promise<SyncOutcome> {
    const before = this.#seen.get(node.name);
    this.#seen.set(node.name, node.status);
    if (node.status !== "online") return "offline";
    const now = this.#now();
    if (!force && (this.#refusedUntil.get(node.name) ?? 0) > now) return "denied";
    const last = this.#store.lastSynced(node.name);
    // Nothing to write and nothing this node ever took to remove: no op at all (a new install, a node that never had
    // Memory's skills). Once a node took a version, an empty one still goes out, to take its skills away.
    if (last === null && bundle.parts.every(p => p.length === 0)) return "current";
    const back = before !== undefined && before !== "online";           // it was stale or offline at the previous round
    if (!force && !back && last !== null && last.version === bundle.version && now - last.at < RESEND_MS) return "current";
    return this.#send(node.name, bundle);
  }

  // Every part, in order; the node took the version whole only when every part was accepted and one of them committed
  // it. Only then is it recorded as the node's.
  async #send(node: string, bundle: Bundle): Promise<SyncOutcome> {
    const outcome = await this.#sendParts(node, bundle);
    if (outcome === "failed") {
      // A part the node could not finish keeps its key `started` there, and the same key would be answered `uncertain` for
      // days: the next round sends the version under fresh keys. Staging a part again changes nothing on the node.
      const t = this.#tries.get(node);
      this.#tries.set(node, { version: bundle.version, n: Math.min((t && t.version === bundle.version ? t.n : 0) + 1, 99) });
    } else if (outcome === "synced") this.#tries.delete(node);
    return outcome;
  }

  async #sendParts(node: string, bundle: Bundle): Promise<SyncOutcome> {
    const t = this.#tries.get(node);
    const attempt = t && t.version === bundle.version ? t.n : 0;
    let committed = false;
    for (const [part, files] of bundle.parts.entries()) {
      let answer: Awaited<ReturnType<MemoryFleet["op"]>>;
      try {
        answer = await this.#fleet.op({ node }, "memory.sync", { version: bundle.version, part, parts: bundle.parts.length, files },
          { key: `hub:memory:${bundle.version}:${part}${attempt > 0 ? `#${attempt}` : ""}`, timeoutMs: OP_TIMEOUT_MS });
      } catch (e) {
        this.#log.warn(`memory: ${node} didn't answer part ${part + 1} of ${bundle.parts.length}; the next round tries again`, e);
        return "failed";
      }
      if (!answer.ok) {
        if (REFUSED.has(answer.error.code)) {
          this.#refusedUntil.set(node, this.#now() + DENIED_RETRY_MS);
          this.#log.info(`memory: ${node} refused memory.sync (${answer.error.code}); asking again in an hour`);
          return "denied";
        }
        this.#log.warn(`memory: ${node} refused part ${part + 1} of ${bundle.parts.length} (${answer.error.code}); the next round tries again`);
        return "failed";
      }
      if (answer.result.committed === true) committed = true;
    }
    if (!committed) {
      this.#log.warn(`memory: ${node} took every part of ${bundle.version} but committed none; the next round sends it again`);
      return "failed";
    }
    this.#refusedUntil.delete(node);
    this.#store.setSynced(node, bundle.version, this.#now());
    return "synced";
  }
}
