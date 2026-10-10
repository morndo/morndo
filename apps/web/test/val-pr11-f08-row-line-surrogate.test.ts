// Validation of review finding #8 (range b9328b196..d90a1443e, PR #11), the part he would see: a chat row's line and a
// lane's status line are made by plain() (phone/chat/rows.ts), which cuts the first line with line.slice(0, max - 1).
// Like the hub's preview cut, that counts UTF-16 code units, so an emoji lying across the cut is halved and the line
// ends in a lone surrogate (drawn as U+FFFD) before its "…". Synthetic data.
import { describe, expect, it } from "vitest";
import { plain } from "../src/lib/phone/chat/rows.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("finding #8: a row's line and characters outside the BMP", () => {
  it("control: a long plain line is cut to 120 characters with an ellipsis", () => {
    const out = plain("x".repeat(300));
    expect(out).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });
  it("an emoji across the cut is not halved", () => {
    const out = plain(`${"x".repeat(118)}\u{1F600} and more words after it`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });
});
