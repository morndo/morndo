// One email can hold two subscriptions: a personal Max plan and a Team seat sign in with the same address. Two folders
// are the same account only when the email matches and their plans are not known to differ (ADR-0039 §9).
import { describe, expect, it } from "vitest";
import { addsNoCapacityLine, sharedEmails } from "../src/lib/signin/accounts.ts";

const rows = [
  { name: "a1", email: "home@example.com", plan: "max", signedIn: "ok" as const },
  { name: "a2", email: "work@example.com", plan: "max", signedIn: "ok" as const },
  { name: "a3", email: "Work@Example.com", plan: "team", signedIn: "ok" as const },
  { name: "a4", email: "work@example.com", plan: null, signedIn: "missing" as const },
];

describe("the same-email mark with plans", () => {
  it("does not mark a Max folder and a Team folder on one email as each other's", () => {
    const shared = sharedEmails(rows);
    expect(shared.get("a2")).toEqual(["a4"]);
    expect(shared.get("a3")).toEqual(["a4"]);
  });

  it("still marks a folder whose plan is unknown: it may be either", () => {
    expect(sharedEmails(rows).get("a4")).toEqual(["a2", "a3"]);
    expect(sharedEmails(rows).has("a1")).toBe(false);
  });

  it("marks two folders on one email and one plan", () => {
    const twins = [...rows, { name: "a5", email: "work@example.com", plan: "Max", signedIn: "ok" as const }];
    expect(sharedEmails(twins).get("a2")).toEqual(["a4", "a5"]);
    expect(sharedEmails(twins).get("a5")).toEqual(["a2", "a4"]);
  });
});

describe("the sheet's 'adds no capacity' line with plans", () => {
  it("says nothing when the folder signed in to the other plan on that email", () => {
    expect(addsNoCapacityLine({ email: "work@example.com", plan: "max" }, "a2", rows)).toBeNull();
    expect(addsNoCapacityLine({ email: "work@example.com", plan: "team" }, "a3", rows)).toBeNull();
  });

  it("names the signed-in folders on the same email and plan", () => {
    expect(addsNoCapacityLine({ email: "WORK@example.com", plan: "Team" }, "a9", rows)).toBe("Same email as a3: this folder adds no capacity.");
  });

  it("claims nothing when the sign-in did not say its plan", () => {
    expect(addsNoCapacityLine({ email: "work@example.com", plan: null }, "a9", rows)).toBeNull();
  });
});
