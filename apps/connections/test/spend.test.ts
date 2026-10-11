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
    expect(catalogTokenCost('{"type":"result","total_cost_usd":99}', glm, "glm-5.3")).toBeNull();
  });

  it("uses the reported cost when the catalog has no price for the model", () => {
    const priced = JSON.stringify({
      type: "result",
      total_cost_usd: 99,
      modelUsage: { "glm-5.3": { inputTokens: 1_000_000, outputTokens: 0 } },
    });
    const unpriced = JSON.stringify({
      type: "result",
      total_cost_usd: 0.1,
      modelUsage: { "deepseek-v4-pro": { inputTokens: 50_000, outputTokens: 1_000 } },
    });
    expect(catalogTokenCost(priced, glm, "glm-5.3")).toBe(1.4);
    expect(catalogTokenCost(unpriced, [], "deepseek-v4-pro")).toBe(0.1);
    expect(catalogTokenCost(unpriced, glm, "kimi-k3")).toBe(0.1);
    expect(catalogTokenCost(JSON.stringify({ type: "result", modelUsage: { "kimi-k3": { inputTokens: 1, outputTokens: 1 } } }), [], "kimi-k3")).toBeNull();
  });

  it("bills cache reads at the catalog price and cache creation as input", () => {
    const prices = [{ at: "2026-10-11", model: "glm-5.3", input: 1.4, output: 4.4, cacheRead: 0.26 }];
    const cached = JSON.stringify({
      type: "result",
      total_cost_usd: 99,
      modelUsage: {
        "glm-5.3": { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
      },
    });
    expect(catalogTokenCost(cached, prices, "glm-5.3")).toBe(3.06);
    const fromUsage = JSON.stringify({
      type: "result",
      total_cost_usd: 99,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 500_000 },
    });
    expect(catalogTokenCost(fromUsage, prices, "glm-5.3")).toBe(0.96);
    const noCachePrice = [{ at: "2026-10-11", model: "glm-5.3", input: 1.4, output: 4.4 }];
    const readOnly = JSON.stringify({
      type: "result",
      modelUsage: { "glm-5.3": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 0 } },
    });
    expect(catalogTokenCost(readOnly, noCachePrice, "glm-5.3")).toBe(1.4);
  });
});
