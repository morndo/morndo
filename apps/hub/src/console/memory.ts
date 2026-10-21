// `morndo memory` (ADR-0031, docs/design/memory/README.md "Console"): Memory at the control plane's console, which acts
// for the principal ({kind: "principal", via: "console"}), as `pair` and `revoke` do. It opens memory.db directly, as
// the other console commands open the hub's database, so it works whether the hub runs or not.
// - list, show: the Notes, as the principal sees them (every one, the pending and the invalidated among them);
// - approve: M4, M5, M8, the principal's approval of a Procedure or an untrusted Note — at the console it needs a
//   one-time code (XXXX-XXXX-XXXX) that only the app, under step-up, can mint for the note;
// - invalidate: M2, with the reason;
// - import: an agent's own markdown notes (frontmatter `name`, `description`) as {kind: "import", label}: tier 3, facts
//   unless named with --procedure, and a procedure still waits for approve;
// - sync: the skills to every online node now, through the fleet's socket as `morndo lanes` finds it. Otherwise the
//   hub's loop does it every minute.
// Exit codes: 0 done, 1 refused (one plain line on stderr), 2 usage, 69 the fleet couldn't be reached (EX_UNAVAILABLE),
// 78 memory.db can't be opened by this hub (EX_CONFIG, as main.ts says of morndo.db).
// util.parseArgs, strict: https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-20.
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { FleetClient, FleetMismatch, FleetUnavailable } from "@morndo/fleet-client";
import { DatabaseUnreadable } from "@morndo/service-kit";
import { MEMORY_LIMITS, TIER_LABELS, parseScope, type MemoryChange, type Note } from "@morndo/domain";
import { MemoryFromFuture } from "../adapters/memory-migrations.ts";
import { MemoryStore } from "../adapters/memory-store.ts";
import { MemoryService, waitsForApproval, type ImportFile, type ImportOutcome } from "../application/memory-service.ts";
import { MemorySync, type MemoryFleet } from "../application/memory-sync.ts";

export const MEMORY_EXIT = { ok: 0, refused: 1, usage: 2, unavailable: 69, data: 78 } as const;

export type MemoryIo = { env: NodeJS.ProcessEnv; out(text: string): Promise<void>; err(text: string): Promise<void> };

export const MEMORY_USAGE = `usage: morndo memory list [--scope S] [--pending] [--all]
       morndo memory show <id>
       morndo memory approve <id> --code CODE
       morndo memory invalidate <id> --reason R
       morndo memory import --dir D --scope S [--label L] [--procedure FILE]...
       morndo memory sync
A scope is repo:<name>, project:<name>, user or org. import reads D's *.md files with YAML frontmatter (name,
description); the files named by --procedure become procedures, which wait for approve. Approving at the console needs a
one-time code from the app (M8). sync pushes the skills to every online node now, through MORNDO_FLEET_SOCKET (default
~/.local/state/morndo-fleet/fleet.sock).`;

const OPTIONS = {
  scope: { type: "string" }, pending: { type: "boolean" }, all: { type: "boolean" }, reason: { type: "string" },
  dir: { type: "string" }, label: { type: "string" }, procedure: { type: "string", multiple: true }, code: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;
type Values = { scope?: string; pending?: boolean; all?: boolean; reason?: string; dir?: string; label?: string; procedure?: string[]; code?: string; help?: boolean };
// The options and the positionals each command takes; anything else is a usage error.
const COMMANDS: Record<string, { options: readonly string[]; ids: number }> = {
  list: { options: ["scope", "pending", "all"], ids: 0 }, show: { options: [], ids: 1 }, approve: { options: ["code"], ids: 1 },
  invalidate: { options: ["reason"], ids: 1 }, import: { options: ["dir", "scope", "label", "procedure"], ids: 0 }, sync: { options: [], ids: 0 },
};

const day = (t: number | null) => (t === null ? "-" : new Date(t).toISOString());
const stateOf = (n: Note) =>
  n.supersededBy ? `superseded by ${n.supersededBy}` : n.invalidatedAt !== null ? "invalidated" : waitsForApproval(n) ? "waits for approve" : "live";
const changeText = (c: MemoryChange) =>
  c.kind === "superseded" ? `superseded by ${c.by}` : c.kind === "invalidated" ? `invalidated: ${c.reason}` : c.kind === "confirmed" ? `confirmed by ${c.evidence}` : c.kind;

// `fleet`: the fleet's client to sync through (a test's own); absent, one on the socket `morndo lanes` uses.
export async function runMemory(argv: string[], io: MemoryIo, o: { dataDir: string; now?: () => number; fleet?: MemoryFleet }): Promise<number> {
  let v: Values;
  let positionals: string[];
  try { ({ values: v, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })); }
  catch (e) { await io.err(`${(e as Error).message}\n${MEMORY_USAGE}`); return MEMORY_EXIT.usage; }
  if (v.help) { await io.out(MEMORY_USAGE); return MEMORY_EXIT.ok; }
  const [sub = "", ...ids] = positionals;
  // Own keys only: a plain object's constructor, toString and valueOf are not commands.
  const command = Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (!command) { await io.err(`${sub ? `no such memory command: ${sub}\n` : ""}${MEMORY_USAGE}`); return MEMORY_EXIT.usage; }
  const extra = Object.keys(v).filter(k => !command.options.includes(k));
  if (extra.length || ids.length !== command.ids) {
    await io.err(`${extra.length ? `memory ${sub} takes no --${extra.join(", --")}\n` : ""}${MEMORY_USAGE}`);
    return MEMORY_EXIT.usage;
  }

  let store: MemoryStore;
  try { store = new MemoryStore(o.dataDir); }
  catch (e) {
    if (!(e instanceof MemoryFromFuture) && !(e instanceof DatabaseUnreadable)) throw e;
    await io.err(`${e.message} Run a newer hub, or move ${join(o.dataDir, "memory.db")} away to start Memory empty.`);
    return MEMORY_EXIT.data;
  }
  const service = new MemoryService({ store, ...(o.now ? { now: o.now } : {}) });
  const id = ids[0] ?? "";
  try {
    switch (sub) {
      case "list": {
        const listed = service.list({ scope: v.scope ?? null, pending: v.pending === true, all: v.all === true });
        if (!listed.ok) { await io.err(`not a scope: ${JSON.stringify(v.scope)}`); return MEMORY_EXIT.usage; }
        for (const n of listed.notes) {
          await io.out(`${n.id.padEnd(7)} ${n.kind.padEnd(9)} ${n.scope.padEnd(24)} ${`${n.tier} ${TIER_LABELS[n.tier]}`.padEnd(11)} ${stateOf(n).padEnd(18)} ${n.title}`);
        }
        if (listed.notes.length === 0) await io.out("no notes");
        return MEMORY_EXIT.ok;
      }
      case "show": {
        const shown = service.show(id);
        if (!shown) { await io.err(`no note ${id}`); return MEMORY_EXIT.refused; }
        const n = shown.note;
        const p = n.provenance;
        await io.out([
          `${n.id}  ${n.kind}  ${n.scope}  ${stateOf(n)}`,
          `title: ${n.title}`, `summary: ${n.summary || "-"}`,
          `tier: ${n.tier} (${TIER_LABELS[n.tier]}), written by ${p.by}${p.node ? ` on ${p.node}` : ""}${p.ref ? ` (${p.ref})` : ""}${p.untrusted ? ", from untrusted content" : ""}`,
          `created ${day(n.createdAt)}, last confirmed ${day(n.lastConfirmedAt)}, re-check ${day(n.recheckAt)}`,
          `approved ${day(n.approvedAt)}${n.approvedBy ? ` by ${n.approvedBy}` : ""}`,
          `invalidated ${day(n.invalidatedAt)}${n.invalidatedBy ? ` by ${n.invalidatedBy}: ${n.invalidReason ?? ""}` : ""}`,
          `supersedes ${n.supersedes ?? "-"}, superseded by ${n.supersededBy ?? "-"}`,
          "", n.body, "", "events:",
          ...shown.events.map(e => `  ${day(e.at)}  ${e.actor}  ${changeText(e.change)}`),
        ].join("\n"));
        return MEMORY_EXIT.ok;
      }
      case "approve": {
        const r = service.approve("console", id, v.code === undefined ? {} : { code: v.code });
        if (!r.ok && r.problem === "code_needed") {
          await io.err(`approving at the console needs a one-time code from the app (ask for one on the note, then: morndo memory approve ${id} --code XXXX-XXXX-XXXX)`);
          return MEMORY_EXIT.refused;
        }
        if (!r.ok && r.problem === "bad_code") {
          await io.err("that code is wrong, already used or expired; ask the app for a new one");
          return MEMORY_EXIT.refused;
        }
        if (!r.ok && r.problem === "replaced_meanwhile") {
          await io.err(`${id}: the note it replaces was replaced by another successor first; look at both (morndo memory show) and, if this one should win, have it proposed again against the version that holds now`);
          return MEMORY_EXIT.refused;
        }
        if (!r.ok) { await io.err(`${id}: ${r.problem}`); return MEMORY_EXIT.refused; }
        await io.out(`approved ${r.note.id} (${r.note.kind}, ${r.note.scope}): it reaches the lanes at the next sync`);
        return MEMORY_EXIT.ok;
      }
      case "invalidate": {
        if (!v.reason?.trim()) { await io.err(`memory invalidate needs --reason\n${MEMORY_USAGE}`); return MEMORY_EXIT.usage; }
        const r = service.invalidate("console", id, v.reason);
        if (!r.ok) { await io.err(`${id}: ${r.problem}`); return MEMORY_EXIT.refused; }
        await io.out(`invalidated ${r.note.id}: it leaves the lanes' skills at the next sync`);
        return MEMORY_EXIT.ok;
      }
      case "import": return await importDir(service, io, v);
      case "sync": return await syncNow(service, store, io, o);
    }
    return MEMORY_EXIT.usage;
  } finally {
    store.close();
  }
}

async function importDir(service: MemoryService, io: MemoryIo, v: Values): Promise<number> {
  if (!v.dir || !v.scope) { await io.err(`memory import needs --dir and --scope\n${MEMORY_USAGE}`); return MEMORY_EXIT.usage; }
  if (!parseScope(v.scope)) { await io.err(`not a scope: ${JSON.stringify(v.scope)}`); return MEMORY_EXIT.usage; }
  const label = (v.label ?? basename(v.dir)).trim();
  if (!label) { await io.err("memory import needs a --label"); return MEMORY_EXIT.usage; }
  let names: string[];
  try { names = readdirSync(v.dir).filter(f => f.endsWith(".md") && lstatSync(join(v.dir ?? "", f)).isFile()).sort(); }
  catch (e) { await io.err(`can't read ${v.dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`); return MEMORY_EXIT.refused; }
  const procedures = new Set((v.procedure ?? []).map(f => basename(f)));
  const missing = [...procedures].filter(f => !names.includes(f));
  if (missing.length) { await io.err(`--procedure names no markdown file in ${v.dir}: ${missing.join(", ")}`); return MEMORY_EXIT.usage; }

  const files: ImportFile[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const path = join(v.dir, name);
    const read = memoryFile(readFileSync(path, "utf8"));
    if (!read) { skipped.push(name); continue; }
    files.push({ file: name, ...read, lastConfirmedAt: Math.round(lstatSync(path).mtimeMs), procedure: procedures.has(name) });
  }
  const outcomes = service.importNotes(files, v.scope, label);
  for (const r of outcomes) await io.out(outcomeLine(r, files.find(f => f.file === r.file)?.procedure === true));
  for (const name of skipped) await io.out(`-       skipped     ${name}: no frontmatter with a name or a description`);
  const count = (done: ImportOutcome["done"]) => outcomes.filter(r => r.done === done).length;
  await io.out(`imported ${count("added") + count("superseded")} (${count("superseded")} superseding), ${count("same")} the same, ${count("refused")} refused, ${skipped.length} skipped`);
  return count("refused") ? MEMORY_EXIT.refused : MEMORY_EXIT.ok;
}

const outcomeLine = (r: ImportOutcome, procedure: boolean): string => {
  const waits = procedure ? "  (a procedure: it waits for approve)" : "";
  if (r.done === "added") return `${r.note.padEnd(7)} added       ${r.file}${waits}`;
  if (r.done === "superseded") return `${r.note.padEnd(7)} supersedes  ${r.file}: ${r.old}${waits}`;
  if (r.done === "same") return `${r.note.padEnd(7)} same        ${r.file}`;
  return `-       refused     ${r.file}: ${r.problem}`;
};

// One markdown file as Memory takes it: the title from `name` (else `description`), the summary from `description`,
// the body after the frontmatter, each cut to Memory's limits. Null when the file has no frontmatter with either.
export function memoryFile(text: string): { title: string; summary: string; body: string } | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields = frontmatterFields(m[1] ?? "");
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!name && !description) return null;
  return {
    title: cut(oneLine(name || description), MEMORY_LIMITS.title),
    summary: cut(oneLine(description), MEMORY_LIMITS.summary),
    body: cut(text.slice(m[0].length).replace(/\r\n/g, "\n").trim(), MEMORY_LIMITS.body),
  };
}

// YAML frontmatter, as far as these files use it: `key: value` lines, each value a plain scalar (a " #" ends it), or a
// single- or double-quoted one on its one line. Any other line (a list, a nested map, a folded block) is passed over.
function frontmatterFields(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    const raw = (kv[2] ?? "").trim();
    let value = raw.replace(/\s+#.*$/, "");
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1).replace(/''/g, "'");
    else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      try { value = String(JSON.parse(raw)); } catch { value = raw.slice(1, -1); }
    }
    out.set(kv[1], value);
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
// At most `n` UTF-16 units, the last one "…" when cut, never half a surrogate pair.
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, end).trimEnd()}…`;
}

async function syncNow(service: MemoryService, store: MemoryStore, io: MemoryIo, o: { now?: () => number; fleet?: MemoryFleet }): Promise<number> {
  const socket = io.env.MORNDO_FLEET_SOCKET || join(io.env.HOME || homedir(), ".local/state/morndo-fleet/fleet.sock");
  const fleet = o.fleet ?? new FleetClient(socket);
  // Each node's outcome is printed below; the loop's own lines would only repeat it, so only its warnings are said.
  const said = (m: string) => { void io.err(m); };
  const sync = new MemorySync({ service, store, fleet, ...(o.now ? { now: o.now } : {}), log: { info: () => {}, warn: said, error: said } });
  let pushed: Awaited<ReturnType<MemorySync["push"]>>;
  try { pushed = await sync.push({ force: true }); }
  catch (e) {
    if (!(e instanceof FleetUnavailable) && !(e instanceof FleetMismatch)) throw e;
    await io.err(`the fleet couldn't be reached at ${socket}, so nothing was sent: ${e.message}`);
    return MEMORY_EXIT.unavailable;
  }
  await io.out(`version ${pushed.version} in ${pushed.parts} ${pushed.parts === 1 ? "part" : "parts"}`);
  for (const [node, outcome] of [...pushed.outcomes].sort(([a], [b]) => a.localeCompare(b))) await io.out(`${node.padEnd(24)} ${outcome}`);
  if (pushed.outcomes.size === 0) await io.out("no nodes");
  return [...pushed.outcomes.values()].some(r => r === "failed" || r === "denied") ? MEMORY_EXIT.refused : MEMORY_EXIT.ok;
}
