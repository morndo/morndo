// The sop-check command (knowledge/skills/recurring-job/scripts/sop-check.ts) as a user runs it: the shipped template
// passes, a broken copy exits 1 naming its rule, a bad call exits 2. Then the skill's JSON Schema against the domain's
// field lists, so the two can't drift, and the preferences example in the skill's references.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { BUDGET_ON_EXCEED, GATE_FIELDS, MODEL_CLASSES, SILENCE_OUTCOMES, SOP_FIELDS, SOP_REQUIRED, STEP_EFFECTS, STEP_FIELDS } from "../packages/domain/src/knowledge.ts";

const SKILL = "knowledge/skills/recurring-job";
const SCRIPT = join(SKILL, "scripts/sop-check.ts");
const TEMPLATE = join(SKILL, "assets/daily-blog-post.yaml");
const tmp = mkdtempSync(join(tmpdir(), "sop-check-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const brokenCopy = (name: string, change: (sop: Record<string, unknown>) => void) => {
  const sop = parse(readFileSync(TEMPLATE, "utf8")) as Record<string, unknown>;
  change(sop);
  const file = join(tmp, `${name}.yaml`);
  writeFileSync(file, stringify(sop));
  return file;
};

describe("sop-check, the command", () => {
  it("passes the daily-blog-post template", () => {
    const r = run(TEMPLATE, "--today", "2026-10-12");
    expect([r.code, r.out]).toEqual([0, "daily-blog-post: passes\n"]);
  });
  it("refuses a copy without its gate, exits 1 and names the rule and the step", () => {
    const r = run(brokenCopy("no-gate", s => { s.gates = []; }), "--today", "2026-10-12");
    expect(r.code).toBe(1);
    expect(r.out).toContain("refused  gate-before-outward  steps.publish");
    expect(r.out).toContain("daily-blog-post: 1 refusal");
  });
  it("warns on a stale note and still passes", () => {
    const r = run(TEMPLATE, "--today", "2027-01-11");
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning  stale-citation  steps.draft  notes/writing-boards was due for a re-read on 2027-01-10");
  });
  it("takes the engine layer's roles from --roles", () => {
    const r = run(TEMPLATE, "--today", "2026-10-12", "--roles", "plan,review,validate");
    expect(r.code).toBe(1);
    expect(r.out).toContain("refused  role-known  steps.research");
  });
  it("exits 2 on a bad call or a file that isn't YAML", () => {
    expect(run().code).toBe(2);
    const bad = join(tmp, "bad.yaml");
    writeFileSync(bad, "steps: [unclosed");
    expect(run(bad).code).toBe(2);
    expect(run(join(tmp, "missing.yaml")).code).toBe(2);
  });
});

describe("the SOP's JSON Schema", () => {
  // oxlint-disable-next-line typescript/no-explicit-any -- a JSON document read for its keys
  const load = () => JSON.parse(readFileSync(join(SKILL, "assets/sop.schema.json"), "utf8")) as Record<string, any>;
  const sorted = (xs: readonly string[]) => [...xs].sort();
  it("is JSON Schema 2020-12 and closed at every level the check closes", () => {
    const schema = load();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect([schema.additionalProperties, schema.$defs.step.additionalProperties, schema.$defs.gate.additionalProperties]).toEqual([false, false, false]);
  });
  it("holds the domain's fields, required fields and enums", () => {
    const schema = load();
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(SOP_FIELDS));
    expect(sorted(schema.required)).toEqual(sorted(SOP_REQUIRED));
    expect(sorted(Object.keys(schema.$defs.step.properties))).toEqual(sorted(STEP_FIELDS));
    expect(sorted(Object.keys(schema.$defs.gate.properties))).toEqual(sorted(GATE_FIELDS));
    expect(schema.$defs.model.properties.class.enum).toEqual([...MODEL_CLASSES]);
    expect(schema.$defs.step.properties.effect.enum).toEqual([...STEP_EFFECTS]);
    expect(schema.$defs.gate.properties.on_silence.properties.then.enum).toEqual([...SILENCE_OUTCOMES]);
    expect(schema.properties.budget.properties.on_exceed.enum).toEqual([...BUDGET_ON_EXCEED]);
  });
});

describe("the preferences example", () => {
  it("parses, and each preference has its holder, its date and its words", () => {
    const doc = readFileSync(join(SKILL, "references/preferences.md"), "utf8");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
    const prefs = (parse(yaml) as { preferences: Record<string, unknown>[] }).preferences;
    expect(prefs.length).toBeGreaterThan(0);
    for (const p of prefs) expect([typeof p.id, typeof p.holder, typeof p.on, typeof p.said, Array.isArray(p.tasks)]).toEqual(["string", "string", "string", "string", true]);
    expect(doc).toContain("your preference");
  });
});
