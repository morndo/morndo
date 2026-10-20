// Fix round 1 for auto routing PR 1 (design sections 7.1, 7.2; R19, R22, R25, R26). Names here are test data.
import { describe, expect, it } from "vitest";
import { decide, emptyPolicy, ensureRole, parseFact, recordFact, scorecard, setPriority, type CandidateFacts, type OutcomeFact, type TaskProfile } from "../src/index.ts";

const T = 1_700_000_000_000;

function fact(over: Partial<OutcomeFact> & Pick<OutcomeFact, "kind" | "source">): OutcomeFact {
  const parsed = parseFact({ route: "rt-1", at: T, ...over });
  if (!parsed.ok) throw new Error("bad fact in test");
  return parsed.value;
}

describe("an Outcome adds up all of a route's Leases (design 7.1)", () => {
  const run = { id: "rt-1", at: T, group: "implement", tier: "standard" as const, task: "T-1", lane: "lane-a" };
  const ran = fact({ kind: "ran", source: "lease", text: "key-a:m@high" });
  const accepted = fact({ kind: "accepted", source: "board", bool: true, at: T + 10 });

  it("the cell sees the sum of three Leases' cost and minutes", () => {
    const facts = [
      ran, accepted,
      fact({ kind: "cost", source: "lease", lease: "l-1", usd: 0.8, spend: "provider" }),
      fact({ kind: "cost", source: "lease", lease: "l-2", usd: 0.6, spend: "provider" }),
      fact({ kind: "cost", source: "lease", lease: "l-3", usd: 0.5, spend: "provider" }),
      fact({ kind: "minutes", source: "lease", lease: "l-1", n: 12 }),
      fact({ kind: "minutes", source: "lease", lease: "l-2", n: 8 }),
      fact({ kind: "minutes", source: "lease", lease: "l-3", n: 5 }),
    ];
    const [cell] = scorecard(facts, [run], T + 100);
    expect(cell?.medianUsd).toBeCloseTo(1.9, 9);
    expect(cell?.medianMinutes).toBe(25);
  });

  it("a higher-trust fact for one Lease replaces only that Lease's figure", () => {
    const facts = [
      ran, accepted,
      fact({ kind: "cost", source: "lease", lease: "l-1", usd: 0.8, spend: "provider" }),
      fact({ kind: "cost", source: "lease", lease: "l-2", usd: 0.6, spend: "estimate" }),
      fact({ kind: "cost", source: "principal", lease: "l-2", at: T + 5, usd: 0.7, spend: "manual" }),
    ];
    expect(scorecard(facts, [run], T + 100)[0]?.medianUsd).toBeCloseTo(1.5, 9);
  });

  it("a second Lease's smaller estimate is not refused, while a lower estimate for the same Lease still is", () => {
    const first = fact({ kind: "cost", source: "lease", lease: "l-1", usd: 0.8, spend: "estimate" });
    const second = fact({ kind: "cost", source: "lease", lease: "l-2", at: T + 1, usd: 0.6, spend: "estimate" });
    const added = recordFact([first], second, { lane: "lane-a" });
    expect(added.ok).toBe(true);
    const lowered = fact({ kind: "cost", source: "lease", lease: "l-1", at: T + 2, usd: 0.3, spend: "estimate" });
    expect(recordFact([first], lowered, { lane: "lane-a" }).ok).toBe(false);
  });
});

function profile(role: string): TaskProfile {
  return {
    role, group: role.split("-")[0] ?? role,
    risk: { value: false, source: "default" }, kind: { value: "unknown", source: "default" },
    size: { value: "unknown", source: "default" }, round: { value: 1, source: "default" },
    priority: { value: "normal", source: "default" }, workspace: "ws", languages: [],
    task: null, lane: null, implementers: [], brief: null,
  };
}

function cand(entry: string, family: string): CandidateFacts {
  return {
    entry, connection: entry.split(":")[0] ?? "c", kindOf: "subscription", family, modelClass: "everyday", inChain: true,
    rank: 0, available: true, gate: "ok", reservation: null, expectedUsd: null, costFrom: null, committedToday: 0,
    dailyCap: 10, window: null, level: "hard", band: "new", minutes: null, heldSince: null, heldWhy: null,
  };
}

describe("R19 applies to every checking role, not only `review`", () => {
  const run = (role: string, reviewRule: boolean) => decide({
    role, reviewRule, implementerFamilies: ["fam-a"], reviewFamilies: ["fam-a", "fam-b"],
    candidates: [cand("sub-a:m@high", "fam-a"), cand("sub-b:m@high", "fam-b")], profile: profile(role),
    settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} }, derived: ["sub-a:m@high", "sub-b:m@high"],
  });

  it.each(["review", "review-fix", "verify", "verify-ui"])("%s with the rule on excludes the implementer's family", role => {
    const got = run(role, true);
    expect(got.excluded).toEqual([{ entry: "sub-a:m@high", reason: { code: "review", stage: "rules", name: "fam-a" } }]);
    expect(got.pick).toBe("sub-b:m@high");
  });

  it("control: with the rule off a checking role excludes nothing", () => {
    expect(run("verify", false).excluded).toEqual([]);
  });

  it("an implementer role keeps the review-chain branch", () => {
    const got = decide({
      role: "implement-backend", reviewRule: true, implementerFamilies: ["fam-b"], reviewFamilies: ["fam-a", "fam-c"],
      candidates: [cand("sub-a:m@high", "fam-a")], profile: profile("implement-backend"),
      settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} }, derived: ["sub-a:m@high"],
    });
    expect(got.excluded).toEqual([]);
  });
});

describe("the Scorecard keeps the last 20 outcomes (design 7.2)", () => {
  it("runs without an outcome do not push real outcomes out of the window", () => {
    const runs = [];
    const facts: OutcomeFact[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `rt-${i}`;
      runs.push({ id, at: T + i, group: "implement", tier: "routine" as const, task: "T-1", lane: "lane-a" });
      facts.push(fact({ route: id, at: T + i, kind: "ran", source: "lease", text: "key-a:m@high" }));
      // Every run from 20 on is still open: no accepted fact yet.
      if (i < 20) facts.push(fact({ route: id, at: T + i, kind: "accepted", source: "board", bool: i % 2 === 0 }));
    }
    const [cell] = scorecard(facts, runs, T + 100);
    expect(cell?.n).toBe(20);
    expect(cell?.k).toBe(10);
  });

  it("keeps only the newest 20 of 25 outcomes", () => {
    const runs = [];
    const facts: OutcomeFact[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `rt-${i}`;
      runs.push({ id, at: T + i, group: "implement", tier: "routine" as const, task: "T-1", lane: "lane-a" });
      facts.push(
        fact({ route: id, at: T + i, kind: "ran", source: "lease", text: "key-a:m@high" }),
        fact({ route: id, at: T + i, kind: "accepted", source: "board", bool: i >= 5 }),
      );
    }
    const [cell] = scorecard(facts, runs, T + 100);
    expect(cell?.n).toBe(20);
    expect(cell?.k).toBe(20);
  });
});

describe("R16: switching auto through the priority writes nothing", () => {
  it("an auto-only change appends AutoSwitched alone and leaves every role byte-equal", () => {
    const base = ensureRole(emptyPolicy(), "implement");
    const next = setPriority(base, { mode: "subscriptions-first", order: [], auto: true }, [], "c1", T, "step-up");
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.roles).toEqual(base.roles);
    expect(next.value.events.map(event => event.type)).toEqual(["AutoSwitched"]);
  });

  it("control: a changed mode still appends PriorityChanged", () => {
    const next = setPriority(emptyPolicy(), { mode: "keys-only", order: [], auto: true }, [], "c1", T, "step-up");
    expect(next.ok && next.value.events.map(event => event.type)).toEqual(["PriorityChanged", "AutoSwitched"]);
  });
});
