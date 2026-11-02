import { describe, expect, it } from "vitest";
import { addsNoCapacityLine, sameEmailLine, sharedEmails } from "../src/lib/signin/accounts.ts";

describe("sharedEmails", () => {
  it("marks folders that share an email, case-insensitively", () => {
    const rows = [
      { name: "a1", email: "Person@example.com" },
      { name: "a2", email: "person@example.com" },
      { name: "a3", email: "other@example.com" },
      { name: "solo", email: null },
    ];
    expect(sharedEmails(rows).get("a1")).toEqual(["a2"]);
    expect(sharedEmails(rows).get("a2")).toEqual(["a1"]);
    expect(sharedEmails(rows).has("a3")).toBe(false);
    expect(sharedEmails(rows).has("solo")).toBe(false);
  });

  it("formats the line the UI shows", () => {
    expect(sameEmailLine(["a2", "a9"])).toBe("Same email as a2, a9");
  });
});

describe("addsNoCapacityLine", () => {
  const rows = [
    { name: "a1", email: "person@example.com" },
    { name: "a2", email: "other@example.com" },
    { name: "a3", email: "Person@Example.com" },
  ];

  it("names every other folder already on the email the sign-in just used", () => {
    expect(addsNoCapacityLine("PERSON@example.com", "a2", rows)).toBe("Same email as a1, a3: this folder adds no capacity.");
  });

  it("does not count the folder that was just signed in", () => {
    expect(addsNoCapacityLine("other@example.com", "a2", rows)).toBeNull();
    expect(addsNoCapacityLine("person@example.com", "a1", rows)).toBe("Same email as a3: this folder adds no capacity.");
  });

  it("says nothing for a new email", () => {
    expect(addsNoCapacityLine("new@example.com", "a9", rows)).toBeNull();
  });
});
