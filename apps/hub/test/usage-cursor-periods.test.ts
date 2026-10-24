// The Cursor period fixtures (AT-37, plan 4.1 items 3 and 5): the hub never drives the Cursor CLI — a collector
// outside the repository posts named windows as readings with source "cli-screen" — so which period a Cursor plan
// is on is the hub's own call, from the length a reading carries, the gap between two observed resets, or the
// reset horizon: never the caption the poster printed. These tests post readings the way usage-codex.test.ts does
// and pin the TITLE Home would show (the view row's `title`). Round 2: the hub maps the account's newest plan name
// to a family (plan 4.1 item 3) and hands it to the domain's cadenceOf, so a weekly-family window with no length
// and a reset within 8 days is titled from that horizon ("about weekly", AT-4: a horizon always says "about"), and
// a name on both periods stays "plan period" until two observed resets title it by their gap.
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
// The plan family comes from the plan watch's confirmed baseline, which only leased readings feed (slice 6 re-check,
// slice 7 review): every reading here is leased, unless a case says it is a stranger's.
const leaseFor = (account: string): string => {
  hub.usage.look();
  const g = hub.usage.leases.grant(account, "cli-screen", "mac", "t");
  if (g.status !== "granted") throw new Error(`the hub did not grant a lease (${g.status})`);
  return g.id;
};
const reading = (windows: { id: string; used_percent: number; resets_at: number; length_mins: number | null; note: string | null }[], o: { plan?: string | null; account?: string; unleased?: boolean } = {}) =>
  hub.usage.reading({
    source: "cli-screen", node: "mac", captured_at: Math.floor(now / SEC),
    ...(o.plan !== undefined ? { plan: o.plan } : {}),
    windows: windows.map(w => ({ ...w, rolling: false })),
    ...(o.unleased === true ? {} : { lease_id: leaseFor(o.account ?? "seat-a") }),
  }, o.account ?? "seat-a", { kind: "worker", name: "usage-cursor", token: "t" });

// The row Home would show for the one window every fixture names.
const titleOf = (account = "seat-a"): string | null =>
  hub.usage.view().accounts.find(a => a.account === account)?.limits?.find(w => w.label === "Cursor models")?.title ?? null;
const noteOf = (account = "seat-a"): string | null =>
  hub.usage.view().accounts.find(a => a.account === account)?.limits?.find(w => w.label === "Cursor models")?.note ?? null;

describe("the Cursor period fixtures (AT-37, plan 4.1)", () => {
  it("(a) a weekly pool shared with another product: a reset within 8 days is weekly, and the note is kept and shown", () => {
    const resetsAt = Math.floor((now + 6 * DAY + 20 * HOUR) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 72, resets_at: resetsAt, length_mins: null, note: "shared with Grok" }], { plan: "Super" }).ok).toBe(true);
    // The plan's own family ("Super") titles the horizon: exactly what windowTitle gives { basis: "horizon",
    // lengthMins: 10080 } — "about weekly", the "about" a horizon always carries (AT-4).
    expect(titleOf()).toBe("about weekly");
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
    expect(reading([{ id: "Cursor models", used_percent: 55, resets_at: r1, length_mins: null, note: null }], { plan: "Ultra" }).ok).toBe(true);
    // "Ultra" is a name on both periods: the family is "either", so the horizon names no length — exactly what
    // windowTitle gives { basis: "horizon", lengthMins: null }: "plan period".
    expect(titleOf()).toBe("plan period");
  });

  it("(c, gap) once two resets are observed, the gap between them titles the window: 7 days weekly, 30 days monthly", () => {
    const r1 = Math.floor((now + 6 * DAY) / SEC);
    expect(reading([{ id: "Cursor models", used_percent: 55, resets_at: r1, length_mins: null, note: null }], { plan: "Ultra", account: "seat-a" }).ok).toBe(true);
    expect(reading([{ id: "Cursor models", used_percent: 40, resets_at: r1, length_mins: null, note: null }], { plan: "Ultra", account: "seat-b" }).ok).toBe(true);
    now = (r1 + MIN) * SEC;                                               // both first cycles have ended
    expect(reading([{ id: "Cursor models", used_percent: 61, resets_at: r1 + 7 * 24 * 3600, length_mins: null, note: null }], { plan: "Ultra", account: "seat-a" }).ok).toBe(true);
    expect(reading([{ id: "Cursor models", used_percent: 44, resets_at: r1 + 30 * 24 * 3600, length_mins: null, note: null }], { plan: "Ultra", account: "seat-b" }).ok).toBe(true);
    expect(titleOf("seat-a")).toBe("weekly");
    expect(titleOf("seat-b")).toBe("monthly");
  });
});

// The slice 7 review (md-rev6, 2026-10-24 10:31): the family titles windows from the plan watch's CONFIRMED plan, which
// waits for a second agreeing reading (AT-28), never from the newest single reading.
describe("the plan family follows the confirmed plan, not the newest reading", () => {
  const win = (usedPercent: number, afterDays = 6) => [{ id: "Cursor models", used_percent: usedPercent, resets_at: Math.floor((now + afterDays * DAY) / SEC), length_mins: null, note: null }];
  const next = () => { now += 16 * MIN; };                  // past the lease cache and the look's staleness

  it("a plan change mid-window changes the title only once a second reading agrees", () => {
    expect(reading(win(50), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(51), { plan: "Super" }).ok).toBe(true);
    expect(titleOf()).toBe("about weekly");
    next(); expect(reading(win(52), { plan: "Ultra" }).ok).toBe(true);        // one reading of another plan: held, says nothing
    expect(titleOf()).toBe("about weekly");
    next(); expect(reading(win(53), { plan: "Ultra" }).ok).toBe(true);        // a second one agrees: the plan changed
    expect(titleOf()).toBe("plan period");
  });

  it("one odd reading, then the old plan again, never flips the title", () => {
    expect(reading(win(50), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(51), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(52), { plan: "Ultra" }).ok).toBe(true);
    expect(titleOf()).toBe("about weekly");
    next(); expect(reading(win(53), { plan: "Super" }).ok).toBe(true);
    expect(titleOf()).toBe("about weekly");
  });

  it("a stranger's unleased reading with another plan changes no title", () => {
    expect(reading(win(50), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(51), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(52), { plan: "Ultra", unleased: true }).ok).toBe(true);
    next(); expect(reading(win(53), { plan: "Ultra", unleased: true }).ok).toBe(true);
    expect(titleOf()).toBe("about weekly");
  });

  it("a leased reading that names no plan keeps the confirmed plan, so the family does not fall away", () => {
    expect(reading(win(50), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(51), { plan: "Super" }).ok).toBe(true);
    next(); expect(reading(win(52), { plan: null }).ok).toBe(true);          // the screen named no plan this time
    expect(titleOf()).toBe("about weekly");
    next(); expect(reading(win(53)).ok).toBe(true);                          // nor does one that omits the field
    expect(titleOf()).toBe("about weekly");
  });
});

