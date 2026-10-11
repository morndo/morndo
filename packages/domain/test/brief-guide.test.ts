// The guide's made-up example (docs/agents/decision-requests.md) must pass the lint: this reads the example out of the
// page itself and lints it, so the page can never drift from what the hub accepts. The markdown-to-brief reading here
// is the page's own fixed template (front matter, the fixed headings, labelled lines, one GFM table), read strictly for
// this test; the hub's template adapter (ADR-0023 §5.2) arrives with PR 2 and gets its own tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintBrief } from "../src/index.ts";

const NOW = Date.UTC(2026, 9, 1, 8, 0);                       // 2026-10-01: the example is dated, so `now` is fixed

// The guide's example: the last ```markdown block on the page (the template comes first and holds placeholders).
function guideExample(): string {
  const page = readFileSync(join(import.meta.dirname, "../../../docs/agents/decision-requests.md"), "utf8");
  const blocks = [...page.matchAll(/```markdown\n([\s\S]*?)```/g)].map(m => m[1] ?? "");
  const example = blocks.at(-1) ?? "";
  if (!example.includes("## Decision")) throw new Error("the guide's example block was not found");
  return example;
}

// A labelled line ("Alternative: …", "Risk: …") with its wrapped continuations joined, out of a section's lines.
function labelled(lines: readonly string[], label: string): string | null {
  const at = lines.findIndex(l => l.startsWith(`${label}:`));
  if (at < 0) return null;
  const value = [lines[at]!.slice(label.length + 1).trim()];
  for (const next of lines.slice(at + 1)) {
    if (next === "" || /^[A-Z][\w ]*:$/.test(next) || next.startsWith("- ") || next.startsWith("|")) break;
    value.push(next.trim());
  }
  return value.filter(Boolean).join(" ");
}

// The section under one heading, its lines as they are written.
function section(markdown: string, heading: string): string[] {
  const at = markdown.indexOf(`## ${heading}`);
  if (at < 0) return [];
  const rest = markdown.slice(at).split("\n").slice(1);
  const end = rest.findIndex(l => l.startsWith("## ") || l.startsWith("# "));
  return (end < 0 ? rest : rest.slice(0, end)).map(l => l.trimEnd()).filter(l => l.trim() !== "");
}

// A paragraph: the section's lines before the first labelled line or list, its wraps joined into one line.
function paragraph(lines: readonly string[]): string {
  const body: string[] = [];
  for (const l of lines) {
    if (body.length && (l.startsWith("- ") || /^[A-Z][\w ]*:$/.test(l))) break;
    if (/^[A-Z][\w ]*:$/.test(l) && body.length === 0) break;
    body.push(l.trim());
  }
  return body.join(" ");
}

function list(lines: readonly string[], from: string): string[] {
  const at = lines.findIndex(l => l.startsWith(from));
  return at < 0 ? [] : lines.slice(at + 1).filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
}

// The template's own table: one GFM table, its header row skipped, each body row a factor and its cells.
function table(lines: readonly string[]): { factor: string; cells: string[] }[] {
  return lines.filter(l => l.startsWith("|") && !/^\|\s*---/.test(l)).slice(1).map(row =>
    ({ factor: row.split("|")[1]?.trim() ?? "", cells: row.split("|").slice(2, -1).map(c => c.trim()) }));
}

// The guide's example as the draft an agent sends: the same shape the hub's adapter will produce.
function guideDraft(): Record<string, unknown> {
  const markdown = guideExample();
  const front = Object.fromEntries(markdown.split("\n").slice(1, markdown.indexOf("---", 1))
    .map(l => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map(m => [(m as RegExpExecArray)[1], (m as RegExpExecArray)[2]]));
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(front.due));            // a date alone: the end of that day, UTC
  if (!day) throw new Error("the guide's example has no date-only due");
  const decision = list(section(markdown, "Decision"), "- [");
  return {
    topic: front.topic, due: Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59, 999),
    minutes: Number(front.minutes), headline: /^# (.+)$/m.exec(markdown)?.[1] ?? "", recommend: front.recommend,
    ask: {
      text: paragraph(section(markdown, "The ask")),
      alternative: labelled(section(markdown, "The ask"), "Alternative") ?? "",
      uncertainty: labelled(section(markdown, "The ask"), "Main uncertainty") ?? "",
    },
    whyNow: section(markdown, "Why now").join("\n"),
    options: decision.map(l => ({ key: /^\[([\w-]+)\]/.exec(l)?.[1] ?? "", label: /^\[[\w-]+\]\s+(.*)$/.exec(l)?.[1]?.trim() ?? "" })),
    comparison: {
      rows: table(section(markdown, "Options compared")),
      note: labelled(section(markdown, "Options compared"), "Note") ?? "",
    },
    why: {
      text: paragraph(section(markdown, "Why the recommendation")),
      assumptions: list(section(markdown, "Why the recommendation"), "Assumptions:"),
      downside: labelled(section(markdown, "Why the recommendation"), "Downside case") ?? "",
    },
    changeIf: paragraph(section(markdown, "What would change the recommendation")),
    risk: {
      risk: labelled(section(markdown, "Main risk and control"), "Risk") ?? "",
      control: labelled(section(markdown, "Main risk and control"), "Control") ?? "",
    },
    authorizes: {
      limits: list(section(markdown, "What approval authorizes"), "Limits:"),
      freshApproval: labelled(section(markdown, "What approval authorizes"), "Needs fresh approval") ?? "",
      reviewPoint: labelled(section(markdown, "What approval authorizes"), "Review point") ?? "",
    },
    ifNoAnswer: paragraph(section(markdown, "If no decision by the due date")) || null,
    evidence: list(section(markdown, "Evidence"), "- [").map(l => ({
      label: /^\[([^\]]+)\]/.exec(l)?.[1] ?? "", url: /\]\((https:\/\/[^\s)]+)\)$/.exec(l)?.[1] ?? "",
    })),
    blocking: front.blocking === "true", project: front.project ?? null, task: front.task ?? null, ref: front.ref ?? null,
  };
}

describe("the guide's example (docs/agents/decision-requests.md)", () => {
  it("lints with no errors and no warnings", () => {
    const r = lintBrief(guideDraft(), NOW);
    expect(r.problems).toEqual([]);
    expect(r.brief).not.toBe(null);
  });
  it("negative control: a section dropped from what the page says is refused", () => {
    const draft = guideDraft();
    delete draft.whyNow;
    expect(lintBrief(draft, NOW).problems.map(p => p.code)).toEqual(["missing_section"]);
  });
});
