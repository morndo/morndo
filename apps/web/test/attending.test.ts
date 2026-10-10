// Attending (ADR-0008 phase F; N3, amendment 3): focus and input in the last 2 minutes, reported on change and renewed
// every minute while it lasts; a window merely visible, or with focus but no input, isn't attending.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTENDING_INPUT_MS, AttendingTracker } from "../src/lib/attending.ts";

let focus: boolean;
let reports: boolean[];
let t: AttendingTracker;
beforeEach(() => {
  vi.useFakeTimers();
  focus = true; reports = [];
  t = new AttendingTracker({ now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>), hasFocus: () => focus, report: v => reports.push(v) });
});
afterEach(() => { t.stop(); vi.useRealTimers(); });

describe("attending", () => {
  it("focus without input isn't attending; input with focus is, and is said once", () => {
    t.focusChanged();
    expect(reports).toEqual([false]);
    t.input(); t.input();
    expect(reports).toEqual([false, true]);
    expect(t.attending).toBe(true);
  });
  it("renewed every minute while input keeps coming; over 2 minutes after the last input", () => {
    t.input();
    vi.advanceTimersByTime(60_000);
    expect(reports).toEqual([true, true]);                         // renewed
    vi.advanceTimersByTime(ATTENDING_INPUT_MS - 60_000);
    expect(reports).toEqual([true, true, false]);                  // 2 minutes without input
    vi.advanceTimersByTime(10 * 60_000);
    expect(reports).toEqual([true, true, false]);                  // nothing more while away
  });
  it("losing focus ends it at once; input without focus isn't attending", () => {
    t.input();
    focus = false;
    t.focusChanged();
    expect(reports).toEqual([true, false]);
    t.input();
    expect(reports).toEqual([true, false]);
  });
  it("says it again after a reconnect", () => {
    t.input();
    t.resend();
    expect(reports).toEqual([true, true]);
  });
  it("steady input keeps the hub's word fresh: never more than a minute between reports (review H2)", () => {
    const at: number[] = [];
    t = new AttendingTracker({ now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>), hasFocus: () => focus, report: v => { reports.push(v); at.push(Date.now()); } });
    const start = Date.now();
    for (let i = 0; i < 10; i++) { t.input(); vi.advanceTimersByTime(30_000); }      // 5 minutes of work
    expect(reports.every(v => v)).toBe(true);
    const gaps = at.map((x, i) => (i ? x - (at[i - 1] ?? 0) : x - start));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
    expect(Date.now() - (at.at(-1) ?? 0)).toBeLessThan(ATTENDING_INPUT_MS);           // the hub still believes it
  });
});

