// Strict DDD: the domain imports nothing but its own files. No node:*, no packages, no adapters.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec => !/^\.\/[\w-]+\.ts$/.test(spec));

describe("domain architecture", () => {
  it("every domain file imports only sibling domain files", () => {
    const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the check catches forbidden imports (negative control)", () => {
    expect(offending(`import { readFileSync } from "node:fs";`)).toEqual(["node:fs"]);
    expect(offending(`import type { X } from "../../apps/hub/src/x.ts";`)).toEqual(["../../apps/hub/src/x.ts"]);
    expect(offending(`const m = await import("ws");`)).toEqual(["ws"]);
    expect(offending(`export * from "./access.ts";`)).toEqual([]);
  });
  it("uses no ambient I/O globals either", () => {
    const code = readdirSync(SRC).map(f => readFileSync(join(SRC, f), "utf8")).join("\n");
    expect(code).not.toMatch(/\b(fetch|process|require|Date\.now|setTimeout|setInterval|crypto)\b/);
  });
});
