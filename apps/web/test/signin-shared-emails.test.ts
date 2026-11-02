import { describe, expect, it } from "vitest";
import { sameEmailLine, sharedEmails } from "../src/lib/signin/accounts.ts";

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
