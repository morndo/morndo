// When to dial the fleet again (spec §5.2): exponential backoff from 1 s up to 60 s with full jitter, a random delay
// between zero and the exponential bound: sleep = random(0, min(cap, base * 2 ** attempt)) (M. Brooker, "Exponential
// Backoff And Jitter", AWS Architecture Blog, 2015-03-04,
// https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/, read 2026-10-06).
// The wait runs on setTimeout, which Node schedules on its monotonic clock, and is reported from performance.now(): a
// wall-clock step (NTP, a laptop resuming) neither fires a retry early nor holds it back (plan Review Focus 4).
export type RetryOptions = { baseMs?: number; capMs?: number; random?: () => number; now?: () => number };

export class RetrySchedule {
  #base: number;
  #cap: number;
  #random: () => number;
  #now: () => number;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #dueAt: number | null = null;

  constructor(o: RetryOptions = {}) {
    this.#base = o.baseMs ?? 1000;
    this.#cap = o.capMs ?? 60_000;
    this.#random = o.random ?? Math.random;
    this.#now = o.now ?? (() => performance.now());
  }

  // The next backoff delay; each call counts as one more failed attempt.
  nextDelay(): number {
    const bound = Math.min(this.#cap, this.#base * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 30);
    return Math.floor(this.#random() * bound);
  }

  // Runs `fn` after the next backoff delay; returns the delay.
  backoff(fn: () => void): number {
    const delay = this.nextDelay();
    this.after(delay, fn);
    return delay;
  }

  // Runs `fn` after `ms` ± `spread` (a fraction: 0.2 is ±20 %), from the same random source as the backoff, so many
  // refused agents don't ask again in step (a refused second instance's 5-minute retry). Returns the delay.
  afterAbout(ms: number, spread: number, fn: () => void): number {
    const delay = Math.round(ms * (1 - spread + 2 * spread * this.#random()));
    this.after(delay, fn);
    return delay;
  }

  // Runs `fn` after exactly `ms` (the hourly retry of an unsupported protocol), replacing any pending retry.
  after(ms: number, fn: () => void): void {
    this.cancel();
    this.#dueAt = this.#now() + ms;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#dueAt = null;
      fn();
    }, ms);
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#dueAt = null;
  }

  // After a welcome: the next failure starts from the base delay again.
  reset(): void { this.#attempt = 0; }

  retryInMs(): number | null {
    return this.#dueAt === null ? null : Math.max(0, this.#dueAt - this.#now());
  }
}
