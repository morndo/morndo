import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliEngines } from "../src/adapters/engines-bin.ts";
import { FileEngines } from "../src/adapters/engines-file.ts";
import { MemoryEngines } from "../src/application/fakes.ts";
import { chainHolders } from "../src/application/providers.ts";

const outside = [
  { role: "review", chain: ["other:m"], risk: ["agy:gemini-2.5"] as readonly string[] | null },
  { role: "plan", chain: ["agy:gemini-2.5"], risk: null },
];
const standIn = join(import.meta.dirname, "fixtures/engines-cli.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("chain holders", () => {
  it("file, memory and the cli refuse a removal with the same roles", () => {
    expect(chainHolders(outside, "agy")).toEqual(["review", "plan"]);
    const held = `agy is still in ${chainHolders(outside, "agy").join(", ")}'s chain`;
    const mem = new MemoryEngines();
    for (const row of outside) mem.setChain(row.role, row.chain, row.risk);
    mem.putProvider({ name: "agy", enabled: true });
    expect(() => mem.removeProvider("agy")).toThrow(held);
    const dir = mkdtempSync(join(tmpdir(), "morndo-holders-"));
    dirs.push(dir);
    const file = new FileEngines(join(dir, "engines.json"));
    for (const row of outside) file.setChain(row.role, row.chain, row.risk);
    file.putProvider({ name: "agy", enabled: true });
    expect(() => file.removeProvider("agy")).toThrow(held);
    const cli = new CliEngines(standIn, { ...process.env, ENGINES_CONFIG: join(dir, "layer.json") });
    for (const row of outside) cli.setChain(row.role, [...row.chain], row.risk);
    expect(chainHolders(cli.chains(), "agy").sort()).toEqual(["plan", "review"]);
    expect(() => cli.removeProvider("agy")).toThrow(`agy is still in ${chainHolders(cli.chains(), "agy").join(", ")}'s chain`);
  });
});
