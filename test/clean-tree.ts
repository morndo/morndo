// A project's globalSetup (vitest.config.ts): the project's scratch directory (test/run-scratch.ts) and the check that the tests left
// no new untracked files in the repository (scripts/clean-tree.ts), in one setup. When the check fails the run fails, and Vitest
// then skips the teardowns that come after it, so the scratch directory is removed in the same teardown, whether the check passes
// or not.
import type { TestProject } from "vitest/node";
import { watchTree } from "../scripts/clean-tree.ts";
import scratch from "./run-scratch.ts";

export default function setup(project: TestProject, root: string = process.cwd()): () => void {
  const removeScratch = scratch(project);
  const check = watchTree(root);
  return () => {
    try { check(); }
    finally { removeScratch(); }
  };
}
