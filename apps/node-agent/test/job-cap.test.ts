// The log cap rule (design §5, "When a log reaches its cap"): the owner's grace and the order of an exit and a stop.
// The helper and the systemd sweep both decide through these, so the rule is one piece of code.
import { describe, expect, it } from "vitest";
import { CAP_GRACE_MS, capStep, endedBeforeStop } from "../src/ops/job-cap.ts";

describe("capStep", () => {
  it("is under the cap until the log reaches it and nothing noted it", () => {
    expect(capStep(null, 7, 8, 1000)).toEqual({ kind: "under" });
  });

  it("starts the grace at the first sighting, with the size seen then", () => {
    expect(capStep(null, 64, 8, 1000)).toEqual({ kind: "grace", sight: { size: 64, at: 1000 } });
  });

  it("starts the grace on a .cap note alone", () => {
    expect(capStep(null, 0, 8, 1000, true)).toEqual({ kind: "grace", sight: { size: 0, at: 1000 } });
  });

  it("stops at the grace boundary while the log is still under the cap", () => {
    const sight = { size: 0, at: 1000 };
    expect(capStep(sight, 0, 8, 1000 + CAP_GRACE_MS - 1)).toEqual({ kind: "grace", sight });
    expect(capStep(sight, 0, 8, 1000 + CAP_GRACE_MS)).toEqual({ kind: "stop" });
  });

  it("stops when the log crosses the cap exactly at the grace boundary", () => {
    expect(capStep({ size: 0, at: 1000 }, 8, 8, 1000 + CAP_GRACE_MS)).toEqual({ kind: "stop" });
  });

  it("keeps the grace while the log stays the same size", () => {
    const sight = { size: 64, at: 1000 };
    expect(capStep(sight, 64, 8, 1000 + CAP_GRACE_MS - 1)).toEqual({ kind: "grace", sight });
  });

  it("stops at once when the log grows again", () => {
    expect(capStep({ size: 64, at: 1000 }, 65, 8, 1001)).toEqual({ kind: "stop" });
  });

  it("stops when the grace is over", () => {
    expect(capStep({ size: 64, at: 1000 }, 64, 8, 1000 + CAP_GRACE_MS)).toEqual({ kind: "stop" });
  });
});

describe("endedBeforeStop", () => {
  it("is true only for an exit recorded before the stop was sent", () => {
    expect(endedBeforeStop(0, 5_000n)).toBe(false);
    expect(endedBeforeStop(4_999, 5_000n)).toBe(true);
    expect(endedBeforeStop(5_000, 5_000n)).toBe(false);
    expect(endedBeforeStop(5_001, 5_000n)).toBe(false);
  });
});

describe("endedBeforeStop with the last time the unit was seen running", () => {
  it("does not take an exit recorded before systemd last said the unit was running", () => {
    expect(endedBeforeStop(4_000, 5_000n, 4_500n)).toBe(false);
    expect(endedBeforeStop(4_600, 5_000n, 4_500n)).toBe(true);
    expect(endedBeforeStop(4_500, 5_000n, 4_500n)).toBe(true);
  });
});
