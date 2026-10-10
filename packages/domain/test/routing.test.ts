// Routing (ADR-0018; R7–R15). The derivation table from the design, plus the save refusals. Names here are test data;
// the domain sources name no vendor.
import { describe, expect, it } from "vitest";
import {
  chainText, checkOrder, deriveChain, drifted, effectiveOrder, emptyPolicy, ensureRole, grantDefaults, parseEngine,
  placeNew, planWrites, project, revokeName, setOverride, setPicks, setPriority, setRole, stillNamed, type Engine, type Listed, type Policy,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const e = (text: string): Engine => {
  const v = parseEngine(text);
  if (!v) throw new Error(`bad engine in test: ${text}`);
  return v;
};
const listed: Listed[] = [
  { name: "claude", kind: "subscription", models: ["sonnet-5.5", "opus-5.5"], efforts: ["high"] },
  { name: "codex", kind: "subscription", models: ["gpt-6-astra"], efforts: ["high"] },
  { name: "credit1", kind: "api-key", models: ["sonnet-5.5"], efforts: ["high"] },
  { name: "deepseek-main", kind: "api-key", models: ["deepseek-v4-pro"], efforts: ["high", "max"] },
];
const known = listed.map(l => ({ name: l.name, kind: l.kind }));
const picks = ["claude:sonnet-5.5@high", "deepseek-main:deepseek-v4-pro@high", "credit1:sonnet-5.5@high", "codex:gpt-6-astra@high"].map(e);
const ORDER = ["claude", "codex", "credit1", "deepseek-main"];

const value = <T>(r: { ok: true; value: T } | { ok: false; error: { problem: string; role?: string } }): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem} ${r.error.role ?? ""}`);
  return r.value;
};

function policy(mode: Policy["priority"]["mode"], order: readonly string[]): Policy {
  let p = ensureRole(emptyPolicy(), "implement-backend");
  p = value(setOverride(p, "implement-backend", "follow", null, listed, "c1", T));
  p = value(setPriority(p, { mode, order }, listed, "c1", T));
  return value(setPicks(p, "implement-backend", picks, null, listed, "c1", T));
}

describe("R8–R10: the derivation table", () => {
  const table: [Policy["priority"]["mode"], readonly string[], string][] = [
    ["subscriptions-first", ORDER, "claude:sonnet-5.5@high,codex:gpt-6-astra@high,credit1:sonnet-5.5@high,deepseek-main:deepseek-v4-pro@high"],
    ["keys-first", ORDER, "credit1:sonnet-5.5@high,deepseek-main:deepseek-v4-pro@high,claude:sonnet-5.5@high,codex:gpt-6-astra@high"],
    ["subscriptions-only", ORDER, "claude:sonnet-5.5@high,codex:gpt-6-astra@high"],
    ["keys-only", ORDER, "credit1:sonnet-5.5@high,deepseek-main:deepseek-v4-pro@high"],
    ["custom", ["deepseek-main", "claude"], "deepseek-main:deepseek-v4-pro@high,claude:sonnet-5.5@high"],
  ];
  it.each(table)("%s derives the chain in the mode's order", (mode, order, want) => {
    const p = policy(mode, order);
    const row = p.roles[0];
    if (!row) throw new Error("no role");
    expect(chainText(deriveChain(row.picks, effectiveOrder(p.priority, known), false)).join(",")).toBe(want);
  });

  it("keeps two picks on one connection in the role's own order", () => {
    const two = [e("claude:sonnet-5.5@high"), e("claude:opus-5.5@high"), e("credit1:sonnet-5.5@high")];
    const order = effectiveOrder({ mode: "subscriptions-first", order: ORDER }, known);
    expect(chainText(deriveChain(two, order, false))).toEqual(["claude:sonnet-5.5@high", "claude:opus-5.5@high", "credit1:sonnet-5.5@high"]);
  });

  it("a hand role keeps its picks exactly as listed", () => {
    let p = ensureRole(emptyPolicy(), "implement-backend");
    p = value(setPicks(p, "implement-backend", picks, null, listed, "c1", T));
    const row = p.roles[0];
    if (!row) throw new Error("no role");
    expect(chainText(deriveChain(row.picks, [], true)).join(",")).toBe(picks.map(x => `${x.provider}:${x.model}@${x.effort}`).join(","));
  });

  it("drops unknown names and never reorders because one is unavailable", () => {
    const order = effectiveOrder({ mode: "custom", order: ["missing", "claude", "credit1"] }, known);
    expect(order).toEqual(["claude", "credit1"]);
    const off = known;
    expect(effectiveOrder({ mode: "keys-only", order: ["claude", "credit1", "deepseek-main"] }, off)).toEqual(["credit1", "deepseek-main"]);
  });
});

describe("R7 and R11: a save is refused whole", () => {
  it("refuses a duplicate name and a name this node does not know", () => {
    expect(checkOrder(["claude", "claude"], ORDER).ok).toBe(false);
    expect(checkOrder(["nope"], ORDER).ok).toBe(false);
    expect(value(checkOrder(ORDER, ORDER))).toEqual(ORDER);
  });
  it("refuses an empty derived chain and a ninth entry, and names the role", () => {
    let p = ensureRole(emptyPolicy(), "review");
    p = value(setOverride(p, "review", "follow", null, listed, "c1", T));
    p = value(setPriority(p, { mode: "subscriptions-only", order: ["credit1"] }, listed, "c1", T));
    const empty = setPicks(p, "review", [e("credit1:sonnet-5.5@high")], null, listed, "c1", T);
    expect(empty.ok ? "" : empty.error).toMatchObject({ problem: "empty", role: "review" });
    const nine = Array.from({ length: 9 }, (_, i) => e(`claude:sonnet-5.5@high`.replace("sonnet-5.5", `m${i}`)));
    const longListed: Listed[] = [{ name: "claude", kind: "subscription", models: nine.map(x => x.model), efforts: ["high"] }];
    let wide = ensureRole(emptyPolicy(), "review");
    wide = value(setOverride(wide, "review", "follow", null, listed, "c1", T));
    wide = value(setPriority(wide, { mode: "custom", order: ["claude"] }, listed, "c1", T));
    const too = setPicks(wide, "review", nine, null, longListed, "c1", T);
    expect(too.ok ? "" : too.error.problem).toBe("too_long");
    const main = [e("claude:m0@high")];
    const emptyRisk = setPicks(wide, "review", main, [], longListed, "c1", T);
    expect(emptyRisk.ok ? "" : emptyRisk.error.problem).toBe("empty");
    const copiedRisk = setPicks(wide, "review", [e("claude:sonnet-5.5@high")], [e("claude:sonnet-5.5@high"), e("claude:sonnet-5.5@high")], listed, "c1", T);
    expect(copiedRisk.ok ? "" : copiedRisk.error.problem).toBe("copied");
    const longRisk = setPicks(wide, "review", main, nine, longListed, "c1", T);
    expect(longRisk.ok ? "" : longRisk.error.problem).toBe("too_long");
    const unfitRisk = setPicks(wide, "review", [e("claude:sonnet-5.5@high")], [e("claude:x0@high")], listed, "c1", T);
    expect(unfitRisk.ok ? "" : unfitRisk.error.problem).toBe("fit");
    const unknownRisk = setPicks(ensureRole(emptyPolicy(), "review"), "review", [e("claude:sonnet-5.5@high")], [e("nope:m@high")], listed, "c1", T);
    expect(unknownRisk.ok ? "" : unknownRisk.error.problem).toBe("unknown");
  });
  it("a hand role keeps a copy and an unlisted model it already had, and adds neither", () => {
    let p = ensureRole(emptyPolicy(), "review");
    const kept = [e("claude:unknown-model@high"), e("claude:unknown-model@high")];
    const row = p.roles[0];
    if (!row) throw new Error("role");
    p = { ...p, roles: [{ ...row, picks: kept }] };
    expect(setPicks(p, "review", kept, null, listed, "c1", T).ok).toBe(true);
    expect(setPicks(p, "review", [...kept, e("claude:opus-5.5@high")], null, listed, "c1", T).ok).toBe(true);
    const copy = setPicks(p, "review", [e("claude:sonnet-5.5@high"), e("claude:sonnet-5.5@high")], null, listed, "c1", T);
    expect(copy.ok ? "" : copy.error.problem).toBe("copied");
    const unfit = setPicks(ensureRole(emptyPolicy(), "review"), "review", [e("claude:x0@high")], null, listed, "c1", T);
    expect(unfit.ok ? "" : unfit.error.problem).toBe("fit");
    const stranger = setPicks(p, "review", [...kept, e("nope:anything@high")], null, listed, "c1", T);
    expect(stranger.ok ? "" : stranger.error.problem).toBe("unknown");
    const already = [e("nope:old@high"), e("claude:sonnet-5.5@high")];
    const held = { ...p, roles: [{ ...row, picks: already }] };
    expect(setPicks(held, "review", [e("claude:sonnet-5.5@high"), e("nope:old@high")], null, listed, "c1", T).ok).toBe(true);
    const added = setPicks(held, "review", [...already, e("ghost:m@high")], null, listed, "c1", T);
    expect(added.ok ? "" : added.error.problem).toBe("unknown");
    const fresh = [...Array.from({ length: 6 }, (_, i) => e(`claude:x${i}@high`)), e("claude:x0@high"), e("nope:anything@high")];
    const refused = setPicks(ensureRole(emptyPolicy(), "review"), "review", fresh, null, listed, "c1", T);
    expect(refused.ok ? "" : refused.error.problem).toBe("unknown");
    const longer = setPicks(p, "review", [...kept, ...kept, ...kept, ...kept, ...kept], null, listed, "c1", T);
    expect(longer.ok ? "" : longer.error.problem).toBe("too_long");
  });
});

describe("R12–R15: a new connection, drift, and revocation", () => {
  it("appends a new connection and grants a default pick only where it fits and the chain stays within eight", () => {
    let p = value(setPriority(emptyPolicy(), { mode: "keys-only", order: [] }, listed, "c1", T));
    p = placeNew(p, "credit1", T);
    expect(p.priority.order).toEqual(["credit1"]);
    expect(p.events.at(-1)).toMatchObject({ type: "PriorityChanged", command: null });
    p = ensureRole(p, "implement");
    p = value(setOverride(p, "implement", "follow", null, listed, "c1", T));
    const granted = grantDefaults(p, "credit1", [{ role: "implement", pick: e("credit1:sonnet-5.5@high") }], listed, T);
    expect(granted.skipped).toEqual([]);
    expect(granted.policy.roles[0]?.picks).toHaveLength(1);
    const skipped = grantDefaults(p, "credit1", [{ role: "implement", pick: e("credit1:not-listed@high") }], listed, T);
    expect(skipped.skipped).toEqual(["implement"]);
  });
  it("grants a default pick once", () => {
    let p = value(setPriority(emptyPolicy(), { mode: "keys-only", order: [] }, listed, "c1", T));
    p = placeNew(p, "credit1", T);
    p = ensureRole(p, "implement");
    p = value(setOverride(p, "implement", "follow", null, listed, "c1", T));
    p = value(setPicks(p, "implement", [e("credit1:sonnet-5.5@high")], null, listed, "c1", T));
    const again = grantDefaults(p, "credit1", [{ role: "implement", pick: e("credit1:sonnet-5.5@high") }], listed, T);
    const twice = grantDefaults(again.policy, "credit1", [{ role: "implement", pick: e("credit1:sonnet-5.5@high") }], listed, T);
    expect(again.policy.roles[0]?.picks).toHaveLength(1);
    expect(twice.policy.roles[0]?.picks).toHaveLength(1);
    expect(twice.skipped).toEqual([]);
  });
  it("a derived role whose chain changed outside is drifted; a hand role is not", () => {
    const p = policy("subscriptions-first", ORDER);
    const row = p.roles[0];
    if (!row) throw new Error("no role");
    const written = value(project(p, "implement-backend", known, T));
    const saved = written.roles[0];
    if (!saved?.written) throw new Error("not written");
    expect(drifted(saved, [...saved.written], saved.writtenRisk)).toBe(false);
    expect(drifted(saved, [...saved.written], ["y:m"])).toBe(true);
    expect(drifted(saved, [...saved.written], [])).toBe(false);
    expect(drifted(saved, ["claude:sonnet-5.5@high"], saved.writtenRisk)).toBe(true);
    expect(drifted({ ...saved, override: "hand" }, ["other:m"], null)).toBe(false);
  });
  it("revoking the only key keeps the last chain and the name stays until nothing names it", () => {
    let p = ensureRole(emptyPolicy(), "implement-backend");
    p = value(setOverride(p, "implement-backend", "follow", null, listed, "c1", T));
    p = value(setPriority(p, { mode: "keys-only", order: ["credit1"] }, listed, "c1", T));
    p = value(setPicks(p, "implement-backend", [e("credit1:sonnet-5.5@high")], null, listed, "c1", T));
    p = value(project(p, "implement-backend", known, T));
    const gone = revokeName(p, "credit1", known, T + 1);
    expect(gone.kept).toEqual(["implement-backend"]);
    expect(gone.policy.priority.order).toEqual([]);
    expect(gone.policy.roles[0]?.picks).toEqual([]);
    expect(gone.policy.roles[0]?.written?.[0]).toBe("credit1:sonnet-5.5@high");
    expect(stillNamed(gone.policy, "credit1")).toBe(true);
    const cleared = { ...gone.policy, roles: gone.policy.roles.map(r => ({ ...r, written: null })) };
    expect(stillNamed(cleared, "credit1")).toBe(false);
  });
  it("projects a risk chain, and a revoke that empties it keeps the last one", () => {
    let p = ensureRole(emptyPolicy(), "review");
    p = value(setOverride(p, "review", "follow", null, listed, "c1", T));
    p = value(setPriority(p, { mode: "custom", order: ["claude", "credit1"] }, listed, "c1", T));
    p = value(setPicks(p, "review", [e("claude:sonnet-5.5@high")], [e("credit1:sonnet-5.5@high")], listed, "c1", T));
    const written = value(project(p, "review", known, T));
    const row = written.roles[0];
    if (!row?.written) throw new Error("not written");
    expect(row.writtenRisk).toEqual(["credit1:sonnet-5.5@high"]);
    expect(drifted(row, row.written, row.writtenRisk)).toBe(false);
    expect(drifted(row, row.written, ["credit1:opus-5.5@high"])).toBe(true);
    const gone = revokeName(written, "credit1", known, T + 1);
    expect(gone.kept).toEqual(["review"]);
    expect(gone.policy.roles[0]?.riskPicks).toEqual([]);
    expect(gone.policy.roles[0]?.writtenRisk).toEqual(["credit1:sonnet-5.5@high"]);
    const again = value(project(gone.policy, "review", known, T + 2));
    expect(again.roles[0]?.writtenRisk).toEqual(["credit1:sonnet-5.5@high"]);
    expect(again.roles[0]?.written).toEqual(["claude:sonnet-5.5@high"]);
  });
  it("refuses a priority that leaves a follow role with nothing to run", () => {
    let p = ensureRole(emptyPolicy(), "review");
    p = value(setPicks(p, "review", [e("claude:sonnet-5.5@high")], null, listed, "c1", T));
    p = value(setPriority(p, { mode: "subscriptions-first", order: ["claude"] }, listed, "c1", T));
    p = value(setOverride(p, "review", "follow", null, listed, "c1", T));
    const keys = setPriority(p, { mode: "keys-only", order: ["claude"] }, listed, "c1", T);
    expect(keys.ok ? "" : keys.error).toMatchObject({ problem: "empty", role: "review" });
  });
  it("refuses to follow a hand chain that already has a copy", () => {
    let p = ensureRole(emptyPolicy(), "review");
    const hand = [e("claude:sonnet-5.5@high"), e("claude:sonnet-5.5@high")];
    const row = p.roles[0];
    if (!row) throw new Error("role");
    p = { ...p, roles: [{ ...row, picks: hand }] };
    p = value(setPriority(p, { mode: "custom", order: ["claude"] }, listed, "c1", T));
    const followed = setOverride(p, "review", "follow", null, listed, "c1", T);
    expect(followed.ok ? "" : followed.error).toMatchObject({ problem: "copied", role: "review" });
  });
  it("refuses to follow a hand chain longer than eight", () => {
    const picks = Array.from({ length: 9 }, (_, i) => e(`claude:m${i}@x`));
    let p = ensureRole(emptyPolicy(), "review");
    const row = p.roles[0];
    if (!row) throw new Error("role");
    p = { ...p, roles: [{ ...row, picks }] };
    p = value(setPriority(p, { mode: "custom", order: ["claude"] }, listed, "c1", T));
    const followed = setOverride(p, "review", "follow", null, listed, "c1", T);
    expect(followed.ok ? "" : followed.error).toMatchObject({ problem: "too_long", role: "review" });
  });
  it("refuses to follow a hand chain whose model does not fit", () => {
    let p = ensureRole(emptyPolicy(), "review");
    const row = p.roles[0];
    if (!row) throw new Error("role");
    p = { ...p, roles: [{ ...row, picks: [e("credit1:opus-5.5@high")] }] };
    p = value(setPriority(p, { mode: "keys-only", order: ["credit1"] }, listed, "c1", T));
    const followed = setOverride(p, "review", "follow", null, listed, "c1", T);
    expect(followed.ok ? "" : followed.error).toMatchObject({ problem: "fit", role: "review" });
  });
  it("a policy change without a command is refused", () => {
    expect(setPriority(emptyPolicy(), { mode: "custom", order: [] }, listed, "", T).ok).toBe(false);
  });
});

describe("planWrites", () => {
  it("plans a role whose chain is missing outside", () => {
    const written = value(project(policy("subscriptions-first", ORDER), "implement-backend", known, T));
    const planned = planWrites(written, known, []);
    expect(value(planned).map(row => row.role)).toEqual(["implement-backend"]);
  });

  it("plans nothing when the outside chain matches what was written", () => {
    const written = value(project(policy("subscriptions-first", ORDER), "implement-backend", known, T));
    const row = written.roles.find(item => item.role === "implement-backend");
    if (!row?.written) throw new Error("written");
    const planned = planWrites(written, known, [{ role: "implement-backend", chain: row.written, risk: null }]);
    expect(value(planned)).toEqual([]);
  });

  it("plans nothing for a chain that was already kept", () => {
    const written = value(project(policy("subscriptions-first", ORDER), "implement-backend", known, T));
    const row = written.roles.find(item => item.role === "implement-backend");
    if (!row) throw new Error("role");
    const emptied = {
      ...written,
      roles: [{ ...row, picks: [] }],
      events: [...written.events, { type: "ChainKept" as const, role: "implement-backend", at: T }],
    };
    expect(value(planWrites(emptied, known, [])).map(item => item.role)).toEqual([]);
  });
});

describe("setRole checks the final state once", () => {
  it("accepts a new order and new picks that would fail as an override first, and records both events", () => {
    let p = ensureRole(emptyPolicy(), "implement");
    p = value(setOverride(p, "implement", "follow", null, listed, "c1", T));
    p = value(setPriority(p, { mode: "custom", order: ["claude", "credit1"] }, listed, "c1", T));
    p = value(setPicks(p, "implement", [e("claude:sonnet-5.5@high")], null, listed, "c1", T));
    const stepped = setOverride(p, "implement", "own", { mode: "custom", order: ["credit1"] }, listed, "c1", T);
    expect(stepped.ok).toBe(false);
    const together = setRole(p, "implement", "own", { mode: "custom", order: ["credit1"] }, [e("credit1:sonnet-5.5@high")], null, listed, "c1", T + 1);
    const next = value(together);
    const row = next.roles.find(item => item.role === "implement");
    expect(row?.override).toBe("own");
    expect(row?.priority?.order).toEqual(["credit1"]);
    expect(chainText(row?.picks ?? [])).toEqual(["credit1:sonnet-5.5@high"]);
    expect(next.events.map(event => event.type)).toEqual(["OverrideChanged", "PriorityChanged", "PicksChanged", "OverrideChanged", "PicksChanged"]);
  });
});
