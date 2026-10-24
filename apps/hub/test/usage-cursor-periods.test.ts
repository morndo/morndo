// The Cursor period fixtures (AT-37, plan 4.1 items 3 and 5): the hub never drives the Cursor CLI — a collector
// outside the repository posts named windows as readings with source "cli-screen" — so which period a Cursor plan
// is on is the hub's own call, from the length a reading carries, the gap between two observed resets, or the
// reset horizon: never the caption the poster printed. These tests post readings the way usage-codex.test.ts does
// and pin the TITLE Home would show (the view row's `title`). Round 1 status:
//   (a) RED: a weekly pool's window (no length, reset within 8 days) must be "weekly", but the hub hands the domain
//       `family: null` (usage-service.ts), so no weekly family is ever claimed and the title falls back to
//       "resets in ..." — the plan-family mapping of plan 4.1 item 3 is not built.
//   (b) green: a reset more than 8 days out is the monthly horizon, which slice 1's cadence already titles
//       "about monthly" (AT-4: a horizon always says "about").
//   (c) RED: an Ultra plan (a name on both periods) must stay "plan period" until two resets are observed, which
//       needs the same missing family mapping; the gap part of (c) is green and pinned below it.
// Synthetic data only; the clock is the fake `now` the other hub tests use.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

let hub: InProcessHub;
let now = 1_700_000_000_000;
const SEC = 1000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

beforeEach(async () => {
  now = 1_700_000_000_000;
  hub = await startInProcessHub({ now: () => now });
});
afterEach(async () => { await hub.close(); });

// The collector's cursor pass posts one reading per look: the windows the screen named, no length when the plan's
// period is the very thing it cannot tell.
const reading = (windows: { id: string; used_percent: number; resets_at: number; length_mins: number | null; note: string | null }[], o: { plan?: string | null; account?: string } = {}) =>
  hub.usage.reading({
    source: "cli-screen", node: "mac", captured_at: Math.floor(now / SEC),
    ...(o.plan !== undefined ? { plan: o.plan } : {}),
    windows: windows.map(w => ({ ...w, rolling: false })),
  }, o.account ?? "seat-a", { kind: "worker", name: "usage-cursor", token: "t" });

// The row Home would show for the one window every fixture names.
const titleOf = (account = "seat-a"): string | null =>
  hub.usage.view().accounts.find(a => a.account === account)?.limits?.find(w => w.label === "Cursor models")?.title ?? null;
const noteOf = (account = "seat-a"): string | null =>
  hub.usage.view().accounts.find(a => a.account === account)?.limits?.find(w => w.label === "Cursor models")?.note ?? null;

describe("the Cursor period fixtures (AT-37, plan 4.1)", () => {
  it("(a) a weekly pool shared with another product: a reset within 8 days is weekly, and the note is kept and shown", () => {
    const resetsAt = Math.floor((now + 6 * DAY + 20 * HOUR) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 72, resets_at: resetsAt, length_mins: null, note: "shared with Grok" }], { plan: "cursor-pro" }).ok).toBe(true);
    // RED (round 1): the hub passes family: null to cadenceOf, so a weekly-family horizon never claims 10080 and
    // the title falls back to "resets in 6 d 20 h". Needs the plan-family mapping of plan 4.1 item 3.
    expect(titleOf()).toBe("weekly");
    expect(noteOf()).toBe("shared with Grok");
  });

  it("(b) a legacy monthly plan: a reset more than 8 days out is the monthly horizon", () => {
    const resetsAt = Math.floor((now + 27 * DAY) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 40, resets_at: resetsAt, length_mins: null, note: null }], { plan: "cursor-pro" }).ok).toBe(true);
    // Slice 1's cadence already does this; a horizon title always says "about" (AT-4), so the pinned title is
    // "about monthly", the monthly period without the observed gap to say it plainly.
    expect(titleOf()).toBe("about monthly");
  });

  it("(c) an Ultra plan stays 'plan period' until two resets have been observed", () => {
    const r1 = Math.floor((now + 6 * DAY) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 55, resets_at: r1, length_mins: null, note: null }], { plan: "ultra" }).ok).toBe(true);
    // RED (round 1): "plan period" is what cadenceOf answers for family "either" (a name on both periods) with one
    // reset seen; the hub never maps a plan name to a family (family: null), so the title is "resets in 6 d".
    expect(titleOf()).toBe("plan period");
  });

  it("(c, gap) once two resets are observed, the gap between them titles the window: 7 days weekly, 30 days monthly", () => {
    const r1 = Math.floor((now + 6 * DAY) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 55, resets_at: r1, length_mins: null, note: null }], { plan: "ultra", account: "seat-a" }).ok).toBe(true);
    expect(reading([{ id: "Cursor models", used_percent: 40, resets_at: r1, length_mins: null, note: null }], { plan: "ultra", account: "seat-b" }).ok).toBe(true);
    now = (r1 + MIN) * SEC;                                               // both first cycles have ended
    expect(reading([{ id: "Cursor models", used_percent: 61, resets_at: r1 + 7 * 24 * 3600, length_mins: null, note: null }], { plan: "ultra", account: "seat-a" }).ok).toBe(true);
    expect(reading([{ id: "Cursor models", used_percent: 44, resets_at: r1 + 30 * 24 * 3600, length_mins: null, note: null }], { plan: "ultra", account: "seat-b" }).ok).toBe(true);
    expect(titleOf("seat-a")).toBe("weekly");
    expect(titleOf("seat-b")).toBe("monthly");
  });
});
