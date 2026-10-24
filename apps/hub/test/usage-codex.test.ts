// The hub's half of reading Codex (S6, plan 4.6, AT-36): the identity a reading carries feeds the plan watch, so a
// changed identity between two agreeing readings is an account change; a leased reading's limit flags mark the seat
// out or end a derived mark, and a reading without a lease never does either from its flags; the free-string
// rate_limit_reached_type is never shown and never stored beyond its boolean effect. Round 1: the wire fields are
// real, the hub's handling is not, so the identity and flag cases are red. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageReadingsBody } from "@morndo/protocol";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now = 1_700_000_000_000;
const HOUR = 3_600_000, MIN = 60_000;

beforeEach(async () => {
  now = 1_700_000_000_000;
  hub = await startInProcessHub({ now: () => now });
});
afterEach(async () => { await hub.close(); });

// The collector's codex pass asks the hub for the lease; each leased reading needs its own, and the hub grants one
// only when somebody wants the account read. A look marks demand once the last reading is 15 minutes old, so the
// tests space their readings that far apart.
const leaseFor = (account: string): string => {
  hub.usage.look();
  const g = hub.usage.leases.grant(account, "app-server", "pc", "t");   // bound to the token the reading below posts as
  if (g.status !== "granted") throw new Error(`the hub did not grant a lease (${g.status})`);
  return g.id;
};
const reading = (o: {
  leaseId?: string | null; plan?: string; identity?: string | null; usedPercent?: number; resetsAt?: number;
  flags?: boolean | null; type?: string | null;
} = {}, account = "seat-a") => hub.usage.reading({
  source: "app-server", node: "pc", captured_at: Math.floor(now / 1000),
  windows: [{ id: "five_hour", used_percent: o.usedPercent ?? 20, resets_at: Math.floor((o.resetsAt ?? now + 2 * HOUR) / 1000), length_mins: 300 }],
  ...(o.plan !== undefined ? { plan: o.plan } : {}),
  ...(o.identity !== undefined ? { identity: o.identity } : {}),
  ...(o.flags !== undefined && o.flags !== null ? { ordinary_usage_allowed: o.flags } : {}),
  ...(o.type !== undefined && o.type !== null ? { rate_limit_reached_type: o.type } : {}),
  ...(o.leaseId ? { lease_id: o.leaseId } : {}),
}, account, { kind: "worker", name: "usage-claude", token: "t" });
const seatOf = (account: string) => hub.usage.view().accounts.find(a => a.account === account)?.seat ?? null;
const noticeTexts = () => hub.usage.view().notices.map(n => n.text);

describe("the hub's codex readings (S6, plan 4.6, AT-36)", () => {
  it("the readings wire accepts the codex fields: the identity digest and the two limit flags", () => {
    expect(UsageReadingsBody.safeParse({
      source: "app-server", captured_at: 1, identity: "a1b2c3d4e5f6", ordinary_usage_allowed: false, rate_limit_reached_type: "weekly",
    }).success).toBe(true);
    expect(UsageReadingsBody.safeParse({
      source: "app-server", captured_at: 1, identity: null, ordinary_usage_allowed: null, rate_limit_reached_type: null,
    }).success).toBe(true);
  });

  it("a changed plan and a changed identity are each told once, by two agreeing leased readings", () => {
    const post = (o: { plan: string; identity: string }) => {
      now += 16 * MIN;                            // past the lease cache and the look's staleness, so the next lease is granted
      return reading({ ...o, leaseId: leaseFor("seat-a") }).ok;
    };
    expect(post({ plan: "plus", identity: "aaa111aaa111" })).toBe(true);
    expect(post({ plan: "plus", identity: "aaa111aaa111" })).toBe(true);    // agrees: the baseline
    expect(post({ plan: "pro", identity: "aaa111aaa111" })).toBe(true);     // holds the plan change
    expect(post({ plan: "pro", identity: "aaa111aaa111" })).toBe(true);     // tells it
    expect(post({ plan: "pro", identity: "bbb222bbb222" })).toBe(true);     // holds the account change
    expect(post({ plan: "pro", identity: "bbb222bbb222" })).toBe(true);     // tells it
    expect(noticeTexts().filter(t => t.includes("plan changed"))).toEqual(['seat-a: plan changed from "plus" to "pro".']);
    expect(noticeTexts().filter(t => t.includes("the account behind it changed"))).toEqual(["seat-a: the account behind it changed. Readings start fresh."]);
  });

  it("a leased flag-false reading marks the seat out at the full window's reset; the type string is never shown", () => {
    const reset = now + 2 * HOUR;
    expect(reading({ leaseId: leaseFor("seat-a"), flags: false, type: "weekly_secondary_rate_limited", usedPercent: 100, resetsAt: reset }).ok).toBe(true);
    expect(seatOf("seat-a")).toMatchObject({ state: "out", why: "usage_limit", backAt: reset, owner: "derived", by: "the usage reading" });
    expect(noticeTexts().some(t => t.includes("usage limit reached"))).toBe(true);
    expect(JSON.stringify(hub.usage.view())).not.toContain("weekly_secondary_rate_limited");
  });

  it("a reading without a lease never marks and never clears from its flags", () => {
    // an unleased flag-false reading marks nothing
    expect(reading({ flags: false, type: "primary", usedPercent: 100, resetsAt: now + 2 * HOUR }).ok).toBe(true);
    expect(seatOf("seat-a")).toBeNull();
    // a leased one marks the seat out
    now += 16 * MIN;
    expect(reading({ leaseId: leaseFor("seat-a"), flags: false, type: "primary", usedPercent: 100, resetsAt: now + 2 * HOUR }).ok).toBe(true);
    expect(seatOf("seat-a")?.state).toBe("out");
    // an unleased allowed-true reading, later than the mark and its back time, clears nothing
    now += 3 * HOUR;
    expect(reading({ flags: true, usedPercent: 20, resetsAt: now + 2 * HOUR }).ok).toBe(true);
    expect(seatOf("seat-a")?.state).toBe("out");
  });

  it("a leased allowed-true reading ends a derived mark (the flag path of clearsMark, AT-34)", () => {
    const marked = now - HOUR;
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: now - MIN, by: "worker-one", at: marked }).ok).toBe(true);
    expect(seatOf("seat-a")?.state).toBe("out");
    now += MIN;                                   // the out mark past its back time wants a confirming read
    expect(reading({ leaseId: leaseFor("seat-a"), flags: true, usedPercent: 20, resetsAt: now + 2 * HOUR }).ok).toBe(true);
    expect(seatOf("seat-a")).toBeNull();
    expect(noticeTexts().some(t => t.includes("back in use"))).toBe(true);
  });
});
