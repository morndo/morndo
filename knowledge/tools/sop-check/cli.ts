// sop-check's command line (ADR-0026, K10 and K14). It reads an SOP, the skills installed beside the recurring-job skill,
// the notes in that skill's references and the engine layer's roles, and, when given, the user's preferences file and model
// snapshot directory, judges the SOP with the domain's checkSop, and prints one line per refusal or warning, then one per
// entry the preferences file left out or file that doesn't exist. Exit 0: passes. 1: refused. 2: a bad call, a file it
// can't read or that is missing while the SOP cites it, or anything unexpected, as one line. main.ts wires the real process; build.ts bundles both, and the domain's rules, into the skill's
// scripts/sop-check.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parsePreferences } from "../../../packages/domain/src/knowledge-facts.ts";
import { isDate } from "../../../packages/domain/src/knowledge-guards.ts";
import { checkSop, sopCitations, type CitationIndex } from "../../../packages/domain/src/knowledge.ts";
import { firstLine, readSnapshotFile } from "../shared.ts";

// The engine layer's default roles, as its `engines get --json` lists them (recorded in
// apps/hub/test/fixtures/engines-defaults.json; a test holds the two equal). Other roles come with --roles.
export const DEFAULT_ROLES: readonly string[] = ["plan", "implement-backend", "implement-ui", "implement-infra", "validate", "review", "research", "read-long", "images", "video"];

export type Io = { skillDir: string; out: (line: string) => void; err: (line: string) => void };
type Parse = (text: string) => unknown;

const USAGE = "usage: sop-check <sop.yaml> [--roles plan,review,...] [--today YYYY-MM-DD] [--preferences <preferences.yaml>] [--snapshots <models-dev cache dir>]";
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---/;

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// The yaml package, from the repository's node_modules or, in a copied skill, from its own (npm install there, once).
async function yamlParse(): Promise<Parse | null> {
  try {
    return ((await import("yaml")) as { parse: Parse }).parse;
  } catch {
    return null;
  }
}

// A YAML file's document, or the one line that says why not.
function readYaml(file: string, parse: Parse): { doc: unknown } | { line: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { line: `sop-check: can't read ${file}: ${firstLine(e)}` };
  }
  try {
    return { doc: parse(text) };
  } catch (e) {
    return { line: `sop-check: ${file} is not YAML: ${firstLine(e)}` };
  }
}

// Notes are the Markdown files in the skill's references whose front matter names a note; each has its re-check date.
function notesIn(dir: string, parse: Parse): Map<string, string> {
  const notes = new Map<string, string>();
  for (const f of existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".md")) : []) {
    const head = FRONT.exec(readFileSync(join(dir, f), "utf8").replace(/^﻿/, ""))?.[1];
    if (head === undefined || !/^note:/m.test(head)) continue;
    const meta = parse(head) as { note?: unknown; recheck?: unknown } | null;
    if (typeof meta?.note !== "string" || typeof meta.recheck !== "string") throw new Error(`the note ${f} needs a note id and a recheck date`);
    notes.set(meta.note, meta.recheck);
  }
  return notes;
}

export async function run(args: readonly string[], io: Io): Promise<number> {
  try {
    let file = "";
    let roles = DEFAULT_ROLES;
    let today = new Date().toISOString().slice(0, 10);
    let preferencesFile: string | null = null;
    let snapshotsDir: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--roles") roles = (args[++i] ?? "").split(",").map(r => r.trim()).filter(Boolean);
      else if (a === "--today") today = args[++i] ?? "";
      else if (a === "--preferences") preferencesFile = args[++i] ?? "";
      else if (a === "--snapshots") snapshotsDir = args[++i] ?? "";
      else if (!a.startsWith("--") && !file) file = a;
      else file = "\0";
    }
    if (!file || file === "\0" || roles.length === 0 || !isDate(today) || preferencesFile === "" || snapshotsDir === "") {
      io.err(USAGE);
      return 2;
    }
    const parse = await yamlParse();
    if (!parse) {
      io.err(`sop-check: the yaml package is missing; run npm install in ${io.skillDir} once`);
      return 2;
    }
    const sopFile = readYaml(file, parse);
    if ("line" in sopFile) {
      io.err(sopFile.line);
      return 2;
    }
    const doc = sopFile.doc;
    // The user's files, read only when given. One that doesn't exist only warns while the SOP cites nothing in it.
    const cited = sopCitations(doc);
    const fileLines: string[] = [];
    // The preferences file: the ids that hold, each it left out with the entry's refusal, and each refusal as a warning.
    let preferences: CitationIndex | undefined;
    const firstPref = cited.preferences[0];
    if (preferencesFile !== null && !existsSync(preferencesFile)) {
      if (firstPref !== undefined) {
        io.err(`sop-check: ${preferencesFile} doesn't exist, and the SOP cites pref:${firstPref}`);
        return 2;
      }
      fileLines.push(`warning  no-preferences-file  --preferences  ${preferencesFile} doesn't exist; the SOP cites no preference`);
    } else if (preferencesFile !== null) {
      const prefFile = readYaml(preferencesFile, parse);
      if ("line" in prefFile) {
        io.err(prefFile.line);
        return 2;
      }
      const parsed = parsePreferences(prefFile.doc);
      preferences = { usable: new Set(parsed.preferences.map(p => p.id)), leftOut: parsed.leftOut };
      for (const r of parsed.refusals) fileLines.push(`warning  preference-left-out  ${r.at}  ${r.message}`);
    }
    // The snapshot directory: a cited date counts only if its file reads as models-dev show reads it and was fetched that day.
    let snapshots: CitationIndex | undefined;
    const firstSnap = cited.snapshots[0];
    if (snapshotsDir !== null && !existsSync(snapshotsDir)) {
      if (firstSnap !== undefined) {
        io.err(`sop-check: ${snapshotsDir} doesn't exist, and the SOP cites models.dev@${firstSnap}`);
        return 2;
      }
      fileLines.push(`warning  no-snapshot-directory  --snapshots  ${snapshotsDir} doesn't exist; the SOP cites no snapshot`);
    } else if (snapshotsDir !== null) {
      let names: string[];
      try {
        names = readdirSync(snapshotsDir);
      } catch (e) {
        io.err(`sop-check: can't read ${snapshotsDir}: ${firstLine(e)}`);
        return 2;
      }
      const usable = new Set<string>();
      const leftOut = new Map<string, string>();
      for (const date of new Set(cited.snapshots)) {
        const name = `${date}.json`;
        if (!names.includes(name)) continue;
        const read = readSnapshotFile(join(snapshotsDir, name));
        if (!read.ok) leftOut.set(date, `${name}: ${read.error}`);
        else if (read.value.fetched !== date) leftOut.set(date, `${name} was fetched ${read.value.fetched}`);
        else usable.add(date);
      }
      snapshots = { usable, leftOut };
    }

    const skillsDir = dirname(io.skillDir);
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(skillsDir, d.name, "SKILL.md")))
      .map(d => d.name);
    const notes = notesIn(join(io.skillDir, "references"), parse);
    const { refusals, warnings } = checkSop(doc, { skills, notes, roles, today, isTimeZone, ...(preferences && { preferences }), ...(snapshots && { snapshots }) });
    const sop = (doc as { sop?: unknown } | null)?.sop;
    const name = typeof sop === "string" ? sop : basename(file);
    for (const r of refusals) io.out(`refused  ${r.rule}  ${r.at}  ${r.message}`);
    for (const w of warnings) io.out(`warning  ${w.rule}  ${w.at}  ${w.message}`);
    for (const line of fileLines) io.out(line);
    io.out(refusals.length === 0 ? `${name}: passes` : `${name}: ${refusals.length} refusal${refusals.length === 1 ? "" : "s"}`);
    return refusals.length === 0 ? 0 : 1;
  } catch (e) {
    io.err(`sop-check: ${firstLine(e)}`);
    return 2;
  }
}
