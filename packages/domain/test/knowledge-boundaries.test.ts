// The Knowledge context's outer boundaries (ADR-0026), as walks over the repository: nothing outside the knowledge modules
// names them or their functions (K9), nothing outside knowledge-facts names the model snapshot (K13), no shipped file is a
// user's preferences.yaml (K12), the domain's index exports the module, and docs/domain.md keeps the terms. Each matcher is
// proven by a planted line it must flag, so a passing walk means something.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("shipped knowledge holds no user's preferences (K12)", () => {
  it("no file in the repository is a preferences.yaml", () => {
    const found = walk(ROOT, ["node_modules", ".git", "dist"], false).filter(p => ["preferences.yaml", "preferences.yml"].includes(basename(p)));
    expect(found.map(p => relative(ROOT, p))).toEqual([]);
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
