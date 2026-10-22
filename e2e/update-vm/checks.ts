// The throwaway-machine run's own judgements, kept apart so they are tested on their own (checks.test.ts): whose
// run a leftover is, and which leftovers (scratch, containers) a run may remove (only a gone run's, never a live
// one's, so two runs on one box leave each other alone); the number a scratch migration takes; whether the recovery
// unit ran; whether an apply said the disk was full. Node built-ins only: scenario.ts imports this inside the
// machine, under the A tree's own Node, beside it in the bundle.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** build.ts's scratch: mkdtemp's prefix and its six random characters, nothing longer or shorter. */
export const SCRATCH_NAME = /^morndo-c2-build-[A-Za-z0-9]{6}$/;

/** A run of the harness, as a leftover names it: the process and its start time (proc(5), stat field 22), so a pid
 *  the kernel has given to another process since is not taken for the run. */
export type Owner = { pid: number; started: string };

// What /proc says of a process: its start time; "gone" only when its stat is not there (ENOENT); "unknown" when it
// cannot be read or parsed for any other reason (hidepid, another PID namespace on one Docker daemon) — never taken
// for gone, so a live run's leftovers are never swept on a guess.
function startedOf(pid: number, procRoot: string): string | "gone" | "unknown" {
  let stat: string;
  try { stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown"; }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);   // field 3 on; the comm may hold spaces
  const started = fields[19];                                                  // field 22
  return started !== undefined && /^\d+$/.test(started) ? started : "unknown";
}

export function ownerOf(pid: number, procRoot = "/proc"): Owner {
  const started = startedOf(pid, procRoot);
  return { pid, started: started === "gone" || started === "unknown" ? "" : started };
}
export const ownerText = (o: Owner): string => `${o.pid}:${o.started}`;
export function parseOwner(text: string): Owner | null {
  const m = /^(\d+):(\d+)$/.exec(text.trim());
  return m === null ? null : { pid: Number(m[1]), started: m[2]! };
}
/** Whether the run that owns a leftover may still run: that pid with that start time, or a process /proc will not
 *  show (unknown is kept). False only for a pid that is not there, or is another process now. */
export function ownerAlive(o: Owner, procRoot = "/proc"): boolean {
  const started = startedOf(o.pid, procRoot);
  if (started === "unknown") return true;
  return started !== "gone" && started === o.started;
}
// A leftover whose owner says nothing parseable (one from before owners were written) is a gone run's.
const gone = (owner: string, procRoot: string): boolean => {
  const o = parseOwner(owner);
  return o === null || !ownerAlive(o, procRoot);
};

/** A new build scratch in `dir`, owned from its first moment under the build's name: made under a name the sweep
 *  does not take (morndo-c2-new-…), its owner written, then renamed to morndo-c2-build-… with the same six
 *  characters. A sweep running meanwhile never sees it without its owner. `afterCreate` is the test's own moment. */
export function makeOwnedScratch(dir: string, owner: string, hooks: { afterCreate?: () => void } = {}): string {
  const made = mkdtempSync(join(dir, "morndo-c2-new-"));
  try {
    hooks.afterCreate?.();
    writeFileSync(join(made, "owner"), owner);
    const scratch = join(dir, `morndo-c2-build-${made.slice(made.length - 6)}`);
    renameSync(made, scratch);
    return scratch;
  } catch (error) {
    rmSync(made, { recursive: true, force: true });
    throw error;
  }
}

/** Removes the build scratch that runs which are gone left in `dir` (build.ts writes `owner` into each) and answers
 *  what it removed. A live run's scratch stays, whoever's it is; a kept scratch (`keep`, from E2E_KEEP=1) is a
 *  person's to read and stays; only a real directory named exactly as the build makes them is removed; a failure to
 *  remove one is said through `say`, never thrown. */
export function sweepScratch(dir: string, o: { keep: boolean; say: (line: string) => void; procRoot?: string }): string[] {
  if (o.keep) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir).filter(n => SCRATCH_NAME.test(n))) {
    const path = join(dir, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      let owner = "";
      try { owner = readFileSync(join(path, "owner"), "utf8"); } catch { /* no owner: a run from before owners */ }
      if (!gone(owner, o.procRoot ?? "/proc")) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
      o.say(`removed the build scratch a gone run left behind (${name})`);
    } catch (error) {
      o.say(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

/** The label each run puts on its container: whose it is (`ownerText`). */
export const OWNER_LABEL = "morndo-c2-e2e.owner";

/** Removes the labelled containers that runs which are gone left (`list` names each with its OWNER_LABEL value) and
 *  answers which. A live run's container stays; one with no owner (from before owners were labelled) is a gone run's. */
export function sweepContainers(o: {
  list: () => { id: string; owner: string }[]; remove: (id: string) => { ok: boolean; err: string };
  say: (line: string) => void; procRoot?: string;
}): string[] {
  const removed: string[] = [];
  for (const c of o.list()) {
    if (!gone(c.owner, o.procRoot ?? "/proc")) continue;
    const done = o.remove(c.id);
    o.say(`removed a container a gone run left behind (${c.id}): ${done.ok ? "ok" : done.err}`);
    if (done.ok) removed.push(c.id);
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
