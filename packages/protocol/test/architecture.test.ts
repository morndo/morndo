// The protocol imports no node:* (docs/design/fleet-core/README.md §12): the app runs it in the browser, and the agent
// channel's format must not lean on Node either. Its files import their siblings and the domain, and zod only through
// z.ts (ADR-0008 A2), and touch no Node global.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (file: string, code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || spec === "@morndo/domain" || (file === "z.ts" && spec === "zod/mini")));
const NODE_GLOBALS = /\b(?:Buffer|process)\.\w|\bnew Buffer\b|\brequire\(|\b__dirname\b|\bimport\.meta\.dirname\b/;

describe("protocol architecture", () => {
  const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
  it("every protocol file imports only siblings, the domain, and zod through z.ts", () => {
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(f, readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("uses no Node global", () => {
    for (const f of files) expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(NODE_GLOBALS);
  });
  it("the checks catch what they forbid (negative controls)", () => {
    expect(offending("fleet.ts", `import { createHash } from "node:crypto";`)).toEqual(["node:crypto"]);
    expect(offending("fleet.ts", `import { readFileSync } from "fs";`)).toEqual(["fs"]);
    expect(offending("fleet.ts", `const m = await import("node:fs");`)).toEqual(["node:fs"]);
    expect(offending("fleet.ts", `import * as z from "zod/mini";`)).toEqual(["zod/mini"]);
    expect(offending("fleet.ts", `import type { X } from "../../../apps/hub/src/x.ts";`)).toEqual(["../../../apps/hub/src/x.ts"]);
    expect(offending("z.ts", `export * from "zod/mini";`)).toEqual([]);
    expect(offending("index.ts", `export * from "./fleet.ts";`)).toEqual([]);
    expect(`const b = Buffer.from(s, "base64url");`).toMatch(NODE_GLOBALS);
    expect(`if (process.env.X) {}`).toMatch(NODE_GLOBALS);
    expect(`// its types include neither Buffer nor TextEncoder`).not.toMatch(NODE_GLOBALS);
  });
});
