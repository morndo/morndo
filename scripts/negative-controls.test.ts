// The runner's own classification (scripts/negative-controls.ts, classify): a control bites only when vitest reports a failed
// test and no breakage. The outputs are vitest 5.0.3's, as it prints them (colors off). And a control marked for one
// platform: skipped elsewhere, a fifth outcome that is never a bite or a pass.
import { describe, expect, it } from "vitest";
import { CONTROLS, check, classify, needs, parseShard, shardOf, verdict, type Control } from "./negative-controls.ts";

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

// The weekly workflow runs the controls as a matrix of shards (T-467): one serial run of 1478 controls passed its 90 minutes.
describe("--shard i/n", () => {
  const c = (id: string, ...run: string[]): Control => ({ id, task: "0", file: "f.ts", find: "a", replace: "b", run });
  it("parses i/n and refuses anything else", () => {
    expect(parseShard("2/6")).toEqual({ index: 2, count: 6 });
    for (const bad of ["0/6", "7/6", "1/0", "a/b", "2", "1/2/3", "-1/2", "1.5/2", ""]) expect(parseShard(bad), bad).toBeNull();
  });
  it("every control lands in exactly one shard, in the order the registry has them", () => {
    const all = [c("a", "x"), c("b", "y"), c("c", "x"), c("d", "z"), c("e", "y"), c("f", "w")];
    const shards = [1, 2, 3].map(i => shardOf(all, i, 3));
    expect(shards.flat().map(x => x.id).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    for (const sh of shards) expect(sh.map(x => all.indexOf(x))).toEqual([...sh.map(x => all.indexOf(x))].sort((p, q) => p - q));
  });
  it("controls that run the same test files stay together, so each shard runs a file set's unchanged baseline once", () => {
    const all = [c("a", "x", "y"), c("b", "z"), c("c", "y", "x"), c("d", "z"), c("e", "w")];
    const home = (id: string) => [1, 2, 3].find(i => shardOf(all, i, 3).some(x => x.id === id));
    expect(home("a")).toBe(home("c"));
    expect(home("b")).toBe(home("d"));
  });
  it("the real registry splits into shards that differ in size by little, and shard 1/1 is all of it", () => {
    const sizes = [1, 2, 3, 4, 5, 6].map(i => shardOf(CONTROLS, i, 6).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(CONTROLS.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(CONTROLS.length * 0.05);
    expect(shardOf(CONTROLS, 1, 1)).toEqual(CONTROLS);
  });
});
