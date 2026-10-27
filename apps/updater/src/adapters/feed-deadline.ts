// One budget for a run of feed fetches (design §10.3): `morndo install` ends with a check that walks the key sets and
// reads the channel, and each document has its own wall in the HTTPS feed. Left alone those add up; here every fetch is
// given only what is left of the budget, and none starts once it is spent. The feed is opened per fetch because its
// walls are fixed at construction.
import { FetchFailed, type ReleaseFeed, type Signed } from "../application/ports.ts";
import type { Channel } from "@morndo/domain";

export class DeadlineFeed implements ReleaseFeed {
  readonly #p: { until: number; now: () => number; open: (limitMs: number) => ReleaseFeed };

  constructor(p: { until: number; now: () => number; open: (limitMs: number) => ReleaseFeed }) { this.#p = p; }

  #feed(): ReleaseFeed {
    const left = this.#p.until - this.#p.now();
    if (left <= 0) throw new FetchFailed("timeout", "the time the install gives its first check ran out");
    return this.#p.open(left);
  }

  keySet(version: number): Promise<Signed | null> { return this.#run(feed => feed.keySet(version)); }
  channel(name: Channel): Promise<Signed> { return this.#run(feed => feed.channel(name)); }
  manifest(url: string, maxBytes: number): Promise<Signed> { return this.#run(feed => feed.manifest(url, maxBytes)); }

  async #run<T>(use: (feed: ReleaseFeed) => Promise<T>): Promise<T> { return await use(this.#feed()); }
}
