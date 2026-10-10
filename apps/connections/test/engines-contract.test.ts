import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliEngines } from "../src/adapters/engines-bin.ts";
import { FileEngines } from "../src/adapters/engines-file.ts";
import type { EngineSettings } from "../src/application/ports.ts";

const standIn = join(import.meta.dirname, "fixtures/engines-cli.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cleared(risk: readonly string[] | null | undefined): boolean {
  return risk == null || risk.length === 0;
}

function riskOf(engines: EngineSettings): readonly string[] | null | undefined {
  return engines.chains().find(row => row.role === "review")?.risk;
}

function contract(open: () => EngineSettings): void {
  const engines = open();
  engines.setChain("review", ["credit:sonnet-5.5@high"], ["credit:opus-5.5@high"]);
  engines.setChain("review", ["credit:sonnet-5.5@high"], null);
  expect(engines.chains().find(row => row.role === "review")?.chain).toEqual(["credit:sonnet-5.5@high"]);
  expect(cleared(riskOf(engines))).toBe(true);
  engines.setChain("review", ["credit:sonnet-5.5@high"], ["credit:opus-5.5@high"]);
  engines.setChain("review", ["credit:sonnet-5.5@high"], []);
  expect(cleared(riskOf(engines))).toBe(true);
  expect(riskOf(engines)).not.toEqual(["credit:opus-5.5@high"]);
}

describe("engine settings chain contract", () => {
  it("FileEngines clears a null or empty risk chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-file-engines-"));
    dirs.push(dir);
    contract(() => new FileEngines(join(dir, "engines.json")));
  });

  it("a chain write does not need --clear-risk when the role has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-old-engines-"));
    dirs.push(dir);
    const bin = join(dir, "old-engines.mjs");
    writeFileSync(bin, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const config = process.env.ENGINES_CONFIG;
const state = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : { roles: {} };
const args = process.argv.slice(2);
if (args.includes("--clear-risk")) { console.error("usage: engines set ROLE CHAIN"); process.exit(2); }
if (args[0] === "get") { console.log(JSON.stringify(state.roles)); process.exit(0); }
if (args[0] === "set") {
  const role = args[1];
  state.roles[role] ??= { chain: [] };
  if (args.includes("--risk")) state.roles[role].risk_chain = args[2].split(",");
  else state.roles[role].chain = args[2].split(",");
  writeFileSync(config, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
    chmodSync(bin, 0o755);
    const engines = new CliEngines(bin, { ...process.env, ENGINES_CONFIG: join(dir, "layer.json") });
    engines.setChain("review", ["credit:sonnet-5.5@high"], null);
    expect(engines.chains().find(row => row.role === "review")?.chain).toEqual(["credit:sonnet-5.5@high"]);
    engines.setChain("review", ["credit:sonnet-5.5@high"], ["credit:opus-5.5@high"]);
    engines.setChain("review", ["credit:m@high"], null);
    expect(engines.chains().find(row => row.role === "review")?.chain).toEqual(["credit:m@high"]);
  });

  it("CliEngines clears a null or empty risk chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-cli-engines-"));
    dirs.push(dir);
    const env = { ...process.env, ENGINES_CONFIG: join(dir, "layer.json") };
    contract(() => new CliEngines(standIn, env));
  });
});
