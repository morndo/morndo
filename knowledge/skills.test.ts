// Every shipped skill against the Agent Skills specification (https://agentskills.io/specification, read 2026-10-12) and
// its reference validator (skills-ref, src/skills_ref/validator.py at 547831f3a2, read the same day): the fields a
// SKILL.md may have, the name and length rules, metadata as a map of strings. Then Morndo's own rules for a loop pattern
// (ADR-0026): the sections each must have, dated sources (K1), a re-check at most 90 days after the reads (K2), and a
// stale skill that warns and still passes (K6). The negative controls are the same checks on broken copies.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SKILLS = "knowledge/skills";
const FIELDS = new Set(["name", "description", "license", "allowed-tools", "metadata", "compatibility"]);
const PATTERN_SECTIONS = ["When to use", "When not to use", "Failure modes", "Guards", "Sources"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

type Result = { errors: string[]; warnings: string[] };

function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
  return out;
}

function checkSkill(dir: string, text: string, today: string, known: Set<string>): Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
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
  if (md["morndo-kind"] !== "loop-pattern") return { errors, warnings };

  // A loop pattern: Morndo's own rules on top of the specification.
  if (desc && (!/\bUse (when|for|before)\b/.test(desc) || !/\bNot\b/.test(desc))) errors.push("description must say when to use the loop and when not");
  const secs = sections(body);
  for (const s of PATTERN_SECTIONS) if (!secs.has(s)) errors.push(`missing section '## ${s}'`);
  const read = md["morndo-sources-read"];
  const recheck = md["morndo-recheck"];
  if (typeof read !== "string" || !DATE.test(read)) errors.push("morndo-sources-read must be a date, YYYY-MM-DD");
  if (typeof recheck !== "string" || !DATE.test(recheck)) errors.push("morndo-recheck must be a date, YYYY-MM-DD");
  const sources = (secs.get("Sources") ?? "").split("\n").filter(l => l.startsWith("- "));
  if (secs.has("Sources") && sources.length === 0) errors.push("Sources lists nothing");
  const dates: string[] = [];
  for (const line of sources) {
    const d = /\(read (\d{4}-\d{2}-\d{2})\)/.exec(line);
    if (!/https:\/\/\S+/.test(line) || !d) errors.push(`source without a URL and a read date: ${line.slice(0, 80)}`);
    else dates.push(d[1] ?? "");
  }
  if (typeof read === "string" && DATE.test(read) && typeof recheck === "string" && DATE.test(recheck)) {
    const oldest = [...dates].sort()[0];
    if (oldest && oldest !== read) errors.push(`morndo-sources-read is ${read}, the oldest source was read ${oldest}`);
    const gap = (Date.parse(recheck) - Date.parse(read)) / DAY;
    if (gap <= 0 || gap > 90) errors.push(`morndo-recheck must fall 1 to 90 days after ${read}, is ${gap} days`);
    if (today > recheck) warnings.push(`${dir} is stale: its sources were due for a re-read on ${recheck}`);
  }
  for (const row of (secs.get("Guards") ?? "").split("\n").filter(l => l.startsWith("|")).slice(2)) {
    const cells = row.split("|").slice(1, -1).map(c => c.trim());
    if (cells.length !== 3 || cells.some(c => !c)) errors.push(`guard row needs a guard, what it catches and the Morndo rule (or 'None yet.'): ${row.slice(0, 80)}`);
  }
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
  it("past its re-check date a skill warns and still passes", () => {
    const r = checkSkill("loop-sample", GOOD, "2027-01-11", SAMPLE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["loop-sample is stale: its sources were due for a re-read on 2027-01-10"]);
  });
});
