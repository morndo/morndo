// Review findings for auto routing PR 1. Names here are test data.
import { describe, expect, it } from "vitest";
import {
  decide, familyOf, modelClassOf, parseFact, reasonOk, recordFact, scorecard, setDailyCap, setReserve,
  setSaveLine, setTaskCeiling, taskProfile, tierOf, type CandidateFacts, type OutcomeFact, type TaskProfile,
} from "../src/index.ts";
import { emptyPolicy, setPriority } from "../src/index.ts";

const T = 1_700_000_000_000;

function profile(over: Partial<TaskProfile> = {}): TaskProfile {
  return {
    role: "implement-backend", group: "implement",
    risk: { value: false, source: "default" }, kind: { value: "unknown", source: "default" },
    size: { value: "unknown", source: "default" }, round: { value: 1, source: "default" },
    priority: { value: "normal", source: "default" }, workspace: "ws", languages: [],
    task: null, lane: null, implementers: [], brief: null, ...over,
  };
}

function cand(over: Partial<CandidateFacts> & { entry: string }): CandidateFacts {
  return {
    connection: over.connection ?? over.entry.split(":")[0] ?? "c",
    kindOf: "subscription", family: "fam-a", modelClass: "everyday", inChain: true, rank: 0,
    available: true, gate: "ok", reservation: null, expectedUsd: null, costFrom: null,
    committedToday: 0, dailyCap: 10, window: null, level: "hard", band: "new", minutes: null,
    heldSince: null, heldWhy: null, ownModel: true, ...over,
  };
}

function run(candidates: readonly CandidateFacts[], derived: readonly string[], over: Partial<TaskProfile> = {}) {
  return decide({
    role: "implement-backend", reviewRule: false, implementerFamilies: [], reviewFamilies: [],
    candidates, profile: profile(over), settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} }, derived,
  });
}

describe("unknown metered cost and the daily cap", () => {
  const routine = { size: { value: "S" as const, source: "flag" as const }, kind: { value: "docs" as const, source: "flag" as const } };

  it("excludes a metered key once committed spend is already at or past the cap", () => {
    const atCap = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: null, committedToday: 10, dailyCap: 10, level: "hard" }),
      cand({ entry: "sub-a:m@high", level: "routine", rank: 1 }),
    ], ["key-a:m@high", "sub-a:m@high"], { risk: { value: true, source: "flag" } });
    expect(atCap.excluded[0]?.reason).toMatchObject({ code: "budget", name: "daily-cap" });
    expect(atCap.pick).toBe("sub-a:m@high");

    const past = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: null, committedToday: 10.01, dailyCap: 10 }),
    ], ["key-a:m@high"]);
    expect(past.excluded[0]?.reason.name).toBe("daily-cap");
  });

  it("excludes a metered key of unknown cost under the cap: an unknown cost is not free", () => {
    const got = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: null, committedToday: 1, dailyCap: 10, level: "routine", rank: 0 }),
      cand({ entry: "sub-a:m@high", window: null, level: "hard", rank: 1 }),
    ], ["key-a:m@high", "sub-a:m@high"], routine);
    expect(got.excluded).toEqual([{ entry: "key-a:m@high", reason: { code: "budget", stage: "rules", name: "no-price" } }]);
    expect(got.pick).toBe("sub-a:m@high");
    expect(got.ranked).toEqual(["sub-a:m@high"]);
  });

  it("treats a sum that lands on the cap as allowed, in cents", () => {
    const at = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 0.55, reservation: 10, committedToday: 1.1, dailyCap: 1.65, level: "routine" }),
      cand({ entry: "sub-a:m@high", rank: 1 }),
    ], ["key-a:m@high", "sub-a:m@high"]);
    expect(at.excluded).toEqual([]);

    const over = run([
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 0.56, reservation: 10, committedToday: 1.1, dailyCap: 1.65, level: "routine" }),
    ], ["key-a:m@high"]);
    expect(over.excluded[0]?.reason).toMatchObject({ code: "budget", name: "daily-cap" });
  });
});

describe("reason names, settings, custody cost, families and review", () => {
  it("normalizes an engine availability reason to a token", () => {
    const got = run([
      cand({ entry: "sub-a:m@high", available: { reason: "signed_out", until: null } }),
    ], ["sub-a:m@high"]);
    expect(got.excluded[0]?.reason.name).toBe("signed-out");
    expect(got.excluded[0] ? reasonOk(got.excluded[0].reason) : false).toBe(true);
  });

  it("refuses a ceiling, save line, cap or reserve that is not a finite non-negative number", () => {
    const policy = emptyPolicy();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(setTaskCeiling(policy, bad, "step-up", "c1", T).ok).toBe(false);
      expect(setSaveLine(policy, bad, "step-up", "c1", T).ok).toBe(false);
      expect(setDailyCap(policy, "key-a", bad, "step-up", "c1", T).ok).toBe(false);
      expect(setReserve(policy, "implement", bad, "step-up", "c1", T).ok).toBe(false);
    }
    expect(policy.autoSettings.taskCeiling).toBe(3);
    expect(policy.autoSettings.saveLine).toBe(0.5);
  });

  it("ranks a subscription the gate does not cover as an unknown cost", () => {
    const routine = { size: { value: "S" as const, source: "flag" as const }, kind: { value: "docs" as const, source: "flag" as const } };
    const got = run([
      cand({ entry: "sub-a:m@high", gate: "not-ours", window: null, rank: 0 }),
      cand({ entry: "key-a:m@high", kindOf: "api-key", expectedUsd: 4, reservation: 10, level: "routine", rank: 1 }),
    ], ["sub-a:m@high", "key-a:m@high"], routine);
    expect(got.pick).toBe("key-a:m@high");
    expect(got.ranked[0]).toBe("key-a:m@high");
  });

  it("strips model options before a family or class pattern", () => {
    const families = [{ pattern: "auto", family: "unknown" }, { pattern: "claude-*", family: "anthropic" }];
    expect(familyOf("auto[mode=fast]", families, "cursor")).toBe("unknown");
    expect(modelClassOf("sonnet-5.5[effort=high]", [{ pattern: "*sonnet*", class: "everyday" }])).toBe("everyday");
  });

  it("counts every earlier implementer family, and not unknown, when the review chain would be emptied", () => {
    const onlyUnknownLeft = decide({
      role: "implement-backend", reviewRule: true, implementerFamilies: [], reviewFamilies: ["fam-a", "unknown"],
      candidates: [cand({ entry: "sub-a:m@high", family: "fam-a" })],
      profile: profile(), settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} },
      derived: ["sub-a:m@high"],
    });
    expect(onlyUnknownLeft.excluded.map(row => row.entry)).toEqual(["sub-a:m@high"]);

    const earlier = decide({
      role: "implement-backend", reviewRule: true, implementerFamilies: ["fam-b"], reviewFamilies: ["fam-a", "fam-b"],
      candidates: [cand({ entry: "sub-a:m@high", family: "fam-a" })],
      profile: profile(), settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} },
      derived: ["sub-a:m@high"],
    });
    expect(earlier.excluded.map(row => row.entry)).toEqual(["sub-a:m@high"]);

    const remains = decide({
      role: "implement-backend", reviewRule: true, implementerFamilies: ["fam-b"], reviewFamilies: ["fam-a", "fam-c"],
      candidates: [cand({ entry: "sub-a:m@high", family: "fam-a" })],
      profile: profile(), settings: { taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} },
      derived: ["sub-a:m@high"],
    });
    expect(remains.excluded).toEqual([]);
  });

  it("breaks an equal rank by the derived chain, not by the order of the candidates", () => {
    const routine = { size: { value: "S" as const, source: "flag" as const }, kind: { value: "docs" as const, source: "flag" as const } };
    const first = cand({ entry: "sub-a:m1@high", rank: 0 });
    const second = cand({ entry: "sub-a:m2@high", rank: 0 });
    expect(run([second, first], ["sub-a:m1@high", "sub-a:m2@high"], routine).pick).toBe("sub-a:m1@high");
    expect(run([first, second], ["sub-a:m2@high", "sub-a:m1@high"], routine).pick).toBe("sub-a:m2@high");
  });
});

describe("outcome facts and conventional titles", () => {
  it("refuses a non-finite fact, and a status line that bypasses parseFact", () => {
    expect(parseFact({ source: "lease", kind: "cost", route: "rt-1", at: T, usd: Number.NaN, spend: "provider" }).ok).toBe(false);
    expect(parseFact({ source: "lease", kind: "minutes", route: "rt-1", at: Number.POSITIVE_INFINITY, n: 1 }).ok).toBe(false);
    expect(parseFact({ source: "board", kind: "findings", route: "rt-1", at: T, n: Number.NaN }).ok).toBe(false);
    const ran: OutcomeFact = { route: "rt-1", at: T, kind: "ran", source: "lease", text: "STATUS: DONE" };
    expect(recordFact([], ran, { lane: "lane-a" }).ok).toBe(false);
  });

  it("does not call a cell band A when no findings were recorded", () => {
    const facts = [];
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const id = `rt-${i}`;
      runs.push({ id, at: T + i, group: "implement", tier: "routine" as const, task: "T-1", lane: "lane-a" });
      facts.push(
        { route: id, at: T + i, kind: "ran" as const, source: "lease" as const, text: "key-a:m@high" },
        { route: id, at: T + i, kind: "accepted" as const, source: "board" as const, bool: true },
      );
    }
    const cell = scorecard(facts, runs, T + 5);
    expect(cell[0]?.n).toBe(5);
    expect(cell[0]?.k).toBe(5);
    expect(cell[0]?.findings).toBeNull();
    expect(cell[0]?.band).toBe("B");
  });

  it("reads a scoped or breaking conventional title", () => {
    const scoped = taskProfile({ role: "implement", workspace: "ws", title: "fix(parser): off by one", size: "S" });
    expect(scoped.kind.value).toBe("fix");
    expect(tierOf(scoped).tier).toBe("routine");
    expect(taskProfile({ role: "implement", workspace: "ws", title: "feat!: drop the flag" }).kind.value).toBe("feature");
    expect(taskProfile({ role: "implement", workspace: "ws", title: "chore(deps)!: bump the lock" }).kind.value).toBe("chore");
  });
});

describe("the priority command is not a second auto switch", () => {
  it("refuses to turn auto on without step-up, and records AutoSwitched when it has it", () => {
    const policy = emptyPolicy();
    const session = setPriority(policy, { mode: "custom", order: [], auto: true }, [], "c1", T);
    expect(session.ok).toBe(false);
    expect(policy.priority.auto).toBe(false);
    const stepped = setPriority(policy, { mode: "custom", order: [], auto: true }, [], "c1", T, "step-up");
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    expect(stepped.value.priority.auto).toBe(true);
    expect(stepped.value.events.some(event => event.type === "AutoSwitched" && event.scope === "global" && event.on)).toBe(true);
  });
});
