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
const COOLDOWN_BASE_MS = 300_000;        // a failure with no retry word of its own: 5 minutes
const COOLDOWN_CAP_MS = 1_800_000;       // however many failures in a row: half an hour at most
// The fix round (2026-10-24, finding 3): the floor under a provider retry word — retry_after_s 0 is a cooldown of a
// minute, not "no cooldown".
const COOLDOWN_FLOOR_MS = 60_000;
// The fix round (2026-10-24, finding 2): a token may start at most this many NEW unknown names an hour.
const UNKNOWN_NEW_NAMES = 5;
const UNKNOWN_HOUR_MS = 3_600_000;

// What a lease ends with (plan 4.4): the capture time of a good reading, or the cooldown it failed with.
export type LeaseOutcome = { ok: true; capturedAt: number } | { ok: false; retryAfterS: number | null };

export type GrantAnswer =
  | { status: "granted"; id: string; expiresAt: number }
  | { status: "fresh"; capturedAt: number }
  | { status: "denied"; reason: "busy" | "cooldown" | "capacity" | "no_demand"; retryAfterMs: number };

type Lease = { id: string; account: string; source: UsageSource; tokenId: string | null; expiresAt: number; done: boolean };
type Cooldown = { until: number; failures: number };

export class LeaseBook {
  #now: () => number;
  #leases = new Map<string, Lease>();
  #cache = new Map<string, number>();       // (account, source) → the capture time of its newest good reading
  #cooldown = new Map<string, Cooldown>();
  #n = 0;
  // Whether anybody wants the account read just now (AT-45): the UsageService's demand set, injected so the policy
  // code stays free of the service. Without one, every account counts as wanted (tests, older callers).
  #wanted: ((account: string, now: number) => boolean) | null;
  // Whether the hub has never heard of an account (fix round 2026-10-24, finding 2): the service's own knowledge,
  // injected like #wanted. Without one, no account counts as unknown (tests, older callers).
  #unknown: ((account: string) => boolean) | null;
  // The NEW unknown names a token started, each until its hour rolls over (finding 2): token → account → when started.
  #startedNames = new Map<string, Map<string, number>>();

  constructor(now: () => number, wanted?: (account: string, now: number) => boolean, unknown?: (account: string) => boolean) {
    this.#now = now;
    this.#wanted = wanted ?? null;
    this.#unknown = unknown ?? null;
  }

  // The policy, in order (plan 4.4): the cache, the shared cooldown, the one live lease per account and source, the
  // hub-wide cap, and the demand. Which node asks is not part of any key — the rationing is across all nodes. The
  // lease is the asking token's (finding 1): only its own readings complete it.
  grant(account: string, source: UsageSource, node: string | null, tokenId: string | null = null): GrantAnswer {
    void node;      // the lease is per account and source; which node asked is for the record only
    const now = this.#now();
    const key = `${account}|${source}`;
    // 1. A good reading younger than the cache window answers every node: use it, spawn nothing.
    const capturedAt = this.#cache.get(key);
    if (capturedAt !== undefined && now - capturedAt < CACHE_MS) return { status: "fresh", capturedAt };
    // 2. A failure's shared cooldown: whichever node asks waits it out.
    const cool = this.#cooldown.get(key);
    if (cool !== undefined && now < cool.until) return { status: "denied", reason: "cooldown", retryAfterMs: cool.until - now };
    const live = [...this.#leases.values()].filter(l => !l.done && l.expiresAt > now);
    // 3. One live lease per account and source, across all nodes.
    const held = live.find(l => l.account === account && l.source === source);
    if (held !== undefined) return { status: "denied", reason: "busy", retryAfterMs: held.expiresAt - now };
    // 4. The hub-wide cap: when another lease frees (or lapses) there is room again.
    if (live.length >= CAP) return { status: "denied", reason: "capacity", retryAfterMs: Math.max(...live.map(l => l.expiresAt)) - now };
    // 5. Nobody wants the account read: no lease. The book asks only when it would grant, so a yes here consumes
    //    the demand it answered.
    if (this.#wanted !== null && !this.#wanted(account, now)) return { status: "denied", reason: "no_demand", retryAfterMs: 0 };
    // 6. An account the hub has never heard of is wanted once per name (finding 2), but one token may start at most
    //    5 NEW unknown names an hour — a name this token already started inside the hour is not new again.
    if (!this.#mayStartUnknown(account, tokenId, now)) return { status: "denied", reason: "no_demand", retryAfterMs: 0 };
    const id = this.#nextId();
    this.#leases.set(id, { id, account, source, tokenId, expiresAt: now + LEASE_TTL_MS, done: false });
    return { status: "granted", id, expiresAt: now + LEASE_TTL_MS };
  }

  // Whether the token may start this unknown name now (finding 2): true when the account is known (no budget spent),
  // when no token is named, or when the name is not new; a name counts once, for an hour.
  #mayStartUnknown(account: string, tokenId: string | null, now: number): boolean {
    if (tokenId === null || this.#unknown === null || !this.#unknown(account)) return true;
    const started = this.#startedNames.get(tokenId) ?? new Map<string, number>();
    for (const [name, at] of started) if (now - at >= UNKNOWN_HOUR_MS) started.delete(name);   // the hour rolled over
    if (started.has(account)) { this.#startedNames.set(tokenId, started); return true; }
    if (started.size >= UNKNOWN_NEW_NAMES) { this.#startedNames.set(tokenId, started); return false; }
    started.set(account, now);
    this.#startedNames.set(tokenId, started);
    return true;
  }

  // Ends the lease and sets what the next grant asks: the cache (a good reading, which also resets the failure
  // count) or the cooldown (a failure, doubling on consecutive failures to the cap, reset by a good reading).
  complete(id: string, outcome: LeaseOutcome): void {
    const l = this.#leases.get(id);
    if (l === undefined) return;
    l.done = true;
    const key = `${l.account}|${l.source}`;
    if (outcome.ok) {
      this.#cache.set(key, outcome.capturedAt);
      this.#cooldown.delete(key);
      return;
    }
    const failures = (this.#cooldown.get(key)?.failures ?? 0) + 1;
    // The fix round (2026-10-24, finding 3): the provider's own retry word is floored at a minute — retry_after_s 0 is
    // a cooldown of 60 s, not "no cooldown" — before the doubling.
    const base = (outcome.retryAfterS !== null ? Math.max(outcome.retryAfterS * 1000, COOLDOWN_FLOOR_MS) : COOLDOWN_BASE_MS) * 2 ** (failures - 1);
    this.#cooldown.set(key, { until: this.#now() + Math.min(base, COOLDOWN_CAP_MS), failures });
  }

  // The lease is the token's that took it (finding 1): valid only for that token, that account and that source. A
  // reading that carries another token's lease id is unleased — it completes nothing, clears nothing.
  valid(id: unknown, account: string, source: UsageSource, tokenId: string | null = null): boolean {
    if (typeof id !== "string") return false;
    const l = this.#leases.get(id);
    return l !== undefined && !l.done && l.tokenId === tokenId && l.account === account && l.source === source && l.expiresAt > this.#now();
  }

  // The id the hub hands out: a counter plus random bytes, so it is unique and unguessable on the wire.
  #nextId(): string {
    return `lease-${++this.#n}-${randomBytes(6).toString("hex")}`;
  }
}
