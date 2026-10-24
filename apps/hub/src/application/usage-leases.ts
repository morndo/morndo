// The hub's read rationing (plan 4.4, U16; S5): one lease per account and source across all nodes, a shared cache of
// 4 minutes and a shared cooldown after a failure, a hub-wide cap of 2 live leases, and a lease that expires by
// itself 210 s after its grant (the read's 180 s timeout plus 30 s), so a killed reader needs no cleanup. The state
// is in memory: a hub restart forgets leases and cooldowns — the provider is still protected by the node's own lock
// file and by the cache the next good reading sets. The id is opaque on the wire.
import { randomBytes } from "node:crypto";
import type { UsageSource } from "@morndo/domain";

export const LEASE_TTL_MS = 210_000;     // the read's 180 s timeout plus 30 s
export const CACHE_MS = 240_000;         // 4 minutes: the minimum gap between grants, any node
export const CAP = 2;                    // live leases the whole hub may hold

// What a lease ends with (plan 4.4): the capture time of a good reading, or the cooldown it failed with.
export type LeaseOutcome = { ok: true; capturedAt: number } | { ok: false; retryAfterS: number | null };

export type GrantAnswer =
  | { status: "granted"; id: string; expiresAt: number }
  | { status: "fresh"; capturedAt: number }
  | { status: "denied"; reason: "busy" | "cooldown" | "capacity" | "no_demand"; retryAfterMs: number };

type Lease = { id: string; account: string; source: UsageSource; expiresAt: number; done: boolean };

export class LeaseBook {
  #now: () => number;
  #leases = new Map<string, Lease>();
  #n = 0;
  // Whether anybody wants the account read just now (AT-45): the UsageService's demand set, injected so the policy
  // code stays free of the service. Without one, every account counts as wanted (tests, older callers).
  #wanted: ((account: string, now: number) => boolean) | null;

  constructor(now: () => number, wanted?: (account: string, now: number) => boolean) {
    this.#now = now;
    this.#wanted = wanted ?? null;
  }

  // The policy, in order (plan 4.4): the cache, the shared cooldown, the one live lease per account and source, the
  // hub-wide cap, and the demand. Which node asks is not part of any key — the rationing is across all nodes.
  grant(account: string, source: UsageSource, node: string | null): GrantAnswer {
    void node; void account; void source; void this.#wanted;      // round 2 (S5): the policy itself
    throw new Error("not implemented");
  }

  // Ends the lease and sets what the next grant asks: the cache (a good reading) or the cooldown (a failure, doubling
  // on consecutive failures, reset by a good reading).
  complete(id: string, outcome: LeaseOutcome): void {
    void id; void outcome;                                        // round 2 (S5)
    throw new Error("not implemented");
  }

  valid(id: unknown, account: string, source: UsageSource): boolean {
    if (typeof id !== "string") return false;
    const l = this.#leases.get(id);
    return l !== undefined && !l.done && l.account === account && l.source === source && l.expiresAt > this.#now();
  }

  // The id the hub hands out: a counter plus random bytes, so it is unique and unguessable on the wire.
  #nextId(): string {
    return `lease-${++this.#n}-${randomBytes(6).toString("hex")}`;
  }
}
