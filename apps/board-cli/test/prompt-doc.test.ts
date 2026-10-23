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
    expect(WORKER_PROMPT).toContain("`STATUS: NEEDS DECISION T-12 checkpoint: <what>`");
    expect(WORKER_PROMPT).toMatch(/checkpoint[^.]*not DONE/);
    expect(WORKER_PROMPT).toMatch(/checkpoint[^.]*blocked/);
  });
  it("the worker's block has every status line name its task key, and the board's moves follow it (B12)", () => {
    for (const line of ["`STATUS: DONE T-12`", "`STATUS: BLOCKED T-12 ", "`STATUS: NEEDS DECISION T-12 ", "`STATUS: WAITING T-12 "]) expect(WORKER_PROMPT).toContain(line);
    expect(WORKER_PROMPT).toMatch(/moves only the task you name/);
  });
  it("each block names the commands it relies on, which the CLI has", () => {
    for (const cmd of ["list", "new", "assign", "start", "block", "resume", "review", "done", "move", "comment", "todo"]) {
      expect(`${MANAGER_PROMPT}\n${WORKER_PROMPT}`).toContain(`morndo-board ${cmd}`);
    }
  });
  it("the worker's block tells a lane to file its brief with whole references", () => {
    expect(WORKER_PROMPT).toContain("morndo-board brief T-12");
    expect(WORKER_PROMPT).toContain("--no-code");
    expect(WORKER_PROMPT).toContain("--test");
  });
  it("the manager's block names proof_not_green and --proof-override", () => {
    expect(MANAGER_PROMPT).toContain("proof_not_green");
    expect(MANAGER_PROMPT).toContain("--proof-override");
  });
});
