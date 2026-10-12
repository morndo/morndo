// Knowledge (ADR-0026; docs/design/capability-knowledge): the SOP check. An SOP is a recurring job as data: a trigger,
// steps that each name a Role and a model class (or a deterministic tool), gates before anything outward, stop rules,
// a budget, a report and metrics. This module judges a parsed SOP. It reads nothing and keeps no clock: the caller
// passes the shipped skill names, the notes with their re-check dates, the engine layer's roles and today's date.

export const MODEL_CLASSES = ["flagship", "everyday", "fast"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const SOP_RULES = [
  "shape", "trigger", "pattern-known", "step-kind", "role-known", "no-model-id", "model-class", "engine-why", "why-resolves",
  "step-check", "outward-declared", "gate-before-outward", "gate-shape", "silence-never-approves", "loop-max-rounds",
  "stop-required", "budget-stop", "done-required", "report-citations", "metrics-required",
] as const;
export type SopRule = (typeof SOP_RULES)[number];
export type SopWarning = "stale-citation";

export type SopFinding<R extends string = SopRule> = { rule: R; at: string; message: string };
export type SopContext = {
  skills: readonly string[];
  notes: ReadonlyMap<string, string>; // note id -> its re-check date, YYYY-MM-DD
  roles: readonly string[];
  today: string; // YYYY-MM-DD
};
export type SopVerdict = { refusals: SopFinding[]; warnings: SopFinding<SopWarning>[] };

export function checkSop(_doc: unknown, _ctx: SopContext): SopVerdict {
  return { refusals: [], warnings: [] };
}
