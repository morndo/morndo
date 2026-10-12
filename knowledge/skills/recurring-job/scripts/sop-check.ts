#!/usr/bin/env node
// sop-check: refuses an unsafe SOP (ADR-0026, K10 and K14).
//   node knowledge/skills/recurring-job/scripts/sop-check.ts <sop.yaml> [--roles plan,review,...] [--today YYYY-MM-DD]
// Exit 0: passes; warnings may print. 1: refused, one line per refusal naming its rule and the step. 2: a bad call, or a
// file that can't be read as YAML. The rules are the domain's (packages/domain/src/knowledge.ts); this file reads the
// SOP, the shipped skills and the notes' re-check dates, and prints. Node resolves a symlinked skill folder to this
// repository, so the paths below hold when the skill is installed by a link.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { checkSop } from "../../../../packages/domain/src/knowledge.ts";

// The engine layer's default roles, as its `engines get --json` lists them (recorded in
// apps/hub/test/fixtures/engines-defaults.json). A user whose engine layer has other roles passes --roles.
const DEFAULT_ROLES = ["plan", "implement-backend", "implement-ui", "implement-infra", "validate", "review", "research", "read-long", "images", "video"];
const KNOWLEDGE = join(import.meta.dirname, "../../..");
const USAGE = "usage: sop-check <sop.yaml> [--roles plan,review,...] [--today YYYY-MM-DD]";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let file = "";
let roles = DEFAULT_ROLES;
let today = new Date().toISOString().slice(0, 10);
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? "";
  if (a === "--roles") roles = (args[++i] ?? "").split(",").map(r => r.trim()).filter(Boolean);
  else if (a === "--today") today = args[++i] ?? "";
  else if (!a.startsWith("--") && !file) file = a;
  else fail(USAGE);
}
if (!file || roles.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(today)) fail(USAGE);

let doc: unknown;
try {
  doc = parse(readFileSync(file, "utf8"));
} catch (e) {
  fail(`sop-check: can't read ${file} as YAML: ${(e as Error).message.split("\n")[0] ?? ""}`);
}

const skillsDir = join(KNOWLEDGE, "skills");
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
  .map(d => d.name);
const notesDir = join(KNOWLEDGE, "notes");
const notes = new Map<string, string>();
for (const f of existsSync(notesDir) ? readdirSync(notesDir).filter(n => n.endsWith(".md")) : []) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(notesDir, f), "utf8").replace(/^﻿/, ""))?.[1] ?? "";
  const meta = parse(head) as { note?: unknown; recheck?: unknown } | null;
  if (typeof meta?.note === "string" && typeof meta.recheck === "string") notes.set(meta.note, meta.recheck);
}

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const { refusals, warnings } = checkSop(doc, { skills, notes, roles, today, isTimeZone });
const name = typeof (doc as { sop?: unknown } | null)?.sop === "string" ? (doc as { sop: string }).sop : basename(file);
for (const r of refusals) process.stdout.write(`refused  ${r.rule}  ${r.at}  ${r.message}\n`);
for (const w of warnings) process.stdout.write(`warning  ${w.rule}  ${w.at}  ${w.message}\n`);
process.stdout.write(refusals.length === 0 ? `${name}: passes\n` : `${name}: ${refusals.length} refusal${refusals.length === 1 ? "" : "s"}\n`);
process.exit(refusals.length === 0 ? 0 : 1);
