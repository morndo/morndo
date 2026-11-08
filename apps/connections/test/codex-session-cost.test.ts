import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexVendorToml } from "../src/adapters/runtime-codex.ts";
import { CodexSessionUsageFile } from "../src/adapters/codex-session-usage.ts";
import * as spend from "../src/adapters/spend.ts";
import { codexAddedCost, codexRunCost, codexUsageTotals, countOf } from "../src/adapters/spend.ts";

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

describe("codex session totals under a lock", () => {
  const MODEL = "zai-glm-5-3";
  const S0 = { thread: "t1", input: 100_000, cached: 40_000, output: 10_000 };
  const priced = (added: { input: number; cached: number; output: number } | null) => codexAddedCost(added, prices, MODEL);
  const dirOf = () => { const dir = mkdtempSync(join(tmpdir(), "morndo-codex-usage-")); dirs.push(dir); return dir; };

  it("prices a delta the way a resumed run is priced", () => {
    const before = { thread: "t1", input: 11_440, cached: 7_552, output: 49 };
    expect(priced({ input: 22_936 - before.input, cached: 18_944 - before.cached, output: 52 - before.output })).toBe(0.001754);
    expect(priced(null)).toBeNull();
    expect(codexAddedCost({ input: 10, cached: 0, output: 1 }, prices, "unknown-model")).toBeNull();
  });

  it("two overlapping resumes each pay what they added, and the record ends at the true total", () => {
    const store = new CodexSessionUsageFile(dirOf());
    store.write(S0);
    const startA = store.read("t1");
    const startB = store.read("t1");                                   // both began from the same record
    const a = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    const b = codexUsageTotals(run("t1", 140_000, 50_000, 15_000))!;   // B's own view is below A's: it never saw A's tokens
    const costA = store.settle(a, { start: startA, resumed: true }, priced);
    const costB = store.settle(b, { start: startB, resumed: true }, priced);
    expect(costA).toBe(codexRunCost(run("t1", 150_000, 60_000, 20_000), prices, MODEL, S0));
    expect(costB).toBe(codexRunCost(run("t1", 140_000, 50_000, 15_000), prices, MODEL, S0));
    expect(store.read("t1")).toEqual({ thread: "t1", input: 190_000, cached: 70_000, output: 25_000 });
  });

  it("a resume with no record is not charged the whole session again: no price, and the record is kept for the next one", () => {
    const store = new CodexSessionUsageFile(dirOf());
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(store.settle(totals, { start: null, resumed: true }, priced)).toBeNull();
    expect(store.read("t1")).toEqual(totals);
    const next = codexUsageTotals(run("t1", 160_000, 64_000, 22_000))!;
    expect(store.settle(next, { start: store.read("t1"), resumed: true }, priced)).toBe(priced({ input: 10_000, cached: 4_000, output: 2_000 }));
  });

  it("a resume with no start reading takes the record found under the lock as its start (--last names no thread beforehand)", () => {
    const store = new CodexSessionUsageFile(dirOf());
    store.write(S0);
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(store.settle(totals, { start: null, resumed: true }, priced)).toBe(priced({ input: 50_000, cached: 20_000, output: 10_000 }));
    expect(store.read("t1")).toEqual(totals);
  });

  it("a new session is charged whole, and so is one whose totals went down (a reset), which becomes the record", () => {
    const store = new CodexSessionUsageFile(dirOf());
    const first = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(store.settle(first, { start: null, resumed: false }, priced)).toBe(priced({ input: 150_000, cached: 60_000, output: 20_000 }));
    expect(store.read("t1")).toEqual(first);
    const reset = codexUsageTotals(run("t1", 30_000, 10_000, 5_000))!;
    expect(store.settle(reset, { start: first, resumed: true }, priced)).toBe(priced({ input: 30_000, cached: 10_000, output: 5_000 }));
    expect(store.read("t1")).toEqual(reset);
  });

  it("another thread's record is not this thread's start", () => {
    const store = new CodexSessionUsageFile(dirOf());
    store.write({ thread: "t9", input: 10, cached: 0, output: 1 });
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(store.settle(totals, { start: store.read("t9"), resumed: true }, priced)).toBeNull();
  });

  it("waits for a lock someone holds and gives up with an error, leaving their lock and the record alone", () => {
    const dir = dirOf();
    const store = new CodexSessionUsageFile(dir, { lockWaitMs: 150 });
    store.write(S0);
    writeFileSync(join(dir, "t1.lock"), "held\n");
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(() => store.settle(totals, { start: S0, resumed: true }, priced)).toThrow(/locked/);
    expect(existsSync(join(dir, "t1.lock"))).toBe(true);
    expect(store.read("t1")).toEqual(S0);
  });

  it("takes over a lock nobody has touched for minutes, and leaves no lock or temporary file behind", () => {
    const dir = dirOf();
    const store = new CodexSessionUsageFile(dir, { lockWaitMs: 150 });
    store.write(S0);
    writeFileSync(join(dir, "t1.lock"), "left by a run that died\n");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, "t1.lock"), old, old);
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(store.settle(totals, { start: S0, resumed: true }, priced)).toBe(priced({ input: 50_000, cached: 20_000, output: 10_000 }));
    expect(readdirSync(dir)).toEqual(["t1.json"]);
  });

  it("a thread id that is not a plain id gets a price (whole when new, none when resumed) and no file, no lock", () => {
    const dir = dirOf();
    const store = new CodexSessionUsageFile(dir);
    const odd = { thread: "../escape", input: 10, cached: 0, output: 1 };
    expect(store.settle(odd, { start: null, resumed: false }, priced)).toBe(priced({ input: 10, cached: 0, output: 1 }));
    expect(store.settle(odd, { start: null, resumed: true }, priced)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a price function that throws leaves the record as it was and the lock released", () => {
    const dir = dirOf();
    const store = new CodexSessionUsageFile(dir);
    store.write(S0);
    const totals = codexUsageTotals(run("t1", 150_000, 60_000, 20_000))!;
    expect(() => store.settle(totals, { start: S0, resumed: true }, () => { throw new Error("boom"); })).toThrow("boom");
    expect(readdirSync(dir)).toEqual(["t1.json"]);
    expect(store.read("t1")).toEqual(S0);
  });
});
