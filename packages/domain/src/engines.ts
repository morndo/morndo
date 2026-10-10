// Engines (ADR-0013; R1–R6 in docs/domain.md): which provider and model does each role's work, with its fallbacks in
// order. The settings themselves live in the engine layer's own file, which only its CLI writes (the hub's
// adapters/engines-cli.ts); this module is the language and the rules of the page that edits them. No file, no
// program run, no clock.
import { err, ok, type EndpointId, type Result } from "./shared.ts";

// R1: an Engine is provider:model[@effort], the text the engine layer's CLI reads and writes (e.g. "acme:large-2@high").
// No effort means the provider's own default.
export type Engine = { provider: string; model: string; effort: string };

// The CLI's grammar for an entry (engine-layer src/engines/config.py, ENTRY_RE), so nothing the page writes is
// refused for its shape. A comma is only part of one entry when it sits inside [options]: parse_chain splits on every
// other comma (engine-layer main, config.py, read 2026-10-09).
const ENGINE = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._\-[\]=,]*)(?:@([a-z]+))?$/;

function commaOutsideOptions(model: string): boolean {
  let depth = 0;
  for (const ch of model) {
    if (ch === "[") depth += 1;
    else if (ch === "]" && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

export function parseEngine(text: string): Engine | null {
  // text.strip(), as the CLI's parse_entry (engine-layer config.py, read 2026-10-09). A hand-edited entry with
  // surrounding whitespace is valid there; without the trim the whole Engines page would be unavailable.
  const m = ENGINE.exec(text.trim());
  if (!m || commaOutsideOptions(m[2] ?? "")) return null;
  return { provider: m[1] ?? "", model: m[2] ?? "", effort: m[3] ?? "" };
}
export const engineText = (e: Engine) => `${e.provider}:${e.model}${e.effort ? `@${e.effort}` : ""}`;

// The argument `engines set ROLE` takes: entries joined by commas. A comma inside a model's [options] is part of
// that entry. The CLI's parse_chain (engine-layer src/engines/config.py, read 2026-10-09) splits only on commas
// outside brackets, so this text reads back as the same entries.
export const chainArg = (entries: readonly string[]) => entries.join(",");
const same = (a: Engine, b: Engine) => engineText(a) === engineText(b);

// R2: a provider's availability, as the engine layer's resolver reports it and in its order of checks: switched off in
// the settings, its program not installed, not signed in, paused by a mark (a run hit its quota, an auth or a billing
// error, until a time). "unconfirmed": nobody has checked the sign-in; the resolver still uses it, with a warning.
export type EngineAvailability = "ready" | "unconfirmed" | "signed_out" | "not_installed" | "out_of_quota" | "off";

export function availabilityOf(p: { enabled: boolean; installed: boolean; login: "ok" | "missing" | "unknown"; providerMarked: boolean }): EngineAvailability {
  if (!p.enabled) return "off";
  if (!p.installed) return "not_installed";
  if (p.login === "missing") return "signed_out";
  if (p.providerMarked) return "out_of_quota";
  return p.login === "unknown" ? "unconfirmed" : "ready";
}

// A provider the page can pick: its known models and the efforts it takes ([] = none; null = it lists none, so any, as
// the CLI reads a missing key), how it is now, until when a
// pause on it lasts, and pauses on single models.
export type EngineProvider = {
  name: string; label: string; kind: "cli" | "studio"; models: string[]; efforts: string[] | null;
  availability: EngineAvailability; until: string | null; pausedModels: { model: string; until: string }[];
};

// A Role (plan, implement-backend, review, research, …) and its chain: the first engine is the first choice, the rest
// are fallbacks in order; the first available one runs. `riskChain`: the chain for risk-area work, if the role has one
// (shown, not edited here). `otherProvider`: the reviewer must come from another model family than the implementer.
export type RoleEngines = { role: string; label: string; chain: Engine[]; riskChain: Engine[] | null; otherProvider: boolean };

export type EngineProblem = "unknown_provider" | "unknown_model" | "unknown_effort" | "duplicate";

// R3, R5: a role's list holds at most this many engines, a first choice and seven fallbacks: the page and the save check
// both use it. A role set longer by hand keeps working: it may get shorter or stay, never longer.
export const MAX_CHAIN = 8;

// Whether the model is one the provider lists, as the CLI reads it (engine-layer config.py known_model): a provider that
// lists none takes any, and a model's "[options]" don't count.
export function knownModel(e: Engine, catalog: readonly EngineProvider[]): boolean {
  const models = catalog.find(x => x.name === e.provider)?.models ?? [];
  return models.length === 0 || models.includes(e.model.split("[")[0] ?? e.model);
}

// Whether the provider takes this effort: none ("") always; any when it lists none (null); else one it lists.
export const takesEffort = (p: Pick<EngineProvider, "efforts">, effort: string) => !effort || p.efforts === null || p.efforts.includes(effort);

// An effort typed for a provider that lists none (efforts null): empty is its default; otherwise lowercase letters only,
// the CLI's grammar for the part after "@" (ENTRY_RE). Null when it isn't one.
export function effortFromText(text: string): string | null {
  const t = text.trim();
  return /^[a-z]*$/.test(t) ? t : null;
}

// R3: an engine fits when its provider is known, the model is one of the provider's known models and the effort one the
// provider takes (none always fits). The CLI refuses the same (an unknown model unless forced).
function problemOf(e: Engine, catalog: readonly EngineProvider[]): EngineProblem | null {
  const p = catalog.find(x => x.name === e.provider);
  if (!p) return "unknown_provider";
  if (!knownModel(e, catalog)) return "unknown_model";
  if (e.effort && !takesEffort(p, e.effort)) return "unknown_effort";
  return null;
}

// R3: the edits. Each returns the role changed, or why not; the role passed in is never changed. The same engine twice
// in one chain is refused (the second could never run), and a role always keeps one engine.
export function replaceEngine(r: RoleEngines, index: number, e: Engine, catalog: readonly EngineProvider[]): Result<RoleEngines, EngineProblem | "out_of_range"> {
  if (index < 0 || index >= r.chain.length) return err("out_of_range");
  const problem = problemOf(e, catalog);
  if (problem) return err(problem);
  if (r.chain.some((x, i) => i !== index && same(x, e))) return err("duplicate");
  return ok({ ...r, chain: r.chain.map((x, i) => (i === index ? e : x)) });
}

export function addFallback(r: RoleEngines, e: Engine, catalog: readonly EngineProvider[]): Result<RoleEngines, EngineProblem | "too_long"> {
  if (r.chain.length >= MAX_CHAIN) return err("too_long");
  const problem = problemOf(e, catalog);
  if (problem) return err(problem);
  if (r.chain.some(x => same(x, e))) return err("duplicate");
  return ok({ ...r, chain: [...r.chain, e] });
}

export function removeEngine(r: RoleEngines, index: number): Result<RoleEngines, "last_engine" | "out_of_range"> {
  if (index < 0 || index >= r.chain.length) return err("out_of_range");
  if (r.chain.length === 1) return err("last_engine");
  return ok({ ...r, chain: r.chain.filter((_, i) => i !== index) });
}

// One step up (-1) or down (+1); a fallback moved to the top becomes the first choice.
export function moveEngine(r: RoleEngines, index: number, by: -1 | 1): Result<RoleEngines, "out_of_range"> {
  const to = index + by;
  if (index < 0 || index >= r.chain.length || to < 0 || to >= r.chain.length) return err("out_of_range");
  const chain = [...r.chain];
  [chain[index], chain[to]] = [chain[to] as Engine, chain[index] as Engine];
  return ok({ ...r, chain });
}

export const setOtherProvider = (r: RoleEngines, on: boolean): RoleEngines => ({ ...r, otherProvider: on });

// The engine after picking another provider for it: the provider's first model that `taken` (the chain's other engines)
// doesn't hold already, else its first; the effort stays when the provider takes it, else high when offered (the engine
// layer's defaults run at high), else the provider's default.
export function retarget(e: Engine, provider: string, catalog: readonly EngineProvider[], taken: readonly Engine[] = []): Engine {
  const p = catalog.find(x => x.name === provider);
  const effort = p && takesEffort(p, e.effort) ? e.effort : p && takesEffort(p, "high") ? "high" : "";
  const models = p?.models ?? [];
  const model = models.find(m => !taken.some(t => same(t, { provider, model: m, effort }))) ?? models[0] ?? e.model;
  return { provider, model, effort };
}

// The fallback "Add a fallback" starts from: the first engine not yet in the chain, taking available providers first
// (in the catalog's order, each provider's models in order) at the first choice's effort when the provider takes it;
// an unavailable one only when no available one is left; null when every engine is in.
export function suggestFallback(r: RoleEngines, catalog: readonly EngineProvider[]): Engine | null {
  const usable = (p: EngineProvider) => p.availability === "ready" || p.availability === "unconfirmed";
  const effort = r.chain[0]?.effort ?? "";
  for (const p of [...catalog.filter(usable), ...catalog.filter(p => !usable(p))]) {
    for (const model of p.models) {
      const e = { provider: p.name, model, effort: takesEffort(p, effort) ? effort : "" };
      if (!r.chain.some(x => same(x, e))) return e;
    }
  }
  return null;
}

// R4: what a save writes. Per role whose chain or rule differs from the saved one: its whole chain in order (the CLI
// sets a chain at once) and the rule, each only when it changed.
export type RoleChange = { role: string; chain?: string[]; otherProvider?: boolean };

export function changesBetween(saved: readonly RoleEngines[], draft: readonly RoleEngines[]): RoleChange[] {
  const out: RoleChange[] = [];
  for (const d of draft) {
    const s = saved.find(x => x.role === d.role);
    if (!s) continue;
    const chain = d.chain.map(engineText);
    const chainChanged = chain.join(",") !== s.chain.map(engineText).join(",");
    const ruleChanged = d.otherProvider !== s.otherProvider;
    if (!chainChanged && !ruleChanged) continue;
    out.push({ role: d.role, ...(chainChanged ? { chain } : {}), ...(ruleChanged ? { otherProvider: d.otherProvider } : {}) });
  }
  return out;
}

export type ChangeProblem = EngineProblem | "unknown_role" | "bad_engine" | "last_engine" | "repeated_role" | "too_long";

// Whether the same engine sits higher in the chain: this copy can never run (the CLI takes such a chain; the page
// shows it).
export const repeatsAbove = (chain: readonly Engine[], index: number) => chain.slice(0, index).some(x => same(x, chain[index] as Engine));

// R5: a save request, checked against the roles and providers as they are now, before anything is written: known roles,
// one change per role, a chain that isn't empty and isn't longer than MAX_CHAIN (or than it was), readable engines, each fitting the catalog, and no new copy of an
// engine (named, so the page can say which to remove). What the role already had keeps two leeways the CLI allows: its
// copies, and a model outside the known list (written with --force); the page keeps them, it never adds one. Every
// other rule of the CLI's own (a known provider, an effort it takes) holds for every entry. A change with neither a
// chain nor a rule is dropped.
export type ChangeRefusal = { role: string; problem: ChangeProblem; engine?: string };
export function checkChanges(roles: readonly RoleEngines[], catalog: readonly EngineProvider[], changes: readonly RoleChange[]): Result<RoleChange[], ChangeRefusal> {
  const seen = new Set<string>();
  const cleaned: RoleChange[] = [];
  for (const c of changes) {
    const r = roles.find(x => x.role === c.role);
    const refuse = (problem: ChangeProblem, engine?: string) => err({ role: c.role, problem, ...(engine ? { engine } : {}) });
    if (!r) return refuse("unknown_role");
    if (seen.has(c.role)) return refuse("repeated_role");
    seen.add(c.role);
    if (c.chain === undefined && c.otherProvider === undefined) continue;
    let chain: string[] | undefined;
    if (c.chain) {
      if (c.chain.length === 0) return refuse("last_engine");
      if (c.chain.length > Math.max(MAX_CHAIN, r.chain.length)) return refuse("too_long");
      const parsed: Engine[] = [];
      chain = [];
      for (const text of c.chain) {
        const e = parseEngine(text);
        if (!e) return refuse("bad_engine");
        const held = r.chain.filter(x => same(x, e)).length;
        if (parsed.filter(x => same(x, e)).length >= Math.max(1, held)) return refuse("duplicate", engineText(e));
        const problem = problemOf(e, catalog);
        // The CLI's `set` applies its entry rules to every entry it writes; only an unknown model can be forced. So a held
        // engine keeps that one leeway and nothing else, and no save can half-land on a refusal (verify round, finding 1).
        if (problem && !(problem === "unknown_model" && r.chain.some(x => same(x, e)))) return refuse(problem);
        parsed.push(e);
        chain.push(engineText(e));
      }
    }
    cleaned.push({ role: c.role, ...(chain ? { chain } : {}), ...(c.otherProvider !== undefined ? { otherProvider: c.otherProvider } : {}) });
  }
  return ok(cleaned);
}

// R6: every change a save made, kept in the audit log with the device it came from (provenance, like PolicyChanged).
export type EnginesChanged = { type: "EnginesChanged"; endpointId: EndpointId; role: string; chain?: string[]; otherProvider?: boolean; at: number };
export const enginesChanged = (endpointId: EndpointId, c: RoleChange, at: number): EnginesChanged => ({ type: "EnginesChanged", endpointId, ...c, at });
