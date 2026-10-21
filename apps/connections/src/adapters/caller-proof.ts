// Check 2 of `morndo-keys lease` (T-340, ADR-0022 amendment): for a connection whose isolation has to be os, the key is
// served only to a Claude Code process that was started with a sandbox that is on, fail-closed and denies the vault and the
// key files. The caller is the helper's parent: /proc/<ppid>/exe is the claude binary, and its command line names a
// --settings (a file, or inline JSON) with those settings. The helper line must `exec` the lease, so that its parent is
// claude and not a shell.
// What this is: a check that stops a mistake and the agent's own tool calls (their parent is a shell the sandbox started,
// never claude). What it is not: a boundary against another process of the same user, which can start a claude-shaped
// process of its own; same-user is not a boundary in Morndo (ADR-0004).
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { sandboxReady } from "./runtime-claude.ts";

// What the check reads about a process; injectable so the cases are shown without starting a process for each.
export type ProcReader = {
  exe(pid: number): string | null;
  cmdline(pid: number): string[] | null;
  cwd(pid: number): string | null;
  file(path: string): string | null;
};

const text = (read: () => string | null): string | null => { try { return read(); } catch { return null; } };

export const procReader: ProcReader = {
  exe: pid => text(() => realpathSync(readlinkSync(`/proc/${pid}/exe`))),
  cmdline: pid => {
    const raw = text(() => readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    const parts = raw === null ? null : raw.split("\0");
    if (parts?.at(-1) === "") parts.pop();                    // the list ends with a NUL
    return parts;
  },
  cwd: pid => text(() => readlinkSync(`/proc/${pid}/cwd`)),
  file: path => text(() => readFileSync(path, "utf8")),
};

// The claude binary the lane was started with, as its real path, or null when it can't be found.
export function claudeBinary(bin: string, pathVar: string | undefined): string | null {
  const candidates = bin.includes("/") ? [bin] : (pathVar ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, bin));
  for (const candidate of candidates) {
    try { return realpathSync(candidate); } catch { /* not there */ }
  }
  return null;
}

export type Proof = { ok: true } | { ok: false; why: string };
const no = (why: string): Proof => ({ ok: false, why });

export function verifyClaudeParent(ppid: number, claudeBin: string, pathVar: string | undefined, denied: readonly string[], read: ProcReader = procReader): Proof {
  const wanted = claudeBinary(claudeBin, pathVar);
  if (wanted === null) return no("claude binary not found");
  if (read.exe(ppid) !== wanted) return no("parent is not claude");
  const args = read.cmdline(ppid);
  if (args === null) return no("parent command line unreadable");
  const given: string[] = [];
  args.forEach((arg, i) => {
    if (arg === "--settings") given.push(args[i + 1] ?? "");
    else if (arg.startsWith("--settings=")) given.push(arg.slice("--settings=".length));
  });
  if (given.length !== 1) return no(given.length === 0 ? "no --settings" : "more than one --settings");
  const value = (given[0] ?? "").trim();
  let source = value;
  if (!value.startsWith("{")) {
    const cwd = read.cwd(ppid);
    const path = isAbsolute(value) ? value : cwd === null ? null : join(cwd, value);
    const body = path === null ? null : read.file(path);
    if (body === null) return no("settings unreadable");
    source = body;
  }
  let settings: unknown;
  try { settings = JSON.parse(source); } catch { return no("settings are not JSON"); }
  return settingsProof(settings, denied);
}

type Settings = { sandbox?: { enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown; filesystem?: { denyRead?: unknown } }; permissions?: { deny?: unknown } };

// A path is covered by a deny entry that is the path itself or a directory above it.
const covers = (entry: string, path: string): boolean => {
  const base = entry.length > 1 ? entry.replace(/\/+$/, "") : entry;
  return path === base || path.startsWith(`${base}/`);
};

export function settingsProof(settings: unknown, denied: readonly string[]): Proof {
  if (typeof settings !== "object" || settings === null) return no("settings are not an object");
  const body = settings as Settings;
  const sandbox = body.sandbox ?? {};
  if (!sandboxReady(sandbox as { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean })) return no("sandbox is not on and fail-closed");
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);
  const denyRead = strings(sandbox.filesystem?.denyRead);
  // permissions.deny blocks the Read tool, denyRead only sandboxed Bash: both must name every path (runtime-claude.ts).
  const rules = strings(body.permissions?.deny)
    .filter(rule => rule.startsWith("Read(//") && rule.endsWith(")"))
    .map(rule => rule.slice("Read(/".length, -1).replace(/\/\*\*$/, ""));
  for (const path of denied) {
    if (!denyRead.some(entry => covers(entry, path))) return no(`denyRead does not cover ${path}`);
    if (!rules.some(entry => covers(entry, path))) return no(`Read is not denied for ${path}`);
  }
  return { ok: true };
}
