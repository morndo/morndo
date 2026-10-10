import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "../src/application/ports.ts";
import { ClaudeRuntime } from "../src/adapters/runtime-claude.ts";
import { CodexRuntime } from "../src/adapters/runtime-codex.ts";

const plan: RunPlan = {
  lease: "l1", connection: "credit", ref: "key-credit", configDir: null, model: "sonnet-5.5",
  effort: "high", workspace: tmpdir(), deny: [], reservation: 1, probe: false,
};

describe("runtime launch", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("awaits a missing binary and names it", async () => {
    const claude = new ClaudeRuntime("/no/such/morndo-runtime", "helper", process.env);
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-"));
    dirs.push(dir);
    const codex = new CodexRuntime({
      bin: "/no/such/morndo-codex", profilePath: join(dir, "missing.toml"), configDir: dir,
      command: "helper", args: [], baseUrl: "http://127.0.0.1", parent: process.env,
    });
    const unhandled: unknown[] = [];
    const note = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", note);
    try {
      await expect(claude.launch(plan)).rejects.toThrow(/not on PATH/);
      await expect(codex.launch({ ...plan, workspace: dir })).rejects.toThrow(/not on PATH/);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", note); }
  });
});
