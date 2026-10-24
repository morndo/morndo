// The barrel re-exports every module with `export *`. A name two modules both export is a TS2308 on a union merge,
// and an explicit re-export in index.ts that picks one hides the other from every importer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");

export function exportedNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:type|interface|const|let|function\*?|class|enum)\s+(\w+)/gm)) names.push(m[1] ?? "");
  for (const m of code.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

export function clashes(modules: Readonly<Record<string, string>>): string[] {
  const owner = new Map<string, string>();
  const found: string[] = [];
  for (const [file, code] of Object.entries(modules)) {
    for (const name of new Set(exportedNames(code))) {
      const first = owner.get(name);
      if (first) found.push(`${name}: ${first}, ${file}`);
      else owner.set(name, file);
    }
  }
  return found;
}

describe("the domain barrel", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const files = [...index.matchAll(/export \* from "\.\/([\w-]+\.ts)"/g)].map(m => m[1] ?? "");

  it("re-exports at least the modules it lists", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("no two modules export the same name, so nothing is hidden or ambiguous", () => {
    const modules = Object.fromEntries(files.map(file => [file, readFileSync(join(SRC, file), "utf8")]));
    expect(clashes(modules)).toEqual([]);
  });

  it("index.ts picks no winner: it holds only `export *` lines and comments", () => {
    const code = index.split("\n").filter(line => line.trim() !== "" && !line.trim().startsWith("//"));
    expect(code.filter(line => !/^export \* from "\.\/[\w-]+\.ts";$/.test(line.trim()))).toEqual([]);
  });

  it("control: the check names a clash between two modules", () => {
    expect(clashes({ "a.ts": "export type Tier = 1;", "b.ts": "export type Tier = 2;\nexport const other = 1;" })).toEqual(["Tier: a.ts, b.ts"]);
    expect(clashes({ "a.ts": "export type Tier = 1;", "b.ts": "export type { Tier as Other };" })).toEqual([]);
    expect(clashes({ "a.ts": "export const roleGroup = 1;", "b.ts": "export { roleGroup };" })).toEqual(["roleGroup: a.ts, b.ts"]);
  });
});
