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

// The fields of an SOP, a step and a gate. The JSON Schema in the recurring-job skill's assets holds the same lists.
export const SOP_FIELDS = ["sop", "version", "patterns", "trigger", "inputs", "steps", "gates", "done", "stop", "budget", "report", "metrics"] as const;
export const SOP_REQUIRED = ["sop", "version", "trigger", "steps", "done", "stop", "budget", "report", "metrics"] as const;
export const STEP_FIELDS = ["id", "pattern", "role", "model", "options", "tool", "effect", "why", "input", "output", "check", "on_fail", "max_rounds"] as const;
export const GATE_FIELDS = ["before", "who", "shows", "options", "on_change", "max_changes", "on_silence"] as const;
export const STEP_EFFECTS = ["local", "outward", "irreversible"] as const;
export const SILENCE_OUTCOMES = ["expire", "drop", "pause"] as const;
export const BUDGET_ON_EXCEED = ["stop", "ask"] as const;
export const MAX_ROUNDS = 5;

// Words in a step's id or tool that act outside the user's machines or can't be undone (K10). Such a step must say so
// with `effect`, so that its gate can't be skipped by leaving the effect out.
const OUTWARD_WORDS = new Set(["publish", "post", "send", "email", "mail", "push", "deploy", "release", "merge", "pay", "delete", "submit"]);
const ID = /^[a-z][a-z0-9-]*$/;
const PREF = /^pref:[a-z0-9][a-z0-9-]*$/;
const SNAPSHOT = /^models\.dev@\d{4}-\d{2}-\d{2}$/;
const NO_EVIDENCE = "no evidence: default";

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const texts = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(text);
const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T => (list as readonly unknown[]).includes(x);
const rounds = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_ROUNDS;
const amount = (x: unknown) => text(x) || (typeof x === "number" && x > 0);
const shown = (x: unknown): string => (typeof x === "string" ? x : (JSON.stringify(x) ?? "nothing"));

export function checkSop(doc: unknown, ctx: SopContext): SopVerdict {
  const refusals: SopFinding[] = [];
  const warnings: SopFinding<SopWarning>[] = [];
  const refuse = (rule: SopRule, at: string, message: string) => { refusals.push({ rule, at, message }); };
  if (!isRec(doc)) return { refusals: [{ rule: "shape", at: "", message: "an SOP is a mapping of fields" }], warnings };

  for (const k of Object.keys(doc)) if (!oneOf(SOP_FIELDS, k)) refuse("shape", k, `'${k}' is not an SOP field`);
  if (!text(doc.sop) || !ID.test(doc.sop)) refuse("shape", "sop", "sop is the SOP's id: lowercase letters, digits and hyphens");
  if (!(typeof doc.version === "number" && Number.isInteger(doc.version) && doc.version >= 1)) refuse("shape", "version", "version is a whole number from 1");

  const trigger = doc.trigger;
  if (!isRec(trigger) || Object.keys(trigger).length !== 1 || !("schedule" in trigger || "event" in trigger)) refuse("trigger", "trigger", "a trigger is exactly one schedule or one event");
  else if ("schedule" in trigger && !(isRec(trigger.schedule) && text(trigger.schedule.cron) && text(trigger.schedule.timezone))) refuse("trigger", "trigger.schedule", "a schedule has a cron line and a time zone");
  else if ("event" in trigger && !text(trigger.event)) refuse("trigger", "trigger.event", "an event names what starts the run");

  if (doc.patterns !== undefined) {
    if (!Array.isArray(doc.patterns)) refuse("pattern-known", "patterns", "patterns is a list of skill names");
    else for (const p of doc.patterns as unknown[]) if (!oneOf(ctx.skills, p)) refuse("pattern-known", "patterns", `'${shown(p)}' is not a shipped skill`);
  }

  const cite = (c: unknown, at: string) => {
    if (typeof c === "string" && (c === NO_EVIDENCE || PREF.test(c) || SNAPSHOT.test(c) || ctx.skills.includes(c))) return;
    if (typeof c === "string" && c.startsWith("notes/")) {
      const due = ctx.notes.get(c.slice("notes/".length));
      if (due === undefined) refuse("why-resolves", at, `${c} is not a note in knowledge/notes`);
      else if (ctx.today > due) warnings.push({ rule: "stale-citation", at, message: `${c} was due for a re-read on ${due}` });
      return;
    }
    refuse("why-resolves", at, `'${shown(c)}' cites nothing known: a skill, notes/<id>, pref:<id>, models.dev@<date> or '${NO_EVIDENCE}'`);
  };

  const steps: unknown[] = Array.isArray(doc.steps) ? (doc.steps as unknown[]) : [];
  if (steps.length === 0) refuse("shape", "steps", "an SOP has at least one step");
  const seen: string[] = [];
  const engines = new Set<string>();
  const outward: string[] = [];
  steps.forEach((raw, i) => {
    if (!isRec(raw)) {
      refuse("shape", `steps[${i}]`, "a step is a mapping");
      return;
    }
    const id = text(raw.id) ? raw.id : "";
    const at = id ? `steps.${id}` : `steps[${i}]`;
    for (const k of Object.keys(raw)) if (!oneOf(STEP_FIELDS, k)) refuse("shape", at, `'${k}' is not a step field`);
    if (!ID.test(id)) refuse("step-kind", at, "a step has an id: lowercase letters, digits and hyphens");
    else if (seen.includes(id)) refuse("step-kind", at, `two steps are called '${id}'`);
    if (raw.pattern !== undefined && !oneOf(ctx.skills, raw.pattern)) refuse("pattern-known", at, `'${shown(raw.pattern)}' is not a shipped skill`);

    const isEngine = "role" in raw && !("tool" in raw);
    if ("role" in raw === "tool" in raw) refuse("step-kind", at, "a step names a role (an engine step) or a tool (a deterministic step): one of the two");
    else if (isEngine) {
      if (!oneOf(ctx.roles, raw.role)) refuse("role-known", at, `'${shown(raw.role)}' is not a role of the engine layer (${ctx.roles.join(", ")})`);
      const model = raw.model;
      if (typeof model === "string") refuse("no-model-id", at, `'${model}' is a model id: name a model class (${MODEL_CLASSES.join(", ")}) and let the role's chain pick the engine`);
      else if (!isRec(model)) refuse("model-class", at, "an engine step names its model as { class, family }");
      else {
        const extra = Object.keys(model).filter(k => k !== "class" && k !== "family");
        if (extra.length > 0) refuse("no-model-id", at, `a model is a class and a family rule, never ${extra.join(", ")}`);
        if (!oneOf(MODEL_CLASSES, model.class)) refuse("model-class", at, `class is one of ${MODEL_CLASSES.join(", ")}`);
        const family = model.family ?? "any";
        const others = isRec(family) && Object.keys(family).length === 1 ? family["other-than"] : undefined;
        if (family !== "any" && !(texts(others) && others.every(o => engines.has(o)))) refuse("model-class", at, "family is 'any' or { other-than: [earlier engine steps] }");
      }
      if (!texts(raw.why)) refuse("engine-why", at, `an engine step says why: a skill, a note, a preference, the model snapshot, or '${NO_EVIDENCE}'`);
    } else {
      if (!text(raw.tool)) refuse("step-kind", at, "a tool step names its tool");
      if ("model" in raw) refuse("no-model-id", at, "a tool step runs no model");
    }
    if (Array.isArray(raw.why)) for (const c of raw.why as unknown[]) cite(c, at);
    if (!text(raw.output) || !text(raw.check)) refuse("step-check", at, "every step has an output and a check");

    const effect = raw.effect ?? "local";
    if (!oneOf(STEP_EFFECTS, effect)) refuse("shape", at, `effect is one of ${STEP_EFFECTS.join(", ")}`);
    else if (effect !== "local") outward.push(id);
    else if ([id, raw.tool].filter(text).some(w => w.toLowerCase().split(/[^a-z]+/).some(x => OUTWARD_WORDS.has(x)))) {
      refuse("outward-declared", at, "this step looks outward or irreversible: say so with effect: outward or effect: irreversible, and put a gate before it");
    }

    if ("on_fail" in raw || raw.pattern === "loop-review-fix") {
      if ("on_fail" in raw && !(typeof raw.on_fail === "string" && seen.includes(raw.on_fail))) refuse("loop-max-rounds", at, "on_fail goes back to an earlier step");
      if (!rounds(raw.max_rounds)) refuse("loop-max-rounds", at, `a loop stops after max_rounds, 1 to ${MAX_ROUNDS}`);
    }
    if (id) seen.push(id);
    if (id && isEngine) engines.add(id);
  });

  const gates: unknown[] = Array.isArray(doc.gates) ? (doc.gates as unknown[]) : [];
  if (doc.gates !== undefined && !Array.isArray(doc.gates)) refuse("gate-shape", "gates", "gates is a list");
  const gated = new Set<string>();
  gates.forEach((g, i) => {
    if (!isRec(g)) {
      refuse("gate-shape", `gates[${i}]`, "a gate is a mapping");
      return;
    }
    const at = text(g.before) ? `gates.${g.before}` : `gates[${i}]`;
    for (const k of Object.keys(g)) if (!oneOf(GATE_FIELDS, k)) refuse("gate-shape", at, `'${k}' is not a gate field`);
    const idx = typeof g.before === "string" ? seen.indexOf(g.before) : -1;
    if (idx < 0) refuse("gate-shape", at, "a gate sits before a step of this SOP");
    else gated.add(seen[idx] ?? "");
    if (g.who !== "principal") refuse("gate-shape", at, "a gate waits for the principal");
    if (!texts(g.shows)) refuse("gate-shape", at, "a gate shows the principal the evidence");
    if (!texts(g.options) || !g.options.includes("approve")) refuse("gate-shape", at, "a gate offers approve among its options");
    const silence = g.on_silence;
    if (!isRec(silence) || !text(silence.after) || !oneOf(SILENCE_OUTCOMES, silence.then)) {
      refuse("silence-never-approves", at, `silence never approves: on_silence is { after, then } with then one of ${SILENCE_OUTCOMES.join(", ")}`);
    }
    if ("on_change" in g && idx >= 0) {
      const back = typeof g.on_change === "string" ? seen.indexOf(g.on_change) : -1;
      if (back < 0 || back >= idx) refuse("loop-max-rounds", at, "on_change goes back to a step before the gated one");
      if (!rounds(g.max_changes)) refuse("loop-max-rounds", at, `a change loop stops after max_changes, 1 to ${MAX_ROUNDS}`);
    }
  });
  for (const id of outward) if (!gated.has(id)) refuse("gate-before-outward", `steps.${id}`, "an outward or irreversible step waits for the principal: put a gate before it");

  const stop = doc.stop;
  if (!Array.isArray(stop) || stop.length === 0 || !(stop as unknown[]).every(r => isRec(r) && text(r.when) && text(r.then))) {
    refuse("stop-required", "stop", "an SOP has at least one stop rule, each { when, then }");
  }
  const budget = doc.budget;
  if (!isRec(budget) || !amount(budget.per_run) || !amount(budget.per_month) || !oneOf(BUDGET_ON_EXCEED, budget.on_exceed)) {
    refuse("budget-stop", "budget", `a budget has per_run, per_month and on_exceed: ${BUDGET_ON_EXCEED.join(" or ")}; spending past it never goes on by itself`);
  }
  if (!texts(doc.done)) refuse("done-required", "done", "an SOP lists the checks that make a run done");
  const report = doc.report;
  if (!isRec(report) || !text(report.to) || !texts(report.holds) || !report.holds.includes("citations")) {
    refuse("report-citations", "report", "a report names where it goes and holds the citations the steps used (K11)");
  }
  const metrics = doc.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0 || !(metrics as unknown[]).every(m => isRec(m) && text(m.name) && text(m.from) && text(m.every))) {
    refuse("metrics-required", "metrics", "an SOP measures something across runs: each metric has a name, where it comes from and how often");
  }
  return { refusals, warnings };
}
