// A Read mark and a node's clock (V15): the ceiling is the later of the hub's clock and the newest message the hub holds
// for that Conversation, so a node whose clock runs ahead can't leave its newest message unread by reading it.
import { describe, expect, it } from "vitest";
import { advanceReadMark } from "../src/index.ts";

const NOW = 1_000_000;
describe("advanceReadMark with the newest message (O7)", () => {
  it("a mark at the newest message is kept even when that message's time is ahead of the hub's clock", () => {
    expect(advanceReadMark(null, NOW + 10_000, NOW, NOW + 10_000)).toBe(NOW + 10_000);
  });
  it("a fast device clock is still clamped: past the newest message and past the hub's clock", () => {
    expect(advanceReadMark(500, NOW + 60_000, NOW, NOW + 10_000)).toBe(NOW + 10_000);
    expect(advanceReadMark(500, NOW + 60_000, NOW, null)).toBe(NOW);
    expect(advanceReadMark(500, NOW + 60_000, NOW, NOW - 5)).toBe(NOW);
  });
});
