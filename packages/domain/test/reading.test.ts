// Read marks (ADR-0008 phase D; O7, O8): per Conversation, they only move forward, a mark from a fast clock is clamped
// to the hub's, and they grant and start nothing (no Mandate, Decision or Acknowledgement is made from one).
import { describe, expect, it } from "vitest";
import { advanceReadMark } from "../src/index.ts";

const NOW = 1_000_000;
describe("advanceReadMark (O7)", () => {
  it("the first mark is taken as it is", () => {
    expect(advanceReadMark(null, 500, NOW)).toBe(500);
  });
  it("only forward: a mark at or before the stored one changes nothing", () => {
    expect(advanceReadMark(500, 400, NOW)).toBeNull();
    expect(advanceReadMark(500, 500, NOW)).toBeNull();
    expect(advanceReadMark(500, 501, NOW)).toBe(501);
  });
  it("a mark later than the hub's clock is clamped to it", () => {
    expect(advanceReadMark(500, NOW + 60_000, NOW)).toBe(NOW);
    expect(advanceReadMark(NOW, NOW + 5, NOW)).toBeNull();               // clamped to what is already stored
  });
  it("refuses what isn't a time", () => {
    expect(advanceReadMark(500, Number.NaN, NOW)).toBeNull();
    expect(advanceReadMark(null, -1, NOW)).toBeNull();
  });
});
