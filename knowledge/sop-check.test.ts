// sop-check, the command. Its logic (knowledge/tools/sop-check/cli.ts) through `run`: exit 0 passes, 1 refused, 2 for a
// bad call or anything unexpected, one line and no stack. The shipped bundle (the skill's scripts/sop-check.mjs) as a user
// runs it, from the repository and from a copy of the skills, and as the build makes it today. Then the skill's JSON
// Schemas against the domain's lists, the roles against the engine layer's, and the preferences example.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { BUDGET_ON_EXCEED, GATE_FIELDS, MODEL_CLASSES, SILENCE_OUTCOMES, SOP_FIELDS, SOP_KINDS, SOP_REQUIRED, STEP_EFFECTS, STEP_FIELDS } from "../packages/domain/src/knowledge.ts";
import { PREFERENCE_FIELDS, PREFERENCE_ID, parsePreferences, renderPreference } from "../packages/domain/src/knowledge-facts.ts";
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
// The template filled in as a user would, its draft step citing `why`.
const instanceCiting = (name: string, why: string[]) =>
  brokenCopy(name, s => {
    s.kind = "instance";
    s.trigger = { schedule: { cron: "0 7 * * 1-5", timezone: "Europe/Berlin" } };
    s.inputs = { topic: { from: "board column ideas", one_per_run: true }, site: { search_console_property: "sc-domain:example.org", cms: "example-cms" }, style: "style.md" };
    s.budget = { per_run: "5 USD", per_month: "100 USD", on_exceed: "stop" };
    const draft = (s.steps as Record<string, unknown>[]).find(x => x.id === "draft");
    if (draft) draft.why = why;
  });
// A preferences file with one preference and one broken entry, and a snapshot directory with one snapshot.
const PREFERENCES = join(tmp, "preferences.yaml");
writeFileSync(PREFERENCES, stringify({ preferences: [
  { id: "write-long", holder: "principal", on: "2026-10-11", said: "Acme models for long-form writing.", tasks: ["draft"] },
  { id: "broken-date", holder: "principal", on: "2026-02-30", said: "Acme for the search pass.", tasks: ["search-pass"] },
] }));
const SNAPSHOTS = join(tmp, "models-dev");
mkdirSync(SNAPSHOTS);
writeFileSync(join(SNAPSHOTS, "2026-10-12.json"), "{}\n");
writeFileSync(join(SNAPSHOTS, "notes.txt"), "not a snapshot\n");
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

describe("run: a cited preference or snapshot", () => {
  const LEFT_OUT = "warning  preference-left-out  preferences[1]  on must be a real date, YYYY-MM-DD";
  it("resolves pref:<id> against --preferences: a preference of the file passes, one the file doesn't hold is refused", async () => {
    expect(await runIo([instanceCiting("pref-known", ["pref:write-long"]), "--today", "2026-10-12", "--preferences", PREFERENCES])).toEqual({
      code: 0, out: [LEFT_OUT, "daily-blog-post: passes"], err: [],
    });
    expect(await runIo([instanceCiting("pref-unknown", ["pref:broken-date"]), "--today", "2026-10-12", "--preferences", PREFERENCES])).toEqual({
      code: 1, out: ["refused  why-resolves  steps.draft  pref:broken-date is no preference of the preferences file", LEFT_OUT, "daily-blog-post: 1 refusal"], err: [],
    });
  });
  it("resolves models.dev@<date> against --snapshots: a snapshot of that date passes, another date is refused", async () => {
    expect(await runIo([instanceCiting("snap-known", ["models.dev@2026-10-12"]), "--today", "2026-10-12", "--snapshots", SNAPSHOTS])).toEqual({
      code: 0, out: ["daily-blog-post: passes"], err: [],
    });
    const r = await runIo([instanceCiting("snap-unknown", ["models.dev@2026-10-01"]), "--today", "2026-10-12", "--snapshots", SNAPSHOTS]);
    expect([r.code, r.out[0]]).toEqual([1, "refused  why-resolves  steps.draft  models.dev@2026-10-01 is no snapshot of the snapshot directory"]);
  });
  it("without them, checks each for its form only and says so", async () => {
    expect(await runIo([instanceCiting("unchecked", ["pref:write-long", "models.dev@2026-10-12"]), "--today", "2026-10-12"])).toEqual({
      code: 0, err: [],
      out: [
        "warning  unchecked-citation  steps.draft  pref:write-long is checked for its form only: no preferences file was given",
        "warning  unchecked-citation  steps.draft  models.dev@2026-10-12 is checked for its form only: no snapshot directory was given",
        "daily-blog-post: passes",
      ],
    });
  });
  it("exits 2 with one line on a preferences file it can't read or that isn't YAML, a snapshot directory it can't read, or a flag without its value", async () => {
    const notYaml = join(tmp, "not-yaml-preferences.yaml");
    writeFileSync(notYaml, "preferences: [unclosed");
    for (const extra of [["--preferences", join(tmp, "missing.yaml")], ["--preferences", notYaml], ["--snapshots", join(tmp, "no-such-dir")], ["--preferences"], ["--snapshots"]]) {
      const r = await runIo([TEMPLATE, "--today", "2026-10-12", ...extra]);
      expect([extra, r.code, r.err.length, r.out]).toEqual([extra, 2, 1, []]);
    }
  });
});

describe("the bundle, as a user runs it", () => {
  it("is what the build makes from today's sources", async () => {
    const { bundle } = (await import("./tools/sop-check/build.ts")) as { bundle: () => Promise<string> };
    expect(await bundle()).toBe(readFileSync(BUNDLE, "utf8"));
  });
  it("runs from the repository: passes the template, refuses an unsafe copy", () => {
    expect(node(BUNDLE, TEMPLATE, "--today", "2026-10-12")).toEqual({ code: 0, out: "daily-blog-post: passes\n" });
    expect(node(BUNDLE, instanceCiting("bundle-pref", ["pref:write-long"]), "--today", "2026-10-12", "--preferences", PREFERENCES, "--snapshots", SNAPSHOTS).code).toBe(0);
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

describe("the preferences schema", () => {
  // Read here, so a missing file fails this test, not the import.
  const load = () => JSON.parse(readFileSync(join(SKILL, "assets/preferences.schema.json"), "utf8")) as Record<string, any>;
  it("is JSON Schema 2020-12, closed at the top and on the item, and holds exactly the preference fields", () => {
    const schema = load();
    const item = schema.$defs.preference;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect([schema.additionalProperties, item.additionalProperties]).toEqual([false, false]);
    expect(Object.keys(item.properties).sort()).toEqual([...PREFERENCE_FIELDS].sort());
    expect(item.required).toEqual([...PREFERENCE_FIELDS]);
  });
});

describe("the preferences schema and parsePreferences agree", () => {
  // Ajv for JSON Schema 2020-12 (ajv.js.org/json-schema.html, v8.20.0, read 2026-10-12); strict, so a keyword it doesn't know fails.
  const validator = () => new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(readFileSync(join(SKILL, "assets/preferences.schema.json"), "utf8")));
  const ENTRY = { id: "write-long", holder: "principal", on: "2026-10-11", said: "Acme models for long-form writing.", tasks: ["draft"] };
  const { said: _said, ...NO_SAID } = ENTRY;
  const FIXTURES: [string, unknown][] = [
    ["an entry", ENTRY], ["a leap day", { ...ENTRY, on: "2024-02-29" }], ["a leap century", { ...ENTRY, on: "2000-02-29" }],
    ["year 0", { ...ENTRY, on: "0000-02-29" }], ["an early year", { ...ENTRY, on: "0026-01-01" }],
    ["no leap day", { ...ENTRY, on: "2026-02-29" }], ["no leap century", { ...ENTRY, on: "2100-02-29" }], ["February 30", { ...ENTRY, on: "2026-02-30" }],
    ["April 31", { ...ENTRY, on: "2026-04-31" }], ["month 13", { ...ENTRY, on: "2026-13-01" }], ["day 0", { ...ENTRY, on: "2026-01-00" }],
    ["an unpadded month", { ...ENTRY, on: "2026-1-01" }], ["a time", { ...ENTRY, on: "2026-10-11T00:00:00Z" }], ["a number", { ...ENTRY, on: 20261011 }],
    ["a blank holder", { ...ENTRY, holder: " " }], ["an empty holder", { ...ENTRY, holder: "" }], ["a no-break-space holder", { ...ENTRY, holder: "\u00a0" }],
    ["blank words", { ...ENTRY, said: "\t\n" }], ["no words", NO_SAID], ["an empty task", { ...ENTRY, tasks: [""] }], ["a blank task", { ...ENTRY, tasks: ["  "] }],
    ["no task", { ...ENTRY, tasks: [] }], ["a task that is a number", { ...ENTRY, tasks: [1] }], ["tasks as one string", { ...ENTRY, tasks: "draft" }],
    ["an upper-case id", { ...ENTRY, id: "Write-long" }], ["an id starting with a hyphen", { ...ENTRY, id: "-write" }],
    ["an id with an underscore", { ...ENTRY, id: "write_long" }], ["an id starting with a digit", { ...ENTRY, id: "2-write" }],
    ["a field the file doesn't have", { ...ENTRY, rank: 1 }], ["an entry that is a string", "write-long"],
  ];
  const agree = (doc: unknown) => [validator()(doc), parsePreferences(doc).refusals.length === 0];
  it("on each entry: the schema accepts it exactly when parsePreferences keeps it", () => {
    const validate = validator();
    for (const [name, entry] of FIXTURES) {
      const doc = { preferences: [entry] };
      expect([name, validate(doc)]).toEqual([name, parsePreferences(doc).refusals.length === 0]);
    }
  });
  it("on every date from day 0 to day 32 of every month, 0 to 13, of a common, a leap, a century and a 400th year", () => {
    const validate = validator();
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    for (const y of [1900, 2000, 2023, 2024, 2100]) for (let m = 0; m <= 13; m++) for (let d = 0; d <= 32; d++) {
      const doc = { preferences: [{ ...ENTRY, on: `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}` }] };
      expect([doc.preferences[0]?.on, validate(doc)]).toEqual([doc.preferences[0]?.on, parsePreferences(doc).refusals.length === 0]);
    }
  });
  it("on the file: no preferences list, a field the file doesn't have, an empty list", () => {
    for (const doc of [{}, { preferences: "none" }, { preferences: [], rank: 1 }, "preferences", { preferences: [] }]) {
      const [schema, parser] = agree(doc);
      expect([doc, schema]).toEqual([doc, parser]);
    }
  });
  it("the id rule is the domain's, and the one rule only parsePreferences holds is that ids are unique, as the schema says", () => {
    const schema = JSON.parse(readFileSync(join(SKILL, "assets/preferences.schema.json"), "utf8")) as Record<string, any>;
    expect(schema.$defs.preference.properties.id.pattern).toBe(PREFERENCE_ID.source);
    const twice = { preferences: [ENTRY, { ...ENTRY, holder: "editor" }] };
    expect(agree(twice)).toEqual([true, false]);
    expect(schema.description).toContain("parsePreferences is the authority");
  });
});

describe("the preferences example", () => {
  it("parses, and each preference has its holder, its date and its words", () => {
    const doc = readFileSync(join(SKILL, "references/preferences.md"), "utf8");
    const yaml = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] ?? "";
    const file = parse(yaml) as { preferences: Record<string, unknown>[] };
    const prefs = file.preferences;
    expect(prefs.length).toBeGreaterThan(0);
    for (const p of prefs) expect([typeof p.id, typeof p.holder, typeof p.on, typeof p.said, Array.isArray(p.tasks)]).toEqual(["string", "string", "string", "string", true]);
    const judged = parsePreferences(file);
    expect(judged.refusals).toEqual([]);
    for (const p of judged.preferences) expect(doc).toContain(renderPreference(p));
    expect(doc).toContain("your preference");
  });
});
