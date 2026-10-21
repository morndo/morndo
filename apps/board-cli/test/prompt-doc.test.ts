// docs/agents/board.md carries the two prompt blocks the CLI prints (ADR-0015, decision 4): they must be the same
// text, so what a person pastes from the docs is what `morndo-board prompt` gives.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGER_PROMPT, WORKER_PROMPT } from "../src/prompt.ts";

const DOC = join(import.meta.dirname, "../../../docs/agents/board.md");
const block = (doc: string, role: string) => {
  const m = new RegExp(`<!-- prompt:${role} -->\\n([\\s\\S]*?)<!-- /prompt:${role} -->`).exec(doc);
  if (!m) throw new Error(`no ${role} block in docs/agents/board.md`);
  return m[1] ?? "";
};

describe("the prompt blocks in docs/agents/board.md", () => {
  const doc = readFileSync(DOC, "utf8");
  it("the manager's block is the CLI's", () => { expect(block(doc, "manager")).toBe(MANAGER_PROMPT); });
  it("the worker's block is the CLI's", () => { expect(block(doc, "worker")).toBe(WORKER_PROMPT); });
  it("the worker's block says a checkpoint is a NEEDS DECISION line, never DONE", () => {
    expect(WORKER_PROMPT).toContain("`STATUS: NEEDS DECISION checkpoint: <what>`");
    expect(WORKER_PROMPT).toMatch(/checkpoint[^.]*not DONE/);
    expect(WORKER_PROMPT).toMatch(/checkpoint[^.]*blocked/);
  });
  it("each block names the commands it relies on, which the CLI has", () => {
    for (const cmd of ["list", "new", "assign", "start", "block", "resume", "review", "done", "move", "comment", "todo"]) {
      expect(`${MANAGER_PROMPT}\n${WORKER_PROMPT}`).toContain(`morndo-board ${cmd}`);
    }
  });
});
