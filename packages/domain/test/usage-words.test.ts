// The closed word lists of the usage view (plan 4.4, S4): every reason, every health state and every fix has exactly
// one non-empty plain word, so nothing a source or an agent token wrote ever reaches the principal as wording.
import { describe, expect, it } from "vitest";
import { FIX_WORDS, NOTICE_KINDS } from "../src/index.ts";
import { REASON_WORDS, STATE_WORDS } from "../src/index.ts";
import { USAGE_FIXES, USAGE_REASONS } from "../src/usage-reading.ts";
import type { HealthState } from "../src/usage-health.ts";

describe("the words of the usage view (S4)", () => {
  it("every reason has one non-empty word, and no word is there twice", () => {
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...USAGE_REASONS].sort());
    for (const r of USAGE_REASONS) expect(typeof REASON_WORDS[r], r).toBe("string");
    for (const w of Object.values(REASON_WORDS)) expect(w.length, w).toBeGreaterThan(0);
    expect(new Set(Object.values(REASON_WORDS)).size).toBe(Object.values(REASON_WORDS).length);
  });
  it("every health state has one non-empty word", () => {
    const states = ["available", "stale", "unavailable", "missing"] as const satisfies readonly HealthState[];
    expect(Object.keys(STATE_WORDS).sort()).toEqual([...states].sort());
    for (const s of states) expect(STATE_WORDS[s].length, s).toBeGreaterThan(0);
  });
  it("every fix has one non-empty word (fixWords, the one Fix wording)", () => {
    expect(Object.keys(FIX_WORDS).sort()).toEqual([...USAGE_FIXES].sort());
    for (const f of USAGE_FIXES) expect(FIX_WORDS[f].length, f).toBeGreaterThan(0);
  });
  it("a notice kind list exists for the wire (the protocol's enum keeps step with it)", () => {
    expect(NOTICE_KINDS).toEqual(["plan", "seat", "back", "threshold", "forgotten"]);
  });
});
