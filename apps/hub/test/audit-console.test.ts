// `morndo audit` as a person runs it: the real console, a child process, with a temporary MORNDO_HOME. `--help` prints the
// usage; a bad argument gets one sentence and exit 2 (never a stack: the argument used to reach the SQL `LIMIT ?` as NaN,
// "SqliteError: datatype mismatch", T-423). Synthetic rows only; never the owner's hub or database.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morndo-audit-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function audit(args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "audit", ...args], {
    env: { PATH: process.env.PATH, HOME: home, MORNDO_HOME: home }, encoding: "utf8", timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("morndo audit: help", () => {
  it.each(["--help", "-h"])("%s prints the usage and exits 0", flag => {
    const r = audit([flag]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/usage: morndo audit \[count\]/);
    expect(r.err).toBe("");
  });
});

describe("morndo audit: bad arguments", () => {
  it.each(["--bogus", "abc", "0", "-3", "1.5", "NaN"])("%s is answered in one sentence, exit 2", arg => {
    const r = audit([arg]);
    expect(r.code, r.err).toBe(2);
    expect(r.err).toMatch(/^morndo audit: .*usage: morndo audit \[count\]\n$/);
    expect(r.err).not.toMatch(/SqliteError|\n\s+at /);
    expect(r.out).toBe("");
  });

  it("a second argument is refused the same way", () => {
    const r = audit(["5", "6"]);
    expect(r.code, r.err).toBe(2);
    expect(r.err).not.toMatch(/SqliteError|\n\s+at /);
  });
});

describe("morndo audit: listing", () => {
  it("prints the latest rows, oldest first, as many as asked", () => {
    const store = new Store(home);
    store.record([1, 2, 3].map(n => ({ type: "EndpointRevoked" as const, endpointId: endpointId(`e${n}`), at: n * 1000 })));
    store.close();
    const two = audit(["2"]);
    expect(two.code, two.err).toBe(0);
    const lines = two.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("e2");
    expect(lines[1]).toContain("e3");
    expect(audit([]).out.trim().split("\n")).toHaveLength(3);
  });
});
