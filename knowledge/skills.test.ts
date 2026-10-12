// Every shipped skill against the Agent Skills specification (https://agentskills.io/specification, read 2026-10-12) and
// its reference validator (skills-ref, src/skills_ref/validator.py at 547831f3a2, read the same day): the fields a
// SKILL.md may have, the name and length rules, metadata as a map of strings. Then Morndo's own rules for a loop pattern
// (ADR-0026): the sections each must have, dated sources (K1), a re-check at most 90 days after the reads (K2), a stale
// skill that warns and still passes (K6), and guards whose Catches name the skill's own failure modes and whose rule is
// one docs/domain.md defines. The negative controls are the same checks on broken copies.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = join(ROOT, "knowledge/skills");
const FIELDS = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
const PATTERN_SECTIONS = ["When to use", "When not to use", "Failure modes", "Guards", "Sources"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
// What docs/domain.md defines, read when a check first needs it, so a missing file fails a test instead of the import:
// the rule ids of its rule tables (rows under a "| # |" header) and of its rule lists ("- **R1**"), and the terms of
// its glossaries (the first column under a "| Term |" header), which a guard may cite as "Term (docs/domain.md, ...)",
// as the other-provider rule has no id.
let domain: { ids: Set<string>; terms: string[] } | undefined;
function domainRules() {
  if (domain) return domain;
  const ids = new Set<string>();
  const terms: string[] = [];
  let table = "";
  for (const line of readFileSync(join(ROOT, "docs/domain.md"), "utf8").split("\n")) {
    if (!line.startsWith("|")) table = "";
    else if (/^\| # \|/.test(line)) table = "rules";
    else if (/^\| Term(s)? \|/.test(line)) table = "terms";
    else if (!/^\|[-| ]+\|$/.test(line)) {
      const first = /^\| ([^|]+?) \|/.exec(line)?.[1] ?? "";
      if (table === "rules" && /^[A-Z]{1,3}\d+$/.test(first)) ids.add(first);
      if (table === "terms" && first) terms.push(first);
    }
    const listed = /^- \*\*([A-Z]{1,3}\d+)\*\*/.exec(line)?.[1];
    if (listed) ids.add(listed);
  }
  return (domain = { ids, terms });
}

type Result = { errors: string[]; warnings: string[] };

// A date in YYYY-MM-DD that is on the calendar: Date.parse gives NaN for month 13 and rolls 02-30 over to 03-02.
function onCalendar(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const realDate = (s: unknown): s is string => typeof s === "string" && onCalendar(s);

// "## " headings outside fenced code split the body; each section keeps only its lines outside fences.
function sections(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  let fence = "";
  for (const line of body.split("\n")) {
    const f = /^\s*(```|~~~)/.exec(line)?.[1];
    if (f && (!fence || fence === f)) {
      fence = fence ? "" : f;
      continue;
    }
    if (fence) continue;
    if (line.startsWith("## ")) out.set(line.slice(3).trim(), (current = []));
    else current?.push(line);
  }
  return out;
}

// Table cells split on pipes that aren't escaped; "\|" stays in its cell as "|".
const cellsOf = (row: string) => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, "|").trim());

function checkSkill(dir: string, text: string, today: string, known: Set<string>): Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  if (!m) return { errors: ["SKILL.md must start with YAML front matter between --- lines"], warnings };
  const [, head = "", body = ""] = m;
  let fm: unknown;
  try {
    fm = parse(head);
  } catch (e) {
    return { errors: [`front matter is not YAML: ${(e as Error).message}`], warnings };
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return { errors: ["front matter must be a mapping"], warnings };
  const f = fm as Record<string, unknown>;

  for (const k of Object.keys(f)) if (!FIELDS.has(k)) errors.push(`unexpected field '${k}'`);
  const name = typeof f.name === "string" ? f.name.normalize("NFKC").trim() : "";
  if (!name) errors.push("name must be a non-empty string");
  else {
    if (name.length > 64) errors.push(`name '${name}' is longer than 64 characters`);
    if (name !== name.toLowerCase()) errors.push(`name '${name}' must be lowercase`);
    if (name.startsWith("-") || name.endsWith("-")) errors.push(`name '${name}' starts or ends with a hyphen`);
    if (name.includes("--")) errors.push(`name '${name}' has consecutive hyphens`);
    if (!/^[\p{L}\p{N}-]+$/u.test(name)) errors.push(`name '${name}' may hold only letters, digits and hyphens`);
    if (name !== dir.normalize("NFKC")) errors.push(`name '${name}' must equal its directory '${dir}'`);
  }
  const desc = typeof f.description === "string" ? f.description.trim() : "";
  if (!desc) errors.push("description must be a non-empty string");
  else if ((f.description as string).length > 1024) errors.push("description is longer than 1024 characters");
  if ("compatibility" in f && (typeof f.compatibility !== "string" || f.compatibility.length > 500)) errors.push("compatibility must be a string of at most 500 characters");
  for (const k of ["license", "allowed-tools"]) if (k in f && typeof f[k] !== "string") errors.push(`${k} must be a string`);
  const meta = f.metadata ?? {};
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) errors.push("metadata must be a mapping");
  else for (const [k, v] of Object.entries(meta)) if (typeof v !== "string") errors.push(`metadata '${k}' must be a string, is ${typeof v}`);
  if (body.split("\n").length > 500) errors.push("SKILL.md body is longer than 500 lines");

  const md = (typeof meta === "object" && meta !== null ? meta : {}) as Record<string, unknown>;
  if (dir.startsWith("loop-") && md["morndo-kind"] !== "loop-pattern") return { errors: [...errors, "a loop-* skill must declare morndo-kind: loop-pattern"], warnings };
  if (md["morndo-kind"] !== "loop-pattern") return { errors, warnings };

  // A loop pattern: Morndo's own rules on top of the specification.
  if (desc && (!/\bUse (when|for|before)\b/.test(desc) || !/\bNot\b/.test(desc))) errors.push("description must say when to use the loop and when not");
  const secs = sections(body);
  for (const s of PATTERN_SECTIONS) if (!secs.has(s)) errors.push(`missing section '## ${s}'`);
  const read = md["morndo-sources-read"];
  const recheck = md["morndo-recheck"];
  if (!realDate(read)) errors.push("morndo-sources-read must be a real calendar date, YYYY-MM-DD");
  if (!realDate(recheck)) errors.push("morndo-recheck must be a real calendar date, YYYY-MM-DD");
  const sources = (secs.get("Sources") ?? []).filter(l => l.startsWith("- "));
  if (secs.has("Sources") && sources.length === 0) errors.push("Sources lists nothing");
  const dates: string[] = [];
  for (const line of sources) {
    const d = /\(read (\d{4}-\d{2}-\d{2})\)/.exec(line)?.[1];
    if (!/https:\/\/\S+/.test(line) || d === undefined) errors.push(`source without a URL and a read date: ${line.slice(0, 80)}`);
    else if (!onCalendar(d)) errors.push(`source read date ${d} is not a real calendar date`);
    else dates.push(d);
  }
  if (realDate(read) && realDate(recheck)) {
    const oldest = [...dates].sort()[0];
    if (oldest && oldest !== read) errors.push(`morndo-sources-read is ${read}, the oldest source was read ${oldest}`);
    const gap = (Date.parse(recheck) - Date.parse(read)) / DAY;
    if (gap <= 0 || gap > 90) errors.push(`morndo-recheck must fall 1 to 90 days after ${read}, is ${gap} days`);
    if (today > recheck) warnings.push(`${dir} is stale: its sources were due for a re-read on ${recheck}`);
  }
  const caught = new Set<string>();
  const modes = new Set((secs.get("Failure modes") ?? []).map(l => /^- \*\*([^*]+?):\*\*/.exec(l)?.[1]).filter(x => x !== undefined));
  for (const row of (secs.get("Guards") ?? []).filter(l => l.trimStart().startsWith("|")).slice(2)) {
    const cells = cellsOf(row);
    for (const c of (cells[1] ?? "").split(",").map(x => x.trim()).filter(Boolean)) caught.add(c);
    if (cells.length !== 3 || cells.some(c => !c)) {
      errors.push(`guard row needs a guard, what it catches and the Morndo rule (or 'None yet.'): ${row.slice(0, 80)}`);
      continue;
    }
    const [, catches = "", rule = ""] = cells;
    for (const c of catches.split(",").map(x => x.trim())) if (!modes.has(c)) errors.push(`guard catches '${c}', which is not a failure mode of this skill`);
    // A rule id is cited at the start of the cell or of a clause after "; " ("J2: ...; J3: ..."); ids inside prose aren't.
    const ids = rule.split("; ").map(clause => /^([A-Z]{1,3}\d+)\b/.exec(clause)?.[1]).filter(x => x !== undefined);
    const { ids: known, terms } = domainRules();
    if (/\bADR-\d+/.test(rule)) errors.push("guard cites an ADR; cite the rule as docs/domain.md states it");
    else if (ids.length) for (const id of ids.filter(i => !known.has(i))) errors.push(`guard cites ${id}, which docs/domain.md doesn't define`);
    else if (rule !== "None yet." && !terms.some(t => rule.startsWith(`${t} (docs/domain.md`))) errors.push(`guard names no rule of docs/domain.md, nor 'None yet.': ${rule.slice(0, 60)}`);
  }
  for (const m of modes) if (!caught.has(m)) errors.push(`failure mode '${m}' has no guard`);
  for (const [, ref = ""] of body.matchAll(/`(loop-[a-z-]+)`/g)) if (!known.has(ref)) errors.push(`refers to a skill that doesn't exist: ${ref}`);
  return { errors, warnings };
}

const dirs = readdirSync(SKILLS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
const known = new Set(dirs);
const today = new Date().toISOString().slice(0, 10);
const LOOPS = ["loop-fan-out-merge", "loop-human-gate", "loop-one-shot", "loop-plan-execute-verify", "loop-review-fix", "loop-scheduled"];

describe("the shipped skills", () => {
  it("are the six loop patterns, each a directory with a SKILL.md", () => {
    expect(dirs).toEqual(LOOPS);
  });
  it("every loop-* skill declares morndo-kind: loop-pattern, so the pattern rules can't be skipped by a typo", () => {
    for (const dir of dirs.filter(d => d.startsWith("loop-"))) {
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8").replace(/^\uFEFF/, ""))?.[1] ?? "";
      expect([dir, (parse(head) as { metadata?: Record<string, unknown> }).metadata?.["morndo-kind"]]).toEqual([dir, "loop-pattern"]);
    }
  });
  it.each(dirs)("%s meets the specification and the pattern rules", dir => {
    const r = checkSkill(dir, readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"), today, known);
    expect(r.errors).toEqual([]);
    for (const w of r.warnings) console.warn(`stale (a warning, never a failure): ${w}`);
  });
});

const GOOD = `---
name: loop-sample
description: A sample loop. Use when testing the checks. Not for anything else.
license: AGPL-3.0
metadata:
  morndo-kind: loop-pattern
  morndo-sources-read: "2026-10-12"
  morndo-recheck: "2027-01-10"
---

# Sample

## When to use
Tests.

## When not to use
Anything else.

## Failure modes
- **looping:** it loops.

## Guards

| Guard | Catches | Morndo rule |
|---|---|---|
| A round limit. | looping | None yet. |

## Sources

- Example, A page. https://example.org/page (read 2026-10-12). Supports the sample.
`;
const SAMPLE = new Set(["loop-sample"]);
const errorsOf = (text: string, dir = "loop-sample", day = "2026-10-12") => checkSkill(dir, text, day, SAMPLE).errors;

describe("the design and the skills", () => {
  it("list the same failure modes for each loop pattern (design, section 5.2)", () => {
    const design = readFileSync(join(ROOT, "docs/design/capability-knowledge/README.md"), "utf8");
    for (const dir of LOOPS) {
      const row = design.split("\n").find(l => l.startsWith(`| \`${dir}\``)) ?? "";
      const inDesign = [...(cellsOf(row)[3] ?? "").matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
      const body = readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8");
      const inSkill = (sections(body.replace(/\r\n?/g, "\n")).get("Failure modes") ?? []).map(l => /^- \*\*([^*]+?):\*\*/.exec(l)?.[1]).filter(x => x !== undefined).sort();
      expect([dir, inDesign]).toEqual([dir, inSkill]);
    }
  });
});

describe("negative controls: a broken copy is refused", () => {
  it("the unbroken sample passes, so each refusal below is the break's", () => {
    expect(errorsOf(GOOD)).toEqual([]);
  });
  it("no front matter", () => {
    expect(errorsOf(GOOD.replace(/^---\n/, ""))).toEqual(["SKILL.md must start with YAML front matter between --- lines"]);
  });
  it("an uppercase name", () => {
    expect(errorsOf(GOOD.replace("name: loop-sample", "name: Loop-Sample"), "Loop-Sample")).toEqual(["name 'Loop-Sample' must be lowercase"]);
  });
  it("consecutive hyphens and a leading hyphen", () => {
    expect(errorsOf(GOOD.replace("name: loop-sample", "name: loop--sample"), "loop--sample")).toEqual(["name 'loop--sample' has consecutive hyphens"]);
    expect(errorsOf(GOOD.replace("name: loop-sample", 'name: "-loop"'), "-loop")).toEqual(["name '-loop' starts or ends with a hyphen"]);
  });
  it("a name that differs from its directory", () => {
    expect(errorsOf(GOOD, "loop-other")).toEqual(["name 'loop-sample' must equal its directory 'loop-other'"]);
  });
  it("an empty and a too-long description", () => {
    expect(errorsOf(GOOD.replace(/^description: .*$/m, 'description: ""'))).toEqual(["description must be a non-empty string"]);
    expect(errorsOf(GOOD.replace(/^description: .*$/m, `description: Use when x. Not y. ${"z".repeat(1020)}`))).toEqual(["description is longer than 1024 characters"]);
  });
  it("a field the specification doesn't have", () => {
    expect(errorsOf(GOOD.replace("license: AGPL-3.0", "license: AGPL-3.0\nversion: 1"))).toEqual(["unexpected field 'version'"]);
  });
  it("a metadata value that isn't a string", () => {
    expect(errorsOf(GOOD.replace('morndo-recheck: "2027-01-10"', 'morndo-recheck: "2027-01-10"\n  morndo-rounds: 3'))).toEqual(["metadata 'morndo-rounds' must be a string, is number"]);
  });
  it("a missing section", () => {
    expect(errorsOf(GOOD.replace("## When not to use\nAnything else.\n\n", ""))).toEqual(["missing section '## When not to use'"]);
  });
  it("a source without a read date, and one without a URL", () => {
    expect(errorsOf(GOOD.replace(" (read 2026-10-12).", "."))).toEqual(["source without a URL and a read date: - Example, A page. https://example.org/page. Supports the sample."]);
    expect(errorsOf(GOOD.replace("https://example.org/page ", ""))).toHaveLength(1);
  });
  it("a re-check more than 90 days after the reads", () => {
    expect(errorsOf(GOOD.replace('morndo-recheck: "2027-01-10"', 'morndo-recheck: "2027-02-10"'))).toEqual(["morndo-recheck must fall 1 to 90 days after 2026-10-12, is 121 days"]);
  });
  it("a guard that names no Morndo rule", () => {
    expect(errorsOf(GOOD.replace("| looping | None yet. |", "| looping |  |"))).toHaveLength(1);
  });
  it("a reference to a pattern that doesn't exist", () => {
    expect(errorsOf(GOOD.replace("Anything else.", "Use `loop-missing`."))).toEqual(["refers to a skill that doesn't exist: loop-missing"]);
  });
  it("a date that matches YYYY-MM-DD but isn't on the calendar", () => {
    expect(errorsOf(GOOD.replace('morndo-recheck: "2027-01-10"', 'morndo-recheck: "2027-13-01"'))).toEqual(["morndo-recheck must be a real calendar date, YYYY-MM-DD"]);
    expect(errorsOf(GOOD.replaceAll("2026-10-12", "2026-02-30"))).toContain("morndo-sources-read must be a real calendar date, YYYY-MM-DD");
  });
  it("a loop-* skill whose kind is misspelt or missing", () => {
    expect(errorsOf(GOOD.replace("morndo-kind: loop-pattern", "morndo-kind: loop-patern"))).toEqual(["a loop-* skill must declare morndo-kind: loop-pattern"]);
    expect(errorsOf(GOOD.replace("  morndo-kind: loop-pattern\n", ""))).toEqual(["a loop-* skill must declare morndo-kind: loop-pattern"]);
  });
  it("a guard that catches a failure mode the skill doesn't list", () => {
    expect(errorsOf(GOOD.replace("| looping | None yet. |", "| drift | None yet. |"))).toEqual(["guard catches 'drift', which is not a failure mode of this skill", "failure mode 'looping' has no guard"]);
  });
  it("a guard citing a rule docs/domain.md doesn't define, or an ADR instead of the rule", () => {
    expect(errorsOf(GOOD.replace("None yet.", "V99: made up."))).toEqual(["guard cites V99, which docs/domain.md doesn't define"]);
    expect(errorsOf(GOOD.replace("None yet.", "The other-provider rule (ADR-0013)."))).toEqual(["guard cites an ADR; cite the rule as docs/domain.md states it"]);
  });
  it("a guard that names no rule, in prose that merely starts like a glossary word", () => {
    expect(errorsOf(GOOD.replace("None yet.", "Some prose."))).toEqual(["guard names no rule of docs/domain.md, nor 'None yet.': Some prose."]);
    expect(errorsOf(GOOD.replace("None yet.", "Checked by hand."))).toEqual(["guard names no rule of docs/domain.md, nor 'None yet.': Checked by hand."]);
  });
  it("a source tag is not a rule id, and ids in the middle of prose are not citations", () => {
    expect(errorsOf(GOOD.replace("None yet.", "S10: a source tag."))).toEqual(["guard cites S10, which docs/domain.md doesn't define"]);
    expect(errorsOf(GOOD.replace("None yet.", "CN11: no new lease once spend reaches the budget, measured at P95 on an H100."))).toEqual([]);
  });
  it("a failure mode that no guard catches", () => {
    expect(errorsOf(GOOD.replace("- **looping:** it loops.", "- **looping:** it loops.\n- **drift:** it drifts."))).toEqual(["failure mode 'drift' has no guard"]);
  });
  it("a guard citing a real rule id or a docs/domain.md glossary entry passes", () => {
    expect(errorsOf(GOOD.replace("None yet.", "V3: a claimed revision that changes anything a Check depends on (for example, weakens the test) is refuted."))).toEqual([]);
    expect(errorsOf(GOOD.replace("None yet.", "Other-provider rule (docs/domain.md, Engines): the reviewer's model comes from another family."))).toEqual([]);
  });
  it("CRLF line ends and a byte-order mark parse like LF", () => {
    expect(errorsOf(`\uFEFF${GOOD.replace(/\n/g, "\r\n")}`)).toEqual([]);
  });
  it("a heading inside a fenced code block is not a section", () => {
    const fenced = GOOD.replace("## When not to use\nAnything else.\n\n", "").replace("Tests.", "Tests.\n\n```md\n## When not to use\n```");
    expect(errorsOf(fenced)).toEqual(["missing section '## When not to use'"]);
  });
  it("an escaped pipe inside a guard cell is part of the cell", () => {
    expect(errorsOf(GOOD.replace("| A round limit. |", "| A round limit \\| a cap. |"))).toEqual([]);
  });
  it("past its re-check date a skill warns and still passes", () => {
    const r = checkSkill("loop-sample", GOOD, "2027-01-11", SAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["loop-sample is stale: its sources were due for a re-read on 2027-01-10"]);
  });
});
