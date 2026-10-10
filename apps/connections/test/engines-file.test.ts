import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileEngines, lockOwner } from "../src/adapters/engines-file.ts";
import { copyCommand } from "../src/application/ports.ts";
import { run } from "../src/cli.ts";

describe("engine file", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("refuses a damaged file instead of treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    writeFileSync(path, "{", { mode: 0o600 });
    const engines = new FileEngines(path);
    expect(() => engines.mark("credit", "model missing", 1)).toThrow(/Move it aside as a backup.*morndo-keys engines reset/s);
    expect(readFileSync(path, "utf8")).toBe("{");
  });

  it("refuses a partial object field by field", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    writeFileSync(path, JSON.stringify({ marks: {} }), { mode: 0o600 });
    expect(() => new FileEngines(path).mark("credit", "model missing", 1)).toThrow(/marks must be a list/);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ marks: {} }));
    writeFileSync(path, JSON.stringify({ providers: [], marks: [], chains: [] }), { mode: 0o600 });
    new FileEngines(path).mark("credit", "model missing", 1);
    expect(new FileEngines(path).marks()).toEqual([{ name: "credit", reason: "model missing", until: 1 }]);
  });

  it("backs up a damaged engines file on reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    writeFileSync(path, "{", { mode: 0o600 });
    const code = await run(["engines", "reset"], { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file" }, { stdout() {}, stderr() {} });
    expect(code).toBe(0);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("{");
    expect(existsSync(path)).toBe(false);
  });

  it("breaks a lock whose owner is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2147483646, started: "1" }), { mode: 0o600 });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      new FileEngines(path, { lockWaitMs: 40 }).mark("credit", "model missing", 1);
    } finally { console.warn = warn; }
    writeFileSync(`${path}.lock`, JSON.stringify({ ...lockOwner(), started: "0" }), { mode: 0o600 });
    new FileEngines(path, { lockWaitMs: 40 }).mark("other", "reused", 2);
    expect(warnings.join("\n")).toContain("stale");
    expect(new FileEngines(path).marks().map(mark => mark.name).sort()).toEqual(["credit", "other"]);
  });

  it("stops waiting when a live owner keeps the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    writeFileSync(`${path}.lock`, JSON.stringify(lockOwner()), { mode: 0o600 });
    expect(() => new FileEngines(path, { lockWaitMs: 30 }).mark("credit", "held", 1)).toThrow(/held/);
  });

  it("keeps both marks when two processes write together", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-"));
    dirs.push(dir);
    const path = join(dir, "engines.json");
    const fixture = join(import.meta.dirname, "fixtures/mark-engine.ts");
    const run = (name: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture, path, name]);
      let err = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { err += chunk; });
      child.on("close", code => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)));
    });
    await Promise.all([run("credit"), run("other")]);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { marks: { name: string }[] };
    expect(saved.marks.map(mark => mark.name).sort()).toEqual(["credit", "other"]);
  });

  it("copies a command once, keeping a string a string", () => {
    const original = ["gate", "bin"];
    const copied = copyCommand(original);
    expect(copied).toEqual(["gate", "bin"]);
    expect(copied).not.toBe(original);
    expect(copyCommand("gate bin")).toBe("gate bin");
    expect(copyCommand(null)).toBeNull();
    const sources = ["engines-file.ts", "engines-bin.ts"].map(name => readFileSync(join(import.meta.dirname, "../src/adapters", name), "utf8"));
    sources.push(readFileSync(join(import.meta.dirname, "../src/application/fakes.ts"), "utf8"));
    for (const source of sources) {
      expect(source).toContain("copyCommand(");
      expect(source).not.toMatch(/typeof \w+ === "string" \? \w+ : \[\.\.\.\w+\]/);
    }
  });
});
