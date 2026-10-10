import { describe, expect, it } from "vitest";
import { freshRef } from "../src/cli.ts";

describe("fresh ref", () => {
  it("never equals the current ref", () => {
    const now = 1_700_000_000_000;
    const first = freshRef("credit", now, "", () => Buffer.from("aaaaaaaa", "hex"));
    let n = 0;
    const second = freshRef("credit", now, first, () => Buffer.from(n++ === 0 ? "aaaaaaaa" : "bbbbbbbb", "hex"));
    expect(second).not.toBe(first);
    expect(second.endsWith("bbbbbbbb")).toBe(true);
    expect(first.length).toBeLessThanOrEqual(80);
    const long = freshRef("n".repeat(80), now);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.startsWith("key-")).toBe(true);
  });
});
