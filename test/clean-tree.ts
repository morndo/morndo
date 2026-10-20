// A project's globalSetup (vitest.config.ts): the untracked files of the repository before the project's first test, and after its
// last, when it fails the run if the tests left new ones (scripts/clean-tree.ts). It runs in the project's teardown, so the files are
// named in the run's own output; the run's other results stand.
import { leftBehind, untrackedFiles } from "../scripts/clean-tree.ts";

export default function setup(): () => void {
  const before = untrackedFiles(process.cwd());
  return () => {
    const left = leftBehind(before, untrackedFiles(process.cwd()));
    if (left.length > 0) throw new Error(`the tests left files in the repository, in the directory they run in; they belong in a temporary one:\n  ${left.join("\n  ")}`);
  };
}
