// The throwaway-machine run's own judgements, kept apart so they are tested on their own (checks.test.ts): which
// leftover scratch a run may remove, the number a scratch migration takes, whether the recovery unit ran, whether an
// apply said the disk was full. Node built-ins only: scenario.ts imports this inside the machine, under the A tree's
// own Node, beside it in the bundle.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** build.ts's scratch: mkdtemp's prefix and its six random characters, nothing longer or shorter. */
export const SCRATCH_NAME = /^morndo-c2-build-[A-Za-z0-9]{6}$/;

/** Removes the build scratch a killed run left in `dir` and answers what it removed. A kept scratch (`keep`, from
 *  E2E_KEEP=1) is a person's to read and stays; only a real directory named exactly as the build makes them is
 *  removed; a failure to remove one is said through `say`, never thrown. One run at a time on a machine. */
export function sweepScratch(dir: string, o: { keep: boolean; say: (line: string) => void }): string[] {
  if (o.keep) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir).filter(n => SCRATCH_NAME.test(n))) {
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      o.say(`removed the build scratch a killed run left behind (${name})`);
    } catch (error) {
      o.say(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

/** The number a scratch migration takes in the hub's migrations.ts text: one past the highest it holds. */
export function nextMigration(text: string): number {
  const numbers = [...text.matchAll(/^\s+version: (\d+),$/gm)].map(m => Number(m[1]));
  if (numbers.length === 0) throw new Error("migrations.ts: no migration numbers found");
  return Math.max(...numbers) + 1;
}

/** Whether the recovery unit ran to its end, from its user-journal lines (`journalctl -o cat`) since a moment: it
 *  started, it finished, and nothing says it failed. systemd unloads an inactive unit, so its properties alone can
 *  read as defaults; the journal is the unit's own record. */
export function recoverUnitRan(journal: string): boolean {
  return /Starting morndo-update-recover\.service/.test(journal) && /Finished morndo-update-recover\.service/.test(journal)
    && !/morndo-update-recover\.service: (Failed|Main process exited, code=exited, status=[1-9])/.test(journal);
}

/** Whether an apply unit's line says the hub's backup failed because the disk was full (SQLite's words, or the
 *  kernel's), not for any other reason. */
export function saysDiskFull(line: string): boolean {
  return line.includes("Not applied: hub:") && /disk is full|SQLITE_FULL|ENOSPC/i.test(line);
}
