// The SOP check (ADR-0026, K10 and K14): the shipped daily-blog-post template passes, so does an instance made from it,
// and a copy broken in one place is refused by exactly the rule that names the break. The fixtures are the template and
// that instance, each changed in one place.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkSop, SOP_REQUIRED, SOP_RULES, type SopContext } from "../src/knowledge.ts";

const ROOT = join(import.meta.dirname, "../../..");
const TEMPLATE = parse(readFileSync(join(ROOT, "knowledge/skills/recurring-job/assets/daily-blog-post.yaml"), "utf8")) as Sop;

type Step = Record<string, unknown> & { id: string };
type Sop = Record<string, unknown> & { steps: Step[]; gates: Record<string, unknown>[] };

const CTX: SopContext = {
  skills: ["loop-fan-out-merge", "loop-human-gate", "loop-one-shot", "loop-plan-execute-verify", "loop-review-fix", "loop-scheduled", "recurring-job"],
  notes: new Map([["search-guidance", "2027-01-10"], ["search-grounding-terms", "2027-01-10"], ["writing-boards", "2027-01-10"]]),
  roles: ["plan", "implement-backend", "implement-ui", "implement-infra", "validate", "review", "research", "read-long", "images", "video"],
  today: "2026-10-12",
  isTimeZone: tz => ["UTC", "Europe/Berlin"].includes(tz),
};

const copy = (): Sop => structuredClone(TEMPLATE);
// The template filled in as a user would: no blank left, a real schedule, a budget in a currency.
const instance = (): Sop => {
  const sop = copy();
  sop.kind = "instance";
  sop.trigger = { schedule: { cron: "0 7 * * 1-5", timezone: "Europe/Berlin" } };
  sop.inputs = { topic: { from: "board column ideas", one_per_run: true }, site: { search_console_property: "sc-domain:example.org", cms: "example-cms" }, style: "style.md" };
  sop.budget = { per_run: "5 USD", per_month: "100 USD", on_exceed: "stop" };
  return sop;
};
const step = (sop: Sop, id: string): Step => {
  const s = sop.steps.find(x => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};
const rulesOf = (sop: unknown, ctx: SopContext = CTX) => checkSop(sop, ctx).refusals.map(r => r.rule);
const broken = (change: (sop: Sop) => void, from: () => Sop = copy) => {
  const sop = from();
  change(sop);
  return rulesOf(sop);
};
const brokenInstance = (change: (sop: Sop) => void) => broken(change, instance);
const addStep = (sop: Sop, s: Record<string, unknown> & { id: string }) => {
  sop.steps.splice(sop.steps.findIndex(x => x.id === "publish"), 0, { output: "out.md", check: "the file exists", ...s });
};

describe("the daily-blog-post template", () => {
  it("passes, with no warning", () => {
    expect(checkSop(copy(), CTX)).toEqual({ refusals: [], warnings: [] });
  });
  it("passes as an instance once it is filled in", () => {
    expect(checkSop(instance(), CTX)).toEqual({ refusals: [], warnings: [] });
  });
});

describe("outward steps say so, and the word list only warns", () => {
  it("a step without an effect is refused, whatever its name", () => {
    expect(broken(s => { delete step(s, "outline").effect; })).toEqual(["effect-declared"]);
    expect(broken(s => { addStep(s, { id: "publishing", tool: "wordpress-posts" }); })).toEqual(["effect-declared"]);
  });
  it("a step that says outward needs its gate", () => {
    expect(broken(s => { addStep(s, { id: "publishing", tool: "wordpress-posts", effect: "outward" }); })).toEqual(["gate-before-outward"]);
  });
  it("a step that says local passes, with a warning when its name or tool sounds outward", () => {
    const sop = copy();
    addStep(sop, { id: "merge-parts", tool: "concat", effect: "local" });
    addStep(sop, { id: "notify-team", tool: "uploading-files", effect: "local" });
    const v = checkSop(sop, CTX);
    expect(v.refusals).toEqual([]);
    expect(v.warnings.map(w => [w.rule, w.at])).toEqual([["outward-sounding", "steps.merge-parts"], ["outward-sounding", "steps.notify-team"]]);
  });
  it("the warning catches inflected and other outward words", () => {
    for (const id of ["publishing", "posts", "sends", "emails", "tweet", "commit-results", "pushed"]) {
      const sop = copy();
      addStep(sop, { id, tool: "x", effect: "local" });
      expect([id, checkSop(sop, CTX).warnings.map(w => w.rule)]).toEqual([id, ["outward-sounding"]]);
    }
  });
});

describe("budgets bound spending", () => {
  it("an amount is a number with a currency", () => {
    expect(brokenInstance(s => { (s.budget as Record<string, unknown>).per_run = "unlimited"; })).toEqual(["budget-stop"]);
    expect(brokenInstance(s => { (s.budget as Record<string, unknown>).per_run = 5; })).toEqual(["budget-stop"]);
    expect(brokenInstance(s => { (s.budget as Record<string, unknown>).per_month = "100 EUR"; })).toEqual(["budget-stop"]);
    expect(brokenInstance(s => { (s.budget as Record<string, unknown>).per_run = "500 USD"; })).toEqual(["budget-stop"]);
  });
  it("zero means nothing may be spent, so no engine step may run", () => {
    const rules = brokenInstance(s => { s.budget = { per_run: 0, per_month: 0, on_exceed: "stop" }; });
    expect([new Set(rules), rules.length]).toEqual([new Set(["budget-stop"]), 6]);
    expect(brokenInstance(s => { s.budget = { per_run: 0, per_month: 0, on_exceed: "stop" }; s.steps = s.steps.filter(x => "tool" in x); s.gates = [{ ...s.gates[0], on_change: undefined, max_changes: undefined }].map(g => Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined))); s.patterns = ["loop-human-gate"]; })).toEqual([]);
  });
  it("a template may leave the amounts blank; an instance may not", () => {
    expect(rulesOf(copy())).toEqual([]);
    expect(brokenInstance(s => { (s.budget as Record<string, unknown>).per_run = "<per run, e.g. 5 USD>"; })).toEqual(["blanks-filled", "budget-stop"]);
  });
});

describe("a template keeps its blanks, an instance fills them", () => {
  it("an instance with a blank left is refused, naming where", () => {
    const sop = instance();
    (sop.inputs as Record<string, unknown>).style = "<style guide file>";
    expect(checkSop(sop, CTX).refusals.map(r => [r.rule, r.at])).toEqual([["blanks-filled", "inputs.style"]]);
  });
  it("an instance's cron line is five POSIX fields in range", () => {
    for (const cron of ["0 25 * * *", "*/15 * * * *", "0 7 * *", "0 7 * * 7", "0 7 * * MON", "60 7 * * *", "0 7 1-32 * *", "0 7 5-1 * *"]) {
      expect([cron, brokenInstance(s => { s.trigger = { schedule: { cron, timezone: "UTC" } }; })]).toEqual([cron, ["trigger"]]);
    }
    for (const cron of ["0 7 * * 1-5", "0,30 6-18 1,15 1-12 0-6", "* * * * *"]) {
      expect([cron, brokenInstance(s => { s.trigger = { schedule: { cron, timezone: "UTC" } }; })]).toEqual([cron, []]);
    }
  });
  it("an instance's time zone is one the runtime knows", () => {
    expect(brokenInstance(s => { s.trigger = { schedule: { cron: "0 7 * * *", timezone: "Mars/Olympus" } }; })).toEqual(["trigger"]);
  });
  it("a template may keep its schedule blank, but a filled-in one must still be valid", () => {
    expect(broken(s => { s.trigger = { schedule: { cron: "0 25 * * *", timezone: "<IANA zone>" } }; })).toEqual(["trigger"]);
  });
  it("kind is template or instance; an SOP without one, or with another, is judged as an instance", () => {
    const unknown = broken(s => { s.kind = "draft"; });
    expect([unknown[0], unknown.includes("blanks-filled")]).toEqual(["shape", true]);
    expect(broken(s => { delete s.kind; })).toContain("blanks-filled");
  });
});

describe("required fields, from one list", () => {
  it.each([...SOP_REQUIRED])("without %s, exactly one refusal, at that field", field => {
    const sop = copy();
    delete sop[field];
    expect(checkSop(sop, CTX).refusals.map(r => r.at)).toEqual([field]);
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
    expect(broken(s => { delete step(s, "publish").effect; })).toEqual(["effect-declared"]);
    expect(broken(s => { step(s, "publish").effect = "sometimes"; })).toEqual(["effect-declared"]);
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
    expect(brokenInstance(s => { step(s, "draft").why = ["loop-review-fix", "notes/writing-boards", "pref:write-long", "models.dev@2026-10-12", "no evidence: default"]; })).toEqual([]);
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

describe("a shipped template cites no preference (K12)", () => {
  it("a template whose step cites a preference is refused; an instance may cite one", () => {
    const cites = (sop: Sop) => { step(sop, "draft").why = ["notes/writing-boards", "pref:write-long"]; };
    expect(broken(cites)).toEqual(["preference-in-template"]);
    expect(brokenInstance(cites)).toEqual([]);
  });
});

describe("the ubiquitous language", () => {
  it("docs/domain.md has the Knowledge context, its terms and the invariants this check enforces", () => {
    const doc = readFileSync(join(ROOT, "docs/domain.md"), "utf8");
    const section = doc.split(/^## /m).find(s => s.startsWith("Knowledge")) ?? "";
    const terms = [...section.matchAll(/^\| ([A-Z][^|]*?) \|/gm)].map(m => m[1]);
    expect(terms).toEqual(expect.arrayContaining(["SOP", "Template", "Instance", "Step", "Effect", "Gate", "Stop rule", "Budget amount", "Model class", "Family rule", "Citation", "Note", "Preference", "Pattern"]));
    for (const id of ["K4", "K6", "K9", "K10", "K11", "K12", "K14"]) expect([id, section.includes(`| ${id} |`)]).toEqual([id, true]);
    expect(doc).toMatch(/\*Knowledge stands beside Engines\*/);
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
