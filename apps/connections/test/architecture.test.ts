// The application imports the domain, the protocol and its siblings. Adapters stay outside it (ADR-0018 §4).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretMaterial } from "../src/adapters/secret-material.ts";

const APP = join(import.meta.dirname, "../src/application");
const SRC = join(import.meta.dirname, "../src");
const ROOT = join(import.meta.dirname, "../../..");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || spec === "@morndo/domain" || spec === "@morndo/protocol"));

const NODE_GLOBALS = /\b(?:Buffer|process)\.\w|\bnew Buffer\b|\brequire\(|\b__dirname\b|\bimport\.meta\.dirname\b|\b(?:fetch|process|require|crypto)\b|Date\.now|setTimeout|setInterval|new Date\(/;

const SECRET_IMPORTERS: readonly string[] = ["adapters/vault-age.ts", "adapters/vault-file.ts", "adapters/vault.ts", "compose.ts"];

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("connections application architecture", () => {
  const sources = readdirSync(APP).filter(name => name.endsWith(".ts"));

  it("imports only the domain, the protocol and siblings", () => {
    expect(sources.length).toBeGreaterThan(0);
    const bad = sources.flatMap(name => offending(readFileSync(join(APP, name), "utf8")).map(spec => `${name} -> ${spec}`));
    expect(bad).toEqual([]);
  });

  it("catches node:fs, an adapter import and a Node global", () => {
    expect(offending(`import { readFileSync } from "node:fs";`)).toEqual(["node:fs"]);
    expect(offending(`import { SecretMaterial } from "../adapters/secret-material.ts";`)).toEqual(["../adapters/secret-material.ts"]);
    expect(`if (process.env.X) {}`).toMatch(NODE_GLOBALS);
    expect(`Date.now()`).toMatch(NODE_GLOBALS);
    expect(`new Date(0)`).toMatch(NODE_GLOBALS);
    expect(`// a comment`).not.toMatch(NODE_GLOBALS);
  });

  it("uses no Node global and no ambient I/O", () => {
    for (const name of sources) expect(readFileSync(join(APP, name), "utf8"), name).not.toMatch(NODE_GLOBALS);
  });

  it("only the fixed list imports the plaintext type", () => {
    const importers = filesUnder(SRC).filter(path => importsOf(readFileSync(path, "utf8")).some(spec => spec.includes("secret-material")));
    expect(importers.map(path => path.slice(SRC.length + 1)).sort()).toEqual([...SECRET_IMPORTERS].sort());
    const planted = offending(`import { SecretMaterial } from "../adapters/secret-material.ts";`);
    expect(planted.length).toBeGreaterThan(0);
    const material = new SecretMaterial(new Uint8Array([1]));
    expect(material.bytes()).toEqual(new Uint8Array([1]));
    expect(JSON.stringify(material)).toBe('"[secret]"');
    expect(String(material)).toBe("[secret]");
  });

  it("no other app imports this one", () => {
    const hits = otherApps().filter(path => /@morndo\/connections|apps\/connections/.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
    expect(`import { x } from "@morndo/connections";`).toMatch(/@morndo\/connections/);
  });
});

function otherApps(): string[] {
  const apps = join(ROOT, "apps");
  const found: string[] = [];
  for (const name of readdirSync(apps)) {
    if (name === "connections") continue;
    const src = join(apps, name, "src");
    try { found.push(...filesUnder(src)); } catch { /* an app with no src */ }
  }
  return found;
}
