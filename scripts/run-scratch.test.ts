// The run-scratch globalSetup's teardown (test/run-scratch.ts): the scratch dir always goes, and a run whose
// tests left a morndo-* entry of their own in it fails naming each (entries like node-compile-cache are not theirs).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

  it("lets the two known intermittent leaks pass, and still names any other", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "morndo-codex-run-a1"));
    mkdirSync(join(dir, "morndo-tx-b2"));
    mkdirSync(join(dir, "morndo-new-c3"));
    let message = "";
    try { teardown(); } catch (e) { message = String(e); }
    expect(message).toContain("morndo-new-c3");
    expect(message).not.toContain("codex-run");
    expect(message).not.toContain("morndo-tx");
    expect(existsSync(dir)).toBe(false);
  });

  it("still removes the dir when it fails", () => {
    const { dir, teardown } = scratch();
    mkdirSync(join(dir, "morndo-wrap-x"));
    expect(() => teardown()).toThrow();
    expect(existsSync(dir)).toBe(false);
  });
});
