// The decision-brief template (ADR-0023 §5.2): front matter, the fixed headings in order, labelled lines and one
// GFM table. It reads only that template, by hand. It is not a general markdown parser. A heading it doesn't know
// is left on the draft so lintBrief reports unknown_section (DB6), and the domain then lints the result. JSON
// callers skip this adapter. The blank itself is brief-template-text.ts, the guide's fence byte for byte.
import type { BriefProblem } from "@morndo/domain";
import { parseDeadline } from "./ledger.ts";
import { BRIEF_TEMPLATE } from "./brief-template-text.ts";

export { BRIEF_TEMPLATE };

export type ParsedTemplate = { draft: Record<string, unknown>; problems: BriefProblem[] };

const ORDER = [
  "The ask",
  "Why now",
  "Options compared",
  "Why the recommendation",
  "What would change the recommendation",
  "Main risk and control",
  "What approval authorizes",
  "If no decision by the due date",
  "Decision",
  "Evidence",
] as const;
const OPTIONAL = new Set<string>(["If no decision by the due date", "Evidence"]);
const KNOWN = new Set<string>(ORDER);
const FRONT = new Set(["topic", "due", "minutes", "recommend", "blocking", "project", "task", "ref"]);
const LABEL = /^(Alternative|Main uncertainty|Note|Assumptions|Downside case|Risk|Control|Limits|Needs fresh approval|Review point):\s*(.*)$/;
const LISTS = new Set(["Assumptions", "Limits"]);

const problem = (code: string, where: string, text: string): BriefProblem => ({ level: "error", code, where, text });

function cellsOf(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
}

function isRule(line: string): boolean {
  const cells = cellsOf(line);
  return cells !== null && cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c));
}

// A labelled line, then its continuation (wrapped prose joined with a space; a list stays items). The prose before
// the first label is the section's own text.
function splitLabels(body: string): { prose: string; labels: Map<string, string>; lists: Map<string, string[]> } {
  const labels = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const prose: string[] = [];
  let current: string | null = null;
  let mode: "prose" | "label" | "list" = "prose";
  for (const line of body.split("\n")) {
    const m = LABEL.exec(line.trim());
    if (m) {
      current = m[1] ?? "";
      const rest = (m[2] ?? "").trim();
      if (LISTS.has(current)) {
        lists.set(current, rest ? [rest] : []);
        mode = "list";
      } else {
        labels.set(current, rest);
        mode = "label";
      }
      continue;
    }
    if (mode === "list" && current) {
      const item = /^[-*]\s+(.*)$/.exec(line.trim());
      if (item) { lists.get(current)?.push((item[1] ?? "").trim()); continue; }
      if (!line.trim()) continue;
      mode = "prose";
      current = null;
    }
    if (mode === "label" && current && line.trim()) {
      labels.set(current, `${labels.get(current) ?? ""} ${line.trim()}`.trim());
      continue;
    }
    if (mode === "label" && !line.trim()) { mode = "prose"; current = null; continue; }
    prose.push(line);
  }
  return { prose: prose.join("\n").trim(), labels, lists };
}

function parseTable(body: string): { headers: string[]; rows: { factor: string; cells: string[] }[]; rest: string } | null {
  const lines = body.split("\n");
  const start = lines.findIndex(l => cellsOf(l) !== null);
  if (start === -1) return null;
  const header = cellsOf(lines[start] ?? "");
  const rule = lines[start + 1] ?? "";
  if (!header || !isRule(rule)) return null;
  const rows: { factor: string; cells: string[] }[] = [];
  let i = start + 2;
  for (; i < lines.length; i++) {
    const c = cellsOf(lines[i] ?? "");
    if (!c) break;
    const [factor, ...cells] = c;
    rows.push({ factor: factor ?? "", cells });
  }
  const rest = [...lines.slice(0, start), ...lines.slice(i)].join("\n");
  return { headers: header.slice(1), rows, rest };
}

function decisionOptions(body: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (const line of body.split("\n")) {
    const m = /^[-*]\s+\[([^\]]*)\]\s*(.*)$/.exec(line.trim());
    if (m) out.push({ key: (m[1] ?? "").trim(), label: (m[2] ?? "").trim() });
  }
  return out;
}

function evidenceOf(body: string): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  for (const line of body.split("\n")) {
    const m = /^[-*]\s+\[([^\]]*)\]\(([^)]*)\)\s*$/.exec(line.trim());
    if (m) out.push({ label: (m[1] ?? "").trim(), url: (m[2] ?? "").trim() });
  }
  return out;
}

function frontMatter(text: string, draft: Record<string, unknown>, problems: BriefProblem[]): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") {
    problems.push(problem("missing_section", "front matter", "the brief starts with a --- block of topic, due, minutes and recommend"));
    return text;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i]?.trim() === "---") { end = i; break; }
  if (end === -1) {
    problems.push(problem("missing_section", "front matter", "the --- block is not closed"));
    return text;
  }
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line.trim());
    if (!m) {
      problems.push(problem("unknown_section", "front matter", `a front-matter line is "key: value"; ${JSON.stringify(line.trim())} is not`));
      continue;
    }
    const key = m[1] ?? "";
    const value = (m[2] ?? "").trim();
    if (!FRONT.has(key)) { draft[key] = value; continue; }   // lint names the unknown key
    if (key === "due") {
      const t = parseDeadline(value);
      draft.due = t ?? value;
    } else if (key === "minutes") {
      draft.minutes = /^-?\d+$/.test(value) ? Number(value) : value;
    } else if (key === "blocking") {
      draft.blocking = value === "true" ? true : value === "false" ? false : value;
    } else if (value) {
      draft[key] = value;
    }
  }
  return lines.slice(end + 1).join("\n");
}

// Markdown in the guide's template → the draft lintBrief checks. Problems here are the ones the draft cannot say
// (a heading out of order, a column whose label isn't the option's). An unknown heading is a key on the draft.
export function parseBriefMarkdown(text: string): ParsedTemplate {
  const draft: Record<string, unknown> = {};
  const problems: BriefProblem[] = [];
  const body = frontMatter(text, draft, problems);
  const lines = body.split("\n");
  type Section = { level: number; title: string; body: string };
  const sections: Section[] = [];
  let current: Section | null = null;
  const loose: string[] = [];
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (current) sections.push(current);
      current = { level: (h[1] ?? "").length, title: (h[2] ?? "").trim(), body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
    else if (line.trim()) loose.push(line);
  }
  if (current) sections.push(current);
  if (loose.length) draft.preamble = loose.join("\n");

  const h1 = sections.filter(s => s.level === 1);
  if (h1.length === 1) draft.headline = h1[0]?.title ?? "";
  else if (h1.length === 0) problems.push(problem("missing_section", "headline", "the brief needs one heading: \"# <Verb> option <KEY>: …\""));
  else {
    draft.headline = h1[0]?.title ?? "";
    problems.push(problem("unknown_section", "headline", "the brief has one headline, the single # heading"));
  }

  const h2 = sections.filter(s => s.level !== 1);
  let last = -1;
  for (const s of h2) {
    if (s.level !== 2 || !KNOWN.has(s.title)) {
      draft[s.title || "(blank heading)"] = s.body.trim();
      continue;
    }
    const at = ORDER.indexOf(s.title as (typeof ORDER)[number]);
    if (at <= last) {
      problems.push(problem("unknown_section", s.title, `"${s.title}" is out of order; keep the template's headings in their order`));
    }
    last = at;
    fill(draft, s.title, s.body);
  }
  for (const title of ORDER) {
    if (OPTIONAL.has(title)) continue;
    if (!h2.some(s => s.title === title)) {
      // Left absent: lintBrief names the missing section. Nothing to add here.
    }
  }
  checkColumns(draft, problems);
  return { draft, problems };
}

function fill(draft: Record<string, unknown>, title: string, raw: string): void {
  if (title === "Options compared") {
    const table = parseTable(raw);
    const labels = splitLabels(table ? table.rest : raw);
    const note = labels.labels.get("Note");
    draft.comparison = {
      ...(table ? { rows: table.rows.map(r => ({ factor: r.factor, cells: r.cells })) } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(table ? { __headers: table.headers } : {}),
    };
    return;
  }
  if (title === "Decision") {
    draft.options = decisionOptions(raw);
    return;
  }
  if (title === "Evidence") {
    draft.evidence = evidenceOf(raw);
    return;
  }
  const { prose, labels, lists } = splitLabels(raw);
  if (title === "The ask") {
    draft.ask = {
      ...(prose ? { text: prose } : {}),
      ...(labels.has("Alternative") ? { alternative: labels.get("Alternative") } : {}),
      ...(labels.has("Main uncertainty") ? { uncertainty: labels.get("Main uncertainty") } : {}),
    };
    return;
  }
  if (title === "Why now") { if (prose) draft.whyNow = prose; return; }
  if (title === "What would change the recommendation") { if (prose) draft.changeIf = prose; return; }
  if (title === "If no decision by the due date") { if (prose) draft.ifNoAnswer = prose; return; }
  if (title === "Why the recommendation") {
    draft.why = {
      ...(prose ? { text: prose } : {}),
      ...(lists.has("Assumptions") ? { assumptions: lists.get("Assumptions") } : {}),
      ...(labels.has("Downside case") ? { downside: labels.get("Downside case") } : {}),
    };
    return;
  }
  if (title === "Main risk and control") {
    draft.risk = {
      ...(labels.has("Risk") ? { risk: labels.get("Risk") } : {}),
      ...(labels.has("Control") ? { control: labels.get("Control") } : {}),
    };
    return;
  }
  if (title === "What approval authorizes") {
    draft.authorizes = {
      ...(lists.has("Limits") ? { limits: lists.get("Limits") } : {}),
      ...(labels.has("Needs fresh approval") ? { freshApproval: labels.get("Needs fresh approval") } : {}),
      ...(labels.has("Review point") ? { reviewPoint: labels.get("Review point") } : {}),
    };
  }
}

// The table's columns are the Decision list: same keys, same labels, same order (DB4). Lint sees cell counts; the
// headings are only in the markdown, so the mismatch is named here and the header list is not part of the draft.
function checkColumns(draft: Record<string, unknown>, problems: BriefProblem[]): void {
  const comparison = draft.comparison;
  if (!comparison || typeof comparison !== "object") return;
  const box = comparison as Record<string, unknown>;
  const headers = box.__headers;
  delete box.__headers;
  if (!Array.isArray(headers)) return;
  const options = Array.isArray(draft.options) ? draft.options : [];
  const parsed = headers.map(h => {
    const m = /^([A-Za-z0-9_-]{1,16})\s*·\s*(.+)$/.exec(String(h).trim());
    return m ? { key: m[1] ?? "", label: (m[2] ?? "").trim() } : null;
  });
  const opts = options.map(o => (o && typeof o === "object" ? o as { key?: unknown; label?: unknown } : {}));
  const same = parsed.length === opts.length && parsed.every((h, i) => {
    const o = opts[i];
    return h !== null && typeof o?.key === "string" && typeof o.label === "string"
      && h.key.toLowerCase() === o.key.toLowerCase() && h.label === o.label;
  });
  if (!same) {
    const got = headers.map(h => String(h)).join(", ") || "none";
    problems.push(problem("table_columns", "comparison", `the table's columns are ${got}; they must be the Decision list, in its order, each "KEY · label"`));
  }
}
