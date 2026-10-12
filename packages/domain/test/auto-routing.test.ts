// Auto routing (ADR-0020; R16–R28). One history per invariant, plus the control that must fail it.
// Decider cases in these rows land with PR 7. Names here are test data.
import { describe, expect, it } from "vitest";
import {
  autoRouted, changeEffect, dailyCapFor, decide, expectedUsd, familyOf, leaseJoins, modelClassOf, moveStanding,
  nextRound, parseFact, reasonOk, recordFact, reserveFor, roleGroup, route, scorecard, startStanding, taskProfile,
  tierOf, type AutoSettings, type CandidateFacts, type Size, type TaskKind, type TaskProfile,
  type Tier,
} from "../src/index.ts";
import {
  chainText, deriveChain, effectiveOrder, emptyPolicy, ensureRole, setGlobalAuto, setOverride, setPicks, setPriority,
  setReserve, setRoleAuto, setSaveLine, setTaskCeiling, type Listed, type Policy,
} from "../src/index.ts";
import { parseEngine, type Engine } from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const settings = (): AutoSettings => ({ taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} });

const e = (text: string): Engine => {
  const v = parseEngine(text);
  if (!v) throw new Error(`bad engine in test: ${text}`);
  return v;
};

function cand(over: Partial<CandidateFacts> & { entry: string }): CandidateFacts {
  return {
    entry: over.entry,
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

describe("R20: tier is the first matching row of rules-v1", () => {
  const rows: [string, Partial<TaskProfile>, Tier, string][] = [
    ["risk", { risk: { value: true, source: "flag" }, size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } }, "hard", "risk"],
    ["third round", { round: { value: 3, source: "flag" }, size: { value: "S", source: "flag" } }, "hard", "third-round"],
    ["size L", { size: { value: "L", source: "flag" } }, "hard", "large"],
    ["size XL", { size: { value: "XL", source: "flag" } }, "hard", "large"],
    ["small docs", { size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } }, "routine", "small-routine-kind"],
    ["small test", { size: { value: "S", source: "flag" }, kind: { value: "test", source: "flag" } }, "routine", "small-routine-kind"],
    ["small chore", { size: { value: "S", source: "flag" }, kind: { value: "chore", source: "flag" } }, "routine", "small-routine-kind"],
    ["small fix", { size: { value: "S", source: "flag" }, kind: { value: "fix", source: "flag" } }, "routine", "small-routine-kind"],
    ["small review-fix", { size: { value: "S", source: "flag" }, kind: { value: "review-fix", source: "flag" } }, "routine", "small-routine-kind"],
    ["small docs, high priority", { size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" }, priority: { value: "high", source: "board" } }, "standard", "default"],
    ["small feature", { size: { value: "S", source: "flag" }, kind: { value: "feature", source: "flag" } }, "standard", "default"],
    ["unknown signals", {}, "standard", "default"],
    ["docs but not small", { size: { value: "M", source: "brief" }, kind: { value: "docs", source: "board" } }, "standard", "default"],
  ];
  it.each(rows)("%s → %s (%s)", (_name, over, tier, code) => {
    const got = tierOf(profile(over));
    expect(got.tier).toBe(tier);
    expect(got.reason.code).toBe(code);
    expect(got.reason.stage).toBe("rules");
  });

  it("control: risk with size S is still hard", () => {
    const got = tierOf(profile({ risk: { value: true, source: "flag" }, size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } }));
    expect(got.tier).toBe("hard");
    expect(got.tier).not.toBe("routine");
  });
});

describe("profile signals: the first source that answers wins, and the title is not stored", () => {
  it("a flag beats the title, the title prefix beats the branch, and a keyword beats a later round", () => {
    const flagged = taskProfile({ role: "implement-backend", workspace: "ws", kind: "docs", title: "fix: the readme", branch: "chore/x" });
    expect(flagged.kind).toEqual({ value: "docs", source: "flag" });
    const titled = taskProfile({ role: "implement-backend", workspace: "ws", title: "fix: the readme", branch: "docs/guide" });
    expect(titled.kind).toEqual({ value: "fix", source: "board" });
    const branched = taskProfile({ role: "implement-backend", workspace: "ws", title: "hello", branch: "docs/guide" });
    expect(branched.kind).toEqual({ value: "docs", source: "branch" });
    const keyword = taskProfile({ role: "implement-backend", workspace: "ws", title: "update the readme", branch: "task/1" });
    expect(keyword.kind).toEqual({ value: "docs", source: "board" });
    const round = taskProfile({ role: "implement-backend", workspace: "ws", title: "hello", branch: "task/1", round: 2 });
    expect(round.kind).toEqual({ value: "review-fix", source: "ledger" });
    expect(round.round).toEqual({ value: 2, source: "flag" });
  });

  it("size comes from the flag, else a review diff, else findings on a fix round, else the brief", () => {
    expect(taskProfile({ role: "implement", workspace: "ws", size: "XL", diff: { lines: 1, files: 1 }, reviewRun: true }).size)
      .toEqual({ value: "XL", source: "flag" });
    expect(taskProfile({ role: "implement", workspace: "ws", reviewRun: true, diff: { lines: 40, files: 2 } }).size)
      .toEqual({ value: "S", source: "diff" });
    expect(taskProfile({ role: "implement", workspace: "ws", reviewRun: true, diff: { lines: 40, files: 10 } }).size)
      .toEqual({ value: "M", source: "diff" });
    expect(taskProfile({ role: "implement", workspace: "ws", reviewRun: true, diff: { lines: 401, files: 2 } }).size)
      .toEqual({ value: "L", source: "diff" });
    expect(taskProfile({ role: "implement", workspace: "ws", reviewRun: true, diff: { lines: 1501, files: 1 } }).size)
      .toEqual({ value: "XL", source: "diff" });
    expect(taskProfile({ role: "implement", workspace: "ws", fixRound: true, findings: 2 }).size)
      .toEqual({ value: "S", source: "findings" });
    expect(taskProfile({ role: "implement", workspace: "ws", fixRound: true, findings: 5 }).size)
      .toEqual({ value: "M", source: "findings" });
    expect(taskProfile({ role: "implement", workspace: "ws", fixRound: true, findings: 6 }).size)
      .toEqual({ value: "L", source: "findings" });
    expect(taskProfile({ role: "implement", workspace: "ws", brief: { digest: "abc", items: 2, paths: 2 } }).size)
      .toEqual({ value: "S", source: "brief" });
    expect(taskProfile({ role: "implement", workspace: "ws", brief: { digest: "abc", items: 3, paths: 2 } }).size)
      .toEqual({ value: "M", source: "brief" });
    expect(taskProfile({ role: "implement", workspace: "ws", brief: { digest: "abc", items: 6, paths: 1 } }).size)
      .toEqual({ value: "L", source: "brief" });
    expect(taskProfile({ role: "implement", workspace: "ws", brief: { digest: "abc", items: 1, paths: 25 } }).size)
      .toEqual({ value: "XL", source: "brief" });
    expect(taskProfile({ role: "implement", workspace: "ws" }).size).toEqual({ value: "unknown", source: "default" });
  });

  it("stores the brief as a digest and counts, never the title", () => {
    const got = taskProfile({
      role: "implement-ui", workspace: "ws", title: "MARKER-TITLE docs: explain",
      brief: { digest: "deadbeef", items: 2, paths: 1 },
    });
    expect(got.group).toBe("implement");
    expect(got.brief).toEqual({ digest: "deadbeef", items: 2, paths: 1 });
    expect(JSON.stringify(got)).not.toContain("MARKER-TITLE");
    expect(roleGroup("implement-ui")).toBe("implement");
    expect(roleGroup("review")).toBe("review");
  });
});

describe("R18: the first hard rule wins, and usage cannot admit a gate refusal", () => {
  const derived = ["sub-a:m@high", "key-a:m@high"];

  it("reports only the first failing step", () => {
    const outside = run([
      cand({ entry: "nope:m@high", inChain: true, family: "unknown", available: { reason: "marked", until: T }, gate: "repo", level: "held" }),
      cand({ entry: "sub-a:m@high", rank: 0 }),
    ], ["sub-a:m@high"]);
    expect(outside.excluded.map(row => [row.entry, row.reason.code])).toEqual([["nope:m@high", "not-in-chain"]]);
    expect(outside.pick).toBe("sub-a:m@high");
  });

  it("excludes an unknown family, then unavailability, then the gate, then budget, quota and held", () => {
    const unknown = run([
      cand({ entry: "sub-a:m@high", family: "unknown", rank: 0 }),
      cand({ entry: "key-a:m@high", rank: 1, kindOf: "api-key", level: "routine" }),
    ], derived);
    expect(unknown.excluded).toEqual([{ entry: "sub-a:m@high", reason: { code: "unknown-family", stage: "rules" } }]);

    const marked = run([
      cand({ entry: "sub-a:m@high", available: { reason: "marked", until: T }, rank: 0 }),
      cand({ entry: "key-a:m@high", rank: 1, kindOf: "api-key", level: "routine", expectedUsd: 1, reservation: 5 }),
    ], derived);
    expect(marked.excluded[0]).toEqual({ entry: "sub-a:m@high", reason: { code: "unavailable", stage: "rules", name: "marked", n: T } });
    expect(marked.pick).toBe("key-a:m@high");

    const gated = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", gate: "repo", window: 0, rank: 0, expectedUsd: 0.1, reservation: 5 }),
      cand({ entry: "sub-a:m@high", rank: 1 }),
    ], derived);
    expect(gated.excluded.map(row => row.reason.code)).toEqual(["gate"]);
    expect(gated.excluded[0]?.reason.name).toBe("repo");
    expect(gated.pick).toBe("sub-a:m@high");

    const overReserve = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 5.01, reservation: 5, rank: 0, level: "routine" }),
      cand({ entry: "sub-a:m@high", rank: 1 }),
    ], derived);
    expect(overReserve.excluded[0]?.reason.code).toBe("budget");
    expect(overReserve.pick).toBe("sub-a:m@high");

    const atReserve = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 5, reservation: 5, rank: 0, level: "hard", window: null }),
      cand({ entry: "sub-a:m@high", rank: 1, window: 0.1 }),
    ], derived, { size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } });
    expect(atReserve.excluded).toEqual([]);

    const cap = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 6, reservation: 10, committedToday: 6, dailyCap: 10, rank: 0, level: "routine" }),
      cand({ entry: "sub-a:m@high", rank: 1 }),
    ], derived);
    expect(cap.excluded[0]?.reason).toMatchObject({ code: "budget", name: "daily-cap" });

    const quota = run([
      cand({ entry: "sub-a:m@high", window: 0.9, rank: 0 }),
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 1, reservation: 5, rank: 1, level: "routine" }),
    ], derived);
    expect(quota.excluded[0]?.reason).toMatchObject({ code: "quota", n: 0.9 });
    const under = run([
      cand({ entry: "sub-a:m@high", window: 0.89, rank: 0 }),
      cand({ entry: "key-a:m@high", rank: 1, kindOf: "api-key", level: "routine" }),
    ], derived);
    expect(under.excluded).toEqual([]);

    const held = run([
      cand({ entry: "sub-a:m@high", level: "held", heldSince: T, heldWhy: "pin", rank: 0 }),
      cand({ entry: "key-a:m@high", rank: 1, kindOf: "api-key", level: "routine", expectedUsd: 1, reservation: 5 }),
    ], derived);
    expect(held.excluded[0]?.reason).toMatchObject({ code: "held", name: "pin", n: T });
  });

  it("control: a gate refusal stays excluded when the window looks unused", () => {
    const got = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", gate: "budget", window: 0, expectedUsd: 0.1, reservation: 5, rank: 0 }),
    ], ["key-a:m@high"]);
    expect(got.excluded[0]?.reason.code).toBe("gate");
    expect(got.pick).toBeNull();
    expect(got.declined).toBe("none-eligible");
  });

  it("prices a metered prior from tokens, and a recorded median once five outcomes exist", () => {
    expect(expectedUsd("S", { input: 1.4, output: 4.4 }, { n: 0, median: null })).toEqual({ usd: 0.552, from: "prior" });
    expect(expectedUsd("M", { input: 1.4, output: 4.4 }, { n: 4, median: 9 })).toEqual({ usd: 2.54, from: "prior" });
    expect(expectedUsd("L", { input: 1.4, output: 4.4 }, { n: 5, median: 1.25 })).toEqual({ usd: 1.25, from: "scorecard" });
    expect(expectedUsd("unknown", null, { n: 0, median: null })).toBeNull();
  });
});

describe("R19: the review rule uses the per-model family", () => {
  const families = [
    { pattern: "claude-*", family: "anthropic" },
    { pattern: "auto", family: "unknown" },
  ];
  const classes = [
    { pattern: "*opus*", class: "flagship" as const },
    { pattern: "*fable*", class: "flagship" as const },
    { pattern: "*sonnet*", class: "everyday" as const },
    { pattern: "*haiku*", class: "fast" as const },
  ];

  it("maps a model, keeps the preset family when nothing matches, and never treats a dot as any character", () => {
    expect(familyOf("claude-sonnet-5.5", families, "cursor")).toBe("anthropic");
    expect(familyOf("auto", families, "cursor")).toBe("unknown");
    expect(familyOf("composer-2", families, "cursor")).toBe("cursor");
    expect(familyOf("a.b", [{ pattern: "a.b", family: "exact" }], "preset")).toBe("exact");
    expect(familyOf("axb", [{ pattern: "a.b", family: "exact" }], "preset")).toBe("preset");
    expect(modelClassOf("claude-opus-5.5", classes)).toBe("flagship");
    expect(modelClassOf("claude-sonnet-5.5", classes)).toBe("everyday");
    expect(modelClassOf("claude-haiku-5.5", classes)).toBe("fast");
    expect(modelClassOf("composer-2", classes)).toBe("unknown");
  });

  it("excludes a reviewer of the implementer's family, and an implementer that would empty a one-family review chain", () => {
    const review = decide({
      role: "review",
      reviewRule: true,
      implementerFamilies: ["anthropic"],
      reviewFamilies: ["anthropic", "fam-b"],
      candidates: [
        cand({ entry: "sub-a:claude-sonnet-5.5@high", family: "anthropic", rank: 0 }),
        cand({ entry: "key-a:m@high", family: "fam-b", rank: 1, kindOf: "api-key", level: "routine", expectedUsd: 1, reservation: 5 }),
      ],
      profile: profile({ role: "review", group: "review" }),
      settings: settings(),
      derived: ["sub-a:claude-sonnet-5.5@high", "key-a:m@high"],
    });
    expect(review.excluded.map(row => row.entry)).toEqual(["sub-a:claude-sonnet-5.5@high"]);
    expect(review.excluded[0]?.reason).toMatchObject({ code: "review", name: "anthropic" });
    expect(review.pick).toBe("key-a:m@high");

    const empties = decide({
      role: "implement-backend",
      reviewRule: true,
      implementerFamilies: [],
      reviewFamilies: ["fam-a"],
      candidates: [
        cand({ entry: "sub-a:m@high", family: "fam-a", rank: 0 }),
        cand({ entry: "key-a:m@high", family: "fam-b", rank: 1, kindOf: "api-key", level: "routine", expectedUsd: 1, reservation: 5 }),
      ],
      profile: profile(),
      settings: settings(),
      derived: ["sub-a:m@high", "key-a:m@high"],
    });
    expect(empties.excluded.map(row => row.entry)).toEqual(["sub-a:m@high"]);
    expect(empties.pick).toBe("key-a:m@high");

    const remains = decide({
      role: "implement-backend",
      reviewRule: true,
      implementerFamilies: [],
      reviewFamilies: ["fam-a", "fam-b"],
      candidates: [cand({ entry: "sub-a:m@high", family: "fam-a", rank: 0 })],
      profile: profile(),
      settings: settings(),
      derived: ["sub-a:m@high"],
    });
    expect(remains.excluded).toEqual([]);
    expect(remains.pick).toBe("sub-a:m@high");
  });

  it("control: the rule off excludes nothing", () => {
    const got = decide({
      role: "review",
      reviewRule: false,
      implementerFamilies: ["fam-a"],
      reviewFamilies: ["fam-a"],
      candidates: [cand({ entry: "sub-a:m@high", family: "fam-a" })],
      profile: profile({ role: "review", group: "review" }),
      settings: settings(),
      derived: ["sub-a:m@high"],
    });
    expect(got.excluded).toEqual([]);
    expect(got.pick).toBe("sub-a:m@high");
  });
});

describe("R17 and R24: the pick is one entry of the derived chain, then the rest in role order", () => {
  it("moves the pick to the front and keeps every fallback, including an excluded one", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", window: null, rank: 0 }),
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 0.55, reservation: 5, level: "routine", rank: 1 }),
      cand({ entry: "key-b:m@high", kindOf: "api-key", gate: "off", rank: 2 }),
    ], ["sub-a:m@high", "key-a:m@high", "key-b:m@high"], { size: { value: "S", source: "flag" }, kind: { value: "docs", source: "flag" } });
    expect(got.pick).toBe("key-a:m@high");
    expect(got.chain).toEqual(["key-a:m@high", "sub-a:m@high", "key-b:m@high"]);
    expect(got.rulesPick).toBe("key-a:m@high");
    expect(got.stage).toBe("rules");
  });

  it("a risk run is given its risk chain, and an outside entry cannot be picked", () => {
    const got = run([
      cand({ entry: "sub-a:opus@high", rank: 0 }),
      cand({ entry: "key-a:m@high", inChain: true, rank: 1 }),
    ], ["sub-a:opus@high"]);
    expect(got.pick).toBe("sub-a:opus@high");
    expect(got.chain).toEqual(["sub-a:opus@high"]);
    expect(got.excluded[0]).toMatchObject({ entry: "key-a:m@high", reason: { code: "not-in-chain" } });
    for (const entry of got.chain) expect(["sub-a:opus@high"]).toContain(entry);
  });

  it("none eligible answers the derived chain unchanged", () => {
    const derived = ["sub-a:m@high", "key-a:m@high"];
    const got = run([
      cand({ entry: "sub-a:m@high", level: "held", rank: 0 }),
      cand({ entry: "key-a:m@high", gate: "repo", rank: 1 }),
    ], derived);
    expect(got.pick).toBeNull();
    expect(got.rulesPick).toBeNull();
    expect(got.declined).toBe("none-eligible");
    expect(got.chain).toEqual(derived);
  });

  it("control: a chain that dropped a fallback would fail this", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", rank: 0, window: 0.1 }),
      cand({ entry: "key-a:m@high", rank: 1, kindOf: "api-key", level: "routine" }),
    ], ["sub-a:m@high", "key-a:m@high"]);
    expect(got.chain).toEqual(["sub-a:m@high", "key-a:m@high"]);
    const dropped = got.chain.filter(entry => entry !== "key-a:m@high");
    expect(dropped).not.toEqual(got.chain);
  });
});

describe("R21: ranking is lexicographic per tier, and the role order breaks ties", () => {
  const hard = { size: { value: "L" as Size, source: "flag" as const } };

  it("hard: trust, then band, then model class, then role order", () => {
    const trustedFast = cand({ entry: "sub-a:m@high", level: "hard", band: "A", modelClass: "fast", rank: 1 });
    const trustedFlagship = cand({ entry: "key-a:m@high", level: "hard", band: "B", modelClass: "flagship", rank: 0, kindOf: "api-key", expectedUsd: 1, reservation: 5 });
    expect(run([trustedFlagship, trustedFast], ["key-a:m@high", "sub-a:m@high"], hard).pick).toBe("sub-a:m@high");

    const sameBand = [
      cand({ entry: "sub-a:m@high", level: "hard", band: "A", modelClass: "everyday", rank: 1 }),
      cand({ entry: "key-a:m@high", level: "hard", band: "A", modelClass: "flagship", rank: 0, kindOf: "api-key", expectedUsd: 1, reservation: 5 }),
    ];
    expect(run(sameBand, ["key-a:m@high", "sub-a:m@high"], hard).pick).toBe("key-a:m@high");

    const probation = cand({ entry: "key-a:m@high", level: "routine", band: "A", modelClass: "flagship", rank: 0, kindOf: "api-key", expectedUsd: 1, reservation: 5 });
    const trusted = cand({ entry: "sub-a:m@high", level: "hard", band: "C", modelClass: "fast", rank: 1 });
    expect(run([probation, trusted], ["key-a:m@high", "sub-a:m@high"], hard).pick).toBe("sub-a:m@high");
  });

  it("standard: trust, then cost, then band, then time, then role order", () => {
    const standard = { size: { value: "M" as Size, source: "flag" as const }, kind: { value: "feature" as TaskKind, source: "flag" as const } };
    const cheapProbation = cand({ entry: "key-a:m@high", level: "routine", kindOf: "api-key", expectedUsd: 0.5, reservation: 5, rank: 0 });
    const keptTrusted = cand({ entry: "sub-a:m@high", level: "standard", window: null, rank: 1 });
    expect(run([cheapProbation, keptTrusted], ["key-a:m@high", "sub-a:m@high"], standard).pick).toBe("sub-a:m@high");

    const included = cand({ entry: "sub-a:m@high", level: "standard", window: 0.2, rank: 1, minutes: 40 });
    const metered = cand({ entry: "key-a:m@high", level: "standard", kindOf: "api-key", expectedUsd: 0.5, reservation: 5, rank: 0, minutes: 5 });
    expect(run([metered, included], ["key-a:m@high", "sub-a:m@high"], standard).pick).toBe("sub-a:m@high");

    const slowA = cand({ entry: "sub-a:m@high", level: "standard", window: 0.2, band: "A", minutes: 30, rank: 1 });
    const fastB = cand({ entry: "key-b:m@high", connection: "key-b", level: "standard", kindOf: "api-key", expectedUsd: 1, reservation: 5, band: "B", minutes: 5, rank: 0 });
    expect(run([fastB, slowA], ["key-b:m@high", "sub-a:m@high"], standard).rulesPick).toBe("sub-a:m@high");

    const sooner = cand({ entry: "sub-a:m@high", level: "standard", window: 0.2, band: "B", minutes: 10, rank: 1 });
    const later = cand({ entry: "key-b:m@high", connection: "key-b", level: "standard", window: 0.2, band: "B", minutes: 40, rank: 0 });
    expect(run([later, sooner], ["key-b:m@high", "sub-a:m@high"], standard).pick).toBe("sub-a:m@high");
  });

  it("routine: cost class first, so a key at the ceiling beats a kept subscription and one past it does not", () => {
    const routine = { size: { value: "S" as Size, source: "flag" as const }, kind: { value: "docs" as TaskKind, source: "flag" as const } };
    const kept = cand({ entry: "sub-a:m@high", window: null, level: "hard", rank: 0 });
    const atCeiling = cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 3, reservation: 5, level: "routine", rank: 1 });
    expect(run([kept, atCeiling], ["sub-a:m@high", "key-a:m@high"], routine).pick).toBe("key-a:m@high");
    expect(run([kept, atCeiling], ["sub-a:m@high", "key-a:m@high"], routine).reasons[0]?.code).toBe("cheapest");

    const past = cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 3.01, reservation: 5, level: "routine", rank: 1 });
    expect(run([past, kept], ["key-a:m@high", "sub-a:m@high"], routine).pick).toBe("sub-a:m@high");

    const included = cand({ entry: "sub-a:m@high", window: 0.49, rank: 1 });
    const cheap = cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 0.2, reservation: 5, level: "routine", rank: 0 });
    expect(run([cheap, included], ["key-a:m@high", "sub-a:m@high"], routine).pick).toBe("sub-a:m@high");
    expect(run([cheap, included], ["key-a:m@high", "sub-a:m@high"], routine).reasons[0]?.code).toBe("included");

    const atLine = cand({ entry: "sub-a:m@high", window: 0.5, rank: 0, level: "hard" });
    expect(run([atLine, cheap], ["sub-a:m@high", "key-a:m@high"], routine).pick).toBe("key-a:m@high");
  });

  it("shuffled candidates give the same pick, and role order wins a total tie", () => {
    const routine = { size: { value: "S" as Size, source: "flag" as const }, kind: { value: "fix" as TaskKind, source: "flag" as const } };
    const a = cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 1, reservation: 5, level: "routine", band: "new", minutes: 10, rank: 0 });
    const b = cand({ entry: "key-b:m@high", connection: "key-b", kindOf: "api-key", expectedUsd: 1, reservation: 5, level: "hard", band: "new", minutes: 10, rank: 1 });
    const derived = ["key-a:m@high", "key-b:m@high"];
    expect(run([a, b], derived, routine).pick).toBe("key-a:m@high");
    expect(run([b, a], derived, routine).pick).toBe("key-a:m@high");
    expect(run([b, a], derived, routine).ranked).toEqual(["key-a:m@high", "key-b:m@high"]);
  });

  it("control: ignoring role order would follow the listing", () => {
    const routine = { size: { value: "S" as Size, source: "flag" as const }, kind: { value: "chore" as TaskKind, source: "flag" as const } };
    const first = cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 1, reservation: 5, level: "routine", rank: 0 });
    const second = cand({ entry: "key-b:m@high", connection: "key-b", kindOf: "api-key", expectedUsd: 1, reservation: 5, level: "routine", rank: 1 });
    const got = run([second, first], ["key-a:m@high", "key-b:m@high"], routine);
    expect(got.pick).toBe("key-a:m@high");
    const listingOrder = [second, first].map(row => row.entry);
    expect(got.pick).not.toBe(listingOrder[0]);
  });

  it("when everyone trusted for the tier is excluded, the best of the rest is picked and says so", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", level: "hard", available: { reason: "marked", until: T }, rank: 0 }),
      cand({ entry: "key-a:m@high", level: "routine", kindOf: "api-key", expectedUsd: 2.54, reservation: 5, rank: 1 }),
    ], ["sub-a:m@high", "key-a:m@high"], { risk: { value: true, source: "flag" } });
    expect(got.pick).toBe("key-a:m@high");
    expect(got.reasons[0]?.code).toBe("no-trusted-available");
    expect(got.chain).toEqual(["key-a:m@high", "sub-a:m@high"]);
  });
});

describe("R16: auto is a switch beside the mode", () => {
  const listed: Listed[] = [
    { name: "sub-a", kind: "subscription", models: ["m"], efforts: ["high"] },
    { name: "key-a", kind: "api-key", models: ["m"], efforts: ["high"] },
  ];
  const known = listed.map(row => ({ name: row.name, kind: row.kind }));
  const picks = ["sub-a:m@high", "key-a:m@high"].map(e);

  function saved(mode: Policy["priority"]["mode"], order: readonly string[]): Policy {
    let p = ensureRole(emptyPolicy(), "implement-backend");
    p = value(setOverride(p, "implement-backend", "follow", null, listed, "c1", T));
    p = value(setPriority(p, { mode, order }, listed, "c1", T));
    return value(setPicks(p, "implement-backend", picks, null, listed, "c1", T));
  }

  const table: [Policy["priority"]["mode"], readonly string[], string][] = [
    ["subscriptions-first", ["sub-a", "key-a"], "sub-a:m@high,key-a:m@high"],
    ["keys-first", ["sub-a", "key-a"], "key-a:m@high,sub-a:m@high"],
    ["subscriptions-only", ["sub-a", "key-a"], "sub-a:m@high"],
    ["keys-only", ["sub-a", "key-a"], "key-a:m@high"],
    ["custom", ["key-a", "sub-a"], "key-a:m@high,sub-a:m@high"],
  ];

  it.each(table)("turning auto on leaves %s unchanged", (mode, order, want) => {
    const before = saved(mode, order);
    const row = before.roles[0];
    if (!row) throw new Error("no role");
    const chain = chainText(deriveChain(row.picks, effectiveOrder(before.priority, known), false)).join(",");
    expect(chain).toBe(want);
    const after = value(setGlobalAuto(before, true, "step-up", "c2", T));
    const again = after.roles[0];
    if (!again) throw new Error("no role");
    expect(chainText(deriveChain(again.picks, effectiveOrder(after.priority, known), false)).join(",")).toBe(chain);
    expect(after.priority.order).toEqual(before.priority.order);
    expect(after.priority.mode).toBe(before.priority.mode);
    expect(again.picks).toEqual(row.picks);
    expect(after.events.some(event => event.type === "ChainProjected")).toBe(false);
    expect(after.priority.auto).toBe(true);
  });

  it("off, a role switch, hand and drifted each decline, and an own role follows both switches", () => {
    expect(autoRouted({ globalAuto: false, roleAuto: true, override: "follow", drifted: false })).toEqual({ auto: false, reason: "off" });
    expect(autoRouted({ globalAuto: true, roleAuto: false, override: "follow", drifted: false })).toEqual({ auto: false, reason: "role-off" });
    expect(autoRouted({ globalAuto: true, roleAuto: true, override: "hand", drifted: false })).toEqual({ auto: false, reason: "hand" });
    expect(autoRouted({ globalAuto: true, roleAuto: true, override: "follow", drifted: true })).toEqual({ auto: false, reason: "drifted" });
    expect(autoRouted({ globalAuto: true, roleAuto: true, override: "own", drifted: false })).toEqual({ auto: true });

    const declined = route({
      globalAuto: true, roleAuto: true, override: "hand", drifted: false,
      role: "implement-backend", reviewRule: false, implementerFamilies: [], reviewFamilies: [],
      candidates: [cand({ entry: "key-a:m@high" })], profile: profile(), settings: settings(),
      derived: ["key-a:m@high"],
    });
    expect(declined.pick).toBeNull();
    expect(declined.declined).toBe("hand");
    expect(declined.chain).toEqual(["key-a:m@high"]);
    expect(declined.ranked).toEqual([]);

    let policy = ensureRole(emptyPolicy(), "implement-backend");
    expect(policy.roles[0]?.auto).toBe(true);
    policy = ensureRole(policy, "review");
    expect(policy.roles.find(row => row.role === "review")?.auto).toBe(false);
    const off = value(setRoleAuto(policy, "implement-backend", false, "step-up", "c1", T));
    expect(off.roles[0]?.auto).toBe(false);
    expect(setRoleAuto(policy, "implement-backend", false, "session", "c1", T).ok).toBe(false);
  });

  it("control: a hand role does not get a pick", () => {
    const got = route({
      globalAuto: true, roleAuto: true, override: "hand", drifted: false,
      role: "implement-backend", reviewRule: false, implementerFamilies: [], reviewFamilies: [],
      candidates: [cand({ entry: "sub-a:m@high", window: 0 })], profile: profile(), settings: settings(),
      derived: ["sub-a:m@high", "key-a:m@high"],
    });
    expect(got.pick).toBeNull();
    expect(got.declined).toBe("hand");
  });
});

describe("R22 and R25: a pick is a pure function of its inputs and writes nothing", () => {
  it("replays the same pick after the live ceiling changes, over 1000 inputs", () => {
    const rand = mulberry32(20);
    for (let i = 0; i < 1000; i++) {
      const input = randomInput(rand);
      const frozen = structuredClone(input);
      const first = decide(frozen);
      expect(decide(structuredClone(frozen))).toEqual(first);
      const live = structuredClone(frozen);
      live.settings = { ...live.settings, taskCeiling: live.settings.taskCeiling + 10 };
      expect(decide(frozen)).toEqual(first);
    }
  });

  it("control: a counter that moves between calls would not replay", () => {
    const shaky = { n: 0 };
    const next = () => {
      shaky.n += 1;
      return shaky.n;
    };
    expect(next()).not.toBe(next());
    const input = {
      role: "implement-backend", reviewRule: false, implementerFamilies: [] as string[], reviewFamilies: [] as string[],
      candidates: [cand({ entry: "sub-a:m@high", window: 0.1 })],
      profile: profile(), settings: settings(), derived: ["sub-a:m@high"],
    };
    expect(decide(input)).toEqual(decide(input));
    expect(input.candidates.map(row => row.entry)).toEqual(["sub-a:m@high"]);
  });

  it("turning auto on and deciding leaves the policy's chains byte-equal", () => {
    const listed: Listed[] = [{ name: "sub-a", kind: "subscription", models: ["m"], efforts: ["high"] }];
    let policy = ensureRole(emptyPolicy(), "plan");
    policy = value(setOverride(policy, "plan", "follow", null, listed, "c1", T));
    policy = value(setPriority(policy, { mode: "custom", order: ["sub-a"] }, listed, "c1", T));
    policy = value(setPicks(policy, "plan", [e("sub-a:m@high")], null, listed, "c1", T));
    const before = structuredClone(policy);
    const after = value(setGlobalAuto(policy, true, "step-up", "c2", T));
    expect(after.roles.map(row => ({ picks: row.picks, written: row.written, writtenRisk: row.writtenRisk }))).toEqual(
      before.roles.map(row => ({ picks: row.picks, written: row.written, writtenRisk: row.writtenRisk })),
    );
    expect(after.priority.order).toEqual(before.priority.order);
    const marked = [...after.priority.order, "marked"];
    expect(after.priority.order).not.toEqual(marked);
    decide({
      role: "plan", reviewRule: false, implementerFamilies: [], reviewFamilies: [],
      candidates: [cand({ entry: "sub-a:m@high" })], profile: profile({ role: "plan", group: "plan" }),
      settings: settings(), derived: ["sub-a:m@high"],
    });
    expect(policy.priority.order).toEqual(before.priority.order);
    expect(policy.roles).toEqual(before.roles);
  });
});

describe("R23: a reason is a code with numbers, and a title does not fit", () => {
  it("every pick and exclusion carries a reason the schema accepts", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", window: null, rank: 0 }),
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 1, reservation: 5, level: "routine", rank: 1, gate: "repo" }),
    ], ["sub-a:m@high", "key-a:m@high"], { size: { value: "M", source: "flag" }, kind: { value: "feature", source: "flag" } });
    expect(got.reasons.length).toBeGreaterThan(0);
    for (const reason of got.reasons) {
      expect(reason.stage).toBe("rules");
      expect(reasonOk(reason)).toBe(true);
    }
    for (const row of got.excluded) expect(reasonOk(row.reason)).toBe(true);
  });

  it("control: a title smuggled into a reason is refused", () => {
    expect(reasonOk({ code: "docs: explain the retry flag", stage: "rules" })).toBe(false);
    expect(reasonOk({ code: "a".repeat(65), stage: "rules" })).toBe(false);
    expect(reasonOk({ code: "cheapest", stage: "rules", name: "MARKER-TITLE" })).toBe(false);
    expect(reasonOk({ code: "cheapest", stage: "rules", n: 0.55 })).toBe(true);
  });
});

describe("R28: a settings change is judged by effect", () => {
  it("a lower ceiling, cap or reserve is a session, and a raise or a save-line change is step-up", () => {
    expect(changeEffect({ kind: "task-ceiling", from: 3, to: 2 })).toBe("session");
    expect(changeEffect({ kind: "daily-cap", from: 10, to: 4 })).toBe("session");
    expect(changeEffect({ kind: "reserve", from: 5, to: 4 })).toBe("session");
    expect(changeEffect({ kind: "task-ceiling", from: 3, to: 4 })).toBe("step-up");
    expect(changeEffect({ kind: "daily-cap", from: 10, to: 11 })).toBe("step-up");
    expect(changeEffect({ kind: "reserve", from: 5, to: 6 })).toBe("step-up");
    expect(changeEffect({ kind: "save-line", from: 0.5, to: 0.4 })).toBe("step-up");
    expect(changeEffect({ kind: "save-line", from: 0.5, to: 0.8 })).toBe("step-up");
    expect(changeEffect({ kind: "global-auto", on: false })).toBe("step-up");
    expect(changeEffect({ kind: "global-auto", on: true })).toBe("step-up");
    expect(changeEffect({ kind: "role-auto", on: false, plainStartsOnKey: true })).toBe("step-up");
    expect(changeEffect({ kind: "pin", from: "routine", to: "held", sharesChainWithMetered: true })).toBe("step-up");
    expect(changeEffect({ kind: "pin", from: "routine", to: "held", sharesChainWithMetered: false })).toBe("session");
    expect(changeEffect({ kind: "pin", from: "hard", to: "routine", sharesChainWithMetered: false })).toBe("session");
    expect(changeEffect({ kind: "pin", from: "routine", to: "hard", sharesChainWithMetered: false })).toBe("step-up");
    expect(changeEffect({ kind: "pin", from: "held", to: "routine", sharesChainWithMetered: false })).toBe("step-up");
  });

  it("control: raising the ceiling without step-up is refused and the policy stays", () => {
    const policy = emptyPolicy();
    const raised = setTaskCeiling(policy, 4, "session", "c1", T);
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.error.problem).toBe("step-up");
    expect(policy.autoSettings.taskCeiling).toBe(3);
    const lowered = value(setTaskCeiling(policy, 2, "session", "c1", T));
    expect(lowered.autoSettings.taskCeiling).toBe(2);
    const line = setSaveLine(policy, 0.8, "session", "c1", T);
    expect(line.ok).toBe(false);
    const reserve = value(setReserve(policy, "implement-backend", 4, "session", "c1", T));
    expect(reserve.autoSettings.reserves["implement-backend"]).toBe(4);
    expect(reserveFor(emptyPolicy().autoSettings, "missing")).toBe(5);
    expect(dailyCapFor(emptyPolicy().autoSettings, "missing")).toBe(10);
  });
});

describe("R26: outcome facts are append-only and a scorecard is a pure function of them", () => {
  const runRow = { id: "rt-1", at: T, group: "implement", tier: "routine" as const, task: "T-1", lane: "lane-a" };

  it("refuses a status line, a decider source, a same-lane review, and an estimate that lowers a provider cost", () => {
    expect(parseFact({ source: "status", kind: "accepted", route: "rt-1", at: T, text: "STATUS: DONE" }).ok).toBe(false);
    expect(parseFact({ source: "decider", kind: "accepted", route: "rt-1", at: T, bool: true }).ok).toBe(false);
    const accepted = value(parseFact({ source: "board", kind: "accepted", route: "rt-1", at: T, bool: true }));
    expect(recordFact([], { ...accepted, source: "review", by: "rt-2", byLane: "lane-a" }, { lane: "lane-a" }).ok).toBe(false);
    expect(recordFact([], { ...accepted, source: "review", kind: "findings", n: 1 }, { lane: "lane-b" }).ok).toBe(false);
    expect(recordFact([], { ...accepted, source: "review", kind: "findings", n: 1, by: "rt-2", byLane: null }, { lane: "lane-b" }).ok).toBe(false);
    expect(recordFact([], { ...accepted, source: "review", kind: "findings", n: 1, by: "rt-2", byLane: "lane-b" }, { lane: null }).ok).toBe(false);
    const review = recordFact([], { ...accepted, source: "review", kind: "findings", n: 2, by: "rt-2", byLane: "lane-b" }, { lane: "lane-a" });
    expect(review.ok).toBe(true);

    const provider = value(parseFact({ source: "lease", kind: "cost", route: "rt-1", at: T, usd: 2, spend: "provider" }));
    const estimate = value(parseFact({ source: "lease", kind: "cost", route: "rt-1", at: T + 1, usd: 1, spend: "estimate" }));
    const lowered = recordFact([provider], estimate, { lane: "lane-a" });
    expect(lowered.ok).toBe(false);
    const higher = value(parseFact({ source: "lease", kind: "cost", route: "rt-1", at: T, usd: 5, spend: "estimate" }));
    const replaced = value(recordFact([higher], provider, { lane: "lane-a" }));
    expect(replaced).toHaveLength(2);
    expect(replaced[0]).toEqual(higher);
  });

  it("a later weaker source does not win, an unknown after 7 days is coverage only, and a route without ran does not count", () => {
    const ran = value(parseFact({ source: "lease", kind: "ran", route: "rt-1", at: T, text: "key-a:m@high" }));
    const board = value(parseFact({ source: "board", kind: "accepted", route: "rt-1", at: T + DAY, bool: true }));
    const ledger = value(parseFact({ source: "ledger", kind: "accepted", route: "rt-1", at: T + 2 * DAY, bool: false }));
    const kept = value(recordFact([board], ledger, { lane: "lane-a" }));
    expect(kept).toHaveLength(2);
    const cell = scorecard([ran, ...kept], [runRow], T + 2 * DAY);
    expect(cell).toEqual([expect.objectContaining({ entry: "key-a:m@high", group: "implement", tier: "routine", k: 1, n: 1, band: "new" })]);
    expect(scorecard([], [{ ...runRow, id: "rt-quiet" }], T + DAY)).toEqual([]);

    const old = { ...runRow, id: "rt-9", at: T - 8 * DAY };
    const oldRan = value(parseFact({ source: "lease", kind: "ran", route: "rt-9", at: old.at, text: "key-a:m@high" }));
    const aged = scorecard([oldRan], [old], T);
    expect(aged[0]).toMatchObject({ coverage: 1, n: 0, k: 0 });

    expect(nextRound([{ task: "T-1", group: "implement", ran: true }, { task: "T-1", group: "implement", ran: false }], "T-1", "implement")).toBe(2);
    expect(leaseJoins({ task: "T-1" }, "T-2")).toBe(false);
    expect(leaseJoins({ task: "T-1" }, "T-1")).toBe(true);
    expect(leaseJoins({ task: "T-1" }, null)).toBe(true);
  });
});

describe("R27: standing moves on outcomes, not on time or a decider choice", () => {
  const accepted = (fixRounds = 0) => ({ accepted: true as const, fixRounds });
  const sentBack = { accepted: false as const, fixRounds: 1 };

  it("starts the first entry of each chain at hard, and a later role does not lower one", () => {
    const rows = startStanding([
      { group: "implement", chains: [["sub-a:m@high", "key-a:m@high"], ["key-b:m@high", "sub-a:m@high"]] },
    ]);
    const level = (entry: string) => rows.find(row => row.entry === entry)?.level;
    expect(level("sub-a:m@high")).toBe("hard");
    expect(level("key-b:m@high")).toBe("hard");
    expect(level("key-a:m@high")).toBe("routine");
  });

  it("promotes after 4 of 5, demotes after 3 of 5, and a pin or a hold stops both", () => {
    const four = [accepted(), accepted(), accepted(), accepted(), sentBack];
    expect(moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: four, deciderChoice: null }).level).toBe("standard");
    expect(moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: four, deciderChoice: "o2" })).toEqual(
      moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: four, deciderChoice: null }),
    );
    const three = [accepted(), accepted(), accepted(), sentBack, sentBack];
    expect(moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: three, deciderChoice: null }).level).toBe("routine");
    const blocked = [accepted(3), accepted(), accepted(), accepted(), accepted()];
    expect(moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: blocked, deciderChoice: null }).level).toBe("routine");

    const failures = [sentBack, sentBack, sentBack, accepted(), accepted()];
    expect(moveStanding({ level: "standard", pinned: false, tier: "standard", atTier: failures, deciderChoice: null }).level).toBe("routine");
    expect(moveStanding({ level: "routine", pinned: false, tier: "routine", atTier: failures, deciderChoice: null }).level).toBe("held");
    expect(moveStanding({ level: "standard", pinned: true, tier: "standard", atTier: failures, deciderChoice: null }).level).toBe("standard");
    expect(moveStanding({ level: "held", pinned: false, tier: "routine", atTier: four, deciderChoice: null }).level).toBe("held");
    expect(moveStanding({ level: "held", pinned: false, tier: "routine", atTier: [], deciderChoice: null }).level).toBe("held");
  });
});

function value<T>(r: { ok: true; value: T } | { ok: false; error: { problem: string } }): T {
  if (!r.ok) throw new Error(r.error.problem);
  return r.value;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function randomInput(rand: () => number) {
  const n = 1 + Math.floor(rand() * 3);
  const entries = ["sub-a:m@high", "key-a:m@high", "key-b:m@high"].slice(0, n);
  const levels = ["routine", "standard", "hard"] as const;
  const bands = ["A", "B", "C", "new"] as const;
  const classes = ["flagship", "everyday", "fast", "unknown"] as const;
  const candidates = entries.map((entry, rank) => cand({
    entry,
    rank,
    kindOf: entry.startsWith("key-") ? "api-key" : "subscription",
    level: levels[Math.floor(rand() * levels.length)] ?? "routine",
    band: bands[Math.floor(rand() * bands.length)] ?? "new",
    modelClass: classes[Math.floor(rand() * classes.length)] ?? "unknown",
    window: rand() < 0.5 ? null : rand(),
    expectedUsd: entry.startsWith("key-") ? rand() * 8 : null,
    reservation: 5,
    minutes: Math.floor(rand() * 40),
    family: rand() < 0.2 ? "unknown" : "fam-a",
    available: rand() < 0.85 ? true : { reason: "marked", until: T },
    gate: rand() < 0.9 ? "ok" : "repo",
  }));
  const sizes = ["S", "M", "L", "unknown"] as const;
  const kinds = ["docs", "fix", "feature", "unknown"] as const;
  return {
    role: "implement-backend",
    reviewRule: false,
    implementerFamilies: [] as string[],
    reviewFamilies: [] as string[],
    candidates,
    profile: profile({
      size: { value: sizes[Math.floor(rand() * sizes.length)] ?? "unknown", source: "flag" },
      kind: { value: kinds[Math.floor(rand() * kinds.length)] ?? "unknown", source: "flag" },
      risk: { value: rand() < 0.2, source: "flag" },
    }),
    settings: { ...settings(), taskCeiling: 1 + rand() * 4 },
    derived: entries,
  };
}
