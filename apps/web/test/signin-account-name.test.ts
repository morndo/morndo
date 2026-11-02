// Adding an account (ADR-0039): "main" is the CLI's own default login, never a new account; the field says so.
import { describe, expect, it } from "vitest";
import { badAccountName } from "../src/lib/signin/words.ts";

describe("the new account name", () => {
  it("takes a pool-style name and refuses main", () => {
    expect(badAccountName("a8")).toBe(null);
    expect(badAccountName("main")).toMatch(/main/);
    expect(badAccountName("A8")).not.toBe(null);
  });
});
