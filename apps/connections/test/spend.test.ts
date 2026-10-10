import { describe, expect, it } from "vitest";
import { costFromOutput } from "../src/adapters/spend.ts";

describe("spend", () => {
  it("reads the last total_cost_usd", () => {
    expect(costFromOutput('{"total_cost_usd": 0.25}\n{"total_cost_usd": 1.5}')).toBe(1.5);
    expect(costFromOutput("no cost")).toBeNull();
  });
});
