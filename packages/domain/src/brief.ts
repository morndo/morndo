// Decision briefs (ADR-0023, design docs/design/decision-briefs/README.md §4): the asker's case for one decision, in
// the owner's fixed sections, as one value in the Escalation context. Pure: no clock (callers pass `now`), no markdown
// library, no I/O. lintBrief is the one check (DB10): the CLI, the agent route and the dry run all call it, so an agent
// sees exactly what the hub refuses. Warnings never refuse; a brief with errors is not returned and carries only its
// errors, so a refusal says what to fix and nothing else.
// The terms (decision brief, version, lint, compact card) and the rules DB1 to DB10 and E14 are in docs/domain.md.

export type Md = string;              // prose in the brief's markdown subset (DB7)

export type BriefOption = { key: string; label: string };            // the manager protocol's grammar, so a tap line answers

export type DecisionBrief = {
  topic: string;                      // ≤ 60, one line
  due: number;                        // ms; the template adapter reads a date alone as the end of that day
  minutes: number;                    // 1–30: time to read and decide
  headline: string;                   // ≤ 100, one line, names one option: "Approve option B: …"
  recommend: string;                  // an option key
  ask: { text: Md; alternative: Md; uncertainty: Md };   // alternative and uncertainty: one line each
  whyNow: Md;
  options: BriefOption[];             // 2–6, in the table's column order
  comparison: { rows: { factor: string; cells: string[] }[]; note: string };   // cells in option order
  why: { text: Md; assumptions: string[]; downside: string };
  changeIf: string;
  risk: { risk: string; control: string };
  authorizes: { limits: string[]; freshApproval: string; reviewPoint: string };
  ifNoAnswer: string | null;
  evidence: { label: string; url: string }[];
  blocking: boolean; project: string | null; task: string | null; ref: string | null;
};

export type BriefProblem = { level: "error" | "warning"; code: string; where: string; text: string };

// The caps (design §4.3), one place: the lint names a field by its place in the brief, never by a count.
const CAPS = {
  topic: 60, headline: 100, askText: 600, line: 300, whyNow: 800, whyText: 1200, item: 200,
  factor: 40, cell: 120, note: 300, list: 6, evidence: 8, evidenceLabel: 80, evidenceUrl: 2000, brief: 16 * 1024,
} as const;

// A control character (C0 or DEL, minus tab and newline): refused everywhere a string is read (§4.3). A newline is
// prose and allowed in the multi-line fields; the one-line fields refuse it as one.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000D-\u001F\u007F]/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const blank = (s: string) => s.trim() === "";

// Money, one pattern for the whole product (DB5 and the compact card): a currency sign before a digit, or a number
// (with k, m or bn) before a sign or an ISO code from a short list. "3 weeks" and "6 agent-days" are not money;
// "$2,400", "2.4k EUR" and "€180" are. One place, so a brief the lint passes and a card that says "includes spend"
// cannot disagree.
const MONEY = /[$€£¥₹]\s?\d|\d[\d.,]*(?:\s?(?:k|m|bn))?\s?(?:[$€£¥₹]|(?:USD|EUR|GBP|CHF|JPY|INR|CAD|AUD)\b)/;
export function hasMoney(text: string): boolean { return MONEY.test(text); }

// Every string value in the draft, keys apart: where a money figure can appear (DB5: anywhere in the brief).
function stringsOf(v: unknown, into: string[] = []): string[] {
  if (isText(v)) into.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, into);
  else if (isObj(v)) for (const x of Object.values(v)) stringsOf(x, into);
  return into;
}

class Lint {
  problems: BriefProblem[] = [];
  error(code: string, where: string, text: string) { this.problems.push({ level: "error", code, where, text }); }

  // One string leaf: DB6 (present, not empty) and the caps. `multiline` fields keep their paragraphs (§4.3).
  string(where: string, v: unknown, cap: number, multiline = false): string | null {
    if (!isText(v)) { this.error("missing_section", where, `the section is missing; every section of the template is required`); return null; }
    if (blank(v)) { this.error("empty_section", where, `the section is empty; write it or drop it from the brief`); return null; }
    if (v.length > cap) { this.error("too_long", where, `${v.length} characters; the cap is ${cap}`); return null; }
    if (CONTROL.test(v) || (!multiline && v.includes("\n"))) { this.error("control_char", where, "control characters, or a line break in a one-line field"); return null; }
    return v;
  }

  strings(where: string, v: unknown, cap: number, min: number, max: number): string[] | null {
    if (!Array.isArray(v)) { this.error("missing_section", where, "the section is missing; every section of the template is required"); return null; }
    if (v.length < min) { this.error("empty_section", where, `list at least ${min} ${min === 1 ? "item" : "items"}`); return null; }
    if (v.length > max) { this.error("too_long", where, `${v.length} items; the cap is ${max}`); return null; }
    const items: string[] = [];
    for (let i = 0; i < v.length; i++) {
      const s = this.string(`${where}[${i}]`, v[i], cap);
      if (s !== null) items.push(s);
    }
    return items;
  }
}

// The brief's own keys, and each fixed object's parts (DB6: an unknown section is refused, so a misspelt heading never
// drops its text). Checked before the sections, so a typo is named first. Array items are checked where they are read.
const KNOWN = new Set(["topic", "due", "minutes", "headline", "recommend", "ask", "whyNow", "options", "comparison", "why",
  "changeIf", "risk", "authorizes", "ifNoAnswer", "evidence", "blocking", "project", "task", "ref"]);
const FIXED: Record<string, readonly string[]> = {
  ask: ["text", "alternative", "uncertainty"], why: ["text", "assumptions", "downside"],
  risk: ["risk", "control"], authorizes: ["limits", "freshApproval", "reviewPoint"], comparison: ["rows", "note"],
};

function unknownKeys(lint: Lint, draft: Record<string, unknown>) {
  for (const [key, v] of Object.entries(draft)) {
    if (!KNOWN.has(key)) { lint.error("unknown_section", key, "the template has no section by that name; check its spelling"); continue; }
    const parts = FIXED[key];
    if (!parts || !isObj(v)) continue;
    for (const sub of Object.keys(v)) {
      if (!parts.includes(sub)) lint.error("unknown_section", `${key}.${sub}`, `the ${key} section has no "${sub}" part; check the template`);
    }
  }
}

export function lintBrief(draft: unknown, now: number): { brief: DecisionBrief | null; problems: BriefProblem[] } {
  const lint = new Lint();
  if (!isObj(draft)) {
    lint.error("missing_section", "root", "a brief is one object with the template's sections");
    return { brief: null, problems: lint.problems };
  }
  unknownKeys(lint, draft);

  // DB1: two to six options in the manager protocol's grammar, so every answer can be typed back as a tap line.
  const KEY = /^[A-Za-z0-9_-]{1,16}$/;
  const optionsIn = draft.options;
  const options: BriefOption[] = [];
  const keys = new Set<string>();
  let optionsBroken = !Array.isArray(optionsIn);
  if (!Array.isArray(optionsIn)) lint.error("missing_section", "options", "the section is missing; every section of the template is required");
  else if (optionsIn.length < 2) lint.error("no_options", "options", "a decision needs two to six options; \"do nothing\" counts when it is a real choice");
  else if (optionsIn.length > 6) lint.error("too_many_options", "options", `${optionsIn.length} options; the cap is six`);
  if (Array.isArray(optionsIn)) {
    optionsBroken ||= optionsIn.length < 2 || optionsIn.length > 6;
    for (let i = 0; i < optionsIn.length; i++) {
      const o = optionsIn[i]!;
      if (!isObj(o)) { lint.error("bad_option", `options[${i}]`, "an option is a key and a label"); optionsBroken = true; continue; }
      for (const sub of Object.keys(o)) {
        if (sub !== "key" && sub !== "label") lint.error("unknown_section", `options[${i}].${sub}`, `an option has no "${sub}" part; check the template`);
      }
      const { key, label } = o;
      if (!isText(key) || !KEY.test(key) || !isText(label) || blank(label) || CONTROL.test(label)) {
        lint.error("bad_option", `options[${i}]`, "a key of letters, digits, - and _ (at most 16) and a label of 1 to 40 characters");
        optionsBroken = true;
        continue;
      }
      if (keys.has(key)) { lint.error("duplicate_option", `options[${i}]`, `option ${key} appears twice; keys must be unique`); optionsBroken = true; continue; }
      keys.add(key);
      if (label.length > 40) { lint.error("too_long", `options[${i}].label`, `${label.length} characters; the cap is 40`); options.push({ key, label }); continue; }
      options.push({ key, label });
    }
  }

  // DB2: one recommended option, and the headline names exactly that one, as "option <KEY>" in any case. When the
  // options themselves are broken there is nothing to recommend against yet: the asker fixes those first.
  let recommend = "";
  if (!optionsBroken) {
    if (!isText(draft.recommend) || !keys.has(draft.recommend)) {
      lint.error("no_recommendation", "recommend",
        isText(draft.recommend) ? `"${draft.recommend}" is not one of the option keys (${[...keys].join(", ")})` : "name the key of the option you recommend");
    } else {
      recommend = draft.recommend;
    }
  }

  // DB3: a due time after the moment the brief is filed or restated, and the minutes it takes to read and decide.
  let due = 0;
  if (draft.due === undefined || draft.due === null) lint.error("no_due", "due", "the decision needs a due date after now");
  else if (typeof draft.due !== "number" || !Number.isFinite(draft.due)) lint.error("bad_due", "due", "a due is a time in ms since the epoch; the template reads a date alone as the end of that day");
  else if (draft.due <= now) lint.error("due_past", "due", `the due time is at ${new Date(draft.due).toISOString()}, not after now; pick one still ahead`);
  else due = draft.due;
  let minutes = 0;
  if (typeof draft.minutes !== "number" || !Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > 30) {
    lint.error("bad_minutes", "minutes", "minutes to read and decide, a whole number from 1 to 30");
  } else minutes = draft.minutes;

  const topic = lint.string("topic", draft.topic, CAPS.topic);
  const headline = lint.string("headline", draft.headline, CAPS.headline);
  if (recommend && headline !== null) {
    const named = [...headline.matchAll(/option\s+([A-Za-z0-9_-]{1,16})/gi)].map(m => (m[1] ?? "").toLowerCase());
    const others = named.filter(k => k !== recommend.toLowerCase());
    if (named.length === 0) {
      lint.error("headline_option", "headline", `the headline names no option; name the one you recommend, as "option ${recommend}"`);
    } else if (others.length > 0) {
      lint.error("headline_option", "headline", `the headline names option ${others[0]!.toUpperCase()}, but recommend is ${recommend}; name the option you recommend`);
    }
  }
  const ask = isObj(draft.ask) ? draft.ask : {};
  const askText = lint.string("ask.text", ask.text, CAPS.askText, true);
  const alternative = lint.string("ask.alternative", ask.alternative, CAPS.line);
  const uncertainty = lint.string("ask.uncertainty", ask.uncertainty, CAPS.line);
  const whyNow = lint.string("whyNow", draft.whyNow, CAPS.whyNow, true);
  const why = isObj(draft.why) ? draft.why : {};
  const whyText = lint.string("why.text", why.text, CAPS.whyText, true);
  // Assumptions may be empty when no money appears (DB5); limits are the asker's commitment, at least one.
  const assumptions = lint.strings("why.assumptions", why.assumptions, CAPS.item, 0, CAPS.list);
  let downside: string | null = null;
  if (!isText(why.downside) || blank(why.downside)) {
    lint.error("no_downside", "why.downside", "state what happens if the assumptions are wrong; every brief has a downside case");
  } else if (why.downside.length > CAPS.line) {
    lint.error("too_long", "why.downside", `${why.downside.length} characters; the cap is ${CAPS.line}`);
  } else if (CONTROL.test(why.downside) || why.downside.includes("\n")) {
    lint.error("control_char", "why.downside", "control characters, or a line break in a one-line field");
  } else {
    downside = why.downside;
  }
  const changeIf = lint.string("changeIf", draft.changeIf, CAPS.line);
  const risk = isObj(draft.risk) ? draft.risk : {};
  const riskText = lint.string("risk.risk", risk.risk, CAPS.line);
  const control = lint.string("risk.control", risk.control, CAPS.line);
  const authorizes = isObj(draft.authorizes) ? draft.authorizes : {};
  const limits = lint.strings("authorizes.limits", authorizes.limits, CAPS.item, 1, CAPS.list);
  const freshApproval = lint.string("authorizes.freshApproval", authorizes.freshApproval, CAPS.line);
  const reviewPoint = lint.string("authorizes.reviewPoint", authorizes.reviewPoint, CAPS.line);
  const ifNoAnswer = draft.ifNoAnswer === undefined || draft.ifNoAnswer === null
    ? null
    : lint.string("ifNoAnswer", draft.ifNoAnswer, CAPS.line);

  // DB4: one column per option in their order, three to ten factor rows, no empty cell ("n/a" is a value), and a note
  // on what the numbers include.
  const comparison = isObj(draft.comparison) ? draft.comparison : {};
  const rowsIn = comparison.rows;
  if (!Array.isArray(rowsIn)) lint.error("missing_section", "comparison.rows", "the section is missing; every section of the template is required");
  else if (rowsIn.length < 3 || rowsIn.length > 10) lint.error("table_rows", "comparison.rows", `${rowsIn.length} factor rows; the comparison needs three to ten`);
  const rows: { factor: string; cells: string[] }[] = [];
  for (let i = 0; Array.isArray(rowsIn) && i < rowsIn.length; i++) {
    const row = isObj(rowsIn[i]) ? rowsIn[i] : {};
    for (const sub of Object.keys(row)) {
      if (sub !== "factor" && sub !== "cells") lint.error("unknown_section", `comparison.rows[${i}].${sub}`, `a factor row has no "${sub}" part; check the template`);
    }
    const factor = lint.string(`comparison.rows[${i}].factor`, row.factor, CAPS.factor);
    const cellsIn = row.cells;
    let cells: string[] | null = Array.isArray(cellsIn) ? cellsIn : null;
    if (cells === null || (!optionsBroken && cells.length !== keys.size)) {
      lint.error("table_columns", `comparison.rows[${i}]`,
        `every row has one cell per option, in the order of the Decision list (${keys.size} options)`);
      cells = null;
    } else {
      const kept: string[] = [];
      for (let j = 0; j < cells.length; j++) {
        const cell = cells[j]!;
        if (!isText(cell) || blank(cell)) { lint.error("empty_cell", `comparison.rows[${i}].cells[${j}]`, "no empty cells: write a value, or \"n/a\" when there is none"); continue; }
        if (cell.length > CAPS.cell) { lint.error("too_long", `comparison.rows[${i}].cells[${j}]`, `${cell.length} characters; the cap is ${CAPS.cell}`); continue; }
        if (CONTROL.test(cell)) { lint.error("control_char", `comparison.rows[${i}].cells[${j}]`, "control characters, or a line break in a one-line field"); continue; }
        kept.push(cell);
      }
      cells = kept;
    }
    if (factor !== null) rows.push({ factor, cells: cells ?? [] });
  }
  let note: string | null = null;
  if (!isText(comparison.note) || blank(comparison.note)) {
    lint.error("no_table_note", "comparison.note", "say under the table what the numbers include and leave out");
  } else if (comparison.note.length > CAPS.note) {
    lint.error("too_long", "comparison.note", `${comparison.note.length} characters; the cap is ${CAPS.note}`);
  } else if (CONTROL.test(comparison.note) || comparison.note.includes("\n")) {
    lint.error("control_char", "comparison.note", "control characters, or a line break in a one-line field");
  } else {
    note = comparison.note;
  }

  const evidenceIn = Array.isArray(draft.evidence) ? draft.evidence : [];
  if (evidenceIn.length > CAPS.evidence) lint.error("too_long", "evidence", `${evidenceIn.length} items; the cap is ${CAPS.evidence}`);
  const evidence: { label: string; url: string }[] = [];
  for (let i = 0; i < evidenceIn.length; i++) {
    const item = isObj(evidenceIn[i]) ? evidenceIn[i] : {};
    const label = lint.string(`evidence[${i}].label`, item.label, CAPS.evidenceLabel);
    const url = lint.string(`evidence[${i}].url`, item.url, CAPS.evidenceUrl);
    if (label !== null && url !== null) evidence.push({ label, url });
  }

  // DB5: a money figure anywhere in the brief needs at least one stated assumption. When the assumptions are missing
  // outright, that is named where they belong; this fires when they are there and empty.
  if (assumptions !== null && assumptions.length === 0 && stringsOf(draft).some(hasMoney)) {
    lint.error("money_without_assumption", "why.assumptions", "money appears in the brief; state at least one assumption behind the numbers");
  }

  // The whole brief, as JSON: one bound, so a brief can't be a page in disguise (§4.3).
  let size = 0;
  try { size = JSON.stringify(draft)?.length ?? 0; } catch { size = Infinity; }
  if (size > CAPS.brief) lint.error("too_long", "brief", `the brief is ${size} characters as JSON; the cap is ${CAPS.brief}`);

  if (lint.problems.some(p => p.level === "error")) return { brief: null, problems: lint.problems };

  // No errors: the draft is the brief. The fields lint doesn't type itself (due, minutes) are checked where their
  // rules are (DB3); the optionals default as the wire schema reads them.
  const brief: DecisionBrief = {
    topic: topic!, headline: headline!,
    due, minutes,
    recommend,
    ask: { text: askText!, alternative: alternative!, uncertainty: uncertainty! },
    whyNow: whyNow!,
    options,
    comparison: { rows, note: note! },
    why: { text: whyText!, assumptions: assumptions ?? [], downside: downside! },
    changeIf: changeIf!,
    risk: { risk: riskText!, control: control! },
    authorizes: { limits: limits ?? [], freshApproval: freshApproval!, reviewPoint: reviewPoint! },
    ifNoAnswer,
    evidence,
    blocking: draft.blocking === true,
    project: isText(draft.project) ? draft.project : null,
    task: isText(draft.task) ? draft.task : null,
    ref: isText(draft.ref) ? draft.ref : null,
  };
  return { brief, problems: lint.problems };
}
