import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCatalog } from "../src/adapters/catalog-file.ts";
import { codexConfig, codexVendorToml } from "../src/adapters/runtime-codex.ts";
import { codexModelArg, codexTokenCost } from "../src/adapters/spend.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");

describe("mistral vendor", () => {
  it("ships a codex preset on Mistral's Responses endpoint with GLM 5.3", () => {
    const file = new FileCatalog(catalog);
    const preset = file.presets().find(item => item.id === "mistral");
    expect(preset).toBeDefined();
    if (!preset) return;
    expect(preset.kinds).toEqual(["api-key"]);
    expect(preset.runtimes).toEqual([{ runtime: "codex", dialect: "openai-responses", baseUrl: "https://api.mistral.ai/v1" }]);
    expect(preset.models).toEqual({ source: "static", ids: ["zai-glm-5-3", "zai-glm-5-3-flash"] });
    expect(preset.defaultPicks["*"]).toBe("zai-glm-5-3@high");
    expect(preset.spend).toEqual(["token-price"]);
    expect(preset.isolation).toBe("rules");
    expect(preset.prices).toContainEqual({ at: "2026-11-07", model: "zai-glm-5-3", input: 1.4, output: 4.4, cacheRead: 0.14 });
    expect(preset.prices).toContainEqual({ at: "2026-11-07", model: "zai-glm-5-3-flash", input: 0.15, output: 0.5, cacheRead: 0.03 });
    expect(preset.terms.sources.length).toBeGreaterThan(0);
    expect(file.autoRouting("mistral")).not.toBeNull();
  });
});

describe("codex vendor lines", () => {
  it("turns hosted web search off for any endpoint but OpenAI's own", () => {
    expect(codexVendorToml("https://api.mistral.ai/v1", "")).toContain('web_search = "disabled"');
    expect(codexVendorToml("https://api.openai.com", "")).not.toContain("web_search");
    expect(codexVendorToml("https://api.openai.com/v1", "")).not.toContain("web_search");
  });

  it("sets the preset's effort unless the profile names one", () => {
    expect(codexVendorToml("https://api.mistral.ai/v1", "high")).toContain('model_reasoning_effort = "high"');
    expect(codexVendorToml("https://api.mistral.ai/v1", "")).not.toContain("model_reasoning_effort");
    const both = codexConfig('model_reasoning_effort = "max"\n', [], "", codexVendorToml("https://api.mistral.ai/v1", "high"));
    expect(both.match(/model_reasoning_effort/g)?.length).toBe(1);
    expect(both).toContain('model_reasoning_effort = "max"');
    expect(both).toContain('web_search = "disabled"');
  });

  it("leaves the three-argument config as it was", () => {
    expect(codexConfig('sandbox_mode = "workspace-write"\n', [], "")).toBe(codexConfig('sandbox_mode = "workspace-write"\n', [], "", ""));
  });
});

describe("codex spend", () => {
  const prices = [{ at: "2026-11-07", model: "zai-glm-5-3", input: 1.4, output: 4.4, cacheRead: 0.14 }];
  const turn = (input: number, cached: number, output: number) => JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 },
  });

  it("prices every completed turn from the catalog, cached input at the cache price", () => {
    const stdout = [JSON.stringify({ type: "thread.started", thread_id: "t" }), turn(1_000_000, 400_000, 100_000), turn(500_000, 500_000, 0)].join("\n");
    expect(codexTokenCost(stdout, prices, "zai-glm-5-3")).toBe(1.406);
  });

  it("is null without a completed turn or a price", () => {
    expect(codexTokenCost(JSON.stringify({ type: "turn.failed", error: { message: "x" } }), prices, "zai-glm-5-3")).toBeNull();
    expect(codexTokenCost(turn(10, 0, 10), prices, "unknown-model")).toBeNull();
  });

  it("reads the model a codex argv names", () => {
    expect(codexModelArg(["exec", "--json", "-m", "zai-glm-5-3-flash", "-c", "x", "hi"])).toBe("zai-glm-5-3-flash");
    expect(codexModelArg(["exec", "--model", "zai-glm-5-3", "hi"])).toBe("zai-glm-5-3");
    expect(codexModelArg(["exec", "--model=zai-glm-5-3", "hi"])).toBe("zai-glm-5-3");
    expect(codexModelArg(["exec", "--json", "hi"])).toBeNull();
  });
});
