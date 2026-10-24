// The seat leases (plan 4.5, U13): one live lease per account and source, so a reading that may clear a seat mark
// comes from a collector the hub itself handed the lease to. Minimal in S2 — slice 5 adds the route, the cache, the
// cooldown and the cap. A lease lives 150 s; the id is opaque on the wire.
import { randomBytes } from "node:crypto";
import type { UsageSource } from "@morndo/domain";

export const LEASE_MS = 150_000;

type Lease = { id: string; account: string; source: UsageSource; expiresAt: number; done: boolean };

export class LeaseBook {
  #now: () => number;
  #leases = new Map<string, Lease>();
  #n = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  grant(account: string, source: UsageSource, node: string | null): { ok: true; id: string; expiresAt: number } | { ok: false; retryAfterMs: number } {
    void node;      // the lease is per account and source; which node asked is not part of its key
    const now = this.#now();
    for (const l of this.#leases.values()) {
      if (l.done || l.expiresAt <= now) continue;
      if (l.account === account && l.source === source) return { ok: false, retryAfterMs: l.expiresAt - now };
    }
    const id = this.#nextId();
    this.#leases.set(id, { id, account, source, expiresAt: now + LEASE_MS, done: false });
    return { ok: true, id, expiresAt: now + LEASE_MS };
  }

  valid(id: unknown, account: string, source: UsageSource): boolean {
    if (typeof id !== "string") return false;
    const l = this.#leases.get(id);
    return l !== undefined && !l.done && l.account === account && l.source === source && l.expiresAt > this.#now();
  }

  complete(id: string): void {
    const l = this.#leases.get(id);
    if (l !== undefined) l.done = true;
  }

  // The id the hub hands out: a counter plus random bytes, so it is unique and unguessable on the wire.
  #nextId(): string {
    return `lease-${++this.#n}-${randomBytes(6).toString("hex")}`;
  }
}
