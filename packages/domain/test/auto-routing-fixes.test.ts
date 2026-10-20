// Fix round 1 for auto routing PR 1 (design sections 7.1, 7.2; R19, R22, R25, R26). Names here are test data.
import { describe, expect, it } from "vitest";
import { parseFact, recordFact, scorecard, type OutcomeFact } from "../src/index.ts";

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
