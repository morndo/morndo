// The unit files a render places (§5), for both service managers: every file Morndo writes carries its mark, so a
// render replaces and removes only files that carry it. A file of the same name without the mark is either the
// setup before the updater — a service unit that runs Morndo's own program, written by hand or by an earlier
// install — which a render adopts once, keeping the old file beside the new one; or someone else's, which a render
// refuses unless asked to replace it, and then keeps it beside the new one first.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class ForeignUnits extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(`${paths.join(", ")}: not Morndo's (no mark of ours); nothing was rendered`);
    this.name = "ForeignUnits";
    this.paths = paths;
  }
}

export interface UnitDir {
  dir: string;
  /** Whether a file name in `dir` is one of the unit files this manager's renders own the name space of. */
  isUnit(name: string): boolean;
  /** Whether a file's text carries Morndo's mark. */
  marked(text: string): boolean;
  /** Whether an unmarked file is the setup before the updater: one of our service names running our own program. */
  legacy(name: string, text: string): boolean;
  /** What of an adopted legacy file must outlive it (its environment), as a file to write beside it, or null. */
  carry?(name: string, text: string): { path: string; text: string } | null;
}

const readOrNull = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

/** The paths among `names` that exist in the directory without Morndo's mark and are not the setup before it. */
export function foreignIn(d: UnitDir, names: readonly string[]): string[] {
  return names.filter(n => { const t = readOrNull(join(d.dir, n)); return t !== null && !d.marked(t) && !d.legacy(n, t); })
    .map(n => join(d.dir, n));
}

/** The paths among `names` that are the setup before the updater: adopted by the next render, kept aside once. */
const legacyIn = (d: UnitDir, names: readonly string[]): string[] =>
  names.filter(n => { const t = readOrNull(join(d.dir, n)); return t !== null && !d.marked(t) && d.legacy(n, t); })
    .map(n => join(d.dir, n));

/** Where a replaced foreign file is kept: `<name>.before-morndo`, numbered when that is taken. */
const keepPath = (path: string): string => {
  let keep = `${path}.before-morndo`;
  for (let i = 1; existsSync(keep); i++) keep = `${path}.before-morndo.${i}`;
  return keep;
};

/** Writes each file whole (temp, rename), then removes the marked unit files that are not among them. A foreign
 *  file of a shipped name is refused before anything is written, or, with `replaceForeign`, copied aside first; a
 *  legacy one is copied aside and adopted. Returns where each replaced file was kept. */
export function placeUnits(d: UnitDir, files: readonly { name: string; text: string }[], replaceForeign: boolean): string[] {
  const foreign = foreignIn(d, files.map(f => f.name));
  if (foreign.length > 0 && !replaceForeign) throw new ForeignUnits(foreign);
  const legacy = legacyIn(d, files.map(f => f.name));
  const kept = [...legacy, ...foreign].map(p => { const keep = keepPath(p); copyFileSync(p, keep); return keep; });
  // What an adopted unit set that the new one does not (its environment) goes beside it first, written whole; a
  // carried file already there with other words is kept, and this one takes the next free name.
  for (const p of legacy) {
    const carried = d.carry?.(basename(p), readFileSync(p, "utf8")) ?? null;
    if (carried === null) continue;
    mkdirSync(dirname(carried.path), { recursive: true });
    let to = carried.path;
    for (let i = 1; existsSync(to) && readFileSync(to, "utf8") !== carried.text; i++) to = carried.path.replace(/\.conf$/, `.${i}.conf`);
    const temp = `${to}.new`;
    writeFileSync(temp, carried.text);
    renameSync(temp, to);
  }
  for (const f of files) {
    // atomic like every updater write (§5): a whole file lands by rename, never half of one by a crash.
    // A leftover temp from a killed render is removed first, so it cannot keep an old mode through create.
    const temp = join(d.dir, `.${f.name}.new`);
    rmSync(temp, { force: true });
    writeFileSync(temp, f.text);
    renameSync(temp, join(d.dir, f.name));
  }
  const names = new Set(files.map(f => f.name));
  for (const name of readdirSync(d.dir)) {
    if (!d.isUnit(name) || names.has(name)) continue;
    const text = readOrNull(join(d.dir, name));
    if (text !== null && d.marked(text)) rmSync(join(d.dir, name));
  }
  return kept;
}
