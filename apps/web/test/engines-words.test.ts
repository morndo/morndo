// The Engines page's words (ADR-0013): a provider's availability with its tone, an engine in plain words, and a
// refusal in a sentence. Synthetic providers only.
import { describe, expect, it } from "vitest";
import type { EngineProvider } from "@morndo/domain";
import { availabilityWords, engineWords, problemWords, providerName } from "../src/lib/engines/words.ts";

const p = (o: Partial<EngineProvider>): EngineProvider => ({
  name: "codex", label: "OpenAI Codex CLI (ChatGPT Plus)", kind: "cli", models: ["gpt-6-astra"], efforts: ["high"], availability: "ready", until: null, pausedModels: [], ...o,
});

describe("the Engines page's words", () => {
  it("a provider's name drops the CLI label's notes", () => {
    expect(providerName(p({}))).toBe("OpenAI Codex CLI");
    expect(providerName(p({ label: "", name: "agy" }))).toBe("agy");
  });
  it("availability: a word and a tone per state; out of quota says until when, except in the short form", () => {
    expect(availabilityWords(p({}))).toEqual({ word: "Ready", tone: "ok" });
    expect(availabilityWords(p({ availability: "signed_out" }))).toEqual({ word: "Not signed in", tone: "bad" });
    expect(availabilityWords(p({ availability: "not_installed" })).tone).toBe("bad");
    expect(availabilityWords(p({ availability: "unconfirmed" })).tone).toBe("warn");
    expect(availabilityWords(p({ availability: "off" }))).toEqual({ word: "Off", tone: "" });
    expect(availabilityWords(p({ availability: "out_of_quota", until: "Wed 19:30" })).word).toBe("Out of quota until Wed 19:30");
    expect(availabilityWords(p({ availability: "out_of_quota", until: "Wed 19:30" }), true).word).toBe("Out of quota");
  });
  it("an engine reads as provider · model · effort, and an unknown provider keeps its id", () => {
    expect(engineWords("codex:gpt-6-astra@high", [p({})])).toBe("OpenAI Codex CLI · gpt-6-astra · high");
    expect(engineWords("studio:chatgpt", [])).toBe("studio · chatgpt");
    expect(engineWords(null, [])).toBe("");
  });
  it("every refusal has a sentence; one it doesn't know still says it wasn't saved", () => {
    expect(problemWords("duplicate")).toBe("That engine is already in this role's list.");
    expect(problemWords("something_new")).toBe("Not saved (something_new).");
  });
});
