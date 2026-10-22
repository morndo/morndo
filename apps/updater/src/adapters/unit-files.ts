// The unit files a render places (§5), for both service managers: every file Morndo writes carries its mark, so a
// render replaces and removes only files that carry it. A file of the same name without the mark is someone
// else's — a unit a person wrote, or another tool's — and a render refuses it unless asked to replace it, and
// then keeps it beside the new one first.
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

const readOrNull = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

/** The paths among `names` that exist in the directory without Morndo's mark. */
export function foreignIn(d: UnitDir, names: readonly string[]): string[] {
  return names.map(n => join(d.dir, n)).filter(p => { const t = readOrNull(p); return t !== null && !d.marked(t); });
}

/** Where a replaced foreign file is kept: `<name>.before-morndo`, numbered when that is taken. */
const keepPath = (path: string): string => {
  let keep = `${path}.before-morndo`;
  for (let i = 1; existsSync(keep); i++) keep = `${path}.before-morndo.${i}`;
  return keep;
};

/** Writes each file whole (temp, rename), then removes the marked unit files that are not among them. A foreign
 *  file of a shipped name is refused before anything is written, or, with `replaceForeign`, copied aside first.
 *  Returns where each replaced foreign file was kept. */
export function placeUnits(d: UnitDir, files: readonly { name: string; text: string }[], replaceForeign: boolean): string[] {
  const foreign = foreignIn(d, files.map(f => f.name));
  if (foreign.length > 0 && !replaceForeign) throw new ForeignUnits(foreign);
  const kept = foreign.map(p => { const keep = keepPath(p); copyFileSync(p, keep); return keep; });
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
