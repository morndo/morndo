// Decision briefs (ADR-0023, design docs/design/decision-briefs/README.md §4): the asker's case for one decision, in
// the owner's fixed sections, as one value in the Escalation context. Pure: no clock (callers pass `now`), no markdown
// library, no I/O. lintBrief is the one check (DB10): the CLI, the agent route and the dry run all call it, so an agent
// sees exactly what the hub refuses. Warnings never refuse; a brief with errors is not returned and carries only its
// errors, so a refusal says what to fix and nothing else.
// The terms (decision brief, version, lint, compact card) and the rules DB1 to DB10 and E14 are in docs/domain.md.
import type { Asker, Ask } from "./escalation.ts";
import { escalationId } from "./escalation.ts";

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

// A date or a time, named in words: what "Why now" needs. Month names capitalised, so "may" stays a verb.
const WHEN = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s\d{4}\b|\b(?:19|20)\d{2}\b/;

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

  // DB7: prose in the subset — paragraphs, lists, bold, italic, strikethrough, code, quotes, tables, https links. No
  // headings of the asker's own (the format owns the outline), no raw HTML, no images; a link that isn't https is
  // refused. What lint accepts, the renderer shows; what the renderer would drop, lint refuses (A1).
  markdown(where: string, s: string) {
    if (/^\s{0,3}#{1,6}(?:\s|$)/m.test(s)) { this.error("bad_markdown", where, "no headings of your own; the format owns the outline"); return; }
    this.#subset(where, s);
  }

  // DB7 for a field that lands inside a line of briefMarkdown which already has its own shape — the title, a labelled
  // line, a list item, a table cell (§4.5: an old app renders `details` as markdown). Links must be https, no raw HTML,
  // no images; a heading can't form there, so the one rule that can't bite isn't checked.
  inline(where: string, s: string) { this.#subset(where, s); }

  #subset(where: string, s: string) {
    if (/!\[[^\]]*\]\([^)]*\)/.test(s)) { this.error("bad_markdown", where, "no images; link the evidence instead"); return; }
    if (/<!--[\s\S]*?-->|<!?[a-zA-Z/][^>\n]*>/.test(s)) { this.error("bad_markdown", where, "no raw HTML; plain markdown only"); return; }
    const bad = [...s.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g)].map(m => m[1] ?? "").find(t => !t.startsWith("https://"));
    if (bad !== undefined) this.error("bad_link", where, `"${bad}" is not an https address; links stay https`);
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
  // Keys compare case-blind (the headline names an option "in any case", DB2, and the table heads uppercase them):
  // two keys that differ only in case are one key twice.
  const keysAnyCase = new Set<string>();
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
      if (keysAnyCase.has(key.toLowerCase())) { lint.error("duplicate_option", `options[${i}]`, `option ${key} appears twice; keys must be unique, whatever the case`); optionsBroken = true; continue; }
      keys.add(key);
      keysAnyCase.add(key.toLowerCase());
      if (label.length > 40) { lint.error("too_long", `options[${i}].label`, `${label.length} characters; the cap is 40`); options.push({ key, label }); continue; }
      // A label lands in briefMarkdown's table head and tap lines: no pipe may break the columns (DB7).
      if (label.includes("|")) { lint.error("bad_markdown", `options[${i}].label`, `a label can't hold "|"; it heads a column of the comparison`); continue; }
      lint.inline(`options[${i}].label`, label);
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
  // A finite number outside Date's own range (±8.64e15 ms, the epoch times ECMA-262's time clip holds) is refused as
  // a problem, never thrown: the due_past message formats it with a Date, which RangeErrors there (DB10).
  let due = 0;
  if (draft.due === undefined || draft.due === null) lint.error("no_due", "due", "the decision needs a due date after now");
  else if (typeof draft.due !== "number" || !Number.isFinite(draft.due) || Math.abs(draft.due) > 8.64e15) lint.error("bad_due", "due", "a due is a time in ms since the epoch; the template reads a date alone as the end of that day");
  else if (draft.due <= now) lint.error("due_past", "due", `the due time is at ${new Date(draft.due).toISOString()}, not after now; pick one still ahead`);
  else due = draft.due;
  let minutes = 0;
  if (typeof draft.minutes !== "number" || !Number.isInteger(draft.minutes) || draft.minutes < 1 || draft.minutes > 30) {
    lint.error("bad_minutes", "minutes", "minutes to read and decide, a whole number from 1 to 30");
  } else minutes = draft.minutes;

  const topic = lint.string("topic", draft.topic, CAPS.topic);
  const headline = lint.string("headline", draft.headline, CAPS.headline);
  if (headline !== null) lint.inline("headline", headline);   // it becomes briefMarkdown's own title line (§4.5)
  if (recommend && headline !== null) {
    // "option <KEY>" with a word boundary, and only a token that is one of the brief's own keys (any case) names an
    // option: "adoption" and "the option with less risk" name none, whatever follows "option".
    const named = [...headline.matchAll(/\boption\s+([A-Za-z0-9_-]{1,16})/gi)]
      .map(m => (m[1] ?? "").toLowerCase())
      .filter(k => keysAnyCase.has(k));
    const others = named.filter(k => k !== recommend.toLowerCase());
    if (named.length === 0) {
      lint.error("headline_option", "headline", `the headline names no option; name the one you recommend, as "option ${recommend}"`);
    } else if (others.length > 0) {
      lint.error("headline_option", "headline", `the headline names option ${others[0]!.toUpperCase()}, but recommend is ${recommend}; name the option you recommend`);
    }
  }
  const ask = isObj(draft.ask) ? draft.ask : {};
  const askText = lint.string("ask.text", ask.text, CAPS.askText, true);
  if (askText !== null) lint.markdown("ask.text", askText);
  const alternative = lint.string("ask.alternative", ask.alternative, CAPS.line);
  if (alternative !== null) lint.markdown("ask.alternative", alternative);
  const uncertainty = lint.string("ask.uncertainty", ask.uncertainty, CAPS.line);
  if (uncertainty !== null) lint.markdown("ask.uncertainty", uncertainty);
  const whyNow = lint.string("whyNow", draft.whyNow, CAPS.whyNow, true);
  if (whyNow !== null) lint.markdown("whyNow", whyNow);
  const why = isObj(draft.why) ? draft.why : {};
  const whyText = lint.string("why.text", why.text, CAPS.whyText, true);
  if (whyText !== null) lint.markdown("why.text", whyText);
  // Assumptions may be empty when no money appears (DB5); limits are the asker's commitment, at least one.
  const assumptions = lint.strings("why.assumptions", why.assumptions, CAPS.item, 0, CAPS.list);
  for (const [i, a] of (assumptions ?? []).entries()) lint.inline(`why.assumptions[${i}]`, a);
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
  if (downside !== null) lint.inline("why.downside", downside);
  // One-line sections print inside a labelled or list line of briefMarkdown (§4.5) — or, for changeIf and ifNoAnswer,
  // as a section's whole body — so each is checked for the shape it lands in, as the Md fields are (DB7).
  const changeIf = lint.string("changeIf", draft.changeIf, CAPS.line);
  if (changeIf !== null) lint.markdown("changeIf", changeIf);
  const risk = isObj(draft.risk) ? draft.risk : {};
  const riskText = lint.string("risk.risk", risk.risk, CAPS.line);
  if (riskText !== null) lint.inline("risk.risk", riskText);
  const control = lint.string("risk.control", risk.control, CAPS.line);
  if (control !== null) lint.inline("risk.control", control);
  const authorizes = isObj(draft.authorizes) ? draft.authorizes : {};
  const limits = lint.strings("authorizes.limits", authorizes.limits, CAPS.item, 1, CAPS.list);
  for (const [i, l] of (limits ?? []).entries()) lint.inline(`authorizes.limits[${i}]`, l);
  const freshApproval = lint.string("authorizes.freshApproval", authorizes.freshApproval, CAPS.line);
  if (freshApproval !== null) lint.inline("authorizes.freshApproval", freshApproval);
  const reviewPoint = lint.string("authorizes.reviewPoint", authorizes.reviewPoint, CAPS.line);
  if (reviewPoint !== null) lint.inline("authorizes.reviewPoint", reviewPoint);
  const ifNoAnswer = draft.ifNoAnswer === undefined || draft.ifNoAnswer === null
    ? null
    : lint.string("ifNoAnswer", draft.ifNoAnswer, CAPS.line);
  if (ifNoAnswer !== null) lint.markdown("ifNoAnswer", ifNoAnswer);

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
    if (factor !== null && factor.includes("|")) {
      lint.error("bad_markdown", `comparison.rows[${i}].factor`, "a factor can't hold \"|\"; it would break the table's columns");
    }
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
        if (CONTROL.test(cell) || cell.includes("\n")) { lint.error("control_char", `comparison.rows[${i}].cells[${j}]`, "control characters, or a line break in a one-line field"); continue; }
        // A cell sits between the row's pipes in briefMarkdown: "|" in it would add a column, a second line would
        // leave the table (DB7).
        if (cell.includes("|")) { lint.error("bad_markdown", `comparison.rows[${i}].cells[${j}]`, "a cell can't hold \"|\"; it would break the table's columns"); continue; }
        lint.inline(`comparison.rows[${i}].cells[${j}]`, cell);
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
  if (note !== null) lint.inline("comparison.note", note);

  const evidenceIn = Array.isArray(draft.evidence) ? draft.evidence : [];
  if (evidenceIn.length > CAPS.evidence) lint.error("too_long", "evidence", `${evidenceIn.length} items; the cap is ${CAPS.evidence}`);
  const evidence: { label: string; url: string }[] = [];
  for (let i = 0; i < evidenceIn.length; i++) {
    const item = isObj(evidenceIn[i]) ? evidenceIn[i] : {};
    const label = lint.string(`evidence[${i}].label`, item.label, CAPS.evidenceLabel);
    const url = lint.string(`evidence[${i}].url`, item.url, CAPS.evidenceUrl);
    // DB7 on an evidence link: https only, and a target briefMarkdown can write inside "[label](url)" without
    // breaking out of it — so nothing on the principal's devices reaches out over plain http or a spliced-in link.
    if (url !== null && !/^https:\/\//.test(url)) {
      lint.error("bad_link", `evidence[${i}].url`, `"${url}" is not an https address; evidence links stay https`);
      continue;
    }
    if (url !== null && !/^https:\/\/[^\s()]+$/.test(url)) {
      lint.error("bad_link", `evidence[${i}].url`, `"${url}" can't be written as a link's target; no spaces or brackets in it`);
      continue;
    }
    if (label !== null) {
      if (/[[\]]/.test(label)) lint.error("bad_markdown", `evidence[${i}].label`, "no brackets in an evidence label; they would break the link it names");
      else lint.inline(`evidence[${i}].label`, label);
    }
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

  // Warnings (DB10): they come back with the brief, one line each, and never refuse. A refused brief reports its
  // errors only — warnings about a brief that won't be filed are noise.
  const warn = (code: string, where: string, text: string) => lint.problems.push({ level: "warning", code, where, text });
  if (!Array.isArray(draft.evidence) || draft.evidence.length === 0) {
    warn("no_evidence", "evidence", "no evidence listed; link what backs the numbers");
  }
  if (askText !== null && !/\*\*[^*]*\d[^*]*\*\*/.test(askText)) {
    warn("ask_no_bold_figure", "ask.text", "the ask carries no number in bold; put the key numbers in bold, the principal reads them first");
  }
  if (whyNow !== null && !WHEN.test(whyNow)) {
    warn("why_now_no_date", "whyNow", "\"Why now\" names no date or time; say what forces the decision, and when");
  }
  if (changeIf !== null && !/\d/.test(changeIf)) {
    warn("change_if_vague", "changeIf", "\"What would change\" names no number or date; make it a condition someone can check");
  }
  const words = stringsOf(draft).join(" ").split(/\s+/).filter(Boolean).length;
  if (words / 200 > minutes) {
    warn("minutes_low", "minutes", `${words} words take about ${Math.ceil(words / 200)} minutes to read at 200 words a minute; minutes says ${minutes}`);
  }

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

// The compact card (design §4.4): what every ask, brief-backed or plain, becomes on the principal's list. Derived from
// the ask alone, never sent: one derivation for the phone, the desktop and the hub, so they cannot disagree. The
// clause split of a long title is the phone's own rule (apps/web/src/lib/phone/brief.ts), moved into the domain.
const TITLE_MAX = 60;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// A title from a long text: its first clause, up to a full stop or "?" or "!" followed by a space or the end, a colon,
// a semicolon or an opening bracket ("recipes.index" or "www.example.com" don't end it); at most 60 characters, cut at
// a word. `rest`: what isn't in the title, or the whole text when the title had to be cut.
export function clause(text: string): { title: string; rest: string | null } {
  const t = oneLine(text);
  const m = /^(.+?)(?:([?!])(?:\s|$)|\.(?:\s|$)|:\s|;\s|\s\()/.exec(t);
  const head = m ? `${m[1] ?? ""}${m[2] ?? ""}`.trim() : t;
  const restAt = m ? (m[0].endsWith("(") ? m[0].length - 1 : m[0].length) : t.length;
  if (head.length <= TITLE_MAX) {
    const rest = t.slice(restAt).trim();
    return { title: head, rest: rest || null };
  }
  const cut = head.slice(0, TITLE_MAX - 1);
  const word = cut.lastIndexOf(" ");
  return { title: `${(word > 20 ? cut.slice(0, word) : cut).replace(/[\s,.;:–-]+$/, "")}…`, rest: t };
}

export type QuickAnswer = { key: string; label: string };
export type CompactCard = {
  topic: string;                      // ≤ 60, one line
  headline: string | null;            // one line: what the principal is asked
  recommended: string | null;         // the recommended option's label
  due: number | null;
  minutes: number | null;
  spend: boolean;                     // a money figure appears in the ask
  quickAnswers: QuickAnswer[];        // the tappable answers, the recommended one first
  hasBrief: boolean;
};

export function cardOf(item: Ask & { brief: DecisionBrief | null }): CompactCard {
  const { brief } = item;
  if (brief) {
    // A brief with a money figure in it asks for a read and a decision, not a tap (owner decision Q2's default);
    // without one, its own options are the quick answers, the recommended one first.
    const spend = stringsOf(brief).some(hasMoney);
    const recommended = brief.options.find(o => o.key === brief.recommend) ?? null;
    const ordered = recommended ? [recommended, ...brief.options.filter(o => o !== recommended)] : brief.options;
    return {
      topic: brief.topic, headline: brief.headline,
      recommended: recommended?.label ?? null,
      due: brief.due, minutes: brief.minutes,
      spend,
      quickAnswers: spend ? [] : ordered.map(o => ({ key: o.key, label: o.label })),
      hasBrief: true,
    };
  }
  const own = item.shortTitle !== null ? oneLine(item.shortTitle) : null;
  const split = own === null ? clause(item.title) : null;
  return {
    topic: own ?? split!.title,
    headline: item.summary !== null ? oneLine(item.summary) : split!.rest,
    recommended: item.answerBy === "tap" ? item.options[0]?.label ?? null : null,
    due: item.deadline,
    minutes: item.minutes,
    spend: hasMoney(item.title) || (item.summary !== null && hasMoney(item.summary)) || (item.details !== null && hasMoney(item.details)),
    quickAnswers: item.answerBy === "tap" ? item.options.map(o => ({ key: o.key, label: o.label })) : [],
    hasBrief: false,
  };
}

// The brief as one text (§4.5): the guide's own headings, in the guide's order, so an old app behind "More" and the
// CLI's `show` print the case the same way the template writes it. A section the brief leaves out is left out here
// too. Pure derivation: the value is the source, this is one reading of it.
export function briefMarkdown(brief: DecisionBrief): string {
  const table = [
    `| Factor | ${brief.options.map(o => `${o.key.toUpperCase()} · ${o.label}`).join(" | ")} |`,
    `|---|${brief.options.map(() => "---").join("|")}|`,
    ...brief.comparison.rows.map(r => `| ${r.factor} | ${r.cells.join(" | ")} |`),
  ];
  const blocks: string[][] = [
    [`# ${brief.headline}`],
    ["## The ask", brief.ask.text],
    [`Alternative: ${brief.ask.alternative}`, `Main uncertainty: ${brief.ask.uncertainty}`],
    ["## Why now", brief.whyNow],
    ["## Options compared", ...table],
    [`Note: ${brief.comparison.note}`],
    ["## Why the recommendation", brief.why.text],
    ...(brief.why.assumptions.length > 0 ? [["Assumptions:", ...brief.why.assumptions.map(a => `- ${a}`)]] : []),
    [`Downside case: ${brief.why.downside}`],
    ["## What would change the recommendation", brief.changeIf],
    ["## Main risk and control", `Risk: ${brief.risk.risk}`, `Control: ${brief.risk.control}`],
    ["## What approval authorizes", "Limits:", ...brief.authorizes.limits.map(l => `- ${l}`)],
    [`Needs fresh approval: ${brief.authorizes.freshApproval}`, `Review point: ${brief.authorizes.reviewPoint}`],
    ...(brief.ifNoAnswer !== null ? [["## If no decision by the due date", brief.ifNoAnswer]] : []),
    ["## Decision", ...brief.options.map(o => `- [${o.key}] ${o.label}`)],
    ...(brief.evidence.length > 0 ? [["## Evidence", ...brief.evidence.map(e => `- [${e.label}](${e.url})`)]] : []),
  ];
  return blocks.map(b => b.join("\n")).join("\n\n");
}

// The Ask a filed brief becomes (§4.5): everything an app that doesn't know `brief` reads is filled from the brief, so
// an old phone shows the whole case behind More and an old desktop under "Why the manager asks". The recommended
// option comes first (the manager's protocol); the hub tracks it (E14). `briefVersion` rides along for the wire.
export function askFromBrief(id: string, brief: DecisionBrief, asker: Asker, version: number, at: number): Ask & { briefVersion: number } {
  const recommended = brief.options.find(o => o.key === brief.recommend) ?? brief.options[0]!;
  const options = [recommended, ...brief.options.filter(o => o !== recommended)]
    .map(o => ({ key: o.key, label: o.label, detail: null }));
  return {
    id: escalationId(id), asker, need: "decision",
    title: brief.headline, shortTitle: brief.topic, summary: brief.headline,
    minutes: brief.minutes, link: null, details: briefMarkdown(brief),
    context: null, contextKind: "markdown",
    options, answerBy: "tap", recommendation: brief.headline,
    ifNoAnswer: brief.ifNoAnswer, deadline: brief.due,
    blocking: brief.blocking, project: brief.project,
    askedAt: at, messageId: null, tracking: "hub",
    briefVersion: version,
  };
}
