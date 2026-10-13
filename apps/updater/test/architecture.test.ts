// The updater's layers (ADR-0019; docs/design/updates/README.md §4.7, test 2): the application layer decides, the
// adapters touch the machine. So src/application imports only the domain, the protocol and its siblings, and uses no
// Node global; `node:crypto` has one door, the SSH-signature verifier; nothing in apps/updater imports
// @morndo/node-ops, which holds the tmux code — the updater must not touch tmux itself (RL13), and the tmux_in_unit
// check before every stop covers what a stop could do to it; and no other app imports the updater: the hub runs the
// program, as it runs the engines CLI (ADR-0013). Until apps/updater's first code lands (PR 4), these hold of no
// files; the negative controls below, and a planted import, are the proof they bite anyway.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const SRC = join(ROOT, "apps/updater/src");

// Every .ts file under a directory that exists (an app not yet born has none, and the checks hold of nothing).
const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
const under = (dir: string, suffix: string) => walk(dir).filter(f => relative(dir, f).startsWith(suffix));

const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? "");

// The application layer: the domain, the protocol, its siblings — and nothing else, no adapter, no Node.
const APP_LAYER_OK = /^(?:\.{1,2}\/[\w-]+\.ts|@morndo\/domain|@morndo\/protocol)$/;
export const applicationOffending = (code: string) => importsOf(code).filter(spec => !APP_LAYER_OK.test(spec));
// @morndo/node-ops holds the tmux code (RL13).
export const bannedImports = (code: string) => importsOf(code).filter(spec => spec === "@morndo/node-ops" || spec.startsWith("@morndo/node-ops/"));
// No other app imports the updater, by path or by its package name (every app is @morndo/<app>).
export const updaterImports = (code: string) => importsOf(code).filter(spec =>
  spec === "@morndo/updater" || spec.startsWith("@morndo/updater/")
  || /(^|\/)apps\/updater\//.test(spec) || /(^|\/)\.\.\/updater\//.test(spec.replace(/^\.\//, "")));
// One door for node:crypto (the verifier); other node:* modules are the adapters' and the CLI's to use.
export const cryptoImports = (code: string) => importsOf(code).filter(spec => spec === "node:crypto");
const NODE_GLOBALS = /\b(?:Buffer|process)\.\w|\bnew Buffer\b|\brequire\(|\b__dirname\b|\bimport\.meta\.dirname\b/;

describe("updater architecture (§4.7)", () => {
  const files = walk(SRC);
  const application = under(SRC, "application");
  const verifier = under(SRC, "adapters/verifier-sshsig.ts");

  it("src/application imports only the domain, the protocol and its siblings", () => {
    const bad = application.flatMap(f => applicationOffending(readFileSync(f, "utf8")).map(spec => `${relative(ROOT, f)} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("src/application uses no Node global", () => {
    for (const f of application) expect(readFileSync(f, "utf8"), relative(ROOT, f)).not.toMatch(NODE_GLOBALS);
  });
  it("nothing in apps/updater imports @morndo/node-ops (RL13)", () => {
    const here = walk(join(ROOT, "apps/updater"));
    const bad = here.flatMap(f => bannedImports(readFileSync(f, "utf8")).map(spec => `${relative(ROOT, f)} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("only the SSH-signature verifier imports node:crypto", () => {
    const bad = files.filter(f => !verifier.includes(f)).flatMap(f => cryptoImports(readFileSync(f, "utf8")).map(spec => `${relative(ROOT, f)} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("no other app imports apps/updater: the hub runs the program", () => {
    const others = readdirSync(join(ROOT, "apps"), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== "updater").flatMap(e => walk(join(ROOT, "apps", e.name, "src")));
    const bad = others.flatMap(f => updaterImports(readFileSync(f, "utf8")).map(spec => `${relative(ROOT, f)} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the checks catch what they forbid (negative controls)", () => {
    // Spelled in halves below so this file's own scanner doesn't read the samples as imports.
    const OPS = "@morndo/node-" + "ops";
    expect(applicationOffending(`import { openSync } from "node:fs";`)).toEqual(["node:fs"]);
    expect(applicationOffending(`import { tmux } from "${OPS}";`)).toEqual([OPS]);
    expect(applicationOffending(`import { p } from "../adapters/installer.ts";`)).toEqual(["../adapters/installer.ts"]);
    expect(applicationOffending(`import { admit } from "@morndo/domain";\nimport { f } from "./feed.ts";`)).toEqual([]);
    expect(applicationOffending(`import "../adapters/installer.ts";`)).toEqual(["../adapters/installer.ts"]);
    expect(bannedImports(`import { tmux } from "${OPS}";`)).toEqual([OPS]);
    expect(bannedImports(`import { x } from "${OPS}/tmux";`)).toEqual([`${OPS}/tmux`]);
    expect(cryptoImports(`import { createHash } from "node:crypto";`)).toEqual(["node:crypto"]);
    expect(cryptoImports(`import "node:crypto";`)).toEqual(["node:crypto"]);
    expect(updaterImports(`import { runUpdate } from "@morndo/updater";`)).toEqual(["@morndo/updater"]);
    expect(updaterImports(`import { x } from "@morndo/updater/run";`)).toEqual(["@morndo/updater/run"]);
    expect(updaterImports(`import { x } from "../../apps/updater/src/main.ts";`)).toEqual(["../../apps/updater/src/main.ts"]);
    expect(updaterImports(`import { x } from "@morndo/hub";`)).toEqual([]);
    expect(`const b = Buffer.from(s);`).toMatch(NODE_GLOBALS);
    expect(`if (process.env.X) {}`).toMatch(NODE_GLOBALS);
  });
});
