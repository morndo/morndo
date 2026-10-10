import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "../src/application/ports.ts";
import { ClaudeRuntime } from "../src/adapters/runtime-claude.ts";

const plan: RunPlan = {
  lease: "l1", connection: "credit", ref: "key-credit", configDir: null, model: "sonnet-5.5",
  effort: "high", workspace: tmpdir(), deny: [], reservation: 1, probe: false,
};

describe("runtime child", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("keeps output past the old buffer and a run past the old cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-child-"));
    dirs.push(dir);
    const script = join(dir, "child.mjs");
    writeFileSync(script, [
      "process.stdout.write(Buffer.alloc(1_500_000, 120));",
      "process.stderr.write('err-marker');",
      "await new Promise(resolve => setTimeout(resolve, 21_000));",
      "process.stdout.write('done');",
    ].join("\n"));
    const seen: string[] = [];
    const runtime = new ClaudeRuntime(script, "helper", process.env);
    const result = await runtime.execute({ ...plan, workspace: dir }, [], { onStdout: chunk => seen.push(chunk) });
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(1_000_000);
    expect(result.stdout.endsWith("done")).toBe(true);
    expect(result.stderr).toContain("err-marker");
    expect(seen.join("").length).toBeGreaterThan(1_000_000);
  }, 40_000);

  it("decodes a character split across chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-decode-"));
    dirs.push(dir);
    const script = join(dir, "child.mjs");
    writeFileSync(script, [
      "process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));",
      "await new Promise(resolve => setTimeout(resolve, 40));",
      "process.stdout.write(Buffer.from([0xa9]));",
    ].join("\n"));
    const seen: string[] = [];
    const runtime = new ClaudeRuntime(script, "helper", process.env);
    const result = await runtime.execute({ ...plan, workspace: dir }, [], { onStdout: chunk => seen.push(chunk) });
    expect(result.stdout).toBe("café");
    expect(seen.join("")).toBe("café");
    expect(seen.join("")).not.toContain("\uFFFD");
  });
});
