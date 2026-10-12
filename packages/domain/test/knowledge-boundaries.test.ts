// The Knowledge context's outer boundaries (ADR-0026), as walks over the repository: nothing outside the knowledge modules
// names them or their functions (K9), nothing outside knowledge-facts names the model snapshot (K13), no shipped file is a
// user's preferences.yaml (K12), each small rule has one copy, the domain's index exports the module, and docs/domain.md keeps
// the terms. Each matcher is proven by a planted line it must flag, so a passing walk means something; the walks are proven on a
// made-up repository to read what it ships and nothing else.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as domain from "../src/index.ts";

const ROOT = join(import.meta.dirname, "../../..");

export type Walked = { path: string; text: string };
const walk = (dir: string, skip: readonly string[], tsOnly: boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return skip.includes(e.name) ? [] : walk(p, skip, tsOnly);
    return tsOnly && !e.name.endsWith(".ts") ? [] : [p];
  });
// Every .ts file under packages/*/src or apps/*/src, by its repository-relative path.
export const packageSources = (): Walked[] =>
  ["packages", "apps"].flatMap(top =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(ROOT, top, e.name, "src")))
      .flatMap(e => walk(join(ROOT, top, e.name, "src"), ["node_modules"], true))
      .map(p => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") })));
// The files, other than the allowed ones, whose text holds any of the banned strings: their paths.
export const offenders = (files: readonly Walked[], banned: readonly string[], allowed: readonly string[]): string[] =>
  files.filter(f => !allowed.includes(f.path) && banned.some(b => f.text.includes(b))).map(f => f.path);

describe("knowledge never routes (K9)", () => {
  const banned = ["knowledge.ts", "knowledge-facts.ts", "checkSop", "scorecardFor", "parsePreferences"];
  const allowed = ["packages/domain/src/knowledge.ts", "packages/domain/src/knowledge-facts.ts", "packages/domain/src/index.ts"];
  it("no other source under packages/*/src or apps/*/src names the knowledge modules or their functions", () => {
    expect(offenders(packageSources(), banned, allowed)).toEqual([]);
  });
  it("the same matcher flags a planted import", () => {
    const planted = [{ path: "apps/hub/src/adapters/planted.ts", text: 'import { scorecardFor } from "@morndo/domain";' }];
    expect(offenders(planted, banned, allowed)).toEqual(["apps/hub/src/adapters/planted.ts"]);
  });
});

describe("the snapshot never feeds a gate (K13)", () => {
  const banned = ["models.dev", "models-dev", "trimModelsDev", "readSnapshot"];
  // knowledge.ts names the citation form models.dev@<date>; it reads no snapshot.
  const allowed = ["packages/domain/src/knowledge-facts.ts", "packages/domain/src/knowledge.ts", "packages/domain/src/index.ts"];
  it("no source outside knowledge-facts names the snapshot's source or its reader", () => {
    expect(offenders(packageSources(), banned, allowed)).toEqual([]);
  });
  it("the same matcher flags a planted read", () => {
    const planted = [{ path: "apps/hub/src/adapters/planted.ts", text: "const snapshot = readSnapshot(doc);" }];
    expect(offenders(planted, banned, allowed)).toEqual(["apps/hub/src/adapters/planted.ts"]);
  });
});

// Every preferences.yaml or .yml under root, by its root-relative path.
export const preferencesFiles = (root: string): string[] =>
  walk(root, ["node_modules", ".git", "dist"], false).filter(p => ["preferences.yaml", "preferences.yml"].includes(basename(p))).map(p => relative(root, p));

describe("shipped knowledge holds no user's preferences (K12)", () => {
  it("no file in the repository is a preferences.yaml", () => {
    expect(preferencesFiles(ROOT)).toEqual([]);
  });
});

// A made-up repository: two sources git ships, one in a folder .gitignore leaves out, and a lane's worktree under
// .worktrees/ (ignored, as in this repository) holding a source and a preferences.yaml of its own.
describe("the walks read what the repository ships, the same files on every run", () => {
  const repo = mkdtempSync(join(tmpdir(), "knowledge-walk-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  execFileSync("git", ["init", "--quiet", repo]);
  put(".gitignore", ".worktrees/\nbuild/\n");
  put("packages/one/src/b.ts", "export const b = 1;\n");
  put("packages/one/src/a/z.ts", "export const z = 1;\n");
  put("packages/one/src/build/generated.ts", "export const generated = 1;\n");
  put(".worktrees/lane/packages/one/src/other.ts", "export const other = 1;\n");
  put(".worktrees/lane/preferences.yaml", "preferences: []\n");
  it("sources under packages/*/src and apps/*/src: what git would ship, sorted", async () => {
    expect((await packageSources(repo)).map(f => f.path)).toEqual(["packages/one/src/a/z.ts", "packages/one/src/b.ts"]);
  });
  it("a preferences file only where the repository would ship it, never in another lane's worktree", () => {
    expect(preferencesFiles(repo)).toEqual([]);
  });
});

describe("one copy of each small rule", () => {
  // Each of these, declared in the file: the copies review point 10 of PR 42 found.
  const declares = (path: string, names: readonly string[]) => {
    const src = readFileSync(join(ROOT, path), "utf8");
    return names.filter(n => new RegExp(`^(?:export )?(?:const|function) ${n}\\b`, "m").test(src));
  };
  it("the Knowledge modules take isRec, text, shown, the date rule and the preference id from one module", () => {
    expect(declares("packages/domain/src/knowledge.ts", ["isRec", "text", "shown", "PREF", "PREFERENCE_ID"])).toEqual([]);
    expect(declares("packages/domain/src/knowledge-facts.ts", ["isRec", "text", "shown", "PREF_ID", "PREFERENCE_ID", "isDate", "utcMs"])).toEqual([]);
  });
  it("the two commands take firstLine from one module", () => {
    expect([...declares("knowledge/tools/models-dev/cli.ts", ["firstLine"]), ...declares("knowledge/tools/sop-check/cli.ts", ["firstLine"])]).toEqual([]);
  });
});

describe("the domain's index", () => {
  it("exports the knowledge-facts module", () => {
    const exported = domain as unknown as Record<string, unknown>;
    expect([typeof exported.trimModelsDev, typeof exported.parsePreferences, typeof exported.scorecardFor]).toEqual(["function", "function", "function"]);
  });
});

describe("the ubiquitous language", () => {
  it("docs/domain.md's Knowledge section names the preference rule and the snapshot's terms", () => {
    const section = readFileSync(join(ROOT, "docs/domain.md"), "utf8").split(/^## /m).find(s => s.startsWith("Knowledge")) ?? "";
    expect([section.includes("preference-in-template"), /^\| Model snapshot \|/m.test(section), /^\| Scorecard cell \|/m.test(section)]).toEqual([true, true, true]);
  });
});
