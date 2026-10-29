// memory.sync (ADR-0031; docs/design/memory/README.md, "The node's memory.sync"): Memory's skill files for this node, in
// parts. Each part is staged as <memory>/staging/<version>/part-<n>.json. Once every part of a version is there, the
// version is committed: each skill goes to the managed folder <memory>/skills/<name>/SKILL.md, then into every directory
// of the policy's memory.skillDirs as <dir>/<name>/SKILL.md, beside a marker file .morndo-memory that holds the version.
// Then every morndo-mem-* folder that carries the marker and is not in the version is removed.
// - What the node owns is what carries its marker. An empty folder holds nothing of anyone's, so it is taken too (it is
//   what a crash between making a folder and marking it leaves). A folder of the same name with anything else in it is
//   someone else's: it is left as it is and named in `conflicts`.
// - Nothing follows a symbolic link: each folder and file is looked at with lstat, read with O_NOFOLLOW and replaced by a
//   rename, which replaces a link instead of writing through it. A link where a skill folder would be is a conflict.
// - Every file is written whole or not at all (atomic-write.ts).
// FL14: no command, no path. The names were checked against MEMORY_SKILL_NAME (args.ts, OP_ARGS), so each is one folder
// name under the directory, never a path out of it.
// <memory> is the memory/ folder of the node's state directory (paths.ts), beside agent.db and the upload inbox, under the
// deny root that keeps file.* out of the node's own state.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS, type OpArgs } from "@morndo/protocol";
import { writeFileAtomic, writeFileAtomicAsync } from "../atomic-write.ts";
import { CHECK } from "./args.ts";
import { effect, fail, ok, type OpTable } from "./executor.ts";

export const MEMORY_MARKER = ".morndo-memory";
const PREFIX = "morndo-mem-";
const PART_FILE = /^part-(\d{1,2})\.json$/;
// A version of which some parts never came is kept as long as their done keys may be (LIMITS.doneKeyTtlMs, and a day
// for the housekeeping that prunes them): a repeat under the same key answers its stored outcome without staging the
// part again, so a part removed sooner would never come back.
const PARTIAL_KEEP_MS = LIMITS.doneKeyTtlMs + 86_400_000;
// The answer stays far below LIMITS.maxMessageBytes however many folders clash.
const CONFLICTS_MAX = 100;

type Part = OpArgs["memory.sync"];
type SkillFile = Part["files"][number];
type Placed = { written: number; removed: number; conflicts: string[] };

export type MemoryDeps = {
  root: string;                          // <memory>: paths.memoryDir
  skillDirs: readonly string[];          // absolute (skillDirsOf)
  now?: () => number;                    // the clock staging folders' times are compared with
};

// The policy's skill directories as this node writes them: "~/" is the node user's home (config.home, from $HOME), and
// what follows it stays under it ("~//etc" too); every other entry is absolute (config.ts, parsePolicy). A directory named
// twice, a trailing "/" or not, is written once.
export function skillDirsOf(dirs: readonly string[], home: string): string[] {
  return [...new Set(dirs.map(d => resolve(d.startsWith("~/") ? join(home, d.slice(2)) : d)))];
}

// What lstat says, or null when nothing is there.
function look(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

const list = (dir: string): string[] => (look(dir)?.isDirectory() ? readdirSync(dir) : []);

// A regular file's text, or null: nothing there, a link (O_NOFOLLOW refuses it), or anything else that is not a file.
// O_NONBLOCK, so a named pipe left in its place never blocks the op.
function readOwn(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try { return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null; }
  finally { closeSync(fd); }
}

// The folder carries the node's marker, as a regular file.
const ours = (folder: string): boolean => look(join(folder, MEMORY_MARKER))?.isFile() === true;

// The parts of one version staged so far, by number. A file that does not read as a part of this version is left out,
// as if it never came.
function stagedParts(dir: string, version: string): Map<number, Part> {
  const parts = new Map<number, Part>();
  for (const name of list(dir)) {
    const m = PART_FILE.exec(name);
    const text = m ? readOwn(join(dir, name)) : null;
    if (!m || text === null) continue;
    let p: Part | null = null;
    try { p = CHECK["memory.sync"](JSON.parse(text)); } catch { /* not JSON */ }
    if (p && p.version === version && p.part === Number(m[1])) parts.set(p.part, p);
  }
  return parts;
}

// One skill directory: each skill written where the node owns its folder or nobody does, then every folder of Memory's
// that the version no longer has removed. A file that already holds the same text is not written again.
function place(dir: string, files: readonly SkillFile[], version: string): Placed {
  const placed: Placed = { written: 0, removed: 0, conflicts: [] };
  // Made when missing. The owner's directory may itself be a link (a dotfiles checkout): the owner named it. One that is
  // not a directory, or can't be made, is left as it is, and named.
  try { mkdirSync(dir, { recursive: true }); if (!statSync(dir).isDirectory()) return { ...placed, conflicts: [dir] }; }
  catch { return { ...placed, conflicts: [dir] }; }
  for (const f of files) {
    const folder = join(dir, f.name);
    const st = look(folder);
    if (st === null) mkdirSync(folder);
    else if (!st.isDirectory() || !(ours(folder) || readdirSync(folder).length === 0)) { placed.conflicts.push(folder); continue; }
    // The marker first: a folder that holds a skill is always marked as the node's.
    const marker = join(folder, MEMORY_MARKER);
    if (readOwn(marker) !== version) writeFileAtomic(marker, version, 0o644);
    const skill = join(folder, "SKILL.md");
    if (readOwn(skill) !== f.content) { writeFileAtomic(skill, f.content, 0o644); placed.written++; }
  }
  const keep = new Set(files.map(f => f.name));
  for (const name of list(dir)) {
    if (!name.startsWith(PREFIX) || keep.has(name)) continue;
    const folder = join(dir, name);
    if (!look(folder)?.isDirectory() || !ours(folder)) continue;          // a link, or someone else's: left as it is
    rmSync(folder, { recursive: true, force: true });                      // unlinks a link inside, never follows it
    placed.removed++;
  }
  return placed;
}

// After a commit, only the committed version's staging is kept (it lets the same version commit again): a version that
// came whole was committed then and goes, and one still missing parts goes once its done keys may be gone.
function pruneStaging(staging: string, version: string, now: number): void {
  for (const v of list(staging)) {
    if (v === version) continue;
    const dir = join(staging, v);
    const parts = stagedParts(dir, v);
    const first = parts.values().next().value;
    const whole = first !== undefined && parts.size === first.parts;
    if (whole || (look(dir)?.mtimeMs ?? 0) < now - PARTIAL_KEEP_MS) rmSync(dir, { recursive: true, force: true });
  }
}

export function memoryOps(d: MemoryDeps): Pick<OpTable, "memory.sync"> {
  const now = d.now ?? Date.now;
  const staging = join(d.root, "staging");
  const managed = join(d.root, "skills");
  return {
    // One queue for every version: parts are staged, and versions committed, one at a time.
    "memory.sync": effect(() => "memory", async (a, ctx) => {
      const names = new Set(a.files.map(f => f.name));
      if (names.size !== a.files.length) return fail("bad_args", "a skill is named twice in this part");
      const dir = join(staging, a.version);
      const staged = stagedParts(dir, a.version);
      for (const [n, p] of staged) {
        if (n === a.part) continue;
        if (p.parts !== a.parts) return fail("bad_args", `this version came in ${p.parts} parts before, not ${a.parts}`);
        if (p.files.some(f => names.has(f.name))) return fail("bad_args", "a skill is named in two parts of this version");
      }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      await writeFileAtomicAsync(join(dir, `part-${a.part}.json`), JSON.stringify(a));   // its fsync off the loop (T-532)
      staged.set(a.part, a);
      const skillDirs = [...d.skillDirs];
      // Every part's number is below `parts` (OP_ARGS), and every staged part has the same `parts`: a full count is every
      // part.
      if (staged.size < a.parts) return ok<"memory.sync">({ committed: false, written: 0, removed: 0, skillDirs, conflicts: [] });
      const files = [...staged.keys()].sort((x, y) => x - y).flatMap(n => staged.get(n)?.files ?? []);
      // The managed folder is the node's own copy: its clashes are reported, its writes are not counted.
      const conflicts = place(managed, files, a.version).conflicts;
      let written = 0;
      let removed = 0;
      for (const skillDir of skillDirs) {
        const p = place(skillDir, files, a.version);
        written += p.written;
        removed += p.removed;
        conflicts.push(...p.conflicts);
      }
      pruneStaging(staging, a.version, now());
      return ok<"memory.sync">({ committed: true, written, removed, skillDirs, conflicts: conflicts.slice(0, CONFLICTS_MAX) });
    }),
  };
}
