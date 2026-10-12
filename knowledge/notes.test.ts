// The hand-written notes (ADR-0026): each source is a link, the date read, its basis and a sentence in our own words
// (K1), with no stored quotes; a leaderboard line names its snapshot date and method (K3); a re-check at most 90 days
// after the reads (K2); a stale note warns and still passes (K6). The negative controls are the same checks on broken
// copies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const NOTES = "knowledge/notes";
const BASES = ["vendor-doc", "vendor-claim", "measured", "study"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

function onCalendar(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function checkNote(id: string, text: string, today: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  if (!m) return { errors: ["a note starts with YAML front matter between --- lines"], warnings };
  const [, head = "", body = ""] = m;
  const f = parse(head) as Record<string, unknown> | null;
  if (f?.note !== id) errors.push(`note must equal its file name '${id}'`);
  const read = f?.read;
  const recheck = f?.recheck;
  if (typeof read !== "string" || !onCalendar(read)) errors.push("read must be a real calendar date, YYYY-MM-DD");
  if (typeof recheck !== "string" || !onCalendar(recheck)) errors.push("recheck must be a real calendar date, YYYY-MM-DD");
  if (/["“”]/.test(body)) errors.push("a note stores no quotes: say it in our own words and link the page");
  const sources = (body.split(/^## Sources\s*$/m)[1] ?? "").split("\n").filter(l => l.startsWith("- "));
  if (sources.length === 0) errors.push("a note lists its sources under '## Sources'");
  const dates: string[] = [];
  for (const line of sources) {
    const d = /\(read (\d{4}-\d{2}-\d{2})\)/.exec(line)?.[1];
    const basis = /\bbasis: ([a-z-]+)/.exec(line)?.[1];
    if (!/https:\/\/\S+/.test(line) || d === undefined || !onCalendar(d)) errors.push(`source without a URL and a real read date: ${line.slice(0, 70)}`);
    else dates.push(d);
    if (basis === undefined || !BASES.includes(basis)) errors.push(`source without a basis (${BASES.join(", ")}): ${line.slice(0, 70)}`);
    if (basis === "measured" && !(/\bsnapshot\b/.test(line) && /\bmethod\b/.test(line))) errors.push(`a measured source names its snapshot and method: ${line.slice(0, 70)}`);
  }
  if (typeof read === "string" && onCalendar(read) && typeof recheck === "string" && onCalendar(recheck)) {
    const oldest = [...dates].sort()[0];
    if (oldest && oldest !== read) errors.push(`read is ${read}, the oldest source was read ${oldest}`);
    const gap = (Date.parse(recheck) - Date.parse(read)) / DAY;
    if (gap <= 0 || gap > 90) errors.push(`recheck must fall 1 to 90 days after ${read}, is ${gap} days`);
    if (today > recheck) warnings.push(`${id} is stale: its sources were due for a re-read on ${recheck}`);
  }
  return { errors, warnings };
}

const files = existsSync(NOTES) ? readdirSync(NOTES).filter(f => f.endsWith(".md")).sort() : [];
const today = new Date().toISOString().slice(0, 10);

describe("the shipped notes", () => {
  it("are the three the blog template cites", () => {
    expect(files).toEqual(["search-grounding-terms.md", "search-guidance.md", "writing-boards.md"]);
  });
  it.each(files)("%s holds links, read dates, bases and our own words", file => {
    const r = checkNote(file.replace(/\.md$/, ""), readFileSync(join(NOTES, file), "utf8"), today);
    expect(r.errors).toEqual([]);
    for (const w of r.warnings) console.warn(`stale (a warning, never a failure): ${w}`);
  });
});

const GOOD = `---
note: sample
read: "2026-10-12"
recheck: "2027-01-10"
---
# Sample

## Sources

- Example, A guide. https://example.org/guide (read 2026-10-12). basis: vendor-doc. Says what the product does.
- Example, A board. https://example.org/board (read 2026-10-12). basis: measured. First on its tasks, snapshot 2026-10-08, method: human votes.
`;
const errorsOf = (text: string, day = "2026-10-12") => checkNote("sample", text, day).errors;

describe("negative controls: a broken note is refused", () => {
  it("the unbroken sample passes", () => {
    expect(errorsOf(GOOD)).toEqual([]);
  });
  it("a stored quote", () => {
    expect(errorsOf(GOOD.replace("Says what the product does.", "Says \"it does everything\"."))).toEqual(["a note stores no quotes: say it in our own words and link the page"]);
  });
  it("a source without a basis, or with a basis that isn't one", () => {
    expect(errorsOf(GOOD.replace(" basis: vendor-doc.", ""))).toHaveLength(1);
    expect(errorsOf(GOOD.replace("basis: vendor-doc", "basis: blog"))).toHaveLength(1);
  });
  it("a leaderboard line without its snapshot or method", () => {
    expect(errorsOf(GOOD.replace(", snapshot 2026-10-08, method: human votes", ""))).toHaveLength(1);
  });
  it("an impossible date and a re-check too far out", () => {
    expect(errorsOf(GOOD.replace('recheck: "2027-01-10"', 'recheck: "2027-02-30"'))).toEqual(["recheck must be a real calendar date, YYYY-MM-DD"]);
    expect(errorsOf(GOOD.replace('recheck: "2027-01-10"', 'recheck: "2027-02-10"'))).toEqual(["recheck must fall 1 to 90 days after 2026-10-12, is 121 days"]);
  });
  it("a note whose id differs from its file", () => {
    expect(errorsOf(GOOD.replace("note: sample", "note: other"))).toEqual(["note must equal its file name 'sample'"]);
  });
  it("past its re-check date a note warns and still passes", () => {
    const r = checkNote("sample", GOOD, "2027-01-11");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(["sample is stale: its sources were due for a re-read on 2027-01-10"]);
  });
});
