import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINES_MAX_OUTPUT, runEnginesSync } from "../src/engines-spawn.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("engines spawn", () => {
  it("reports output past the buffer as a size error", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-buffer-"));
    dirs.push(dir);
    const script = join(dir, "big.mjs");
    writeFileSync(script, `process.stdout.write("x".repeat(${ENGINES_MAX_OUTPUT + 64}))\n`);
    expect(() => runEnginesSync(process.execPath, [script], process.env)).toThrow(/output exceeded/);
  });
});
