import { describe, expect, it } from "vitest";
import { briefFromPageState, decisionFromSearch } from "../src/lib/phone/brief-route.ts";

describe("the phone brief's place in history", () => {
  it("reads the sheet's id from shallow page state and ignores anything else", () => {
    expect(briefFromPageState({ brief: "d-1" })).toBe("d-1");
    expect(briefFromPageState({})).toBeNull();
    expect(briefFromPageState({ brief: "" })).toBeNull();
    expect(briefFromPageState(null)).toBeNull();
  });
  it("reads a link's decision id from the query", () => {
    expect(decisionFromSearch("?decision=d-1")).toBe("d-1");
    expect(decisionFromSearch("?view=decisions")).toBeNull();
    expect(decisionFromSearch("?decision=")).toBeNull();
  });
});
