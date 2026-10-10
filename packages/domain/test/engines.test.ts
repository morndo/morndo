// Engines (ADR-0013; R1–R6 in docs/domain.md): which provider and model does each role's work, with its fallbacks.
// The engine text the engine layer's CLI reads and writes, availability as its resolver reports it, the page's edits
// and what a save writes. Synthetic data shaped like `engines get --json` and `engines providers --json`.
import { describe, expect, it } from "vitest";
import {
  MAX_CHAIN, addFallback, availabilityOf, effortFromText, changesBetween, checkChanges, engineText, moveEngine, parseEngine, removeEngine, replaceEngine,
  repeatsAbove, retarget, setOtherProvider, suggestFallback, type Engine, type EngineProvider, type RoleEngines,
} from "../src/index.ts";

const provider = (name: string, models: string[], efforts: string[] | null, o: Partial<EngineProvider> = {}): EngineProvider =>
  ({ name, label: name, kind: "cli", models, efforts, availability: "ready", until: null, pausedModels: [], ...o });
const CATALOG: EngineProvider[] = [
  provider("claude", ["opus-5.5", "sonnet-5.5"], ["low", "medium", "high", "xhigh", "max"]),
  provider("cursor", ["claude-sonnet-5.5", "gpt-5.6-sol", "auto"], ["low", "medium", "high"], { availability: "signed_out" }),
  provider("codex", ["gpt-6-astra", "gpt-6.1-sol"], ["low", "high", "ultra"]),
  provider("studio", ["chatgpt", "gemini"], [], { kind: "studio" }),
];
const e = (text: string): Engine => {
  const v = parseEngine(text);
  if (!v) throw new Error(`bad engine in test: ${text}`);
  return v;
};
const role = (name: string, chain: string[], o: Partial<RoleEngines> = {}): RoleEngines =>
  ({ role: name, label: name, chain: chain.map(e), riskChain: null, otherProvider: false, ...o });
const texts = (r: RoleEngines) => r.chain.map(engineText);
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe("the engine text (R1): provider:model[@effort], as the engine layer's CLI writes it", () => {
  it("reads and writes the three parts; no effort means the provider's own default", () => {
    expect(parseEngine("cursor:claude-sonnet-5.5@high")).toEqual({ provider: "cursor", model: "claude-sonnet-5.5", effort: "high" });
    expect(parseEngine("studio:chatgpt")).toEqual({ provider: "studio", model: "chatgpt", effort: "" });
    expect(engineText({ provider: "codex", model: "gpt-6-astra", effort: "" })).toBe("codex:gpt-6-astra");
    expect(engineText(e("claude:opus-5.5@xhigh"))).toBe("claude:opus-5.5@xhigh");
  });
  it("trims surrounding whitespace, as the CLI's parse_entry does, and still refuses a space inside", () => {
    expect(parseEngine("  claude:opus-5.5@high\n")).toEqual({ provider: "claude", model: "opus-5.5", effort: "high" });
    expect(parseEngine("\tclaude:opus ")).toEqual({ provider: "claude", model: "opus", effort: "" });
    expect(parseEngine("claude:opus 5")).toBeNull();
  });
  it("allows a comma inside [options] and refuses one outside, which the CLI would split into two entries", () => {
    expect(parseEngine("claude:opus-5.5[a=1,b=2]@high")).toEqual({ provider: "claude", model: "opus-5.5[a=1,b=2]", effort: "high" });
    expect(parseEngine("claude:opus,foo")).toBeNull();
    expect(parseEngine("claude:opus[a=1],foo")).toBeNull();
    expect(checkChanges([role("plan", ["claude:opus-5.5@high"])], CATALOG, [{ role: "plan", chain: ["claude:opus,foo"] }]))
      .toEqual({ ok: false, error: { role: "plan", problem: "bad_engine" } });
  });
  it("refuses what the CLI would refuse: no provider, capitals in the provider, an empty model, a bare @", () => {
    for (const bad of ["opus-5.5", "Claude:opus", "claude:", "claude:opus@", "claude:opus@HIGH", "claude:opus 5"]) {
      expect(parseEngine(bad), bad).toBeNull();
    }
  });
});

describe("availability as the resolver reports it (R2)", () => {
  const base = { enabled: true, installed: true, login: "ok" as const, providerMarked: false };
  it("ready when on, installed, signed in and not paused", () => {
    expect(availabilityOf(base)).toBe("ready");
  });
  it("in the resolver's order: off, not installed, signed out, out of quota; an unconfirmed sign-in still runs", () => {
    expect(availabilityOf({ ...base, enabled: false, installed: false, login: "missing", providerMarked: true })).toBe("off");
    expect(availabilityOf({ ...base, installed: false, login: "missing", providerMarked: true })).toBe("not_installed");
    expect(availabilityOf({ ...base, login: "missing", providerMarked: true })).toBe("signed_out");
    expect(availabilityOf({ ...base, providerMarked: true })).toBe("out_of_quota");
    expect(availabilityOf({ ...base, login: "unknown" })).toBe("unconfirmed");
  });
});

describe("the edits (R3): each returns a new role or the reason it can't, and never changes the one passed in", () => {
  const review = role("review", ["claude:opus-5.5@high", "codex:gpt-6-astra@high"]);

  it("the first choice can be replaced by any known model and an effort its provider takes", () => {
    const r = value(replaceEngine(review, 0, e("cursor:gpt-5.6-sol@medium"), CATALOG));
    expect(texts(r)).toEqual(["cursor:gpt-5.6-sol@medium", "codex:gpt-6-astra@high"]);
    expect(texts(review)).toEqual(["claude:opus-5.5@high", "codex:gpt-6-astra@high"]);
  });
  it("refuses an unknown provider, a model outside the provider's list and an effort the provider doesn't take", () => {
    expect(replaceEngine(review, 0, e("kimi:k3"), CATALOG)).toEqual({ ok: false, error: "unknown_provider" });
    expect(replaceEngine(review, 0, e("claude:opus-9"), CATALOG)).toEqual({ ok: false, error: "unknown_model" });
    expect(replaceEngine(review, 0, e("claude:opus-5.5@ultra"), CATALOG)).toEqual({ ok: false, error: "unknown_effort" });
    expect(replaceEngine(review, 0, e("studio:chatgpt@high"), CATALOG)).toEqual({ ok: false, error: "unknown_effort" });
  });
  it("as the CLI reads a provider's lists: no known models means any model; a model's [options] don't count", () => {
    const open = [...CATALOG, provider("local", [], ["high"])];
    expect(texts(value(replaceEngine(review, 1, e("local:anything-7b@high"), open)))).toEqual(["claude:opus-5.5@high", "local:anything-7b@high"]);
    expect(texts(value(replaceEngine(review, 1, e("cursor:auto[fast=true]"), CATALOG)))).toEqual(["claude:opus-5.5@high", "cursor:auto[fast=true]"]);
  });
  it("a provider that lists no efforts (null, the CLI's missing key) takes any effort; one listing [] takes none", () => {
    const free = [...CATALOG, provider("free", ["m-1", "m-2"], null)];
    expect(texts(value(replaceEngine(review, 1, e("free:m-1@turbo"), free)))).toEqual(["claude:opus-5.5@high", "free:m-1@turbo"]);
    expect(replaceEngine(review, 1, e("studio:chatgpt@turbo"), free)).toEqual({ ok: false, error: "unknown_effort" });
    expect(retarget(e("claude:opus-5.5@xhigh"), "free", free)).toEqual(e("free:m-1@xhigh"));
    expect(suggestFallback(role("r", ["claude:opus-5.5@max"]), [provider("claude", ["opus-5.5"], ["max"]), provider("free", ["m-1"], null)])).toEqual(e("free:m-1@max"));
  });
  it("an effort typed for a provider that lists none: empty is its default; otherwise lowercase letters, as the CLI reads one", () => {
    expect(effortFromText("")).toBe("");
    expect(effortFromText("  turbo ")).toBe("turbo");
    for (const bad of ["High", "x y", "high!", "@high", "h1gh"]) expect(effortFromText(bad), bad).toBeNull();
  });
  it("no effort always fits (the provider's default)", () => {
    expect(texts(value(replaceEngine(review, 1, e("codex:gpt-6.1-sol"), CATALOG)))).toEqual(["claude:opus-5.5@high", "codex:gpt-6.1-sol"]);
  });
  it("the same engine twice in one chain is refused: the second could never run", () => {
    expect(replaceEngine(review, 1, e("claude:opus-5.5@high"), CATALOG)).toEqual({ ok: false, error: "duplicate" });
    expect(addFallback(review, e("codex:gpt-6-astra@high"), CATALOG)).toEqual({ ok: false, error: "duplicate" });
    // the same model at another effort is another engine
    expect(texts(value(addFallback(review, e("claude:opus-5.5@max"), CATALOG)))).toHaveLength(3);
  });
  it("a fallback goes to the end; moving one up makes it the first choice", () => {
    const added = value(addFallback(review, e("studio:gemini"), CATALOG));
    expect(texts(added)).toEqual(["claude:opus-5.5@high", "codex:gpt-6-astra@high", "studio:gemini"]);
    expect(texts(value(moveEngine(review, 1, -1)))).toEqual(["codex:gpt-6-astra@high", "claude:opus-5.5@high"]);
    expect(moveEngine(review, 0, -1)).toEqual({ ok: false, error: "out_of_range" });
    expect(moveEngine(review, 1, 1)).toEqual({ ok: false, error: "out_of_range" });
  });
  it("a role always keeps one engine: removing the last is refused", () => {
    const one = value(removeEngine(review, 0));
    expect(texts(one)).toEqual(["codex:gpt-6-astra@high"]);
    expect(removeEngine(one, 0)).toEqual({ ok: false, error: "last_engine" });
    expect(removeEngine(review, 5)).toEqual({ ok: false, error: "out_of_range" });
  });
  it("the reviewer-from-another-provider rule is a switch on the role", () => {
    expect(setOtherProvider(review, true).otherProvider).toBe(true);
    expect(review.otherProvider).toBe(false);
  });
});

describe("one limit on a chain's length (R3, R5)", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `free:m-${i}@high`);
  const free = [...CATALOG, provider("free", Array.from({ length: 20 }, (_, i) => `m-${i}`), ["high"])];
  it("a list holds at most MAX_CHAIN engines: adding past it is refused", () => {
    expect(MAX_CHAIN).toBe(8);
    expect(addFallback(role("r", many(MAX_CHAIN)), e("claude:opus-5.5@high"), free)).toEqual({ ok: false, error: "too_long" });
    expect(addFallback(role("r", many(MAX_CHAIN - 1)), e("claude:opus-5.5@high"), free).ok).toBe(true);
  });
  it("a save past the limit is refused, naming the role", () => {
    const roles = [role("plan", many(2))];
    expect(checkChanges(roles, free, [{ role: "plan", chain: many(MAX_CHAIN + 1) }])).toEqual({ ok: false, error: { role: "plan", problem: "too_long" } });
  });
  it("a role already over the limit (set by hand) can still be edited: it may get shorter or stay, never longer", () => {
    const roles = [role("plan", many(MAX_CHAIN + 2))];
    expect(checkChanges(roles, free, [{ role: "plan", chain: [...many(MAX_CHAIN + 2)].reverse() }]).ok).toBe(true);
    expect(checkChanges(roles, free, [{ role: "plan", chain: many(MAX_CHAIN + 1) }]).ok).toBe(true);
    expect(checkChanges(roles, free, [{ role: "plan", chain: many(MAX_CHAIN + 3) }])).toEqual({ ok: false, error: { role: "plan", problem: "too_long" } });
  });
});

describe("switching an engine's provider (R3)", () => {
  it("takes the provider's first model and keeps the effort when the new provider takes it", () => {
    expect(retarget(e("claude:opus-5.5@high"), "codex", CATALOG)).toEqual(e("codex:gpt-6-astra@high"));
  });
  it("skips a model whose engine the chain already holds, so switching never lands on a duplicate", () => {
    const taken = [e("claude:opus-5.5@high")];
    expect(retarget(e("codex:gpt-6-astra@high"), "claude", CATALOG, taken)).toEqual(e("claude:sonnet-5.5@high"));
  });
  it("otherwise the effort becomes high when offered, else the provider's default", () => {
    expect(retarget(e("claude:opus-5.5@xhigh"), "codex", CATALOG)).toEqual(e("codex:gpt-6-astra@high"));
    expect(retarget(e("claude:opus-5.5@high"), "studio", CATALOG)).toEqual(e("studio:chatgpt"));
  });
});

describe("the fallback the page suggests to add (R3)", () => {
  it("the first available provider not yet in the chain, at the first choice's effort when it takes it", () => {
    const r = role("review", ["claude:opus-5.5@high"]);
    expect(suggestFallback(r, CATALOG)).toEqual(e("claude:sonnet-5.5@high"));          // claude's next model first
    const all = role("review", ["claude:opus-5.5@high", "claude:sonnet-5.5@high"]);
    expect(suggestFallback(all, CATALOG)).toEqual(e("codex:gpt-6-astra@high"));        // cursor is signed out: skipped
  });
  it("an unavailable provider only when no available one is left, and null when every engine is in", () => {
    const tiny = [provider("claude", ["opus-5.5"], ["high"]), provider("cursor", ["auto"], ["high"], { availability: "signed_out" })];
    expect(suggestFallback(role("r", ["claude:opus-5.5@high"]), tiny)).toEqual(e("cursor:auto@high"));
    expect(suggestFallback(role("r", ["claude:opus-5.5@high", "cursor:auto@high"]), tiny)).toBeNull();
  });
});

describe("what a save writes (R4)", () => {
  const saved = [role("plan", ["claude:opus-5.5@high"]), role("review", ["claude:opus-5.5@high", "codex:gpt-6-astra@high"])];
  it("nothing when nothing changed", () => {
    expect(changesBetween(saved, saved.map(r => ({ ...r })))).toEqual([]);
  });
  it("a changed role's whole chain, in order, as the CLI's text; the rule only when it changed", () => {
    const draft = [saved[0] as RoleEngines, setOtherProvider(value(moveEngine(saved[1] as RoleEngines, 1, -1)), true)];
    expect(changesBetween(saved, draft)).toEqual([{ role: "review", chain: ["codex:gpt-6-astra@high", "claude:opus-5.5@high"], otherProvider: true }]);
    expect(changesBetween(saved, [saved[0] as RoleEngines, setOtherProvider(saved[1] as RoleEngines, true)])).toEqual([{ role: "review", otherProvider: true }]);
  });
});

describe("a save request checked before anything is written (R5)", () => {
  const roles = [role("plan", ["claude:opus-5.5@high", "cursor:grok-9@high"]), role("review", ["claude:opus-5.5@high"])];
  it("passes known engines and gives back the parsed changes", () => {
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["codex:gpt-6-astra@ultra"] }]))
      .toEqual({ ok: true, value: [{ role: "plan", chain: ["codex:gpt-6-astra@ultra"] }] });
  });
  it("refuses an unknown role, an empty chain, unreadable text, a duplicate, and a bad effort, naming the role", () => {
    expect(checkChanges(roles, CATALOG, [{ role: "deploy", chain: ["claude:opus-5.5"] }])).toEqual({ ok: false, error: { role: "deploy", problem: "unknown_role" } });
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: [] }])).toEqual({ ok: false, error: { role: "plan", problem: "last_engine" } });
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["claude opus"] }])).toEqual({ ok: false, error: { role: "plan", problem: "bad_engine" } });
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["  claude:opus-5.5@high\n"] }]))
      .toEqual({ ok: true, value: [{ role: "plan", chain: ["claude:opus-5.5@high"] }] });
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["claude:opus-5.5", "claude:opus-5.5"] }])).toEqual({ ok: false, error: { role: "plan", problem: "duplicate", engine: "claude:opus-5.5" } });
    expect(checkChanges(roles, CATALOG, [{ role: "review", chain: ["claude:opus-5.5@ultra"] }])).toEqual({ ok: false, error: { role: "review", problem: "unknown_effort" } });
  });
  it("copies the role already held pass (the CLI took them); only a new copy is refused, naming the engine to remove", () => {
    const twice = [role("validate", ["claude:opus-5.5@high", "claude:opus-5.5@high"])];
    expect(checkChanges(twice, CATALOG, [{ role: "validate", chain: ["claude:opus-5.5@high", "claude:opus-5.5@high", "codex:gpt-6-astra@high"] }]).ok).toBe(true);
    expect(checkChanges(twice, CATALOG, [{ role: "validate", chain: ["claude:opus-5.5@high", "claude:opus-5.5@high", "claude:opus-5.5@high"] }]))
      .toEqual({ ok: false, error: { role: "validate", problem: "duplicate", engine: "claude:opus-5.5@high" } });
    expect(checkChanges(roles, CATALOG, [{ role: "review", chain: ["claude:opus-5.5@high", "claude:opus-5.5@high"] }]))
      .toEqual({ ok: false, error: { role: "review", problem: "duplicate", engine: "claude:opus-5.5@high" } });
  });
  it("a copy lower in a chain never runs: the page can say so", () => {
    const chain = ["claude:opus-5.5@high", "codex:gpt-6-astra@high", "claude:opus-5.5@high"].map(e);
    expect([0, 1, 2].map(i => repeatsAbove(chain, i))).toEqual([false, false, true]);
  });
  it("one change per role: a second for the same role is refused, so the order of writes can't matter", () => {
    expect(checkChanges(roles, CATALOG, [{ role: "plan", otherProvider: true }, { role: "plan", otherProvider: false }]))
      .toEqual({ ok: false, error: { role: "plan", problem: "repeated_role" } });
  });
  it("a held engine still meets the CLI's own entry rules (a known provider, an effort it takes): only an unknown model is kept, with --force", () => {
    const held = [role("plan", ["codex:gpt-6-astra@turbo", "claude:opus-5.5@high"]), role("review", ["claude:opus-5.5@high"])];
    expect(checkChanges(held, CATALOG, [{ role: "review", otherProvider: true }, { role: "plan", chain: ["claude:opus-5.5@high", "codex:gpt-6-astra@turbo"] }]))
      .toEqual({ ok: false, error: { role: "plan", problem: "unknown_effort" } });
    const ghost = [role("plan", ["kimi:k3", "claude:opus-5.5@high"])];
    expect(checkChanges(ghost, CATALOG, [{ role: "plan", chain: ["claude:opus-5.5@high", "kimi:k3"] }])).toEqual({ ok: false, error: { role: "plan", problem: "unknown_provider" } });
  });
  it("a change with neither a chain nor a rule is dropped: nothing to write, nothing to record", () => {
    expect(checkChanges(roles, CATALOG, [{ role: "plan" }, { role: "review", otherProvider: true }])).toEqual({ ok: true, value: [{ role: "review", otherProvider: true }] });
  });
  it("a model outside the known list passes only when the role already had that exact engine (set by hand with --force)", () => {
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["cursor:grok-9@high", "claude:opus-5.5@high"] }]).ok).toBe(true);
    expect(checkChanges(roles, CATALOG, [{ role: "plan", chain: ["cursor:grok-9@low"] }])).toEqual({ ok: false, error: { role: "plan", problem: "unknown_model" } });
    expect(checkChanges(roles, CATALOG, [{ role: "review", chain: ["cursor:grok-9@high"] }])).toEqual({ ok: false, error: { role: "review", problem: "unknown_model" } });
  });
});
