// Source health on the hub (plan 4.3, AT-9 to AT-11, AT-23 to AT-26, AT-30): a permanent failure replaces a source's
// meters, a declared cadence makes silence meaningful, the status line is only ever stale, the principal can forget
// a dead source, two weeks of silence forgets a source once, and when two sources read one window the newer reading
// wins and a disagreement is shown. Real server on a random port, fake clock, synthetic data only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now: number;
let workerToken: string;
const HOUR = 3_600_000, MIN = 60_000, DAY = 86_400_000;
type Body = Record<string, unknown>;

// A source's reading, as the collector posts it: epoch seconds on the wire.
const reading = (o: {
  source?: string; capturedAt?: number; everyS?: number | null; plan?: string | null; windows?: unknown[]; failure?: unknown;
} = {}, account = "seat-a") => fetch(`${hub.base}/api/agent/usage/readings`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({
    source: o.source ?? "app-server", node: null, captured_at: Math.floor((o.capturedAt ?? now) / 1000),
    ...(o.everyS === undefined ? {} : { every_s: o.everyS }), ...(o.plan === undefined ? {} : { plan: o.plan }),
    ...(o.windows === undefined ? {} : { windows: o.windows }), ...(o.failure === undefined ? {} : { failure: o.failure }),
  }),
});
// A status line's JSON, as the agent CLI posts it (only the parts the hub reads).
const statusLine = (five: number, account = "seat-a") => fetch(`${hub.base}/api/agent/usage`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: five, resets_at: Math.floor((now + 2 * HOUR) / 1000) } } }),
});
// The same, with the five-hour reset the caller names (a far one, so the window stays alive across a long clock jump).
const statusLineAt = (five: number, resetsAt: number, account = "seat-a") => fetch(`${hub.base}/api/agent/usage`, {
  method: "POST",
  headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json", "x-morndo-lane": "builder", "x-morndo-account": account },
  body: JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: five, resets_at: Math.floor(resetsAt / 1000) } } }),
});
const fiveHour = (usedPercent: number, resetsAt = now + 2 * HOUR) => ({ id: "five_hour", used_percent: usedPercent, resets_at: Math.floor(resetsAt / 1000), length_mins: 300 });
const viewOf = async () => {
  const cookie = await hub.cookie();
  return (await (await fetch(`${hub.base}/api/usage`, { headers: { cookie: `__Host-morndo=${cookie}` } })).json()) as Body;
};
const accountOf = async (name = "seat-a") => ((await viewOf()).accounts as Body[]).find(a => a.account === name);
const sourcesOf = async (name = "seat-a") => ((await accountOf(name))?.sources ?? []) as Body[];
const sourceState = async (source: string, name = "seat-a") => (await sourcesOf(name)).find(s => s.source === source);

beforeEach(async () => {
  now = 1_700_000_000_000;      // 10:00
  hub = await startInProcessHub({ now: () => now });
  workerToken = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

describe("source health (plan 4.3)", () => {
  it("a posted permanent failure replaces the meters (AT-9)", async () => {
    expect((await statusLine(41.2)).status).toBe(200);
    expect((await reading({ windows: [fiveHour(30)], capturedAt: now + 2 * MIN })).status).toBe(200);
    expect((((await accountOf()) as Body).fiveHour as Body).usedPercentage).toBe(30);
    const at = now + 5 * MIN;
    expect((await reading({ failure: { reason: "unknown_screen" }, capturedAt: at })).status).toBe(200);
    // The source is unavailable since the failure, its windows are gone from what is shown, and the status line's
    // windows of the same account are still there.
    expect(await sourceState("app-server")).toMatchObject({ state: "unavailable", since: at, reason: "unknown_screen", fix: "check_the_source" });
    expect((((await accountOf()) as Body).fiveHour as Body).usedPercentage).toBe(41.2);
    expect(await sourceState("status-line")).toMatchObject({ state: "available" });
  });

  it("a source that declared every goes silent after max(4 x every, 30 min), and a new post clears it (AT-10)", async () => {
    expect((await reading({ everyS: 900, windows: [fiveHour(20)] })).status).toBe(200);
    expect(await sourceState("app-server")).toMatchObject({ state: "available" });
    now += 59 * MIN;
    expect(await sourceState("app-server")).toMatchObject({ state: "stale" });        // not yet 60 minutes
    now += 2 * MIN;
    expect(await sourceState("app-server")).toMatchObject({ state: "unavailable" });
    const r = await reading({ everyS: 900, windows: [fiveHour(21)] });              // a new post clears it
    expect(r.status).toBe(200);
    expect(await sourceState("app-server")).toMatchObject({ state: "available" });
  });

  it("the status line is stale after 10 minutes and never unavailable by silence (AT-11)", async () => {
    expect((await statusLine(41.2)).status).toBe(200);
    now += 11 * MIN;
    expect(await sourceState("status-line")).toMatchObject({ state: "stale" });
    now += 2 * DAY;
    expect(await sourceState("status-line")).toMatchObject({ state: "stale" });       // never unavailable by silence
  });

  it("the principal can forget a dead source (AT-23)", async () => {
    expect((await reading({ source: "cli-screen", plan: "Max 5x", windows: [fiveHour(20)] })).status).toBe(200);
    expect((await reading({ source: "cli-screen", failure: { reason: "unknown_screen" }, capturedAt: now + MIN })).status).toBe(200);
    const cookie = await hub.cookie();
    const forget = await fetch(`${hub.base}/api/usage/forget`, {
      method: "POST", headers: { origin: "https://hub.example.test", cookie: `__Host-morndo=${cookie}`, "content-type": "application/json" },
      body: JSON.stringify({ account: "seat-a", source: "cli-screen" }),
    });
    expect(await forget.json()).toEqual({ forgotten: true });
    expect(await sourceState("cli-screen")).toBeUndefined();
    // The same call under an agent token is refused, exactly as other principal routes refuse it.
    const agent = await fetch(`${hub.base}/api/usage/forget`, {
      method: "POST", headers: { origin: "https://hub.example.test", authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ account: "seat-a", source: "cli-screen" }),
    });
    expect(agent.status).toBe(401);
    // A later ok post is a new first reading: the plan watch starts from nothing, so no change is told.
    expect((await reading({ source: "cli-screen", plan: "Max 20x", windows: [fiveHour(21)], capturedAt: now + 2 * MIN })).status).toBe(200);
    expect((await reading({ source: "cli-screen", plan: "Max 20x", windows: [fiveHour(22)], capturedAt: now + 3 * MIN })).status).toBe(200);
    const v = await viewOf();
    expect((v.notices as Body[]).filter(n => (n.text as string).includes("plan changed"))).toEqual([]);
  });

  it("any source silent for 14 days is forgotten once (AT-24)", async () => {
    expect((await reading({ source: "app-server", everyS: 900, windows: [fiveHour(20)] })).status).toBe(200);
    expect((await statusLine(41.2)).status).toBe(200);
    now += 13 * DAY;
    hub.usage.sweep();
    expect(await sourceState("app-server")).toBeDefined();
    expect(await sourceState("status-line")).toBeDefined();
    expect(((await viewOf()).notices as Body[]).filter(n => n.kind === "forgotten")).toEqual([]);
    now += DAY + MIN;
    hub.usage.sweep();
    expect(await sourceState("app-server")).toBeUndefined();
    expect(await sourceState("status-line")).toBeUndefined();
    const forgotten = ((await viewOf()).notices as Body[]).filter(n => n.kind === "forgotten");
    expect(forgotten.filter(n => (n.text as string).includes("from app-server"))).toHaveLength(1);
    expect(forgotten.filter(n => (n.text as string).includes("from status-line"))).toHaveLength(1);
    hub.usage.sweep();
    const again = ((await viewOf()).notices as Body[]).filter(n => n.kind === "forgotten");
    expect(again.filter(n => (n.text as string).includes("from app-server"))).toHaveLength(1);
    expect(again.filter(n => (n.text as string).includes("from status-line"))).toHaveLength(1);
  });

  it("a declared every is clamped to between one minute and six hours (AT-25)", async () => {
    expect((await reading({ everyS: 1e9, windows: [fiveHour(20)] })).status).toBe(200);
    expect(hub.store.usageSources().find(r => r.account === "seat-a" && r.source === "app-server")?.body.health.everyS).toBe(21_600);
    expect((await reading({ everyS: 1, windows: [fiveHour(21)], capturedAt: now + MIN })).status).toBe(200);
    expect(hub.store.usageSources().find(r => r.account === "seat-a" && r.source === "app-server")?.body.health.everyS).toBe(60);
  });

  it("a source that declares nothing still has a stale line, at 15 minutes; the status line at 10 (AT-26)", async () => {
    const r = await reading({ windows: [fiveHour(20)] });
    expect(r.status).toBe(200);
    expect((await statusLine(41.2)).status).toBe(200);
    now += 12 * MIN;                           // the status line's own line, but not a declaring source's
    expect(await sourceState("app-server")).toMatchObject({ state: "available" });
    expect(await sourceState("status-line")).toMatchObject({ state: "stale" });
    now += 4 * MIN;
    expect(await sourceState("app-server")).toMatchObject({ state: "stale" });
  });

  it("the newer reading wins, and a disagreement is shown (AT-30)", async () => {
    const reset = now + 2 * HOUR;      // the echo below must repeat the first reading's reset, not drift with the clock
    expect((await reading({ windows: [fiveHour(40, reset)], capturedAt: now })).status).toBe(200);             // 10:00, headless 40%
    now += 3 * MIN;
    expect((await statusLine(70)).status).toBe(200);                                                          // 10:03, the status line moved
    let a = await accountOf();
    expect(((a as Body).fiveHour as Body).usedPercentage).toBe(70);
    expect(a?.disagree).toEqual([{ window: "five_hour", a: { source: "status-line", usedPercent: 70, capturedAt: now }, b: { source: "app-server", usedPercent: 40, capturedAt: now - 3 * MIN } }]);
    now += 7 * MIN;
    expect((await reading({ windows: [fiveHour(40, reset)], capturedAt: now })).status).toBe(200);             // 10:10, an echo of its own earlier reading
    a = await accountOf();
    expect(((a as Body).fiveHour as Body).usedPercentage).toBe(70);
    expect(a?.disagree).toEqual([]);
    now += 5 * MIN;
    expect((await reading({ windows: [fiveHour(45)], capturedAt: now })).status).toBe(200);                    // 10:15, newer and different
    a = await accountOf();
    expect(((a as Body).fiveHour as Body).usedPercentage).toBe(45);
    expect(a?.disagree).toEqual([]);                                                                          // 12 minutes apart: no disagreement
  });
  it("a reading with nothing readable is refused and recorded as a failure, and a stamp from the future is capped at the hub's clock plus the skew", async () => {
    expect((await reading({ windows: [] })).status).toBe(400);
    expect((await reading({ windows: [{ id: "x", used_percent: 1_700_000_000, resets_at: 1 }] })).status).toBe(400);      // an epoch value is no percentage, so nothing is readable
    // PR #125 finding 4a changed this pin: an all-unreadable reading is a failure the principal sees, not silence.
    expect(await sourceState("app-server")).toMatchObject({ state: "unavailable", reason: "unknown_screen", hint: "the reading had no readable window" });
    expect((await reading({ windows: [fiveHour(20)], capturedAt: now + DAY })).status).toBe(200);
    expect(((await sourcesOf())[0] as Body).asOf).toBe(now + 5 * MIN);
  });

  it("a last-known echo shows over a status line that spoke days ago, with no disagreement invented (PR #125 finding 1)", async () => {
    expect((await statusLineAt(20, now + 10 * DAY)).status).toBe(200);                                // three days of fake clock ago
    now += 3 * DAY;
    const reset = now + 2 * HOUR;
    expect((await reading({ windows: [fiveHour(55, reset)], capturedAt: now - 10 * MIN })).status).toBe(200);   // the source's previous read
    expect((await reading({ windows: [fiveHour(55, reset)], capturedAt: now })).status).toBe(200);              // the same numbers again: an echo
    const a = await accountOf();
    expect(((a as Body).fiveHour as Body).usedPercentage).toBe(55);
    expect(a?.disagree).toEqual([]);                                                                  // three days apart: the 15-point rule cannot apply
  });

  it("a reading older than the source's newest known stamp is ignored, good or bad (PR #125 finding 2)", async () => {
    const t = now;
    expect((await reading({ windows: [fiveHour(30)], capturedAt: t })).status).toBe(200);
    now += MIN;                                                                                        // the clock moves, the old stamp does not
    expect((await reading({ windows: [fiveHour(99)], capturedAt: t - 5 * DAY })).status).toBe(200);    // an ok five days older: ignored
    const a = await accountOf();
    expect(await sourceState("app-server")).toMatchObject({ state: "available", asOf: t });
    expect(((a as Body).fiveHour as Body).usedPercentage).toBe(30);
    expect((await reading({ failure: { reason: "unknown_screen" }, capturedAt: t - 10 * MIN })).status).toBe(200);  // an older failure: ignored too
    expect(await sourceState("app-server")).toMatchObject({ state: "available", asOf: t, reason: null });
  });

  it("a failure at T then an older ok: the source stays failing; an equal-stamp ok clears it (PR #125 finding 2)", async () => {
    const t = now;
    expect((await reading({ failure: { reason: "unknown_screen" }, capturedAt: t })).status).toBe(200);
    now += MIN;
    expect((await reading({ windows: [fiveHour(30)], capturedAt: t - 10 * MIN })).status).toBe(200);   // older than the failure: ignored
    expect(await sourceState("app-server")).toMatchObject({ state: "unavailable", since: t, reason: "unknown_screen" });
    expect((await reading({ windows: [fiveHour(30)], capturedAt: t })).status).toBe(200);              // equal stamps are accepted
    expect(await sourceState("app-server")).toMatchObject({ state: "available", asOf: t });
  });

  it("an all-unreadable reading is a failure the principal sees, and a good reading clears it (PR #125 finding 4a)", async () => {
    const at = now;
    const r = await reading({ windows: [{ id: "five_hour", used_percent: 1_700_000_000, resets_at: Math.floor((now + HOUR) / 1000) }], capturedAt: at });
    expect(r.status).toBe(400);                                                                        // still a bad reading on the wire
    expect(await sourceState("app-server")).toMatchObject({ state: "unavailable", since: at, reason: "unknown_screen", hint: "the reading had no readable window" });
    now += MIN;
    expect((await reading({ windows: [fiveHour(30)], capturedAt: now })).status).toBe(200);
    expect(await sourceState("app-server")).toMatchObject({ state: "available", hint: null });
  });

  it("the status line's health row is rewritten at most once a minute (PR #125 finding 5a)", async () => {
    const t = now;
    expect((await statusLine(20)).status).toBe(200);
    const row = () => hub.store.usageSources().find(r => r.account === "seat-a" && r.source === "status-line");
    expect(row()?.body.health.lastOkAt).toBe(t);
    now += 30_000;
    expect((await statusLine(21)).status).toBe(200);
    expect(row()?.body.health.lastOkAt).toBe(t);                                                       // inside 60 s of the stored row: the save is skipped
    now += 31_000;                                                                                     // 61 s after the first
    expect((await statusLine(22)).status).toBe(200);
    expect(row()?.body.health.lastOkAt).toBe(t + 61_000);
  });
});
