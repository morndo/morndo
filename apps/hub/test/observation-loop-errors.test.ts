// The observation loop keeps running when the session registry can't be read: a session file that holds `null`, a
// `sessions` that isn't a directory, or one the hub may not read. The loop runs in a child process
// (observation-loop-errors.fixture.ts), so a hub that dies fails this test's own assertion.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-loop-"));
  mkdirSync(join(dir, "projects", "-tmp-demo"), { recursive: true });
  writeFileSync(join(dir, "projects", "-tmp-demo", "s1.jsonl"), JSON.stringify({
    type: "assistant", uuid: "a1", timestamp: "2026-10-01T08:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "tests pass" }] },
  }) + "\n");
});
afterEach(() => {
  try { chmodSync(join(dir, "sessions"), 0o755); } catch { /* not there */ }
  rmSync(dir, { recursive: true, force: true });
});

const live = JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/tmp/demo", version: "2.1.286", updatedAt: 1 });

function run() {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "observation-loop-errors.fixture.ts"), dir], { encoding: "utf8", timeout: 15_000 });
  const out = r.stdout.trim().split("\n").at(-1) ?? "";
  return { exit: r.status, ...(out.startsWith("{") ? JSON.parse(out) : { died: r.stderr.split("\n").find(l => /Error/.test(l)) ?? r.stderr.slice(0, 200) }) };
}

describe("a bad session registry doesn't stop the observation loop", () => {
  it("one session file holding `null`: later polls still update the workers, and the good session is followed", () => {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "1.json"), live);
    writeFileSync(join(dir, "sessions", "2.json"), "null");
    expect(run()).toEqual({ exit: 0, appeared: ["%1", "%2"], history: ["tests pass"] });
  });
  it("`sessions` is a file (ENOTDIR): later polls still update the workers", () => {
    writeFileSync(join(dir, "sessions"), "");
    expect(run()).toEqual({ exit: 0, appeared: ["%1", "%2"], history: [] });
  });
  it.skipIf(process.getuid?.() === 0)("`sessions` can't be read (EACCES): later polls still update the workers", () => {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "1.json"), live);
    chmodSync(join(dir, "sessions"), 0o000);
    expect(run()).toEqual({ exit: 0, appeared: ["%1", "%2"], history: [] });
  });
});
