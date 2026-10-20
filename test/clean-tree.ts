// A project's globalSetup (vitest.config.ts): the untracked files of the repository before the run's first test, and after its last,
// when it fails the run if the tests left new ones (scripts/clean-tree.ts).
import { watchTree } from "../scripts/clean-tree.ts";

export default function setup(): () => void {
  return watchTree(process.cwd());
}
