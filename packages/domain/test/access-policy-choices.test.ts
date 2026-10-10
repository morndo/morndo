// AC5, AC7, AC8: a policy is one of the listed choices, never a key every object inherits ("constructor", "toString").
// Such a key once passed isPolicy: loosening it skipped the step-up, and sessions under it never expired.
import { describe, expect, it } from "vitest";
import { STAY_CHOICES, STEP_UP_CHOICES, isPolicy } from "../src/index.ts";

const inherited = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"];

describe("isPolicy accepts only the listed choices", () => {
  it("accepts every listed stay and step-up choice (positive control)", () => {
    for (const stay of Object.keys(STAY_CHOICES)) for (const stepUp of Object.keys(STEP_UP_CHOICES)) {
      expect(isPolicy({ stay, stepUp }), `${stay}/${stepUp}`).toBe(true);
    }
  });
  it("refuses a stay that is an inherited object key", () => {
    for (const stay of inherited) expect(isPolicy({ stay, stepUp: "1h" }), stay).toBe(false);
  });
  it("refuses a step-up that is an inherited object key", () => {
    for (const stepUp of inherited) expect(isPolicy({ stay: "7d", stepUp }), stepUp).toBe(false);
  });
});
