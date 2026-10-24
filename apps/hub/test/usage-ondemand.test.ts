// On demand (AT-45, U16; plan 4.4): a read is leased only when somebody is looking (a viewer's hello, the look route)
// and the account's own word is old, or when a derived mark's back time passed and a confirming read is due. With no
// viewer and no mark, an hour of fake time asks for nothing. And the end-to-end close of the loop: the leased
// confirming read of a new cycle clears the derived mark, and the same read without a lease does not. Round 1: the
// demand and the policy are stubbed, so the lease-asking tests are red; the no-lease half of the mark test passes
// today. Synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_MS } from "../src/application/usage-leases.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let now = 1_700_000_000_000;      // 10:00, the hub's clock for the whole file
const sec = (ms: number) => Math.floor(ms / 1000);

let hub: InProcessHub;
let worker = "";
let manager = "";
beforeEach(async () => {
  hub = await startInProcessHub({ now: () => now });
  // The fix round (2026-10-24, finding 1): the lease route is a manager's or the usage-pool scope's, so the lane's
  // own token carries the scope. A pin changed with the finding: this was a bare worker token.
  worker = hub.agents.issue("lanes", "worker", ["usage-pool"]).secret;
  manager = hub.agents.issue("manager", "manager").secret;
});
afterEach(async () => { await hub.close(); });

const laneHeaders = (): Record<string, string> => ({ authorization: `Bearer ${worker}`, "x-morndo-lane": "usage-claude" });
const ask = (account: string, node = "pc") =>
  hub.post("/api/agent/usage/lease", { account, source: "claude-usage", node }, laneHeaders());
const report = (account: string) =>
  hub.post("/api/agent/usage", { session_id: `s-${account}` }, { ...laneHeaders(), "x-morndo-account": account });
const reading = (account: string, body: Record<string, unknown>) =>
  hub.post("/api/agent/usage/readings", { source: "claude-usage", node: "pc", captured_at: sec(now), ...body }, { ...laneHeaders(), "x-morndo-account": account });
const limit = (account: string, backAtMs: number) =>
  hub.post("/api/agent/usage/limit", { kind: "usage_limit", account, back_at: sec(backAtMs), by: "lane-x" }, { authorization: `Bearer ${manager}` });
const denied = async (account: string, reason: string) => {
  const r = await ask(account);
  expect(r.status).toBe(200);
  const body = await r.json() as Record<string, unknown>;
  expect(body.status).toBe("denied");
  expect(body.reason).toBe(reason);
  return body;
};
const seat = (account: string) => hub.usage.view().accounts.find(a => a.account === account)?.seat ?? null;

describe("no read without a viewer or a mark (AT-45)", () => {
  it("an hour of fake time, no viewer and no mark: every lease ask is denied no_demand", async () => {
    const r = await report("seat-a");
    expect(r.status).toBe(200);
    for (let minute = 1; minute <= 60; minute++) {
      now += 60_000;
      await denied("seat-a", "no_demand");
    }
  });

  it("a viewer opens Home with a stale account and a silent status line: one lease is granted", async () => {
    await report("seat-a");
    now += 16 * 60_000;                            // the last word is older than 15 minutes, silent longer than 10
    hub.usage.look();
    const r = await ask("seat-a");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Record<string, unknown>).status).toBe("granted");
  });

  it("a look is not a standing order: its demand lapses after ten minutes if no lease used it", async () => {
    await report("seat-a");
    now += 16 * 60_000;
    hub.usage.look();
    now += 11 * 60_000;                            // nobody asked in ten minutes: the viewer has gone
    await denied("seat-a", "no_demand");
  });

  it("ten looks inside the cache window cause one read: after it, the next ask is fresh", async () => {
    await report("seat-a");
    now += 16 * 60_000;
    hub.usage.look();
    const g = await ask("seat-a");
    const grant = await g.json() as Record<string, unknown>;
    expect(grant.status).toBe("granted");
    const leaseId = grant.lease_id as string;
    await reading("seat-a", { lease_id: leaseId, windows: [{ id: "five_hour", used_percent: 42, resets_at: sec(now + 3 * 3_600_000), length_mins: 300 }] });
    for (let i = 0; i < 9; i++) hub.usage.look();      // nine more viewers, all inside the window
    now += 60_000;
    const again = await ask("seat-a");
    expect(((await again.json()) as Record<string, unknown>).status).toBe("fresh");       // the cache answers, no second read
    expect(CACHE_MS).toBe(240_000);
  });

  it("an account whose status line reported 5 minutes ago is not wanted", async () => {
    await report("seat-a");
    now += 5 * 60_000;
    hub.usage.look();
    await denied("seat-a", "no_demand");
  });

  it("after a derived mark's backAt a confirming lease is granted with no viewer", async () => {
    await report("seat-a");
    const r = await limit("seat-a", now + 60_000);
    expect(r.status).toBe(200);
    expect(seat("seat-a")?.state).toBe("out");
    now += 61_000;                                 // the back time passed, nobody has looked
    const asked = await hub.post("/api/agent/usage/lease", { account: "seat-a", source: "claude-usage", node: "pc" }, laneHeaders());
    expect(((await asked.json()) as Record<string, unknown>).status).toBe("granted");
  });

  it("the look route answers ok for the principal's session", async () => {
    const cookie = await hub.cookie();
    const r = await fetch(`${hub.base}/api/usage/look`, { method: "POST", headers: { origin: "https://hub.example.test", cookie: `__Host-morndo=${cookie}` } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });
});

describe("the leased confirming read ends a derived mark (U13, end to end)", () => {
  // A 5-hour window resetting 6 hours out began an hour ago — after the mark a minute old — so it is a new cycle
  // (clearsMark, AT-18: a window that began before the mark is the old cycle, whatever its numbers say). Round 2:
  // these reset 3 hours out, a window that began two hours before the mark; that is not a new cycle, and the
  // clearing test could only pass by ignoring the cycle rule.
  it("a reading without a lease does not clear it, even of a new cycle past the back time", async () => {
    await report("seat-a");
    await limit("seat-a", now + 60_000);
    now += 61_000;
    const r = await reading("seat-a", { windows: [{ id: "five_hour", used_percent: 10, resets_at: sec(now + 6 * 3_600_000), length_mins: 300 }] });
    expect(r.status).toBe(200);
    expect(seat("seat-a")?.state).toBe("out");      // the mark stands: no lease, no clear
  });

  it("the collector's lease ask is granted for the mark, and its reading with that lease clears the seat", async () => {
    await report("seat-a");
    await limit("seat-a", now + 60_000);
    now += 61_000;
    const g = await ask("seat-a");
    const grant = await g.json() as Record<string, unknown>;
    expect(grant.status).toBe("granted");
    const r = await reading("seat-a", { lease_id: grant.lease_id, windows: [{ id: "five_hour", used_percent: 10, resets_at: sec(now + 6 * 3_600_000), length_mins: 300 }] });
    expect(r.status).toBe(200);
    expect(seat("seat-a")).toBeNull();              // a new cycle, read under a lease, after the back time: back
    const notices = hub.usage.view().notices.filter(n => n.account === "seat-a" && n.kind === "back");
    expect(notices).toHaveLength(1);
  });

  // The fix round (2026-10-24, finding 1): the lease belongs to the token that took it, so another token's confirming
  // read with that lease id clears no mark. Red against the code before the fix: any token's reading ends the lease.
  it("another token's confirming read with the holder's lease does not clear the mark; the holder's own does", async () => {
    await limit("seat-x", now + 60_000);
    now += 61_000;
    const g = await ask("seat-x");
    const grant = await g.json() as Record<string, unknown>;
    expect(grant.status).toBe("granted");
    const other = hub.agents.issue("another-lane", "worker").secret;
    const windows = [{ id: "five_hour", used_percent: 10, resets_at: sec(now + 6 * 3_600_000), length_mins: 300 }];
    const theirs = await hub.post("/api/agent/usage/readings", { source: "claude-usage", node: "pc", captured_at: sec(now), lease_id: grant.lease_id, windows },
      { authorization: `Bearer ${other}`, "x-morndo-lane": "usage-claude", "x-morndo-account": "seat-x" });
    expect(theirs.status).toBe(200);
    expect(seat("seat-x")?.state).toBe("out");      // not the holder's word: the mark stands
    now += 1_000;
    const mine = await reading("seat-x", { lease_id: grant.lease_id, windows: [{ id: "five_hour", used_percent: 10, resets_at: sec(now + 6 * 3_600_000), length_mins: 300 }] });
    expect(mine.status).toBe(200);
    expect(seat("seat-x")).toBeNull();              // the holder's own reading, under its own lease: back
  });
});

// The fix round (2026-10-24, finding 2): an account the hub has never heard of is still wanted once per name, but one
// token may start at most five NEW unknown names an hour; a sixth inside the hour is denied no_demand. Red against the
// code before the fix: every unknown name is granted.
describe("unknown names: five new ones per token per hour (finding 2)", () => {
  // One unknown name the token starts and finishes: a grant, then the reading that completes it.
  const start = async (account: string): Promise<void> => {
    const g = await ask(account);
    const grant = await g.json() as Record<string, unknown>;
    expect(grant.status).toBe("granted");
    const r = await reading(account, { lease_id: grant.lease_id, windows: [{ id: "five_hour", used_percent: 42, resets_at: sec(now + 3 * 3_600_000), length_mins: 300 }] });
    expect(r.status).toBe(200);
  };

  it("six invented names in an hour from one token: five granted, the sixth denied no_demand", async () => {
    for (let i = 1; i <= 5; i++) await start(`fresh-${i}`);
    await denied("fresh-6", "no_demand");
  });

  it("after an hour the same token may start another unknown name", async () => {
    for (let i = 1; i <= 5; i++) await start(`fresh-${i}`);
    await denied("fresh-6", "no_demand");
    now += 3_601_000;                               // the budget's hour rolled over
    const later = await ask("fresh-7");
    expect(((await later.json()) as Record<string, unknown>).status).toBe("granted");
  });

  it("a known account is not spent against the token's unknown-name budget", async () => {
    for (let i = 1; i <= 5; i++) await start(`fresh-${i}`);
    await denied("fresh-6", "no_demand");           // the token's budget is spent on unknown names
    await limit("seat-a", now + 60_000);            // a known account: its seat is the hub's own word
    now += 61_000;
    const asked = await ask("seat-a");
    expect(((await asked.json()) as Record<string, unknown>).status).toBe("granted");
  });
});
