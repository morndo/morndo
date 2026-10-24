// Source health (U6, U11): a transient failure keeps a source merely stale for an hour, a source that declared how
// often it may be read and then went quiet is unavailable once its silence outruns that, the status line is never
// unavailable by silence, and two weeks of silence forgets a source entirely.
import { describe, expect, it } from "vitest";
import { failedRead, okRead, shouldForget, sourceState, unavailableSince, type SourceHealth } from "../src/index.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const health = (o: Partial<SourceHealth> = {}): SourceHealth => ({ source: "app-server", lastOkAt: null, lastFailAt: null, failingSince: null, reason: null, everyS: null, ...o });

describe("source health (U6, U11)", () => {
  it("transient failures stay stale for an hour", () => {
    const ok = okRead(health(), T0, null);
    const failing = failedRead(ok, T0 + MIN, "rate_limited", null);
    expect(failing.lastOkAt).toBe(T0);                                   // the last good read still counted
    expect(sourceState(failing, T0 + 30 * MIN)).toBe("stale");
    expect(sourceState(failing, failing.failingSince! + 60 * MIN)).toBe("stale");
    expect(sourceState(failing, failing.failingSince! + 61 * MIN)).toBe("unavailable");
    expect(unavailableSince(failing, failing.failingSince! + 61 * MIN)).toBe(failing.failingSince! + 60 * MIN);
    const permanent = failedRead(ok, T0 + MIN, "signed_out", null);
    expect(sourceState(permanent, T0 + MIN)).toBe("unavailable");       // a permanent reason is unavailable at once
    expect(sourceState(health(), T0)).toBe("missing");                  // nothing recorded at all
  });

  it("a source that declared every goes silent", () => {
    const h = okRead(health(), T0, 900);
    expect(h.everyS).toBe(900);
    expect(sourceState(h, T0 + 10 * MIN)).toBe("available");
    expect(sourceState(h, T0 + 35 * MIN)).toBe("stale");                // stale before it is unavailable
    expect(sourceState(h, T0 + 59 * MIN)).toBe("stale");
    expect(sourceState(h, T0 + 61 * MIN)).toBe("unavailable");          // max(4 * every, 30 min) of silence
    expect(unavailableSince(h, T0 + 61 * MIN)).toBe(T0 + 60 * MIN);
    const back = okRead(h, T0 + 61 * MIN, 900);
    expect(sourceState(back, T0 + 61 * MIN)).toBe("available");         // a new good read clears it
  });

  it("the status line is stale after 10 minutes and never unavailable by silence", () => {
    const h = okRead(health({ source: "status-line" }), T0, null);
    expect(sourceState(h, T0 + 9 * MIN)).toBe("available");
    expect(sourceState(h, T0 + 11 * MIN)).toBe("stale");
    expect(sourceState(h, T0 + 6 * HOUR)).toBe("stale");
    expect(sourceState(h, T0 + 13 * DAY)).toBe("stale");
    expect(shouldForget(h, T0 + 13 * DAY)).toBe(false);
    expect(shouldForget(h, T0 + 14 * DAY)).toBe(true);
  });

  it("a source that declares nothing still has a stale line", () => {
    const h = okRead(health(), T0, null);
    expect(sourceState(h, T0 + 14 * MIN)).toBe("available");
    expect(sourceState(h, T0 + 16 * MIN)).toBe("stale");
    expect(sourceState(h, T0 + 13 * DAY)).toBe("stale");                // no declared every: never unavailable by silence
  });

  it("a failure that declares nothing keeps the declared every", () => {
    const failing = failedRead(okRead(health(), T0, 900), T0 + MIN, "timeout", null);
    expect(failing.everyS).toBe(900);
    expect(failedRead(failing, T0 + 2 * MIN, "timeout", 120).everyS).toBe(120);
  });

  it("a declared every is clamped", () => {
    expect(okRead(health(), T0, 1e9).everyS).toBe(21_600);
  });

  it("any source silent for 14 days is forgotten", () => {
    const h = okRead(health(), T0, 900);
    expect(shouldForget(h, T0 + 13 * DAY)).toBe(false);
    expect(shouldForget(h, T0 + 14 * DAY)).toBe(true);
    expect(shouldForget(h, T0 + 61 * MIN + 14 * DAY)).toBe(true);       // unavailable for two weeks
  });
});
