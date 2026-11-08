import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexVendorToml } from "../src/adapters/runtime-codex.ts";
import { CodexSessionUsageFile, keepTotals } from "../src/adapters/codex-session-usage.ts";
import * as spend from "../src/adapters/spend.ts";
import { codexRunCost, codexUsageTotals, countOf } from "../src/adapters/spend.ts";

const prices = [{ at: "2026-11-07", model: "zai-glm-5-3", input: 1.4, output: 4.4, cacheRead: 0.14 }];
const run = (thread: string, input: number, cached: number, output: number) => [
  JSON.stringify({ type: "thread.started", thread_id: thread }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } }),
].join("\n");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("codex session totals", () => {
  it("reads the session's running totals and its thread", () => {
    expect(codexUsageTotals(run("t1", 22_936, 18_944, 52))).toEqual({ thread: "t1", input: 22_936, cached: 18_944, output: 52 });
    expect(codexUsageTotals(JSON.stringify({ type: "thread.started", thread_id: "t1" }))).toBeNull();
  });

  it("charges a resumed run only what it added to the session", () => {
    const before = { thread: "t1", input: 11_440, cached: 7_552, output: 49 };
    expect(codexRunCost(run("t1", 22_936, 18_944, 52), prices, "zai-glm-5-3", before)).toBe(0.001754);
  });

  it("charges the whole total of a new session, of one with no record, and of one whose totals went down", () => {
    expect(codexRunCost(run("t2", 1_000_000, 400_000, 100_000), prices, "zai-glm-5-3", null)).toBe(1.336);
    const other = { thread: "t9", input: 10, cached: 0, output: 1 };
    expect(codexRunCost(run("t2", 1_000_000, 400_000, 100_000), prices, "zai-glm-5-3", other)).toBe(1.336);
    const larger = { thread: "t2", input: 2_000_000, cached: 0, output: 1 };
    expect(codexRunCost(run("t2", 1_000_000, 400_000, 100_000), prices, "zai-glm-5-3", larger)).toBe(1.336);
  });

  it("is null without a completed turn or a price", () => {
    expect(codexRunCost(JSON.stringify({ type: "thread.started", thread_id: "t1" }), prices, "zai-glm-5-3", null)).toBeNull();
    expect(codexRunCost(run("t1", 10, 0, 10), prices, "unknown-model", null)).toBeNull();
  });

  it("keeps one record per thread and refuses a thread id that is not a plain id", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-usage-"));
    dirs.push(dir);
    const store = new CodexSessionUsageFile(dir);
    expect(store.read("t1")).toBeNull();
    store.write({ thread: "t1", input: 1, cached: 0, output: 2 });
    expect(store.read("t1")).toEqual({ thread: "t1", input: 1, cached: 0, output: 2 });
    expect(store.read("t2")).toBeNull();
    store.write({ thread: "../escape", input: 1, cached: 0, output: 2 });
    expect(store.read("../escape")).toBeNull();
  });
});

describe("codex vendor lines by endpoint", () => {
  it("adds nothing for OpenAI's own endpoint and both lines for any other", () => {
    expect(codexVendorToml("https://api.openai.com/v1", "high")).toBe("");
    expect(codexVendorToml("https://api.deepseek.com/", "high")).toBe('web_search = "disabled"\nmodel_reasoning_effort = "high"');
  });
});

describe("one count reader", () => {
  it("spend.ts exports countOf and the session record uses it: a count is a finite number that is not negative", () => {
    expect(countOf({ a: 3 }, "a")).toBe(3);
    expect(countOf({ a: 0 }, "a")).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) expect(countOf({ a: bad }, "a"), String(bad)).toBeNull();
    expect(countOf({}, "a")).toBeNull();
  });

  it("codexTokenCost is gone: nothing in production called it, and it summed running totals as if they were per turn", () => {
    expect("codexTokenCost" in spend).toBe(false);
  });
});

describe("keeping the session record", () => {
  const dirOf = () => { const dir = mkdtempSync(join(tmpdir(), "morndo-codex-usage-")); dirs.push(dir); return dir; };
  const totals = { thread: "t1", input: 150_000, cached: 60_000, output: 20_000 };

  it("writes through a temporary file in the same folder and leaves none behind", () => {
    const dir = dirOf();
    const store = new CodexSessionUsageFile(dir);
    store.write({ thread: "t1", input: 1, cached: 0, output: 2 });
    store.write(totals);
    expect(readdirSync(dir)).toEqual(["t1.json"]);
    expect(store.read("t1")).toEqual(totals);
  });

  it("a write that fails leaves no temporary file", () => {
    const dir = dirOf();
    mkdirSync(join(dir, "t1.json"));                                   // a folder where the record goes: the rename onto it fails
    expect(() => new CodexSessionUsageFile(dir).write(totals)).toThrow();
    expect(readdirSync(dir)).toEqual(["t1.json"]);
  });

  it("keepTotals writes the record and says nothing when it lands", () => {
    const dir = dirOf();
    const said: string[] = [];
    keepTotals(new CodexSessionUsageFile(dir), totals, line => said.push(line));
    expect(said).toEqual([]);
    expect(new CodexSessionUsageFile(dir).read("t1")).toEqual(totals);
  });

  it("keepTotals logs a record that cannot be written once, with the error code and no path, and does not throw", () => {
    const dir = dirOf();
    mkdirSync(join(dir, "t1.json"));
    writeFileSync(join(dir, "other"), "x");
    const said: string[] = [];
    expect(() => keepTotals(new CodexSessionUsageFile(dir), totals, line => said.push(line))).not.toThrow();
    expect(said.length).toBe(1);
    expect(said[0]).toMatch(/^could not keep the codex usage record \([A-Z]+\)/);
    expect(said[0]).not.toContain(dir);
  });
});
