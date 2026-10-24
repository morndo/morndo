// The plain words of a usage notice (plan 4.4): every word comes from these functions and the account's own name.
// Nothing an agent token wrote is ever in one, and the fix words are the closed list's, never free text.
import { describe, expect, it } from "vitest";
import { NOTICE_KEEP, backNoticeText, fixWords, forgottenNoticeText, planNoticeText, seatExpiredNoticeText, seatNoticeText, thresholdNoticeText, type SeatRecord } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00
const HOUR = 3_600_000;

const seat = (o: Partial<SeatRecord> = {}): SeatRecord =>
  ({ state: "out", why: "usage_limit", since: T, markedAt: T, backAt: T + HOUR, cycleReset: T + 3 * HOUR, windowId: "five_hour", owner: "derived", by: "seat-a", ...o });

describe("the words of a usage notice (plan 4.4)", () => {
  it("a plan change is said in plain words, each kind its own", () => {
    expect(planNoticeText("seat-a", { kind: "name", window: null, from: "Max 5x", to: "Max 20x" })).toBe('seat-a: plan changed from "Max 5x" to "Max 20x".');
    expect(planNoticeText("seat-a", { kind: "account", window: null, from: "ada@example.test", to: "ben@example.test" })).toBe("seat-a: the account behind it changed. Readings start fresh.");
    expect(planNoticeText("seat-a", { kind: "cadence", window: "five_hour", from: "300", to: "10080" })).toBe("seat-a: the five_hour window changed from 300 to 10080 minutes.");
    expect(planNoticeText("seat-a", { kind: "windows", window: null, from: "a,b", to: "a,c" })).toBe("seat-a: the set of windows changed from a,b to a,c.");
    expect(planNoticeText("seat-a", { kind: "drop", window: "five_hour", from: "80", to: "40" })).toBe("seat-a: the five_hour window fell from 80% to 40% with its reset unchanged.");
  });

  it("a seat is said with its fix, and an unknown back time is said as one", () => {
    expect(seatNoticeText("seat-a", seat())).toBe(`seat-a: usage limit reached. Back at ${new Date(T + HOUR).toISOString()}. Fix: wait for the reset.`);
    expect(seatNoticeText("seat-a", seat({ backAt: null }))).toBe("seat-a: usage limit reached. Back at an unknown time. Fix: wait for the reset.");
    expect(seatNoticeText("seat-a", seat({ state: "retired", why: "refused", backAt: null }))).toBe("seat-a: sign-in was refused. Fix: use another account.");
    expect(seatNoticeText("seat-a", seat({ state: "retired", why: "plan_ended", backAt: null }))).toBe("seat-a: the plan has ended. Fix: reactivate the seat.");
    expect(seatNoticeText("seat-a", seat({ state: "retired", why: "billing", backAt: null }))).toBe("seat-a: billing problem. Fix: ask the org admin.");
    expect(seatNoticeText("seat-a", seat({ state: "logged-out", why: "signed_out", backAt: null }))).toBe("seat-a: signed out. Fix: sign in again.");
  });

  it("a return, a threshold and a forgotten source are said in plain words too", () => {
    expect(backNoticeText("seat-a", "a fresh reading")).toBe("seat-a: back in use (a fresh reading shows a new cycle).");
    expect(thresholdNoticeText("seat-a", "5-hour", "warning")).toBe("seat-a: the 5-hour window passed 75%.");
    expect(thresholdNoticeText("seat-a", "weekly", "critical")).toBe("seat-a: the weekly window passed 90%.");
    expect(forgottenNoticeText("seat-a", "cli-screen")).toBe("seat-a: no reading for 14 days from cli-screen, so it is forgotten.");
    expect(forgottenNoticeText("seat-a", null)).toBe("seat-a: no reading for 14 days, so it is forgotten.");
  });

  it("an expired limit mark is said in plain words (PR #127, finding 3b)", () => {
    expect(seatExpiredNoticeText("seat-a")).toBe("seat-a: its limit mark expired, the back time passed with no newer hit.");
  });

  it("the fix words are the closed list's, all seven of them", () => {
    expect(fixWords("sign_in_again")).toBe("sign in again");
    expect(fixWords("use_another_account")).toBe("use another account");
    expect(fixWords("wait_for_reset")).toBe("wait for the reset");
    expect(fixWords("ask_the_org_admin")).toBe("ask the org admin");
    expect(fixWords("reactivate_the_seat")).toBe("reactivate the seat");
    expect(fixWords("check_the_source")).toBe("check the source");
    expect(fixWords("sign_in_fully_here")).toBe("sign in fully on this machine");
    expect(NOTICE_KEEP).toBe(50);
  });
});
