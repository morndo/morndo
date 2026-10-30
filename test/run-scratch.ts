// A project's own scratch directory in a run (vitest.config.ts, ramScratch:
// TMPDIR=$XDG_RUNTIME_DIR/morndo-test-<pid>-<random>-<project>), as that project's globalSetup: made before its first
// test, removed after its last with whatever the tests left in it, whether they passed or not. Each project removes
// only its own, so the order Vitest runs teardowns in doesn't matter. A run killed before its teardown leaves its
// directories; the next run removes those whose process is gone. The teardown also fails the run
// when the tests left a morndo-* entry of their own in it, naming each.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TestProject } from "vitest/node";

const OURS = /^morndo-test-(\d+)-[0-9a-f]+(?:-[a-z]+)?$/;

export default function setup(project: TestProject): () => void {
  const dir = project.config.env.TMPDIR;
  if (typeof dir !== "string" || !OURS.test(basename(dir))) return () => {};
  for (const name of readdirSync(dirname(dir))) {
    const pid = Number(OURS.exec(name)?.[1] ?? 0);
    if (pid > 0 && pid !== process.pid && !alive(pid)) rmSync(join(dirname(dir), name), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return () => {
    try {
      const theirs = (existsSync(dir) ? readdirSync(dir) : []).filter(name => name.startsWith("morndo-"));
      if (theirs.length > 0) throw new Error(`tests must remove the temp dirs they make, but left: ${theirs.join(", ")}`);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

// EPERM: a process of another user holds the pid, so the directory may still be in use.
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as { code?: string }).code === "EPERM"; }
}
