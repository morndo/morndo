// The previous build's migration runner (design docs/design/updates/README.md §13): packages/service-kit's migrate.ts
// as it is on this branch's base, loaded from git into a throwaway directory and imported from there. Until the first
// Release exists, "the previous build" is a build of the parent commit, and its runner is this one — which predates
// floors: the version alone is its rule, so it refuses any database above the list it is given, floor or not. The
// downgrade-contract tests use it instead of standing a previous build in with a prefix of today's list behind
// today's floor-aware runner, which would answer for a build that never shipped.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";

// The commit this branch grows from: the parent build the contract is made with. Update it when a branch is rebased.
export const PREVIOUS_RUNNER_BASE = "3b2fb22";

// The base runner's migration shape: today's Migration without the compat field, which it does not know.
export type PreviousMigration = { version: number; name: string; up(db: Database.Database): void };

export type PreviousRunner = (
  db: Database.Database, migrations: readonly PreviousMigration[], refuse: (found: number, known: number) => Error,
) => { from: number; to: number };

/** The previous build's migrate(), with a `done()` that drops the throwaway directory it was loaded from. */
export async function previousRunner(): Promise<{ migrate: PreviousRunner; done: () => void }> {
  const text = execFileSync("git", ["show", `${PREVIOUS_RUNNER_BASE}:packages/service-kit/src/migrate.ts`], { encoding: "utf8" });
  expectRealRunner(text);
  const dir = mkdtempSync(join(tmpdir(), "morndo-previous-runner-"));
  const file = join(dir, "previous-migrate.ts");
  writeFileSync(file, text);
  const loaded = await import(pathToFileURL(file).href) as { migrate: PreviousRunner };
  return { migrate: loaded.migrate, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// The base runner must be the floorless one; a wrong base (a commit that already writes floors) would quietly test
// today's rule against itself.
function expectRealRunner(text: string): void {
  if (text.includes("_morndo_schema") || !text.includes("if (first > known) throw refuse")) {
    throw new Error(`${PREVIOUS_RUNNER_BASE} is not a floorless migrate.ts; point PREVIOUS_RUNNER_BASE at the branch base`);
  }
}
