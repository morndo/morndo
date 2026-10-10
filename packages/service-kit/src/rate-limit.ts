// A token bucket per key (ADR-0008, A6). Design reference, not code: Signal-Server's limits/ and
// validate_rate_limit.lua. Each key's bucket holds up to `capacity` tokens and refills continuously at
// `refillPerSecond`; a request takes one. A refusal carries the wait until enough tokens are back, rounded UP to whole
// seconds for Retry-After (Signal's mapper truncates, which sends a client back too early). In memory: one process. The clock is the caller's to name: the hub's wall clock, the fleet's monotonic one.
export type BucketConfig = { capacity: number; refillPerSecond: number };
export type Taken = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  readonly config: BucketConfig;
  #now: () => number;
  #buckets = new Map<string, { tokens: number; at: number }>();
  #takes = 0;

  constructor(config: BucketConfig, now: () => number) {
    if (!(config.capacity > 0) || !(config.refillPerSecond > 0)) throw new Error(`bad rate limit: ${JSON.stringify(config)}`);
    this.config = config;
    this.#now = now;
  }

  get size() { return this.#buckets.size; }

  #level(key: string, now: number): number {
    const b = this.#buckets.get(key);
    if (!b) return this.config.capacity;
    return Math.min(this.config.capacity, b.tokens + ((now - b.at) / 1000) * this.config.refillPerSecond);
  }

  // Whether `cost` tokens are there now, without taking them.
  peek(key: string, cost = 1): Taken {
    const tokens = this.#level(key, this.#now());
    if (tokens >= cost) return { ok: true };
    const waitSeconds = (cost - tokens) / this.config.refillPerSecond;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitSeconds - 1e-9)) };
  }

  take(key: string, cost = 1): Taken {
    const now = this.#now();
    if (++this.#takes % 1000 === 0) this.prune();
    const seen = this.peek(key, cost);
    if (seen.ok) this.#buckets.set(key, { tokens: this.#level(key, now) - cost, at: now });
    return seen;
  }

  // Drops every bucket that has refilled completely: it behaves exactly like a key never seen.
  prune() {
    const now = this.#now();
    for (const key of this.#buckets.keys()) if (this.#level(key, now) >= this.config.capacity) this.#buckets.delete(key);
  }
}

// One request against several buckets (a caller's own and a shared ceiling): every bucket is charged only when all have
// room, so a refusal by one spends nothing of the others; the wait is the longest. (Phase A review L6.)
export function takeAll(entries: readonly (readonly [RateLimiter, string])[]): Taken {
  let wait = 0;
  for (const [limiter, key] of entries) {
    const r = limiter.peek(key);
    if (!r.ok) wait = Math.max(wait, r.retryAfterSeconds);
  }
  if (wait > 0) return { ok: false, retryAfterSeconds: wait };
  for (const [limiter, key] of entries) limiter.take(key);
  return { ok: true };
}
