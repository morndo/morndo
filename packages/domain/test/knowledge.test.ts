// The SOP check (ADR-0026, K10 and K14): the shipped daily-blog-post template passes, and a copy broken in one place is
// refused by exactly the rule that names the break. The fixtures are the template itself, changed in one place each.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSop, SOP_RULES, type SopContext } from "../src/knowledge.ts";

const ROOT = join(import.meta.dirname, "../../..");
const TEMPLATE = parse(readFileSync(join(ROOT, "knowledge/skills/recurring-job/assets/daily-blog-post.yaml"), "utf8")) as Sop;

type Step = Record<string, unknown> & { id: string };
type Sop = Record<string, unknown> & { steps: Step[]; gates: Record<string, unknown>[] };

const CTX: SopContext = {
  skills: ["loop-fan-out-merge", "loop-human-gate", "loop-one-shot", "loop-plan-execute-verify", "loop-review-fix", "loop-scheduled", "recurring-job"],
  notes: new Map([["search-guidance", "2027-01-10"], ["search-grounding-terms", "2027-01-10"], ["writing-boards", "2027-01-10"]]),
  roles: ["plan", "implement-backend", "implement-ui", "implement-infra", "validate", "review", "research", "read-long", "images", "video"],
  today: "2026-10-12",
};

const copy = (): Sop => structuredClone(TEMPLATE);
const step = (sop: Sop, id: string): Step => {
  const s = sop.steps.find(x => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};
const rulesOf = (sop: unknown, ctx: SopContext = CTX) => checkSop(sop, ctx).refusals.map(r => r.rule);
const broken = (change: (sop: Sop) => void) => {
  const sop = copy();
  change(sop);
  return rulesOf(sop);
};

describe("the daily-blog-post template", () => {
  it("passes, with no warning", () => {
    expect(checkSop(copy(), CTX)).toEqual({ refusals: [], warnings: [] });
  });
});

describe("the brief's three: each break refused by its rule", () => {
  it("without the approval gate before publishing", () => {
    expect(broken(s => { s.gates = []; })).toEqual(["gate-before-outward"]);
  });
  it("without max_rounds on the fact-check loop", () => {
    expect(broken(s => { delete step(s, "fact-check").max_rounds; })).toEqual(["round-limit"]);
  });
  it("with a model id where the model class belongs", () => {
    expect(broken(s => { step(s, "draft").model = "acme-large-2"; })).toEqual(["no-model-id"]);
    expect(broken(s => { step(s, "draft").model = { class: "flagship", id: "acme-large-2" }; })).toEqual(["no-model-id"]);
  });
});

describe("every other rule, one break each", () => {
  it("an engine step without a why", () => {
    expect(broken(s => { delete step(s, "outline").why; })).toEqual(["engine-why"]);
    expect(broken(s => { step(s, "outline").why = []; })).toEqual(["engine-why"]);
  });
  it("a step without a check, or without an output", () => {
    expect(broken(s => { delete step(s, "edit").check; })).toEqual(["step-check"]);
    expect(broken(s => { step(s, "edit").output = ""; })).toEqual(["step-check"]);
  });
  it("a gate whose silence goes ahead", () => {
    expect(broken(s => { (s.gates[0] as Record<string, unknown>).on_silence = { after: "48h", then: "approve" }; })).toEqual(["silence-never-approves"]);
    expect(broken(s => { delete (s.gates[0] as Record<string, unknown>).on_silence; })).toEqual(["silence-never-approves"]);
  });
  it("an outward step that doesn't say so", () => {
    expect(broken(s => { delete step(s, "publish").effect; })).toEqual(["outward-declared"]);
    expect(broken(s => { step(s, "publish").tool = "git-push"; delete step(s, "publish").effect; })).toEqual(["outward-declared"]);
  });
  it("an outward engine step without a gate", () => {
    expect(broken(s => { step(s, "search-pass").effect = "outward"; })).toEqual(["gate-before-outward"]);
  });
  it("a gate that names no step, or no principal, or offers no approve", () => {
    expect(broken(s => { (s.gates[0] as Record<string, unknown>).before = "nowhere"; })).toEqual(["gate-shape", "gate-before-outward"]);
    expect(broken(s => { (s.gates[0] as Record<string, unknown>).who = "reviewer"; })).toEqual(["gate-shape"]);
    expect(broken(s => { (s.gates[0] as Record<string, unknown>).options = ["change", "drop"]; })).toEqual(["gate-shape"]);
  });
  it("a gate's change loop without a limit", () => {
    expect(broken(s => { delete (s.gates[0] as Record<string, unknown>).max_changes; })).toEqual(["round-limit"]);
  });
  it("a loop back to a later step, or past five rounds", () => {
    expect(broken(s => { step(s, "fact-check").on_fail = "publish"; })).toEqual(["round-limit"]);
    expect(broken(s => { step(s, "fact-check").max_rounds = 9; })).toEqual(["round-limit"]);
  });
  it("no stop rule", () => {
    expect(broken(s => { s.stop = []; })).toEqual(["stop-required"]);
    expect(broken(s => { s.stop = [{ when: "a budget is spent" }]; })).toEqual(["stop-required"]);
  });
  it("a budget that lets spending go on", () => {
    expect(broken(s => { (s.budget as Record<string, unknown>).on_exceed = "continue"; })).toEqual(["budget-stop"]);
    expect(broken(s => { delete (s.budget as Record<string, unknown>).per_run; })).toEqual(["budget-stop"]);
  });
  it("a role the engine layer doesn't have", () => {
    expect(broken(s => { step(s, "draft").role = "writer"; })).toEqual(["role-known"]);
  });
  it("a class that isn't one, and a family rule pointing at a later step", () => {
    expect(broken(s => { step(s, "draft").model = { class: "huge", family: "any" }; })).toEqual(["model-class"]);
    expect(broken(s => { step(s, "edit").model = { class: "fast", family: { "other-than": ["fact-check"] } }; })).toEqual(["model-class"]);
  });
  it("a why that cites nothing known", () => {
    expect(broken(s => { step(s, "draft").why = ["notes/missing"]; })).toEqual(["why-resolves"]);
    expect(broken(s => { step(s, "draft").why = ["a hunch"]; })).toEqual(["why-resolves"]);
  });
  it("a why may cite a skill, a note, a preference, the model snapshot, or say there is no evidence", () => {
    expect(broken(s => { step(s, "draft").why = ["loop-review-fix", "notes/writing-boards", "pref:write-long", "models.dev@2026-10-12", "no evidence: default"]; })).toEqual([]);
  });
  it("a pattern that isn't a shipped skill", () => {
    expect(broken(s => { s.patterns = ["loop-scheduled", "loop-forever"]; })).toEqual(["pattern-known"]);
    expect(broken(s => { step(s, "edit").pattern = "loop-forever"; })).toEqual(["pattern-known"]);
  });
  it("a trigger that is neither, or both, a schedule and an event", () => {
    expect(broken(s => { s.trigger = {}; })).toEqual(["trigger"]);
    expect(broken(s => { s.trigger = { schedule: { cron: "0 7 * * *", timezone: "UTC" }, event: "board" }; })).toEqual(["trigger"]);
  });
  it("no done checks, a report without citations, a metric without its source", () => {
    expect(broken(s => { s.done = []; })).toEqual(["done-required"]);
    expect(broken(s => { s.report = { to: "manager", holds: ["URL or reason"] }; })).toEqual(["report-citations"]);
    expect(broken(s => { s.metrics = [{ name: "cost per post", every: "week" }]; })).toEqual(["metrics-required"]);
  });
  it("two steps with one id, or a step that is both an engine and a tool", () => {
    expect(broken(s => { step(s, "outline").id = "research"; })).toEqual(["step-kind"]);
    expect(broken(s => { step(s, "publish").role = "plan"; })).toEqual(["step-kind"]);
  });
  it("a field the SOP doesn't have, or no mapping at all", () => {
    expect(broken(s => { s.owner = "someone"; })).toEqual(["shape"]);
    expect(rulesOf("daily-blog-post")).toEqual(["shape"]);
    expect(rulesOf({})).toContain("shape");
  });
});

describe("findings", () => {
  it("name the step they are about", () => {
    const sop = copy();
    delete step(sop, "edit").check;
    expect(checkSop(sop, CTX).refusals).toEqual([{ rule: "step-check", at: "steps.edit", message: expect.stringContaining("check") }]);
  });
  it("each citation of a note past its re-check date warns, and refuses nothing", () => {
    const v = checkSop(copy(), { ...CTX, today: "2027-01-11" });
    expect(v.refusals).toEqual([]);
    expect(v.warnings.map(w => [w.rule, w.at])).toEqual([
      ["stale-citation", "steps.research"], ["stale-citation", "steps.draft"], ["stale-citation", "steps.search-pass"],
      ["stale-citation", "steps.search-pass"], ["stale-citation", "steps.fact-check"],
    ]);
  });
  it("every rule has a test above that breaks it", () => {
    const src = readFileSync(import.meta.filename, "utf8");
    expect(SOP_RULES.filter(r => !src.includes(`"${r}"]`) && !src.includes(`"${r}",`))).toEqual([]);
  });
});
