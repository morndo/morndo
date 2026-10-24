// The runner's own classification (scripts/negative-controls.ts, classify): a control bites only when vitest reports a failed
// test and no breakage. The outputs are vitest 5.0.3's, as it prints them (colors off). And a control marked for one
// platform: skipped elsewhere, a fifth outcome that is never a bite or a pass.
import { describe, expect, it } from "vitest";
import { CONTROLS, check, classify, installDependencies, needs, spawnOutput, verdict, type Control } from "./negative-controls.ts";

const FAILED_TEST = [
  " RUN  v5.0.3 /repo", "", " FAIL  |units| packages/protocol/test/fleet.test.ts > messages > reads a code",
  "AssertionError: expected 'no' to be 'maybe'", "", " Test Files  1 failed (1)", "      Tests  1 failed | 25 passed (26)", "",
].join("\n");
const TRANSFORM = [
  " RUN  v5.0.3 /repo", "", " ❯ |units| packages/protocol/test/worker-id.test.ts (0 test)", "", "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯", "",
  " FAIL  |units| packages/protocol/test/worker-id.test.ts [ packages/protocol/test/worker-id.test.ts ]",
  "Error: Transform failed with 1 error:", "", "[PARSE_ERROR] Unexpected token", "", " Test Files  1 failed (1)", "      Tests  no tests", "",
].join("\n");
const NO_FILES = [" RUN  v5.0.3 /repo", "", "No test files found, exiting with code 1", "", "filter: packages/protocol/test/nonexistent.test.ts", ""].join("\n");

describe("classify: how a vitest run ended", () => {
  it("a failed test and nothing broken is a bite", () => {
    expect(classify(1, null, FAILED_TEST).kind).toBe("failed");
    expect(classify(1, null, "      Tests  2 failed (2)\n").kind).toBe("failed");
  });
  it("exit 0 is a pass", () => {
    expect(classify(0, null, " Test Files  1 passed (1)\n      Tests  7 passed (7)\n").kind).toBe("passed");
  });
  it("a transform error is broke, not a bite, and its first line is the error", () => {
    const r = classify(1, null, TRANSFORM);
    expect(r.kind).toBe("broke");
    expect(r.first).toBe("Error: Transform failed with 1 error:");
  });
  it("a failed suite is broke, even when some other test also failed", () => {
    expect(classify(1, null, `${TRANSFORM}\n${FAILED_TEST}`).kind).toBe("broke");
    expect(classify(1, null, "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n Test Files  1 failed (1)\n").kind).toBe("broke");
  });
  it("an import that fails to load is broke", () => {
    expect(classify(1, null, "Error: Failed to load url ../src/gone.ts (resolved id: ../src/gone.ts)\n Test Files  1 failed (1)\n      Tests  no tests\n").kind).toBe("broke");
  });
  it("vitest's \"No test files found\" is broke", () => {
    const r = classify(1, null, NO_FILES);
    expect(r.kind).toBe("broke");
    expect(r.first).toContain("No test files found");
  });
  it("a non-zero exit with no failed test is broke", () => {
    expect(classify(1, null, "something went wrong\n").kind).toBe("broke");
    expect(classify(1, null, "").kind).toBe("broke");
  });
  it("a test that asserts on a message with such words in it is still a bite", () => {
    const out = "AssertionError: expected 'SyntaxError: Cannot find module x (Transform failed)' to be 'ok'\n      Tests  1 failed | 3 passed (4)\n";
    expect(classify(1, null, out).kind).toBe("failed");
  });
  it("a timeout, and a run with no status or a signal, have no result: never a bite", () => {
    expect(classify(null, "SIGTERM", FAILED_TEST, true)).toMatchObject({ kind: "timeout", first: expect.stringContaining("no result within") });
    expect(classify(null, null, FAILED_TEST).kind).toBe("timeout");
    const killed = classify(null, "SIGKILL", FAILED_TEST);
    expect(killed.kind).toBe("timeout");
    expect(killed.first).toBe("killed by SIGKILL");
    expect(classify(1, "SIGKILL", FAILED_TEST).kind).toBe("timeout");
  });
});

describe("a control marked for one platform (platform)", () => {
  const linuxOnly: Control = { id: "x-linux-only", task: "x", file: "f.ts", find: "a", replace: "b", run: ["t.test.ts"], platform: "linux" };
  const anywhere: Control = { id: "x-anywhere", task: "x", file: "f.ts", find: "a", replace: "b", run: ["t.test.ts"] };
  it("is skipped on any other platform, and says which one it needs; an unmarked control runs everywhere", () => {
    expect(needs(linuxOnly, "darwin")).toBe("linux");
    expect(needs(linuxOnly, "win32")).toBe("linux");
    expect(needs(linuxOnly, "linux")).toBeNull();
    expect(needs(anywhere, "darwin")).toBeNull();
  });
  it("is never counted as bit or as passed: the summary lists the skipped apart, and the exit is 0 only when every applicable control bit", () => {
    expect(verdict({ bit: 236, passes: 0, broke: 0, timeout: 0, skipped: 1 }, 237))
      .toEqual({ line: "236/236 controls bit; still pass 0, broke 0, timed out 0, skipped 1", code: 0 });
    expect(verdict({ bit: 237, passes: 0, broke: 0, timeout: 0, skipped: 0 }, 237).code).toBe(0);
    expect(verdict({ bit: 235, passes: 1, broke: 0, timeout: 0, skipped: 1 }, 237))
      .toEqual({ line: "235/236 controls bit; still pass 1, broke 0, timed out 0, skipped 1", code: 1 });
    expect(verdict({ bit: 235, passes: 0, broke: 1, timeout: 0, skipped: 1 }, 237).code).toBe(1);
    expect(verdict({ bit: 235, passes: 0, broke: 0, timeout: 1, skipped: 1 }, 237).code).toBe(1);
    // Nothing applied here (--only a Linux control on darwin): nothing was shown to bite, so it is no success.
    expect(verdict({ bit: 0, passes: 0, broke: 0, timeout: 0, skipped: 1 }, 1))
      .toEqual({ line: "0/0 controls bit; still pass 0, broke 0, timed out 0, skipped 1", code: 1 });
  });
  it("--check still checks a skipped control's text, on every platform", () => {
    const procFd = CONTROLS.find(c => c.id === "t2-openconfined-proc-fd");
    if (!procFd) throw new Error("no t2-openconfined-proc-fd");
    // check() prints. A deliberate miss says STALE; left on stdout it looks like the CI step failed.
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(check([procFd])).toBe(0);
      expect(check([{ ...procFd, find: `${procFd.find} /* not in the file */` }])).toBe(1);
    } finally {
      process.stdout.write = write;
    }
    const out = lines.join("");
    expect(out).toContain("ok    t2-openconfined-proc-fd: found 1 time");
    expect(out).toContain("STALE t2-openconfined-proc-fd: found 0 times");
  });
  it("the Linux-only /proc/self/fd control is marked linux (it still runs on CI's weekly ubuntu run)", () => {
    expect(CONTROLS.find(c => c.id === "t2-openconfined-proc-fd")?.platform).toBe("linux");
  });
});

// The setup's error printer (T-433): `(ci.stdout + ci.stderr).trim()` threw "trim is not a function" when npm gave no text
// (null + null is 0), and that hid why `npm ci --offline` had failed.
const COLD = "npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/zod/-/zod-4.6.5.tgz failed: cache mode is 'only-if-cached' but no cached response is available.\n";
type Ran = { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null; error?: Error; signal?: NodeJS.Signals | null };
const fakeNpm = (...results: Ran[]) => {
  const calls: string[][] = [];
  const run = (_cmd: string, args: readonly string[]) => { calls.push([...args]); return (results[calls.length - 1] ?? { status: 1 }) as never; };
  return { run, calls };
};

describe("spawnOutput: what a finished process left to read", () => {
  it("is the last lines of stdout and stderr together", () => {
    const out = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(spawnOutput({ stdout: out, stderr: "boom\n" }, 3)).toBe("line 11\nline 12\nboom");
  });
  it("reads Buffers as text", () => {
    expect(spawnOutput({ stdout: Buffer.from("npm error code E404\n"), stderr: Buffer.from("") })).toBe("npm error code E404");
  });
  it("does not throw when there is no output at all (null, undefined), and is empty then", () => {
    expect(spawnOutput({ stdout: null, stderr: null })).toBe("");
    expect(spawnOutput({})).toBe("");
    expect(spawnOutput({ stdout: undefined, stderr: "only stderr" })).toBe("only stderr");
  });
  it("says why the process never ran, or how it was stopped", () => {
    expect(spawnOutput({ stdout: null, stderr: null, error: new Error("spawn npm ENOENT") })).toContain("spawn npm ENOENT");
    expect(spawnOutput({ stdout: null, stderr: null, signal: "SIGKILL" })).toContain("SIGKILL");
  });
});

describe("installDependencies: npm ci in the temporary worktree", () => {
  it("one offline ci when it works", () => {
    const npm = fakeNpm({ status: 0, stdout: "added 190 packages" });
    const r = installDependencies("/tmp/tree", npm.run);
    expect(r).toEqual({ ok: true, notes: [] });
    expect(npm.calls).toEqual([["ci", "--offline", "--no-audit", "--no-fund"]]);
  });
  it("a cold npm cache (ENOTCACHED) falls back to an online ci, and says so in one sentence with the command that warms it", () => {
    const npm = fakeNpm({ status: 1, stdout: "", stderr: COLD }, { status: 0, stdout: "added 190 packages" });
    const r = installDependencies("/tmp/tree", npm.run);
    expect(r.ok).toBe(true);
    expect(npm.calls).toEqual([["ci", "--offline", "--no-audit", "--no-fund"], ["ci", "--no-audit", "--no-fund"]]);
    expect(r.ok && r.notes).toHaveLength(1);
    expect(r.ok && r.notes[0]).toMatch(/cache is cold.*online.*npm ci/);
    expect(r.ok && r.notes[0]).not.toContain("\n");
  });
  it("a cold cache and no network prints the online ci's own error", () => {
    const npm = fakeNpm({ status: 1, stderr: COLD }, { status: 1, stderr: "npm error code ENOTFOUND\nnpm error network request failed\n" });
    const r = installDependencies("/tmp/tree", npm.run);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("ENOTFOUND");
    expect(!r.ok && r.message).toContain("npm ci");
  });
  it("any other offline failure is printed as npm said it, with no online retry", () => {
    const npm = fakeNpm({ status: 1, stdout: "", stderr: "npm error code EACCES\nnpm error permission denied, mkdir '/x'\n" });
    const r = installDependencies("/tmp/tree", npm.run);
    expect(npm.calls).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("EACCES");
    expect(!r.ok && r.message).toContain("/tmp/tree");
  });
  it("npm that never ran (no stdout, no stderr) is the error, not a TypeError", () => {
    const npm = fakeNpm({ status: null, stdout: null, stderr: null, error: new Error("spawn npm ENOENT") });
    const r = installDependencies("/tmp/tree", npm.run);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("spawn npm ENOENT");
  });
});
