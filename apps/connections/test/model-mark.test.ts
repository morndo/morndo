// What a run may write into an engine mark from its own output (ADR-0037, path h): only a model id, and never one that holds a key the run knows.
import { describe, expect, it } from "vitest";
import { markableModel } from "../src/adapters/models.ts";

const KEY = "sk-ant-synthetic-model-key-0001";

describe("markableModel", () => {
  it("passes a model id as it is", () => {
    for (const id of ["sonnet-5.5", "claude-opus-5-5", "gpt-5.6-sol-high", "acme:large-2", "vendor/model_v2[1m]"]) expect(markableModel(id, [KEY])).toBe(id);
  });
  it("refuses a string that is not shaped like a model id: spaces, quotes, newlines, very long", () => {
    for (const text of ["my key is x", "a\"b", "line\nbreak", "x".repeat(200), "", " lead"]) expect(markableModel(text, [KEY]), text).toBeNull();
  });
  it("refuses a string that holds a key the run knows, even one that looks like a model id", () => {
    expect(markableModel(KEY, [KEY])).toBeNull();
    expect(markableModel(`pre-${KEY}`, [KEY])).toBeNull();
    expect(markableModel("sonnet-5.5", [""])).toBe("sonnet-5.5");
  });
});
