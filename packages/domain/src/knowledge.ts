// Knowledge (ADR-0026; docs/design/capability-knowledge): the SOP check. An SOP is a recurring job as data: a trigger,
// steps that each name a Role and a model class (or a deterministic tool) and declare their effect, gates before
// anything outward, stop rules, a budget, a report and metrics. This module judges a parsed SOP. It reads nothing and
// keeps no clock: the caller passes the shipped skill names, the notes with their re-check dates, the engine layer's
// roles, today's date and a way to tell whether a time zone exists, and, when the user gives them, the ids of their
// preferences and the dates of their model snapshots, which cited preferences and snapshots must then resolve to.
import { isDate, isRec, PREFERENCE_ID, shown, text } from "./knowledge-guards.ts";

export const MODEL_CLASSES = ["flagship", "everyday", "fast"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export const SOP_RULES = [
  "shape", "trigger", "blanks-filled", "pattern-known", "step-kind", "role-known", "no-model-id", "model-class", "engine-why",
  "why-resolves", "preference-in-template", "step-check", "effect-declared", "gate-before-outward", "gate-shape", "silence-never-approves",
  "round-limit", "stop-required", "budget-stop", "done-required", "report-citations", "metrics-required",
] as const;
export type SopRule = (typeof SOP_RULES)[number];
export type SopWarning = "stale-citation" | "outward-sounding" | "unchecked-citation";

export type SopFinding<R extends string = SopRule> = { rule: R; at: string; message: string };
export type SopContext = {
  skills: readonly string[];
  notes: ReadonlyMap<string, string>; // note id -> its re-check date, YYYY-MM-DD
  roles: readonly string[];
  today: string; // YYYY-MM-DD
  isTimeZone: (tz: string) => boolean; // whether the runtime knows this IANA time zone
  preferences?: ReadonlySet<string>; // the ids in the user's preferences file; without it, pref:<id> is checked for its form only
  snapshots?: ReadonlySet<string>; // the dates of the user's model snapshots; without them, models.dev@<date> is checked for its form only
};
export type SopVerdict = { refusals: SopFinding[]; warnings: SopFinding<SopWarning>[] };

// The fields of an SOP, a step and a gate. The JSON Schema in the recurring-job skill's assets holds the same lists.
export const SOP_FIELDS = ["sop", "version", "kind", "patterns", "trigger", "inputs", "steps", "gates", "done", "stop", "budget", "report", "metrics"] as const;
export const STEP_FIELDS = ["id", "pattern", "role", "model", "options", "tool", "effect", "why", "input", "output", "check", "on_fail", "max_rounds"] as const;
export const GATE_FIELDS = ["before", "who", "shows", "options", "on_change", "max_changes", "on_silence"] as const;
// Each required field, and the rule that refuses an SOP without it: the one place checkSop reads them from.
const REQUIRED_BY: Readonly<Record<string, SopRule>> = {
  sop: "shape", version: "shape", trigger: "trigger", steps: "shape", done: "done-required", stop: "stop-required",
  budget: "budget-stop", report: "report-citations", metrics: "metrics-required",
};
export const SOP_REQUIRED = Object.keys(REQUIRED_BY) as readonly string[];
// A template may keep blanks such as "<IANA zone>"; an instance, the default, may not.
export const SOP_KINDS = ["template", "instance"] as const;
export const STEP_EFFECTS = ["local", "outward", "irreversible"] as const;
export const SILENCE_OUTCOMES = ["expire", "drop", "pause"] as const;
export const BUDGET_ON_EXCEED = ["stop", "ask"] as const;
export const MAX_ROUNDS = 5;

// Parts of names that usually mean acting outside the user's machines. Only a warning on a step declared local: the gate
// rule rests on the declared effect, never on a word list (K10).
const OUTWARD_SOUNDING = /publish|post|send|sent|mail|upload|tweet|notif|commit|push|deploy|release|merge|pay|delet|submit|share|messag|webhook|broadcast/;
// The five fields of a POSIX crontab line: each an asterisk, or a list of numbers and ranges, within its range.
const CRON_RANGES: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const BLANK = /<[^<>]+>/;
const AMOUNT = /^(\d+(?:\.\d{1,2})?) ([A-Z]{3})$/;
const ID = /^[a-z][a-z0-9-]*$/;
const NO_EVIDENCE = "no evidence: default";

type Amount = { value: number; currency: string | null };
const texts = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(text);
const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T => (list as readonly unknown[]).includes(x);
const rounds = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_ROUNDS;
const blank = (x: unknown) => typeof x === "string" && BLANK.test(x);

// A number with a currency ("5 USD"), or 0: nothing may be spent. Anything else ("unlimited", 5) is no amount.
function amountOf(x: unknown): Amount | null {
  if (x === 0 || x === "0") return { value: 0, currency: null };
  const m = typeof x === "string" ? AMOUNT.exec(x) : null;
  return m ? { value: Number(m[1]), currency: Number(m[1]) === 0 ? null : (m[2] ?? null) } : null;
}

export function posixCron(line: string): boolean {
  const fields = line.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f, i) => {
    const [lo, hi] = CRON_RANGES[i] ?? [0, -1];
    return f === "*" || f.split(",").every(el => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(el);
      if (!m) return false;
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : Number(m[2]);
      return a >= lo && b <= hi && a <= b;
    });
  });
}

// Every string in the SOP that still holds a blank, with where it is: steps by id, other lists by position.
function blanksIn(x: unknown, at: string): string[] {
  if (blank(x)) return [at];
  if (Array.isArray(x)) return x.flatMap((v, i) => blanksIn(v, at === "steps" && isRec(v) && text(v.id) ? `steps.${v.id}` : `${at}[${i}]`));
  if (isRec(x)) return Object.entries(x).flatMap(([k, v]) => blanksIn(v, at ? `${at}.${k}` : k));
  return [];
}

export function checkSop(doc: unknown, ctx: SopContext): SopVerdict {
  const refusals: SopFinding[] = [];
  const warnings: SopFinding<SopWarning>[] = [];
  const refuse = (rule: SopRule, at: string, message: string) => { refusals.push({ rule, at, message }); };
  if (!isRec(doc)) return { refusals: [{ rule: "shape", at: "", message: "an SOP is a mapping of fields" }], warnings };

  for (const k of Object.keys(doc)) if (!oneOf(SOP_FIELDS, k)) refuse("shape", k, `'${k}' is not an SOP field`);
  const missing = new Set(SOP_REQUIRED.filter(k => !(k in doc)));
  for (const k of missing) refuse(REQUIRED_BY[k] ?? "shape", k, `'${k}' is missing`);
  const has = (k: string) => !missing.has(k);
  if (has("sop") && (!text(doc.sop) || !ID.test(doc.sop))) refuse("shape", "sop", "sop is the SOP's id: lowercase letters, digits and hyphens");
  if (has("version") && !(typeof doc.version === "number" && Number.isInteger(doc.version) && doc.version >= 1)) refuse("shape", "version", "version is a whole number from 1");
  const kind = doc.kind ?? "instance";
  if (!oneOf(SOP_KINDS, kind)) refuse("shape", "kind", `kind is ${SOP_KINDS.join(" or ")}; without it the SOP is an instance`);
  const template = kind === "template";
  if (!template) for (const at of blanksIn(doc, "")) refuse("blanks-filled", at, "an instance fills every <blank>; only an SOP with kind: template may keep them");

  const trigger = doc.trigger;
  if (has("trigger")) {
    if (!isRec(trigger) || Object.keys(trigger).length !== 1 || !("schedule" in trigger || "event" in trigger)) refuse("trigger", "trigger", "a trigger is exactly one schedule or one event");
    else if ("schedule" in trigger) {
      const s = trigger.schedule;
      if (!(isRec(s) && text(s.cron) && text(s.timezone))) refuse("trigger", "trigger.schedule", "a schedule has a cron line and a time zone");
      else {
        if (!(template && blank(s.cron)) && !posixCron(s.cron)) refuse("trigger", "trigger.schedule.cron", "a cron line is five POSIX fields: minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6 (0 is Sunday), each *, a number, a range or a list");
        if (!(template && blank(s.timezone)) && !ctx.isTimeZone(s.timezone)) refuse("trigger", "trigger.schedule.timezone", `'${s.timezone}' is not a time zone this runtime knows`);
      }
    } else if (!text(trigger.event)) refuse("trigger", "trigger.event", "an event names what starts the run");
  }

  if (doc.patterns !== undefined) {
    if (!Array.isArray(doc.patterns)) refuse("pattern-known", "patterns", "patterns is a list of skill names");
    else for (const p of doc.patterns as unknown[]) if (!oneOf(ctx.skills, p)) refuse("pattern-known", "patterns", `'${shown(p)}' is not a shipped skill`);
  }

  const cite = (c: unknown, at: string) => {
    const unknown = () => refuse("why-resolves", at, `'${shown(c)}' cites nothing known: a skill, notes/<id>, pref:<id>, models.dev@<date> or '${NO_EVIDENCE}'`);
    if (typeof c !== "string") return unknown();
    if (template && c.startsWith("pref:")) {
      return refuse("preference-in-template", at, "a template cites no preference: a preference is one person's, so only an instance may cite pref:<id> (K12)");
    }
    if (c === NO_EVIDENCE || ctx.skills.includes(c)) return;
    // A preference or a snapshot resolves against the user's files when the caller has them; without them it is checked for
    // its form only, and a warning says so.
    const pref = c.startsWith("pref:") ? c.slice("pref:".length) : "";
    if (PREFERENCE_ID.test(pref)) {
      if (ctx.preferences === undefined) warnings.push({ rule: "unchecked-citation", at, message: `${c} is checked for its form only: no preferences file was given` });
      else if (!ctx.preferences.has(pref)) refuse("why-resolves", at, `${c} is no preference of the preferences file`);
      return;
    }
    const fetched = c.startsWith("models.dev@") ? c.slice("models.dev@".length) : "";
    if (isDate(fetched)) {
      if (ctx.snapshots === undefined) warnings.push({ rule: "unchecked-citation", at, message: `${c} is checked for its form only: no snapshot directory was given` });
      else if (!ctx.snapshots.has(fetched)) refuse("why-resolves", at, `${c} is no snapshot of the snapshot directory`);
      return;
    }
    if (!c.startsWith("notes/")) return unknown();
    const due = ctx.notes.get(c.slice("notes/".length));
    if (due === undefined) refuse("why-resolves", at, `${c} is not a note of the recurring-job skill`);
    else if (ctx.today > due) warnings.push({ rule: "stale-citation", at, message: `${c} was due for a re-read on ${due}` });
  };

  const steps: unknown[] = Array.isArray(doc.steps) ? (doc.steps as unknown[]) : [];
  if (has("steps") && steps.length === 0) refuse("shape", "steps", "an SOP has at least one step");
  const seen: string[] = [];
  const engines: string[] = [];
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
        if (family !== "any" && !(texts(others) && others.every(o => engines.includes(o)))) refuse("model-class", at, "family is 'any' or { other-than: [earlier engine steps] }");
      }
      if (!texts(raw.why)) refuse("engine-why", at, `an engine step says why: a skill, a note, a preference, the model snapshot, or '${NO_EVIDENCE}'`);
    } else {
      if (!text(raw.tool)) refuse("step-kind", at, "a tool step names its tool");
      if ("model" in raw) refuse("no-model-id", at, "a tool step runs no model");
    }
    if (Array.isArray(raw.why)) for (const c of raw.why as unknown[]) cite(c, at);
    if (!text(raw.output) || !text(raw.check)) refuse("step-check", at, "every step has an output and a check");

    if (!oneOf(STEP_EFFECTS, raw.effect)) refuse("effect-declared", at, `every step declares its effect: ${STEP_EFFECTS.join(", ")}; outward and irreversible steps need a gate`);
    else if (raw.effect !== "local") outward.push(id);
    else if (OUTWARD_SOUNDING.test([id, raw.tool].filter(text).join(" ").toLowerCase())) {
      warnings.push({ rule: "outward-sounding", at, message: "declared local, but its name or tool sounds outward: if it acts outside the user's machines, say effect: outward and put a gate before it" });
    }

    if ("on_fail" in raw || raw.pattern === "loop-review-fix") {
      if ("on_fail" in raw && !(typeof raw.on_fail === "string" && seen.includes(raw.on_fail))) refuse("round-limit", at, "on_fail goes back to an earlier step");
      if (!rounds(raw.max_rounds)) refuse("round-limit", at, `a loop stops after max_rounds, 1 to ${MAX_ROUNDS}`);
    }
    if (id) seen.push(id);
    if (id && isEngine) engines.push(id);
  });

  const gates: unknown[] = has("steps") && Array.isArray(doc.gates) ? (doc.gates as unknown[]) : [];
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
    else if (typeof g.before === "string") gated.add(g.before);
    if (g.who !== "principal") refuse("gate-shape", at, "a gate waits for the principal");
    if (!texts(g.shows)) refuse("gate-shape", at, "a gate shows the principal the evidence");
    if (!texts(g.options) || !g.options.includes("approve")) refuse("gate-shape", at, "a gate offers approve among its options");
    const silence = g.on_silence;
    if (!isRec(silence) || !text(silence.after) || !oneOf(SILENCE_OUTCOMES, silence.then)) {
      refuse("silence-never-approves", at, `silence never approves: on_silence is { after, then } with then one of ${SILENCE_OUTCOMES.join(", ")}`);
    }
    if ("on_change" in g && idx >= 0) {
      const back = typeof g.on_change === "string" ? seen.indexOf(g.on_change) : -1;
      if (back < 0 || back >= idx) refuse("round-limit", at, "on_change goes back to a step before the gated one");
      if (!rounds(g.max_changes)) refuse("round-limit", at, `a change loop stops after max_changes, 1 to ${MAX_ROUNDS}`);
    }
  });
  for (const id of outward) if (!gated.has(id)) refuse("gate-before-outward", `steps.${id}`, "an outward or irreversible step waits for the principal: put a gate before it");

  const stop = doc.stop;
  if (has("stop") && (!Array.isArray(stop) || stop.length === 0 || !(stop as unknown[]).every(r => isRec(r) && text(r.when) && text(r.then)))) {
    refuse("stop-required", "stop", "an SOP has at least one stop rule, each { when, then }");
  }
  const budget = doc.budget;
  if (has("budget")) {
    if (!isRec(budget)) refuse("budget-stop", "budget", "a budget is { per_run, per_month, on_exceed }");
    else {
      const amounts: Amount[] = [];
      for (const k of ["per_run", "per_month"]) {
        if (template && blank(budget[k])) continue;
        const a = amountOf(budget[k]);
        if (!a) refuse("budget-stop", `budget.${k}`, `an amount is a number with a currency, such as 5 USD, or 0 for nothing at all; not ${shown(budget[k])}`);
        else amounts.push(a);
      }
      const [run, month] = amounts.length === 2 ? amounts : [];
      if (run && month && run.currency && month.currency && run.currency !== month.currency) refuse("budget-stop", "budget", "per_run and per_month are in one currency");
      else if (run && month && run.value > month.value) refuse("budget-stop", "budget", "per_run is at most per_month");
      if (!oneOf(BUDGET_ON_EXCEED, budget.on_exceed)) refuse("budget-stop", "budget.on_exceed", `on_exceed is ${BUDGET_ON_EXCEED.join(" or ")}: spending past the budget never goes on by itself`);
      if (amounts.some(a => a.value === 0)) for (const id of engines) refuse("budget-stop", `steps.${id}`, "the budget is 0, so no engine step may run");
    }
  }
  if (has("done") && !texts(doc.done)) refuse("done-required", "done", "an SOP lists the checks that make a run done");
  const report = doc.report;
  if (has("report") && (!isRec(report) || !text(report.to) || !texts(report.holds) || !report.holds.includes("citations"))) {
    refuse("report-citations", "report", "a report names where it goes and holds the citations the steps used (K11)");
  }
  const metrics = doc.metrics;
  if (has("metrics") && (!Array.isArray(metrics) || metrics.length === 0 || !(metrics as unknown[]).every(m => isRec(m) && text(m.name) && text(m.from) && text(m.every)))) {
    refuse("metrics-required", "metrics", "an SOP measures something across runs: each metric has a name, where it comes from and how often");
  }
  return { refusals, warnings };
}
