// A policy stored before Auto has no autoSettings and no role switch. Parsing fills the design defaults.
import { describe, expect, it } from "vitest";
import { adoptPolicy, parsePolicy, setRoleAuto, setTaskCeiling } from "../src/index.ts";

const T = 1_700_000_000_000;

const stored = {
  priority: { mode: "subscriptions-first", order: ["sub-a"] },
  roles: [
    {
      role: "implement-backend", override: "follow", priority: null,
      picks: [{ provider: "sub-a", model: "m", effort: "high" }],
      riskPicks: null, written: null, writtenRisk: null, seenChain: null, seenRisk: null,
    },
    {
      role: "review", override: "follow", priority: null,
      picks: [], riskPicks: null, written: null, writtenRisk: null, seenChain: null, seenRisk: null,
    },
  ],
  events: [{ type: "PriorityChanged", at: T, command: "c0" }],
};

describe("parsePolicy", () => {
  it("loads a policy from before Auto with the design defaults", () => {
    const policy = parsePolicy(stored);
    expect(policy).not.toBeNull();
    if (!policy) return;
    expect(policy.priority.auto).toBe(false);
    expect(policy.autoSettings).toEqual({ taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} });
    expect(policy.roles.find(row => row.role === "implement-backend")?.auto).toBe(true);
    expect(policy.roles.find(row => row.role === "review")?.auto).toBe(false);
    const same = setRoleAuto(policy, "implement-backend", true, "session", "c1", T);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.value.events).toEqual(policy.events);
    const lowered = setTaskCeiling(policy, 2, "session", "c1", T);
    expect(lowered.ok).toBe(true);
    if (lowered.ok) expect(lowered.value.autoSettings.taskCeiling).toBe(2);
  });

  it("refuses a body that is not a policy", () => {
    expect(parsePolicy(null)).toBeNull();
    expect(parsePolicy({ priority: { mode: "custom" } })).toBeNull();
  });

  it("adoptPolicy keeps a stored policy the strict parser refuses and fills the Auto fields", () => {
    const { events: _events, ...stubborn } = stored;
    void _events;
    expect(parsePolicy(stubborn)).toBeNull();
    const policy = adoptPolicy(stubborn);
    expect(policy).not.toBeNull();
    if (!policy) return;
    expect(policy.priority.auto).toBe(false);
    expect(policy.events).toEqual([]);
    expect(policy.autoSettings).toEqual({ taskCeiling: 3, saveLine: 0.5, dailyCaps: {}, reserves: {} });
    expect(policy.roles.find(row => row.role === "implement-backend")?.auto).toBe(true);
    expect(policy.roles.find(row => row.role === "review")?.auto).toBe(false);
    expect(policy.roles[0]?.picks).toHaveLength(1);
  });

  it("adoptPolicy keeps the stored Auto settings of a policy the strict parser refuses", () => {
    const { events: _events, ...stubborn } = stored;
    void _events;
    const saved = { ...stubborn, autoSettings: { taskCeiling: 1.5, saveLine: 0.7, dailyCaps: { "key-a": 4 }, reserves: { review: 2 } } };
    expect(parsePolicy(saved)).toBeNull();
    expect(adoptPolicy(saved)?.autoSettings).toEqual({ taskCeiling: 1.5, saveLine: 0.7, dailyCaps: { "key-a": 4 }, reserves: { review: 2 } });
  });

  it("adoptPolicy returns null for something that is not a policy", () => {
    expect(adoptPolicy(null)).toBeNull();
    expect(adoptPolicy({ priority: "custom", roles: [] })).toBeNull();
    expect(adoptPolicy({ priority: { mode: "custom", order: [] }, roles: "implement" })).toBeNull();
  });
});
