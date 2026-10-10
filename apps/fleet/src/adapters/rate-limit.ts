// The per-node token bucket (the hub's pattern, @morndo/service-kit's bucket): a full bucket's capacity at once, then
// refills continuously; on the monotonic clock by default, so a wall-clock jump neither drains nor fills a bucket (Review
// Focus 4). `take` says only whether a token was there.
import { RateLimiter as Bucket, type BucketConfig } from "@morndo/service-kit";

export type { BucketConfig };
export class RateLimiter {
  #bucket: Bucket;
  constructor(config: BucketConfig, now: () => number = () => performance.now()) { this.#bucket = new Bucket(config, now); }
  take(key: string): boolean { return this.#bucket.take(key).ok; }
}
