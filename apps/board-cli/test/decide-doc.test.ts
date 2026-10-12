// docs/agents/decision-requests.md carries the blank, the example and the prompt blocks the CLI prints (ADR-0023).
// What a person copies from the guide is what `morndo-decide` checks and what `prompt` prints.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintBrief } from "@morndo/domain";
import { BRIEF_TEMPLATE, parseBriefMarkdown } from "../../hub/src/adapters/brief-template.ts";
import { run } from "../src/decide.ts";
import { DECIDE_MANAGER_PROMPT, DECIDE_WORKER_PROMPT } from "../src/prompt.ts";

const DOC = join(import.meta.dirname, "../../../docs/agents/decision-requests.md");
const NOW = Date.parse("2026-10-01T00:00:00Z");
const block = (doc: string, role: string) => {
  const m = new RegExp(`<!-- prompt:${role} -->\\n([\\s\\S]*?)<!-- /prompt:${role} -->`).exec(doc);
  if (!m) throw new Error(`no ${role} block in docs/agents/decision-requests.md`);
  return m[1] ?? "";
};
const fence = (doc: string, heading: string) => {
  const at = doc.indexOf(`## ${heading}`);
  const open = doc.indexOf("```markdown\n", at);
  const close = doc.indexOf("\n```", open + 12);
  if (at < 0 || open < 0 || close < 0) throw new Error(`no ${heading} fence`);
  return doc.slice(open + "```markdown\n".length, close + 1);
};

describe("the decision-request guide matches the command", () => {
  const doc = readFileSync(DOC, "utf8");
  it("the blank is the CLI's template", async () => {
    expect(fence(doc, "The template")).toBe(BRIEF_TEMPLATE);
    const out: string[] = [];
    expect(await run(["template"], {}, { fetch, lane: async () => null, read: async () => "", out: l => out.push(l), err: () => {} })).toBe(0);
    expect(`${out.join("\n")}\n`).toBe(BRIEF_TEMPLATE);
  });
  it("the example lints with no errors and no warnings at 2026-10-01", () => {
    const parsed = parseBriefMarkdown(fence(doc, "An example"));
    expect(parsed.problems).toEqual([]);
    expect(lintBrief(parsed.draft, NOW).problems).toEqual([]);
  });
  it("the manager's block is the CLI's", () => { expect(block(doc, "manager")).toBe(DECIDE_MANAGER_PROMPT); });
  it("the worker's block is the CLI's", () => { expect(block(doc, "worker")).toBe(DECIDE_WORKER_PROMPT); });
});
