import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINES_MAX_OUTPUT, runEngines, runEnginesSync } from "../src/engines-spawn.ts";

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
  it("a stopped run is killed and settles only once its process is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-engines-stop-"));
    dirs.push(dir);
    const pidFile = join(dir, "pid");
    const stop = new AbortController();
    const t0 = performance.now();
    const run = runEngines(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 10000)`], process.env, stop.signal);
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) await new Promise(r => setTimeout(r, 10));
    stop.abort();
    await expect(run).rejects.toThrow(/was stopped/);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();          // gone, and reaped
    await expect(runEngines(process.execPath, ["-e", ""], process.env, stop.signal)).rejects.toThrow(/was stopped/);   // not started
  });
});
