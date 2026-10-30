// The run-scratch globalSetup's teardown (test/run-scratch.ts): the scratch dir always goes, and a run whose
// tests left a morndo-* entry of their own in it fails naming each (entries like node-compile-cache are not theirs).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "../test/run-scratch.ts";

describe("the run-scratch teardown", () => {
  let parent: string;

  beforeEach(() => { parent = mkdtempSync(join(tmpdir(), "rs-")); });
  afterEach(() => { rmSync(parent, { recursive: true, force: true }); });

  const scratch = () => {
    const dir = join(parent, `morndo-test-${process.pid}-abcd1234-units`);
    const teardown = setup({ config: { env: { TMPDIR: dir } } } as unknown as TestProject);
    return { dir, teardown };
  };

  it("removes the project's scratch dir and passes when the tests left nothing of their own", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "node-compile-cache"));
    expect(() => teardown()).not.toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("passes when something already removed the dir", () => {
    const { dir, teardown } = scratch();
    rmSync(dir, { recursive: true });
    expect(() => teardown()).not.toThrow();
  });

  it("removes the dir and fails naming each morndo-* entry the tests left behind", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "morndo-wrap-x"));
    mkdirSync(join(dir, "morndo-job-sock-y"));
    mkdirSync(join(dir, "other"));
    let message = "";
    try { teardown(); } catch (e) { message = String(e); }
    expect(message).toContain("morndo-wrap-x");
    expect(message).toContain("morndo-job-sock-y");
    expect(message).not.toContain("other");
  });

  it("names a morndo-codex-run-* and a morndo-tx-* leftover too: the two once let through as intermittent are traced and fixed", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "morndo-codex-run-aB3dE9"));
    mkdirSync(join(dir, "morndo-tx-aB3dE9"));
    let message = "";
    try { teardown(); } catch (e) { message = String(e); }
    for (const name of ["morndo-codex-run-aB3dE9", "morndo-tx-aB3dE9"]) expect(message).toContain(name);
    expect(existsSync(dir)).toBe(false);
  });

  it("removes the dir even when it cannot be listed", () => {
    const { dir, teardown } = scratch();
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "not a directory");
    expect(() => teardown()).toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  it("still removes the dir when it fails", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "morndo-wrap-x"));
    expect(() => teardown()).toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
