import { describe, expect, it } from "vitest";
import { catalogTokenCost, costFromOutput } from "../src/adapters/spend.ts";

const glm = [
  { at: "2026-10-10", model: "glm-5.3", input: 1.4, output: 4.4 },
  { at: "2026-10-10", model: "glm-5.3-flash", input: 0.15, output: 0.5 },
];

describe("spend", () => {
  it("reads the last total_cost_usd", () => {
    expect(costFromOutput('{"total_cost_usd": 0.25}\n{"total_cost_usd": 1.5}')).toBe(1.5);
    expect(costFromOutput("no cost")).toBeNull();
  });

  it("prices a third-party result from catalog tokens and ignores total_cost_usd", () => {
    const stdout = `${JSON.stringify({
      type: "result",
      total_cost_usd: 99,
      modelUsage: {
        "glm-5.3": { inputTokens: 1_000_000, outputTokens: 500_000 },
        "glm-5.3-flash": { inputTokens: 2_000_000, outputTokens: 0 },
      },
    })}\n`;
    expect(catalogTokenCost(stdout, glm, "glm-5.3")).toBe(3.9);
    expect(catalogTokenCost(stdout, [], "glm-5.3")).toBeNull();
    expect(catalogTokenCost('{"type":"result","total_cost_usd":99}', glm, "glm-5.3")).toBeNull();
  });
});
