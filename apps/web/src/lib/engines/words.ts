// The Engines page's words (ADR-0013): a provider's availability, an engine in plain words, and why a change or a save
// was refused. The domain classifies; these say it.
import { MAX_CHAIN, parseEngine, type ChangeProblem, type EngineAvailability, type EngineProvider } from "@morndo/domain";

// A provider's name without the CLI label's notes: "Claude Code (Max plans, …)" -> "Claude Code".
export const providerName = (p: Pick<EngineProvider, "label" | "name">) => p.label.replace(/\s*\(.*$/, "") || p.name;

const AVAILABILITY: Record<EngineAvailability, { word: string; tone: "ok" | "warn" | "bad" | "" }> = {
  ready: { word: "Ready", tone: "ok" },
  unconfirmed: { word: "Sign-in not checked", tone: "warn" },
  out_of_quota: { word: "Out of quota", tone: "warn" },
  signed_out: { word: "Not signed in", tone: "bad" },
  not_installed: { word: "Not installed", tone: "bad" },
  off: { word: "Off", tone: "" },
};

// `short`: without the time a pause ends (an engine's chip, next to its buttons; the providers list says until when).
export function availabilityWords(p: Pick<EngineProvider, "availability" | "until">, short = false): { word: string; tone: "ok" | "warn" | "bad" | "" } {
  const a = AVAILABILITY[p.availability];
  return p.availability === "out_of_quota" && p.until && !short ? { ...a, word: `${a.word} until ${p.until}` } : a;
}

// "claude:opus-5.5@high" -> "Claude Code · opus-5.5 · high".
export function engineWords(text: string | null, providers: readonly EngineProvider[]): string {
  const e = text ? parseEngine(text) : null;
  if (!e) return text ?? "";
  const p = providers.find(x => x.name === e.provider);
  return [p ? providerName(p) : e.provider, e.model, e.effort].filter(Boolean).join(" · ");
}

const PROBLEMS: Record<ChangeProblem | "out_of_range", string> = {
  unknown_provider: "The engines don't know that provider.",
  unknown_model: "That model isn't in the provider's list.",
  unknown_effort: "That provider doesn't take this effort.",
  duplicate: "That engine is already in this role's list.",
  last_engine: "A role needs at least one engine.",
  out_of_range: "That engine isn't in the list any more.",
  unknown_role: "The engines don't know that role any more. Reload the page.",
  bad_engine: "That engine can't be read.",
  repeated_role: "One role was changed twice in one save. Reload the page.",
  too_long: `A list holds at most ${MAX_CHAIN} engines; remove one first.`,
};
export const problemWords = (p: string) => PROBLEMS[p as ChangeProblem] ?? `Not saved (${p}).`;
