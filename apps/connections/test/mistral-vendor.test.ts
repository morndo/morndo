import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileCatalog } from "../src/adapters/catalog-file.ts";
import { codexConfig, codexVendorToml } from "../src/adapters/runtime-codex.ts";
import { codexModelArg } from "../src/adapters/spend.ts";

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

  // Codex 0.161.0 takes any non-empty effort: its ReasoningEffort has none, minimal, low, medium, high, xhigh, max, ultra, persistent
  // and Custom(String) for the rest (codex-rs/protocol/src/openai_models.rs at rust-v0.161.0), and the config reference says the levels
  // depend on the model (https://learn.chatgpt.com/docs/config-file/config-reference). Mistral's GLM 5.3 takes low, high and max
  // (probe 2026-11-07), so "max" must reach the file as it is. What must not reach it is anything that is not one plain word.
  it("writes the efforts Codex and the endpoints take as they are, lowercased and trimmed", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(codexVendorToml("https://api.mistral.ai/v1", effort), effort).toBe(`web_search = "disabled"\nmodel_reasoning_effort = "${effort}"`);
    }
    expect(codexVendorToml("https://api.mistral.ai/v1", " High\n")).toBe('web_search = "disabled"\nmodel_reasoning_effort = "high"');
  });

  it("never writes an effort that is not one plain word: no quote, newline, space, equals sign or length past 32", () => {
    const bad = ['high"\nsandbox_mode = "danger-full-access"', "high\nweb_search = \"live\"", "a b", "=high", "x".repeat(33), "hi\\gh", "-high", "high\u0000"];
    for (const effort of bad) {
      const toml = codexVendorToml("https://api.mistral.ai/v1", effort);
      expect(toml, JSON.stringify(effort)).toBe('web_search = "disabled"');
      expect(toml).not.toContain("sandbox_mode");
    }
    expect(codexVendorToml("https://api.openai.com", 'bad"')).toBe("");
  });

  it("warns once, naming the word and the effort used, when an effort is not one plain word; says nothing for a good one or none", () => {
    const said: string[] = [];
    const warn = (line: string) => { said.push(line); };
    codexVendorToml("https://api.mistral.ai/v1", "high", warn);
    codexVendorToml("https://api.mistral.ai/v1", "", warn);
    codexVendorToml("https://api.mistral.ai/v1", "  ", warn);
    codexVendorToml("https://api.openai.com", 'bad"', warn);          // OpenAI's own host gets no vendor lines at all
    expect(said).toEqual([]);
    codexVendorToml("https://api.mistral.ai/v1", "very high", warn);
    expect(said).toEqual(['codex effort "very high" is not one plain word (letters, digits, - and _, up to 32); model_reasoning_effort is not set, so the model\'s own default effort is used']);
    said.length = 0;
    codexVendorToml("https://api.mistral.ai/v1", 'high"\nsandbox_mode = "x"\u001b[31m', warn);
    expect(said.length).toBe(1);
    expect([...said[0]!].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)).toBe(false);   // the word is shown escaped, never as raw control characters
    expect(said[0]).toContain("sandbox_mode");
  });

  it("leaves the three-argument config as it was", () => {
    expect(codexConfig('sandbox_mode = "workspace-write"\n', [], "")).toBe(codexConfig('sandbox_mode = "workspace-write"\n', [], "", ""));
  });
});

describe("codex spend", () => {
  it("reads the model a codex argv names", () => {
    expect(codexModelArg(["exec", "--json", "-m", "zai-glm-5-3-flash", "-c", "x", "hi"])).toBe("zai-glm-5-3-flash");
    expect(codexModelArg(["exec", "--model", "zai-glm-5-3", "hi"])).toBe("zai-glm-5-3");
    expect(codexModelArg(["exec", "--model=zai-glm-5-3", "hi"])).toBe("zai-glm-5-3");
    expect(codexModelArg(["exec", "--json", "hi"])).toBeNull();
  });
});
