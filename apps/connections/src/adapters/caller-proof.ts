// Check 2 of `morndo-keys lease` (T-340, ADR-0022 amendment): for a connection whose isolation has to be os, the key is
// served only to a Claude Code process that was started with a sandbox that is on, fail-closed and denies the vault and the
// key files. The caller is the helper's parent, and everything is read from /proc, from the node's own pin and from the
// settings the parent was started with, never from the caller's environment:
//  - /proc/<ppid>/exe is the claude binary the owner pinned (`morndo-keys pin-claude`, a file in the connections home);
//  - its command line has --strict-mcp-config and no --mcp-config (no MCP server, which would run outside the sandbox), exactly
//    one --settings, and --setting-sources with an empty value (so no user, project or local
//    settings file merges its arrays into the sandbox: https://code.claude.com/docs/en/cli-reference, read 2026-10-21);
//  - a settings FILE has not changed since the parent started, and the sandbox denies writing it; inline JSON is in the
//    parent's argv and needs neither;
//  - the sandbox is on and fail-closed, runs every command inside it (no excludedCommands), denies reading the vault, the
//    database and the identity to Bash and to the Read tool, and does not re-open reading or opens writing there;
//  - the parent is still the same process when the checks are done (a reused pid is refused).
// The helper line must `exec` the lease, so that its parent is claude and not a shell.
// What this is: a check that stops a mistake and the agent's own tool calls (their parent is a shell the sandbox started,
// never claude). What it is not: a boundary against another process of the same user, which can start a claude-shaped
// process of its own; same-user is not a boundary in Morndo (ADR-0004).
import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { sandboxReady } from "./runtime-claude.ts";

// What the check reads about a process and the file system; injectable so the cases are shown without a process each.
export type ProcReader = {
  exe(pid: number): string | null;                                      // readlink(/proc/<pid>/exe), "(deleted)" included
  cmdline(pid: number): string[] | null;
  cwd(pid: number): string | null;
  startMs(pid: number): number | null;                                  // when the process started, epoch ms
  ticks(pid: number): number | null;                                    // its start time as the kernel states it: the process's identity
  file(path: string): { body: string; mtimeMs: number; ctimeMs: number } | null;
  real(path: string): string;                                           // the real path, or the path itself when it is not there
};

const text = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };

// Linux reports process start times in clock ticks since boot; USER_HZ is 100 on every Linux architecture.
const TICKS_PER_SECOND = 100;

export const procReader: ProcReader = {
  exe: pid => text(() => readlinkSync(`/proc/${pid}/exe`)),
  cmdline: pid => {
    const raw = text(() => readFileSync(`/proc/${pid}/cmdline`, "utf8"));
    const parts = raw === null ? null : raw.split("\0");
    if (parts?.at(-1) === "") parts.pop();                              // the list ends with a NUL
    return parts;
  },
  cwd: pid => text(() => readlinkSync(`/proc/${pid}/cwd`)),
  ticks: pid => {
    const stat = text(() => readFileSync(`/proc/${pid}/stat`, "utf8"));
    const ticks = stat === null ? NaN : Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]);   // field 22, starttime
    return Number.isFinite(ticks) ? ticks : null;
  },
  // Now minus how long the process has run: uptime and starttime are both ticks since boot, so the 1 s of /proc/stat's btime
  // never enters (a settings file written just before the parent started would read as written after it).
  startMs: pid => {
    const ticks = procReader.ticks(pid);
    const uptime = Number((text(() => readFileSync("/proc/uptime", "utf8")) ?? "").split(" ")[0]);
    return ticks === null || !Number.isFinite(uptime) ? null : Date.now() - (uptime - ticks / TICKS_PER_SECOND) * 1000;
  },
  file: path => text(() => {
    const info = statSync(path);
    return info.isFile() ? { body: readFileSync(path, "utf8"), mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } : null;
  }),
  real: path => text(() => realpathSync(path)) ?? resolve(path),
};

// The claude binary the owner pinned: where it was found (a link may move with an update) and what that was then.
export type Pin = { path: string; resolved: string };

// The pin to write for `path` (a file, or a name found on `pathVar`), or null when there is no such file.
export function pinFor(path: string, pathVar: string | undefined): Pin | null {
  const candidates = path.includes("/") ? [resolve(path)] : (pathVar ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, path));
  for (const candidate of candidates) {
    const resolved = text(() => realpathSync(candidate));
    if (resolved !== null && text(() => statSync(resolved).isFile())) return { path: candidate, resolved };
  }
  return null;
}

export function parsePin(body: string | null): Pin | null {
  if (body === null) return null;
  const pin = text(() => JSON.parse(body) as Partial<Pin>);
  return typeof pin?.path === "string" && typeof pin.resolved === "string" ? { path: pin.path, resolved: pin.resolved } : null;
}

export type Proof = { ok: true } | { ok: false; why: string };
const no = (why: string): Proof => ({ ok: false, why });

// A path is covered by an entry that is the path itself or a directory above it.
const covers = (entry: string, path: string): boolean => {
  const base = entry.length > 1 ? entry.replace(/\/+$/, "") : entry;
  return path === base || path.startsWith(`${base}/`);
};

export type Wanted = {
  denied: readonly string[];            // the vault, the database, the identity: denied to reading and not re-opened
  writeProtected: readonly string[];    // the same and the pin: the sandbox must not open them for writing
};

type Settings = {
  sandbox?: {
    enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown; excludedCommands?: unknown;
    filesystem?: { denyRead?: unknown; allowRead?: unknown; allowWrite?: unknown; denyWrite?: unknown };
  };
  permissions?: { deny?: unknown };
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

// What the settings leave of the sandbox, judged on real paths (a link can't dodge a deny entry).
export function settingsProof(settings: unknown, want: Wanted, real: (path: string) => string = p => p): Proof {
  if (typeof settings !== "object" || settings === null) return no("settings are not an object");
  const body = settings as Settings;
  const sandbox = body.sandbox ?? {};
  if (!sandboxReady(sandbox as { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean })) return no("sandbox is not on and fail-closed");
  const excluded = sandbox.excludedCommands;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.length > 0)) return no("commands may run outside the sandbox");
  const files = sandbox.filesystem ?? {};
  const denyRead = strings(files.denyRead).map(real);
  // permissions.deny blocks the Read tool, denyRead only sandboxed Bash: both must name every path (runtime-claude.ts).
  const rules = strings(body.permissions?.deny)
    .filter(rule => rule.startsWith("Read(//") && rule.endsWith(")"))
    .map(rule => real(rule.slice("Read(/".length, -1).replace(/\/\*\*$/, "")));
  const allowRead = strings(files.allowRead).map(real);
  const allowWrite = strings(files.allowWrite).map(real);
  for (const path of want.denied.map(real)) {
    if (!denyRead.some(entry => covers(entry, path))) return no(`denyRead does not cover ${path}`);
    if (!rules.some(entry => covers(entry, path))) return no(`Read is not denied for ${path}`);
    // allowRead re-opens a region inside a denyRead one: an entry that reaches the path, or lies inside it, is refused
    if (allowRead.some(entry => covers(entry, path) || covers(path, entry))) return no(`allowRead reaches ${path}`);
  }
  for (const path of want.writeProtected.map(real)) {
    if (allowWrite.some(entry => covers(entry, path))) return no(`allowWrite reaches ${path}`);
  }
  return { ok: true };
}

export type Check = {
  ppid: () => number;                  // the live parent: process.ppid reads it again each time
  pin: Pin | null;
  want: Wanted;
  read?: ProcReader;
};

const DELETED = " (deleted)";
// Process start times come in ticks of 10 ms: a settings file written just before the fork can read as just after.
const START_SLACK_MS = 20;

export function verifyClaudeParent(check: Check): Proof {
  const read = check.read ?? procReader;
  if (check.pin === null) return no("no pinned claude binary");
  const parent = check.ppid();
  const started = read.startMs(parent);
  const ticks = read.ticks(parent);
  const exe = read.exe(parent);
  const args = read.cmdline(parent);
  if (started === null || ticks === null || exe === null) return no("parent unreadable");
  if (args === null) return no("parent command line unreadable");
  // The binary: the pinned one now, or the one that was pinned, which after an update reads "(deleted)" while it runs.
  const gone = exe.endsWith(DELETED);
  const path = gone ? exe.slice(0, -DELETED.length) : exe;
  const pinnedNow = gone ? null : read.real(check.pin.path);
  if (!(path === check.pin.resolved || (pinnedNow !== null && read.real(path) === pinnedNow))) return no("parent is not the pinned claude");
  const flag = (name: string): string[] => args.flatMap((arg, i) => (arg === name ? [args[i + 1] ?? ""] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []));
  const sources = flag("--setting-sources");
  if (sources.length !== 1 || sources[0] !== "") return no("setting sources are not limited to none");
  // An MCP server is a child of claude that runs outside the sandbox, so one from the repo's .mcp.json could run the lease:
  // only the servers the lane names count, and the lane names none (https://code.claude.com/docs/en/cli-reference).
  if (!args.includes("--strict-mcp-config") || flag("--mcp-config").length > 0) return no("MCP servers are not limited to none");
  const given = flag("--settings");
  if (given.length !== 1) return no(given.length === 0 ? "no --settings" : "more than one --settings");
  const value = (given[0] ?? "").trim();
  const protectedWrite = [...check.want.writeProtected];
  let source = value;
  if (!value.startsWith("{")) {
    // A file: it must not have changed since the parent started, and the sandbox must not let a command write it.
    const cwd = read.cwd(parent);
    const file = isAbsolute(value) ? value : cwd === null ? null : join(cwd, value);
    const seen = file === null ? null : read.file(file);
    if (file === null || seen === null) return no("settings unreadable");
    if (seen.mtimeMs > started + START_SLACK_MS || seen.ctimeMs > started + START_SLACK_MS) return no("settings changed after the parent started");
    source = seen.body;
    protectedWrite.push(file);
  }
  let settings: unknown;
  try { settings = JSON.parse(source); } catch { return no("settings are not JSON"); }
  const proof = settingsProof(settings, { denied: check.want.denied, writeProtected: protectedWrite }, path => read.real(path));
  if (!proof.ok) return proof;
  if (value !== "" && !value.startsWith("{")) {
    const denyWrite = strings((settings as Settings).sandbox?.filesystem?.denyWrite).map(entry => read.real(entry));
    const file = read.real(isAbsolute(value) ? value : join(read.cwd(parent) ?? "", value));
    if (!denyWrite.some(entry => covers(entry, file))) return no("the settings file is not denied to writing");
  }
  // Still the process the checks read: a pid that went away and was reused, or a parent that was replaced, is refused.
  if (check.ppid() !== parent || read.ticks(parent) !== ticks || read.exe(parent) !== exe) return no("the parent changed while it was checked");
  return { ok: true };
}
