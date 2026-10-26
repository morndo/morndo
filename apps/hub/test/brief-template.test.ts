// The template adapter (ADR-0023 §5.2): the guide's example becomes a brief lint accepts, an unknown heading is refused,
// and a column that isn't an option is named. One change each, so a parser that drops text still fails.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lintBrief } from "@morndo/domain";
import { BRIEF_TEMPLATE, parseBriefMarkdown } from "../src/adapters/brief-template.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const doc = readFileSync(new URL("../../../docs/agents/decision-requests.md", import.meta.url), "utf8");
const fence = (heading: string) => {
  const at = doc.indexOf(`## ${heading}`);
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  if (at < 0 || open < 0 || close < 0) throw new Error(`no ${heading} fence`);
  return doc.slice(open + "```markdown\n".length, close + 1);
};
const example = () => fence("An example");

describe("the brief template", () => {
  it("is the guide's blank, and the blank is not a brief", () => {
    expect(BRIEF_TEMPLATE).toBe(fence("The template"));
    const parsed = parseBriefMarkdown(BRIEF_TEMPLATE);
    const lint = lintBrief(parsed.draft, NOW);
    expect(lint.brief).toBeNull();
    expect(lint.problems.some(p => p.level === "error")).toBe(true);
  });

  it("reads the guide's example with no errors and no warnings", () => {
    const parsed = parseBriefMarkdown(example());
    expect(parsed.problems).toEqual([]);
    const lint = lintBrief(parsed.draft, NOW);
    expect(lint.problems).toEqual([]);
    expect(lint.brief).toMatchObject({ topic: "Support inbox triage", recommend: "b", minutes: 4 });
  });

  it("an unknown heading is refused, and a missing column is table_columns", () => {
    const renamed = parseBriefMarkdown(example().replace("## Why now", "## Why soon"));
    const lint = lintBrief(renamed.draft, NOW);
    expect(lint.problems.map(p => `${p.code} ${p.where}`)).toContain("unknown_section Why soon");
    const dropped = example().replace(" | C · Buy a hosted add-on", "");
    const parsed = parseBriefMarkdown(dropped);
    expect(parsed.problems.map(p => p.code)).toContain("table_columns");
  });
});
