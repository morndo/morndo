// Retry-After on a 429 (ADR-0008, A6): delay-seconds or an HTTP date (RFC 9110, 10.2.3), and the words the app shows.
import { describe, expect, it } from "vitest";
import { ApiError, explain, retryAfterMs } from "../src/lib/api.ts";

describe("Retry-After", () => {
  it("reads delay-seconds and HTTP dates; anything else is unknown", () => {
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs(" 2 ")).toBe(2000);
    const now = Date.UTC(2026, 9, 2, 12, 0, 0);
    expect(retryAfterMs("Fri, 02 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs("Fri, 02 Oct 2026 11:00:00 GMT", now)).toBe(0);          // a date in the past: ask now
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs("-3")).toBeNull();
  });
  it("says how long to wait", () => {
    expect(explain(new ApiError(429, "rate_limited", 7000))).toBe("Too many attempts. Try again in 7 seconds.");
    expect(explain(new ApiError(429, "rate_limited", 400))).toBe("Too many attempts. Try again in 1 second.");
    expect(explain(new ApiError(429, "rate_limited", null))).toBe("Too many attempts. Wait a moment, then try again.");
  });
});
