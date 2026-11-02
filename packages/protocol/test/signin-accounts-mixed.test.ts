// A node still on an agent from before account emails (ADR-0039 §9) answers signin.accounts without `email`. The fleet
// checks every node's answer against OP_RESULTS, so that answer must still pass, with no email, while nodes update one
// by one.
import { describe, expect, it } from "vitest";
import { OP_RESULTS } from "../src/fleet.ts";
import { AccountsViewSchema } from "../src/signin.ts";

const olderRow = { name: "a1", signedIn: "ok", retired: false, plan: "max" };

describe("account rows from a node that predates emails", () => {
  it("passes the fleet's check of the node's answer, with no email", () => {
    expect(OP_RESULTS["signin.accounts"].parse({ accounts: [olderRow] })).toEqual({ accounts: [{ ...olderRow, email: null }] });
  });

  it("passes the hub's view to the app the same way", () => {
    expect(AccountsViewSchema.parse({ node: "n1", runtime: "claude", accounts: [olderRow] }).accounts[0]?.email).toBeNull();
  });

  it("still takes an email, and still refuses one of the wrong shape", () => {
    expect(OP_RESULTS["signin.accounts"].parse({ accounts: [{ ...olderRow, email: "person@example.com" }] }).accounts[0]?.email)
      .toBe("person@example.com");
    expect(() => OP_RESULTS["signin.accounts"].parse({ accounts: [{ ...olderRow, email: 7 }] })).toThrow();
  });
});
