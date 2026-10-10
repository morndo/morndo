// file.* uses the same deny config as lane.start (CLAUDE_CONFIG_DIR, ENGINES_CONFIG). Synthetic directories only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeOpener } from "../src/ops/node-files.ts";

let base = "";
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ["CLAUDE_CONFIG_DIR", "ENGINES_CONFIG"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (base) rmSync(base, { recursive: true, force: true });
});

describe("node file reads", () => {
  it("refuses a Claude config file and an engines directory the way a lane start does", async () => {
    base = mkdtempSync(join(tmpdir(), "morndo-node-files-"));
    saved.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
    saved.ENGINES_CONFIG = process.env.ENGINES_CONFIG;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.ENGINES_CONFIG;
    const claude = join(base, "claude");
    const eng = join(base, "eng");
    mkdirSync(claude);
    mkdirSync(eng);
    writeFileSync(join(claude, "sessions.json"), "x");
    writeFileSync(join(eng, "engines.json"), "x");
    writeFileSync(join(eng, "notes.json"), "x");
    const open = nodeOpener({ home: base, stateDir: join(base, "state"), configDir: join(base, "node-cfg") });
    const allowed = await open(join(claude, "sessions.json"));
    expect(allowed.ok).toBe(true);
    if (allowed.ok) await allowed.fh.close();
    process.env.CLAUDE_CONFIG_DIR = claude;
    expect(await open(join(claude, "sessions.json"))).toEqual({ ok: false, reason: "denied" });
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.ENGINES_CONFIG = join(eng, "engines.json");
    expect(await open(join(eng, "notes.json"))).toEqual({ ok: false, reason: "denied" });
  });
});
