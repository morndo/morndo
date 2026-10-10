// The hub's token bucket (ADR-0008, A6): @morndo/service-kit's, on the wall clock (one hub process, and a test's clock is
// a parameter).
import { RateLimiter as Bucket, takeAll, type BucketConfig, type Taken } from "@morndo/service-kit";

export { takeAll, type BucketConfig, type Taken };
export class RateLimiter extends Bucket {
  constructor(config: BucketConfig, now: () => number = Date.now) { super(config, now); }
}
