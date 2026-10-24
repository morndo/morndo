// The seat leases (plan 4.5, U13; S5's rationing): a grant hands out an opaque id and 210 seconds, one lease per
// account and source holds across asks, and a completed or expired one frees the account again. Adapted to the S5
// policy (grant answers granted/fresh/denied; complete takes an outcome): the slice-2 cases the policy contradicts
// moved with it. Synthetic data only. Round 1: the policy itself is stubbed, so these are red.
import { describe, expect, it } from "vitest";
import { CACHE_MS, CAP, LEASE_TTL_MS, LeaseBook } from "../src/application/usage-leases.ts";

let now = 1_700_000_000_000;      // 10:00
const book = () => new LeaseBook(() => now);

describe("the seat leases (U13, U16)", () => {
  it("a grant hands out an id and 210 seconds", () => {
    const b = book();
    const g = b.grant("seat-a", "claude-usage", "pc");
    expect(g.status).toBe("granted");
    if (g.status !== "granted") return;
    expect(g.id).toMatch(/^lease-/);
    expect(g.expiresAt).toBe(now + LEASE_TTL_MS);
    expect(b.valid(g.id, "seat-a", "claude-usage")).toBe(true);
  });

  it("a second grant for the same account and source is busy, whichever node asks; the cap is two", () => {
    const b = book();
    expect(b.grant("seat-a", "claude-usage", "node-a").status).toBe("granted");
    const again = b.grant("seat-a", "claude-usage", "node-b");
    expect(again.status).toBe("denied");
    if (again.status !== "denied") return;
    expect(again.reason).toBe("busy");
    expect(again.retryAfterMs).toBeGreaterThan(0);
    expect(again.retryAfterMs).toBeLessThanOrEqual(LEASE_TTL_MS);
    expect(b.grant("seat-b", "claude-usage", null).status).toBe("granted");         // another account: its own lease
    // The hub-wide cap: two live leases are all there is, for any account or source.
    const third = b.grant("seat-c", "app-server", null);
    expect(third.status).toBe("denied");
    if (third.status === "denied") expect(third.reason).toBe("capacity");
    expect(CAP).toBe(2);
  });

  it("valid is false for another account, another source, an unknown id, an expired lease and a completed one", () => {
    const b = book();
    const g = b.grant("seat-a", "claude-usage", null);
    if (g.status !== "granted") throw new Error("grant denied");
    expect(b.valid(g.id, "seat-b", "claude-usage")).toBe(false);
    expect(b.valid(g.id, "seat-a", "app-server")).toBe(false);
    expect(b.valid("lease-99-nothing", "seat-a", "claude-usage")).toBe(false);
    now += LEASE_TTL_MS + 1_000;
    expect(b.valid(g.id, "seat-a", "claude-usage")).toBe(false);
    now -= LEASE_TTL_MS + 1_000;
    b.complete(g.id, { ok: true, capturedAt: now });
    expect(b.valid(g.id, "seat-a", "claude-usage")).toBe(false);
  });
});
