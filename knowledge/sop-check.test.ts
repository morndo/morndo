// sop-check, the command. Its logic (knowledge/tools/sop-check/cli.ts) through `run`: exit 0 passes, 1 refused, 2 for a
// bad call or anything unexpected, one line and no stack. The shipped bundle (the skill's scripts/sop-check.mjs) as a user
// runs it, from the repository and from a copy of the skills, and as the build makes it today. Then the skill's JSON
// Schema against the domain's lists, the roles against the engine layer's, and the preferences example.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { BUDGET_ON_EXCEED, GATE_FIELDS, MODEL_CLASSES, SILENCE_OUTCOMES, SOP_FIELDS, SOP_KINDS, SOP_REQUIRED, STEP_EFFECTS, STEP_FIELDS } from "../packages/domain/src/knowledge.ts";
import { DEFAULT_ROLES, run } from "./tools/sop-check/cli.ts";

const SKILL = "knowledge/skills/recurring-job";
const BUNDLE = join(SKILL, "scripts/sop-check.mjs");
const TEMPLATE = join(SKILL, "assets/daily-blog-post.yaml");
const tmp = mkdtempSync(join(tmpdir(), "sop-check-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const runIo = async (args: string[], skillDir = SKILL) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { skillDir, out: l => out.push(l), err: l => err.push(l) });
  return { code, out, err };
};
const brokenCopy = (name: string, change: (sop: Record<string, unknown>) => void) => {
  const sop = parse(readFileSync(TEMPLATE, "utf8")) as Record<string, unknown>;
  change(sop);
  const file = join(tmp, `${name}.yaml`);
  writeFileSync(file, stringify(sop));
  return file;
};
const node = (script: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("run: exit codes and lines", () => {
  it("passes the daily-blog-post template", async () => {
    expect(await runIo([TEMPLATE, "--today", "2026-10-12"])).toEqual({ code: 0, out: ["daily-blog-post: passes"], err: [] });
  });
  it("refuses a copy without its gate with 1, naming the rule and the step", async () => {
    const r = await runIo([brokenCopy("no-gate", s => { s.gates = []; }), "--today", "2026-10-12"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refused  gate-before-outward  steps.publish  an outward or irreversible step waits for the principal: put a gate before it");
    expect(r.out.at(-1)).toBe("daily-blog-post: 1 refusal");
  });
  it("warns on a stale note and still passes", async () => {
    const r = await runIo([TEMPLATE, "--today", "2027-01-11"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("warning  stale-citation  steps.draft  notes/writing-boards was due for a re-read on 2027-01-10");
  });
  it("takes the engine layer's roles from --roles", async () => {
    const r = await runIo([TEMPLATE, "--today", "2026-10-12", "--roles", "plan,review,validate"]);
    expect(r.code).toBe(1);
    expect(r.out.some(l => l.startsWith("refused  role-known  steps.research"))).toBe(true);
  });
  it("exits 2 on a bad call, a missing file or a file that isn't YAML, with one line", async () => {
    const bad = join(tmp, "bad.yaml");
    writeFileSync(bad, "steps: [unclosed");
    for (const args of [[], ["a.yaml", "b.yaml"], ["--today", "soon", TEMPLATE], [join(tmp, "missing.yaml")], [bad]]) {
      const r = await runIo(args);
      expect([args, r.code, r.err.length, r.out]).toEqual([args, 2, 1, []]);
    }
  });
  it("exits 2 with one line when something unexpected breaks, such as a note it can't parse", async () => {
    const skills = join(tmp, "broken-skills");
    cpSync("knowledge/skills", skills, { recursive: true });
    writeFileSync(join(skills, "recurring-job/references/writing-boards.md"), "---\nnote: writing-boards\nrecheck: [2027-01-10\n---\n");
    const r = await runIo([TEMPLATE, "--today", "2026-10-12"], join(skills, "recurring-job"));
    expect([r.code, r.err.length, r.out]).toEqual([2, 1, []]);
    expect(r.err[0]).toMatch(/^sop-check: /);
  });
  it("uses the engine layer's roles as recorded from its CLI by default", () => {
    const recorded = JSON.parse(readFileSync("apps/hub/test/fixtures/engines-defaults.json", "utf8")) as { roles: Record<string, unknown> };
    expect([...DEFAULT_ROLES]).toEqual(Object.keys(recorded.roles));
  });
});

describe("the bundle, as a user runs it", () => {
  it("is what the build makes from today's sources", async () => {
    const { bundle } = (await import("./tools/sop-check/build.ts")) as { bundle: () => Promise<string> };
    expect(await bundle()).toBe(readFileSync(BUNDLE, "utf8"));
  });
  it("runs from the repository: passes the template, refuses an unsafe copy", () => {
    expect(node(BUNDLE, TEMPLATE, "--today", "2026-10-12")).toEqual({ code: 0, out: "daily-blog-post: passes\n" });
    const r = node(BUNDLE, brokenCopy("model-id", s => { (s.steps as Record<string, unknown>[])[2] = { ...(s.steps as Record<string, unknown>[])[2], model: "acme-large-2" }; }), "--today", "2026-10-12");
    expect([r.code, r.out.includes("refused  no-model-id  steps.draft")]).toEqual([1, true]);
  });
  it("runs from a copy of the skills once yaml is installed there, and says how to install it until then", () => {
    const skills = join(tmp, "copied", "skills");
    mkdirSync(skills, { recursive: true });
    cpSync("knowledge/skills", skills, { recursive: true });
    const copied = join(skills, "recurring-job");
    const before = node(join(copied, "scripts/sop-check.mjs"), join(copied, "assets/daily-blog-post.yaml"), "--today", "2026-10-12");
    expect(before.code).toBe(2);
    expect(before.out).toContain("npm install");
    // As `npm install` in the skill folder would place it.
    mkdirSync(join(copied, "node_modules"));
    symlinkSync(resolve("node_modules/yaml"), join(copied, "node_modules/yaml"));
    expect(node(join(copied, "scripts/sop-check.mjs"), join(copied, "assets/daily-blog-post.yaml"), "--today", "2026-10-12")).toEqual({ code: 0, out: "daily-blog-post: passes\n" });
  });
  it("sets the exit code and lets output drain, instead of exiting at once", () => {
    const main = readFileSync("knowledge/tools/sop-check/main.ts", "utf8");
    expect([main.includes("process.exitCode"), main.includes("process.exit(")]).toEqual([true, false]);
  });
  it("pins the one dependency a copied skill installs", () => {
    const pkg = JSON.parse(readFileSync(join(SKILL, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const repo = JSON.parse(readFileSync("node_modules/yaml/package.json", "utf8")) as { version: string };
    expect(pkg.dependencies).toEqual({ yaml: repo.version });
  });
});

describe("the SOP's JSON Schema", () => {
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
    expect(schema.$defs.step.required).toContain("effect");
    expect(sorted(Object.keys(schema.$defs.gate.properties))).toEqual(sorted(GATE_FIELDS));
    expect(schema.properties.kind.enum).toEqual([...SOP_KINDS]);
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
