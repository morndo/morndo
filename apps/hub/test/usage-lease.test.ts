// The read leases across nodes (AT-40, AT-41; plan 4.4, U16): one lease per account and source whichever node asks,
// a shared 4-minute cache a good reading sets, a shared cooldown a failure sets (doubling, reset by a good reading),
// a hub-wide cap of two, and a lease that lapses by itself after 210 s. The policy half runs on the LeaseBook with a
// fake clock; the route half on a real in-process hub. Round 1: the policy is stubbed, so these are red. Synthetic
// data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_MS, LEASE_TTL_MS, LeaseBook } from "../src/application/usage-leases.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let now = 1_700_000_000_000;      // 10:00, the hub's clock for the whole file

describe("the lease policy on the book (AT-40)", () => {
  it("node A holds a lease for seat-a; node B asks: denied busy with a retry", () => {
    const b = new LeaseBook(() => now);
    const a = b.grant("seat-a", "claude-usage", "node-a");
    expect(a.status).toBe("granted");
    const c = b.grant("seat-a", "claude-usage", "node-b");
    expect(c.status).toBe("denied");
    if (c.status !== "denied") return;
    expect(c.reason).toBe("busy");
    expect(c.retryAfterMs).toBe(LEASE_TTL_MS);
  });

  it("A's reading lands; B asks inside 4 minutes: fresh with that capture time, and after the window a grant again", () => {
    const b = new LeaseBook(() => now);
    const a = b.grant("seat-a", "claude-usage", "node-a");
    if (a.status !== "granted") throw new Error("grant denied");
    b.complete(a.id, { ok: true, capturedAt: now });
    const inside = b.grant("seat-a", "claude-usage", "node-b");
    expect(inside).toEqual({ status: "fresh", capturedAt: now });
    now += CACHE_MS + 1_000;
    expect(b.grant("seat-a", "claude-usage", "node-b").status).toBe("granted");
  });

  it("a failure with retry_after_s 120 denies every node until then; a second failure doubles; a good reading resets", () => {
    const b = new LeaseBook(() => now);
    const first = b.grant("seat-a", "claude-usage", "node-a");
    if (first.status !== "granted") throw new Error("grant denied");
    b.complete(first.id, { ok: false, retryAfterS: 120 });
    const held = b.grant("seat-a", "claude-usage", "node-b");
    expect(held.status).toBe("denied");
    if (held.status === "denied") { expect(held.reason).toBe("cooldown"); expect(held.retryAfterMs).toBe(120_000); }
    now += 121_000;
    const second = b.grant("seat-a", "claude-usage", "node-b");
    expect(second.status).toBe("granted");
    if (second.status !== "granted") return;
    b.complete(second.id, { ok: false, retryAfterS: 120 });            // the same failure again: doubled
    const doubled = b.grant("seat-a", "claude-usage", "node-a");
    expect(doubled.status).toBe("denied");
    if (doubled.status === "denied") { expect(doubled.reason).toBe("cooldown"); expect(doubled.retryAfterMs).toBe(240_000); }
    now += 241_000;
    const third = b.grant("seat-a", "claude-usage", "node-a");
    expect(third.status).toBe("granted");
    if (third.status !== "granted") return;
    b.complete(third.id, { ok: true, capturedAt: now });               // a good reading resets the count
    const after = b.grant("seat-a", "claude-usage", "node-b");
    expect(after.status).toBe("fresh");                                // the cache, not a cooldown
  });

  it("a failure without a retry word cools down 300 s", () => {
    const b = new LeaseBook(() => now);
    const g = b.grant("seat-a", "claude-usage", null);
    if (g.status !== "granted") throw new Error("grant denied");
    b.complete(g.id, { ok: false, retryAfterS: null });
    const held = b.grant("seat-a", "claude-usage", null);
    expect(held.status).toBe("denied");
    if (held.status === "denied") { expect(held.reason).toBe("cooldown"); expect(held.retryAfterMs).toBe(300_000); }
  });

  // The fix round (2026-10-24, finding 3): retry_after_s 0 is a cooldown of a minute, not "no cooldown" — the floor is
  // max(retry_after_s * 1000, 60 s) before the doubling. Red against the code before the fix: a 0 cools nothing.
  it("a failure with retry_after_s 0 cools down 60 s and doubles on a second failure", () => {
    const b = new LeaseBook(() => now);
    const first = b.grant("seat-a", "claude-usage", null);
    if (first.status !== "granted") throw new Error("grant denied");
    b.complete(first.id, { ok: false, retryAfterS: 0 });
    const held = b.grant("seat-a", "claude-usage", null);
    expect(held.status).toBe("denied");
    if (held.status === "denied") { expect(held.reason).toBe("cooldown"); expect(held.retryAfterMs).toBe(60_000); }
    now += 61_000;
    const second = b.grant("seat-a", "claude-usage", null);
    expect(second.status).toBe("granted");
    if (second.status !== "granted") return;
    b.complete(second.id, { ok: false, retryAfterS: 0 });              // the same zero failure again: doubled
    const doubled = b.grant("seat-a", "claude-usage", null);
    expect(doubled.status).toBe("denied");
    if (doubled.status === "denied") { expect(doubled.reason).toBe("cooldown"); expect(doubled.retryAfterMs).toBe(120_000); }
  });

  it("two accounts at once are granted; a third concurrent lease is denied by the hub-wide cap", () => {
    const b = new LeaseBook(() => now);
    expect(b.grant("seat-a", "claude-usage", null).status).toBe("granted");
    expect(b.grant("seat-b", "claude-usage", null).status).toBe("granted");
    const third = b.grant("seat-c", "claude-usage", null);
    expect(third.status).toBe("denied");
    if (third.status === "denied") expect(third.reason).toBe("capacity");
  });
});

describe("a lease that nobody completes (AT-41)", () => {
  it("lapses after 210 s and another node is granted", () => {
    const b = new LeaseBook(() => now);
    expect(b.grant("seat-a", "claude-usage", "node-a").status).toBe("granted");
    now += LEASE_TTL_MS + 1_000;
    expect(b.grant("seat-a", "claude-usage", "node-b").status).toBe("granted");
  });
});

describe("the lease route", () => {
  let hub: InProcessHub;
  let token: string;
  beforeEach(async () => {
    hub = await startInProcessHub({ now: () => now });
    // The fix round (2026-10-24, finding 1): the lease route is a manager's or the usage-pool scope's, so the lane's
    // own token carries the scope. A pin changed with the finding: this was a bare worker token.
    token = hub.agents.issue("lanes", "worker", ["usage-pool"]).secret;
  });
  afterEach(async () => { await hub.close(); });

  const ask = (body: unknown) => hub.post("/api/agent/usage/lease", body, { authorization: `Bearer ${token}`, "x-morndo-lane": "usage-claude" });

  it("answers a grant in the wire shape: status, lease id and expiry in seconds, nothing else", async () => {
    const r = await ask({ account: "seat-a", source: "claude-usage", node: "pc" });
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.status).toBe("granted");
    expect(typeof body.lease_id).toBe("string");
    expect(body.expires_at).toBe(Math.floor((now + LEASE_TTL_MS) / 1000));
    expect(Object.keys(body).sort()).toEqual(["expires_at", "lease_id", "status"]);
  });

  it("answers a denial with one reason and a wait in whole seconds", async () => {
    await ask({ account: "seat-a", source: "claude-usage", node: "node-a" });
    const r = await ask({ account: "seat-a", source: "claude-usage", node: "node-b" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "denied", reason: "busy", retry_after_s: LEASE_TTL_MS / 1000 });
  });

  it("refuses a bad account and an unknown source", async () => {
    expect((await ask({ account: "", source: "claude-usage" })).status).toBe(400);
    expect((await ask({ account: "x".repeat(81), source: "claude-usage" })).status).toBe(400);
    expect((await ask({ account: "seat-a", source: "not-a-source" })).status).toBe(400);
  });
});

// The fix round (2026-10-24, finding 1): a lease belongs to the token that took it. The route is a manager's or the
// usage-pool scope's (the limit route's rule), and a reading that carries another token's lease id completes nothing —
// no cache, no cooldown. Red against the code before the fix: any agent token may ask, and any token's reading ends
// the lease.
describe("the lease route's authority and the lease's owner (finding 1)", () => {
  let hub: InProcessHub;
  let pool = "";      // a worker token with the usage-pool scope: the collector's own shape
  let bare = "";      // a worker token without it
  let manager = "";
  beforeEach(async () => {
    hub = await startInProcessHub({ now: () => now });
    pool = hub.agents.issue("lanes", "worker", ["usage-pool"]).secret;
    bare = hub.agents.issue("lanes", "worker").secret;
    manager = hub.agents.issue("manager", "manager").secret;
  });
  afterEach(async () => { await hub.close(); });

  const ask = (token: string, account: string) =>
    hub.post("/api/agent/usage/lease", { account, source: "claude-usage", node: "pc" }, { authorization: `Bearer ${token}`, "x-morndo-lane": "usage-claude" });
  const reading = (token: string, account: string, body: Record<string, unknown>) =>
    hub.post("/api/agent/usage/readings", { source: "claude-usage", node: "pc", captured_at: Math.floor(now / 1000), ...body },
      { authorization: `Bearer ${token}`, "x-morndo-lane": "usage-claude", "x-morndo-account": account });
  const grantOf = async (token: string, account: string): Promise<string> => {
    const r = await ask(token, account);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body.status).toBe("granted");
    return body.lease_id as string;
  };

  it("a worker token without the usage-pool scope is refused 403 not_allowed; a manager's or a scoped one is answered", async () => {
    const refused = await ask(bare, "seat-a");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "not_allowed" });
    expect((await ask(pool, "seat-a")).status).toBe(200);
    expect((await ask(manager, "seat-b")).status).toBe(200);
  });

  it("a reading that carries another token's lease id completes nothing: no cache, no cooldown", async () => {
    const leaseA = await grantOf(pool, "seat-a");
    const good = await reading(bare, "seat-a", { lease_id: leaseA, windows: [{ id: "five_hour", used_percent: 10, resets_at: Math.floor((now + 6 * 3_600_000) / 1000), length_mins: 300 }] });
    expect(good.status).toBe(200);
    const again = await ask(pool, "seat-a");
    expect(await again.json()).toEqual({ status: "denied", reason: "busy", retry_after_s: LEASE_TTL_MS / 1000 });   // the lease stands: no cache was set
    const leaseB = await grantOf(pool, "seat-b");
    const failed = await reading(bare, "seat-b", { lease_id: leaseB, failure: { reason: "unknown_screen", retry_after_s: 120 } });
    expect(failed.status).toBe(200);
    const after = await ask(pool, "seat-b");
    expect(await after.json()).toEqual({ status: "denied", reason: "busy", retry_after_s: LEASE_TTL_MS / 1000 });   // and no cooldown was set
  });
});
