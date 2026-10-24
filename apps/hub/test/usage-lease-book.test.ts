// The seat leases (plan 4.5, U13): one live lease per account and source, alive for 150 s, valid only for the account
// and source it was granted for, and ended by complete. Synthetic data only.
import { describe, expect, it } from "vitest";
import { LeaseBook } from "../src/application/usage-leases.ts";

let now = 1_700_000_000_000;      // 10:00
const book = () => new LeaseBook(() => now);

describe("the seat leases (U13)", () => {
  it("a grant hands out an id and 150 seconds", () => {
    const b = book();
    const g = b.grant("seat-a", "cli-screen", "mac-mini");
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.id).toMatch(/^lease-/);
    expect(g.expiresAt).toBe(now + 150_000);
    expect(b.valid(g.id, "seat-a", "cli-screen")).toBe(true);
  });

  it("a second grant for the same account and source is denied, with a retry; another account is independent", () => {
    const b = book();
    expect(b.grant("seat-a", "cli-screen", null).ok).toBe(true);
    const again = b.grant("seat-a", "cli-screen", null);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.retryAfterMs).toBeGreaterThan(0);
    expect(b.grant("seat-b", "cli-screen", null).ok).toBe(true);        // another account: its own lease
    expect(b.grant("seat-a", "app-server", null).ok).toBe(true);        // another source: its own lease
  });

  it("valid is false for another account, another source, an unknown id, an expired lease and a completed one", () => {
    const b = book();
    const g = b.grant("seat-a", "cli-screen", null);
    if (!g.ok) throw new Error("grant denied");
    expect(b.valid(g.id, "seat-b", "cli-screen")).toBe(false);
    expect(b.valid(g.id, "seat-a", "app-server")).toBe(false);
    expect(b.valid("lease-99-nothing", "seat-a", "cli-screen")).toBe(false);
    now += 151_000;
    expect(b.valid(g.id, "seat-a", "cli-screen")).toBe(false);
    now -= 151_000;
    b.complete(g.id);
    expect(b.valid(g.id, "seat-a", "cli-screen")).toBe(false);
  });
});
