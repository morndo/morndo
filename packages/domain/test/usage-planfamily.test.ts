// Which period a plan's own name says (plan 4.1 item 3, S7): the weekly words, the both-periods word, and everything
// else saying nothing — so the hub can title a window with no length of its own from the reset horizon only when the
// plan's name really says the period.
import { describe, expect, it } from "vitest";
import { planFamilyOf } from "../src/index.ts";

describe("the family of a plan name (plan 4.1 item 3)", () => {
  it("each weekly word names the weekly family, whatever else the name says", () => {
    for (const name of ["free", "plus", "premium", "super", "Free Trial", "Super Plan", "Plus (annual)", "the premium seat"])
      expect(planFamilyOf(name), name).toBe("weekly");
  });

  it("ultra is a name on both periods, and wins over a weekly word beside it", () => {
    expect(planFamilyOf("Ultra")).toBe("either");
    expect(planFamilyOf("ultra")).toBe("either");
    expect(planFamilyOf("Pro Ultra")).toBe("either");
    expect(planFamilyOf("Super Ultra")).toBe("either");
  });

  it("any other name, an empty one, and no name at all, say nothing", () => {
    for (const name of ["Pro", "team", "max 20x", ""]) expect(planFamilyOf(name), JSON.stringify(name)).toBe(null);
    expect(planFamilyOf(null)).toBe(null);
  });
});
