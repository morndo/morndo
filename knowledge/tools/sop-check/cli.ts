// sop-check's command line (ADR-0026, K10 and K14). It reads an SOP, the skills installed beside the recurring-job skill,
// the notes in that skill's references and the engine layer's roles, judges the SOP with the domain's checkSop, and
// prints one line per refusal or warning. Exit 0: passes. 1: refused. 2: a bad call, or anything unexpected, as one line.
// main.ts wires the real process; build.ts bundles both, and the domain's rules, into the skill's scripts/sop-check.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkSop } from "../../../packages/domain/src/knowledge.ts";

// The engine layer's default roles, as its `engines get --json` lists them (recorded in
// apps/hub/test/fixtures/engines-defaults.json; a test holds the two equal). Other roles come with --roles.
export const DEFAULT_ROLES: readonly string[] = ["plan", "implement-backend", "implement-ui", "implement-infra", "validate", "review", "research", "read-long", "images", "video"];

export type Io = { skillDir: string; out: (line: string) => void; err: (line: string) => void };
type Parse = (text: string) => unknown;

const USAGE = "usage: sop-check <sop.yaml> [--roles plan,review,...] [--today YYYY-MM-DD]";
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
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
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--roles") roles = (args[++i] ?? "").split(",").map(r => r.trim()).filter(Boolean);
      else if (a === "--today") today = args[++i] ?? "";
      else if (!a.startsWith("--") && !file) file = a;
      else file = "\0";
    }
    if (!file || file === "\0" || roles.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      io.err(USAGE);
      return 2;
    }
    const parse = await yamlParse();
    if (!parse) {
      io.err(`sop-check: the yaml package is missing; run npm install in ${io.skillDir} once`);
      return 2;
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      io.err(`sop-check: can't read ${file}: ${firstLine(e)}`);
      return 2;
    }
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (e) {
      io.err(`sop-check: ${file} is not YAML: ${firstLine(e)}`);
      return 2;
    }

    const skillsDir = dirname(io.skillDir);
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => (d.isDirectory() || d.isSymbolicLink()) && existsSync(join(skillsDir, d.name, "SKILL.md")))
      .map(d => d.name);
    const notes = notesIn(join(io.skillDir, "references"), parse);
    const { refusals, warnings } = checkSop(doc, { skills, notes, roles, today, isTimeZone });
    const sop = (doc as { sop?: unknown } | null)?.sop;
    const name = typeof sop === "string" ? sop : basename(file);
    for (const r of refusals) io.out(`refused  ${r.rule}  ${r.at}  ${r.message}`);
    for (const w of warnings) io.out(`warning  ${w.rule}  ${w.at}  ${w.message}`);
    io.out(refusals.length === 0 ? `${name}: passes` : `${name}: ${refusals.length} refusal${refusals.length === 1 ? "" : "s"}`);
    return refusals.length === 0 ? 0 : 1;
  } catch (e) {
    io.err(`sop-check: ${firstLine(e)}`);
    return 2;
  }
}
