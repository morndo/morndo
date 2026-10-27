// Fix round 1 on PR 48 (review findings F1–F7). Names here are test data.
import { describe, expect, it } from "vitest";
import {
  decide, ownModelOf, parseFact, scorecard, type AutoSettings, type CandidateFacts, type OutcomeFact, type TaskProfile,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const settings = (): AutoSettings => ({ taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} });

function cand(over: Partial<CandidateFacts> & { entry: string }): CandidateFacts {
  return {
    connection: over.connection ?? over.entry.split(":")[0] ?? "c",
    kindOf: "subscription",
    family: "fam-a",
    modelClass: "everyday",
    inChain: true,
    rank: 0,
    available: true,
    gate: "ok",
    reservation: null,
    expectedUsd: null,
    costFrom: null,
    committedToday: 0,
    dailyCap: 10,
    window: null,
    level: "hard",
    band: "new",
    minutes: null,
    heldSince: null,
    heldWhy: null,
    ownModel: true,
    ...over,
  };
}

function profile(over: Partial<TaskProfile> = {}): TaskProfile {
  return {
    role: "implement-backend",
    group: "implement",
    risk: { value: false, source: "default" },
    kind: { value: "unknown", source: "default" },
    size: { value: "unknown", source: "default" },
    round: { value: 1, source: "default" },
    priority: { value: "normal", source: "default" },
    workspace: "ws",
    languages: [],
    task: null,
    lane: null,
    implementers: [],
    brief: null,
    ...over,
  };
}

function run(candidates: readonly CandidateFacts[], derived: readonly string[], over: Partial<TaskProfile> = {}) {
  return decide({
    role: "implement-backend",
    reviewRule: false,
    implementerFamilies: [],
    reviewFamilies: [],
    candidates,
    profile: profile(over),
    settings: settings(),
    derived,
  });
}

function fact(over: Partial<OutcomeFact> & Pick<OutcomeFact, "kind" | "source">): OutcomeFact {
  const parsed = parseFact({ route: "rt-1", at: T, ...over });
  if (!parsed.ok) throw new Error("bad fact in test");
  return parsed.value;
}

describe("budget fails closed", () => {
  const key = (over: Partial<CandidateFacts>) => cand({ entry: "key-a:m@high", kindOf: "api-key", ...over });

  it("an api-key with no price is excluded: budget no-price", () => {
    const got = run([key({ expectedUsd: null, committedToday: 1, dailyCap: 10 })], ["key-a:m@high"]);
    expect(got.excluded[0]?.reason).toMatchObject({ code: "budget", stage: "rules", name: "no-price" });
    expect(got.pick).toBeNull();
  });

  it("an api-key with no daily cap is excluded: budget no-cap", () => {
    const got = run([key({ expectedUsd: 0.5, committedToday: 1, dailyCap: null })], ["key-a:m@high"]);
    expect(got.excluded[0]?.reason).toMatchObject({ code: "budget", stage: "rules", name: "no-cap" });
  });

  it("an api-key with no recorded spend is excluded: budget no-spend", () => {
    const got = run([key({ expectedUsd: 0.5, committedToday: null, dailyCap: 10 })], ["key-a:m@high"]);
    expect(got.excluded[0]?.reason).toMatchObject({ code: "budget", stage: "rules", name: "no-spend" });
  });

  it("an api-key with price, cap and spend under the cap is still eligible", () => {
    const got = run([key({ expectedUsd: 0.5, committedToday: 1, dailyCap: 10 })], ["key-a:m@high"]);
    expect(got.excluded).toEqual([]);
    expect(got.pick).toBe("key-a:m@high");
  });

  it("a subscription with no price, cap or spend is unaffected", () => {
    const got = run([cand({ entry: "sub-a:m@high", expectedUsd: null, committedToday: null, dailyCap: null })], ["sub-a:m@high"]);
    expect(got.excluded).toEqual([]);
    expect(got.pick).toBe("sub-a:m@high");
  });

  it("no-price does not hide the daily-cap reason when the key is already at its cap", () => {
    const got = run([key({ expectedUsd: null, committedToday: 10, dailyCap: 10 })], ["key-a:m@high"]);
    expect(got.excluded[0]?.reason).toMatchObject({ code: "budget", stage: "rules", name: "daily-cap" });
  });
});

describe("hard tier: cost before rank", () => {
  const hard = { size: { value: "L" as const, source: "flag" as const } };

  it("hard: a metered flagship never beats a subscription that can do the work", () => {
    const subscription = cand({ entry: "sub-a:m@high", level: "hard", modelClass: "fast", window: 0.7, rank: 1 });
    const key = cand({ entry: "key-a:m@high", kindOf: "api-key", level: "hard", modelClass: "flagship", expectedUsd: 0.1, reservation: 5, rank: 0 });
    expect(run([key, subscription], ["key-a:m@high", "sub-a:m@high"], hard).pick).toBe("sub-a:m@high");
  });

  it("hard: between two metered keys the cheaper wins before class", () => {
    const flagship = cand({ entry: "key-a:m@high", kindOf: "api-key", level: "hard", band: "A", modelClass: "flagship", expectedUsd: 2, reservation: 5, rank: 0 });
    const everyday = cand({ entry: "key-b:m@high", connection: "key-b", kindOf: "api-key", level: "hard", band: "A", modelClass: "everyday", expectedUsd: 0.5, reservation: 5, rank: 1 });
    const got = run([flagship, everyday], ["key-a:m@high", "key-b:m@high"], hard);
    expect(got.pick).toBe("key-b:m@high");
    expect(got.reasons[0]?.code).toBe("cheapest");
  });

  it("hard: trust still decides before cost", () => {
    const subscription = cand({ entry: "sub-a:m@high", level: "standard", window: null, rank: 0 });
    const key = cand({ entry: "key-a:m@high", kindOf: "api-key", level: "hard", expectedUsd: 0.1, reservation: 5, rank: 1 });
    expect(run([subscription, key], ["sub-a:m@high", "key-a:m@high"], hard).pick).toBe("key-a:m@high");
  });

  it("hard: a pick reason names cost when cost decided", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", level: "hard", window: 0.2, rank: 1 }),
      cand({ entry: "key-a:m@high", kindOf: "api-key", level: "hard", expectedUsd: 0.5, reservation: 5, rank: 0 }),
    ], ["key-a:m@high", "sub-a:m@high"], hard);
    expect(got.pick).toBe("sub-a:m@high");
    expect(got.reasons[0]?.code).toBe("included");
  });
});

describe("the vendor's own models", () => {
  it("ownModelOf: no list means any model; a list admits only its globs", () => {
    expect(ownModelOf("claude-sonnet-5.5", undefined)).toBe(true);
    expect(ownModelOf("grok-4.7[effort=high]", ["grok-*", "composer-*"])).toBe(true);
    expect(ownModelOf("composer-2.5", ["grok-*", "composer-*"])).toBe(true);
    expect(ownModelOf("claude-sonnet-5.5", ["grok-*", "composer-*"])).toBe(false);
    expect(ownModelOf("auto", ["grok-*", "composer-*"])).toBe(false);
  });

  it("a candidate outside the vendor's own models is excluded: outside-pool, even when it is the cheapest and trusted", () => {
    const got = run([
      cand({ entry: "key-a:claude-sonnet-5.5@high", kindOf: "api-key", ownModel: false, expectedUsd: 0.1, reservation: 5, rank: 0 }),
      cand({ entry: "sub-a:m@high", level: "routine", rank: 1 }),
    ], ["key-a:claude-sonnet-5.5@high", "sub-a:m@high"], { size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } });
    expect(got.excluded[0]?.reason).toEqual({ code: "outside-pool", stage: "rules" });
    expect(got.pick).toBe("sub-a:m@high");
  });

  it("outside-pool is the first reason after not-in-chain", () => {
    const got = run([
      cand({
        entry: "key-a:claude-sonnet-5.5@high", kindOf: "api-key", ownModel: false, family: "unknown",
        available: { reason: "marked", until: T }, gate: "repo", level: "held",
      }),
    ], ["key-a:claude-sonnet-5.5@high"]);
    expect(got.excluded[0]?.reason).toEqual({ code: "outside-pool", stage: "rules" });
  });
});

describe("equal timestamps", () => {
  const runRow = { id: "rt-1", at: T, group: "implement", tier: "routine" as const, task: "T-1", lane: "lane-a" };

  it("two cost facts of equal trust and time: the later recorded one is the route's cost", () => {
    const facts = [
      fact({ kind: "ran", source: "lease", text: "key-a:m@high" }),
      fact({ kind: "accepted", source: "board", bool: true }),
      fact({ kind: "cost", source: "lease", lease: "l-1", usd: 0.8, spend: "provider" }),
      fact({ kind: "cost", source: "lease", lease: "l-1", usd: 0.5, spend: "provider" }),
    ];
    expect(scorecard(facts, [runRow], T + 100)[0]?.medianUsd).toBeCloseTo(0.5, 9);
  });

  it("two ran facts of equal trust and time: the later recorded one names the entry in the scorecard", () => {
    const facts = [
      fact({ kind: "ran", source: "lease", text: "key-a:m@high" }),
      fact({ kind: "ran", source: "lease", text: "key-b:m@high" }),
      fact({ kind: "accepted", source: "board", bool: true }),
    ];
    expect(scorecard(facts, [runRow], T + 100)[0]?.entry).toBe("key-b:m@high");
  });

  it("a higher-trust fact still beats a later lower-trust one at the same time", () => {
    const facts = [
      fact({ kind: "ran", source: "lease", text: "key-a:m@high" }),
      fact({ kind: "ran", source: "board", text: "key-b:m@high" }),
      fact({ kind: "accepted", source: "board", bool: true }),
    ];
    expect(scorecard(facts, [runRow], T + 100)[0]?.entry).toBe("key-b:m@high");
  });
});
