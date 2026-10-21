// Check 2 of `morndo-keys lease` (T-340, ADR-0022 amendment): for a connection whose isolation has to be os, the key is
// served only to a Claude Code process that was started with a sandbox that is on, fail-closed and denies the vault and the
// key files. The caller is the helper's parent, and everything is read from /proc, from the node's own pin and from the
// settings the parent was started with, never from the caller's environment:
//  - /proc/<ppid>/exe is the claude binary the owner pinned (`morndo-keys pin-claude`, a file in the connections home) and its
//    content is what was pinned: size, mtime and inode as pinned, else the sha256 of the running binary;
//  - its environment (/proc/<ppid>/environ) names, as ANTHROPIC_BASE_URL, the API host the owner pinned for this connection,
//    and carries no proxy, extra CA or TLS-verification switch that could put another party between claude and that host;
//  - its command line has --strict-mcp-config and no --mcp-config (no MCP server, which would run outside the sandbox), exactly
//    one --settings, and --setting-sources with an empty value (so no user, project or local
//    settings file merges its arrays into the sandbox: https://code.claude.com/docs/en/cli-reference, read 2026-10-21);
//  - a settings FILE has not changed since the parent started, is reached through no symlink, and the sandbox denies writing
//    it; inline JSON is in the parent's argv and needs none of that;
//  - the sandbox is on and fail-closed, runs every command inside it (no excludedCommands), denies reading the vault, the
//    database and the identity to Bash and to the Read tool, and does not re-open reading or opens writing there;
//  - the parent is still the same process when the checks are done (a reused pid is refused).
// The helper line must `exec` the lease, so that its parent is claude and not a shell.
// What this is: a check that stops a mistake and the agent's own tool calls (their parent is a shell the sandbox started,
// never claude). What it is not: a boundary against another process of the same user, which can start a claude-shaped
// process of its own; same-user is not a boundary in Morndo (ADR-0004).
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { CLAUDE_RELEASE_FINGERPRINT } from "./claude-release-key.ts";
import { compareVersions, isVersion, type ReleasePin } from "./release-manifest.ts";
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
  linked(path: string): boolean;                                        // the path is, or goes through, a symlink (or cannot be read)
  exeIdentity(pid: number): Identity | null;                            // the running binary's inode, whatever its name (it may be deleted)
  exeSha256(pid: number): string | null;                                // the content of the running binary
  environ(pid: number): [string, string][] | null;                      // the environment the process started with, every entry (a name may repeat)
};

export type Identity = { size: number; mtimeMs: number; ctimeMs: number; ino: number };

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
  linked: path => {
    let at = "/";
    for (const part of resolve(path).split("/").filter(Boolean)) {
      at = join(at, part);
      const info = text(() => lstatSync(at));
      if (info === null || info.isSymbolicLink()) return true;
    }
    return false;
  },
  exeIdentity: pid => {
    const info = text(() => statSync(`/proc/${pid}/exe`));                  // follows the link to the inode the process runs
    return info === null ? null : { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
  },
  exeSha256: pid => sha256Of(`/proc/${pid}/exe`),
  environ: pid => {
    const raw = text(() => readFileSync(`/proc/${pid}/environ`, "utf8"));
    return raw === null ? null : parseEnviron(raw);
  },
};

// /proc/<pid>/environ: NAME=value entries, each ended by a NUL, in order and as many times as they occur.
export function parseEnviron(raw: string): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) out.push([entry.slice(0, eq), entry.slice(eq + 1)]);
  }
  return out;
}

// The sha256 of a file, read in chunks (a claude binary is large), or null when it can't be read.
export function sha256Of(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
    return hash.digest("hex");
  } catch { return null; } finally { closeSync(fd); }
}

// The claude binary the owner pinned: where it was found, the real path it had then, and what it was: its content hash,
// and the size, mtime, ctime and inode that tell at lease time whether it is still the same file (the hash is read again only
// when one of them differs, since a claude binary is large; utimes can put an mtime back, never a ctime); and, for each key
// connection the lease may serve, the API base URL its preset names, so a parent started against another host does not get
// the key. An update is a new file, and a new connection a new URL: both are pinned again by the owner.
export type Pin = {
  path: string; resolved: string; sha256: string; size: number; mtimeMs: number; ctimeMs: number; ino: number;
  baseUrls: Record<string, string>;      // per connection, the API host its claude must be started with (ANTHROPIC_BASE_URL)
};

// The pin to write for `path` (a file, or a name found on `pathVar`), or null when there is no such file.
export function pinFor(path: string, pathVar: string | undefined, baseUrls: Record<string, string> = {}): Pin | null {
  const candidates = path.includes("/") ? [resolve(path)] : (pathVar ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, path));
  for (const candidate of candidates) {
    const resolved = text(() => realpathSync(candidate));
    const info = resolved === null ? null : text(() => statSync(resolved));
    if (resolved === null || info === null || !info.isFile()) continue;
    const sha256 = sha256Of(resolved);
    if (sha256 !== null) return { path: candidate, resolved, sha256, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, baseUrls };
  }
  return null;
}

export function parsePin(body: string | null): Pin | null {
  if (body === null) return null;
  const pin = text(() => JSON.parse(body) as Partial<Pin>);
  if (pin === null || typeof pin.path !== "string" || typeof pin.resolved !== "string" || typeof pin.sha256 !== "string") return null;
  if (typeof pin.size !== "number" || typeof pin.mtimeMs !== "number" || typeof pin.ctimeMs !== "number" || typeof pin.ino !== "number") return null;
  const urls = pin.baseUrls;
  if (typeof urls !== "object" || urls === null || Array.isArray(urls) || Object.values(urls).some(url => typeof url !== "string")) return null;
  return { path: pin.path, resolved: pin.resolved, sha256: pin.sha256, size: pin.size, mtimeMs: pin.mtimeMs, ctimeMs: pin.ctimeMs, ino: pin.ino, baseUrls: { ...urls } };
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
    enabled?: unknown; failIfUnavailable?: unknown; allowUnsandboxedCommands?: unknown;
    filesystem?: { denyRead?: unknown; allowWrite?: unknown; denyWrite?: unknown };
  } & Record<string, unknown>;
  permissions?: { deny?: unknown };
};

// The settings keys a lane turn may carry: an allowlist, because every key that is not named here (a proxy, hooks, env, a
// model endpoint, a status line command, plugins, extra directories, anything a later Claude Code version adds) could
// weaken the sandbox or send the key somewhere. A leaf `true` takes any value (the checks below judge the ones that matter);
// a key that is not here is refused, set or not. The set is exactly what the lane launcher (agent-engines glm-turn) puts in
// its inline settings; the sandbox keys that weaken it (https://code.claude.com/docs/en/sandboxing, read 2026-10-21:
// enableWeakerNestedSandbox, enableWeakerNetworkIsolation, allowAppleEvents, ignoreViolations, filesystem.disabled,
// network.allowAllUnixSockets, network.allowUnixSockets, network.allowLocalBinding, network.allowMachLookup, excludedCommands,
// filesystem.allowRead) are among those it keeps out. `run` does not pass through the lease check and writes its own.
type Tree = { [key: string]: true | Tree };
export const ALLOWED_SETTINGS: Tree = {
  apiKeyHelper: true,
  permissions: { deny: true },
  sandbox: {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: true,
    filesystem: { denyRead: true, allowWrite: true, denyWrite: true },
    network: { allowedDomains: true },
  },
};

// The path of the first key of `value` that `tree` does not allow, or null.
function unlisted(value: unknown, tree: Tree, prefix: string[] = []): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const [key, inner] of Object.entries(value)) {
    const allowed = Object.hasOwn(tree, key) ? tree[key] : undefined;
    if (allowed === undefined) return [...prefix, key].join(".");
    if (allowed !== true) {
      const deeper = unlisted(inner, allowed, [...prefix, key]);
      if (deeper !== null) return deeper;
      if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return [...prefix, key].join(".");   // a branch holds keys
    }
  }
  return null;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);

// What the settings leave of the sandbox, judged on real paths (a link can't dodge a deny entry).
export function settingsProof(settings: unknown, want: Wanted, real: (path: string) => string = p => p): Proof {
  if (typeof settings !== "object" || settings === null) return no("settings are not an object");
  const extra = unlisted(settings, ALLOWED_SETTINGS);
  if (extra !== null) return no(`settings key ${extra} is not one a lane turn may carry`);
  const body = settings as Settings;
  const sandbox = body.sandbox ?? {};
  if (!sandboxReady(sandbox as { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean })) return no("sandbox is not on and fail-closed");
  const files = sandbox.filesystem ?? {};
  const denyRead = strings(files.denyRead).map(real);
  // permissions.deny blocks the Read tool, denyRead only sandboxed Bash: both must name every path (runtime-claude.ts).
  const rules = strings(body.permissions?.deny)
    .filter(rule => rule.startsWith("Read(//") && rule.endsWith(")"))
    .map(rule => real(rule.slice("Read(/".length, -1).replace(/\/\*\*$/, "")));
  const allowWrite = strings(files.allowWrite).map(real);
  for (const path of want.denied.map(real)) {
    if (!denyRead.some(entry => covers(entry, path))) return no(`denyRead does not cover ${path}`);
    if (!rules.some(entry => covers(entry, path))) return no(`Read is not denied for ${path}`);
  }
  for (const path of want.writeProtected.map(real)) {
    if (allowWrite.some(entry => covers(entry, path))) return no(`allowWrite reaches ${path}`);
  }
  return { ok: true };
}

export type Check = {
  ppid: () => number;                  // the live parent: process.ppid reads it again each time
  pin: Pin | null;                     // the one claude binary the owner pinned, or
  release: ReleasePin | null;          // the signed releases the owner pinned (T-346): either admits the binary
  // Is this sha256 in the signed manifest cached for this version? Offline (release-manifest.ts); the proof calls it, never the network.
  verifyRelease?: (version: string, sha256: string) => Promise<Proof>;
  connection: string;                  // the connection the key is for: its API host is looked up in the pin
  want: Wanted;
  read?: ProcReader;
};

const DELETED = " (deleted)";

// Environment variables that route claude's traffic through another party, or change whom it trusts: any proxy (in any case),
// an extra or replaced CA, and NODE_TLS_REJECT_UNAUTHORIZED=0 (tested apart: any other value is Node's default).
const INTERCEPTING_ENV = /^(https?_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir)$/i;

// Two base URLs name the same place: scheme, host, port and path, the host in lower case, without a trailing slash.
function sameBase(given: string | undefined, pinned: string): boolean | null {
  const norm = (url: string): string | null => {
    try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`; } catch { return null; }
  };
  const a = given === undefined ? null : norm(given);
  const b = norm(pinned);
  return a !== null && b !== null && a === b;
}
// Process start times come in ticks of 10 ms: a settings file written just before the fork can read as just after.
const START_SLACK_MS = 20;

// The binary is the one pinned: this file, with the pinned content (size, mtime, ctime and inode as pinned, else the hash).
function pinnedBinary(pin: Pin, path: string, read: ProcReader, parent: number): Proof {
  if (path !== pin.resolved) return no("parent is not the pinned claude");
  const running = read.exeIdentity(parent);
  if (running === null) return no("parent binary unreadable");
  if (running.size !== pin.size || running.mtimeMs !== pin.mtimeMs || running.ctimeMs !== pin.ctimeMs || running.ino !== pin.ino) {
    if (read.exeSha256(parent) !== pin.sha256) return no("the claude binary is not the one that was pinned");
  }
  return { ok: true };
}

// Or the binary is a signed release: a file named by its version in the pinned directory, at or above the pinned floor, whose
// sha256 (read from the running inode) a verified, cached manifest lists. The owner pinned the key, once; an update needs
// nothing more, since the update's manifest is signed by the same key.
async function signedRelease(release: ReleasePin, verify: Check["verifyRelease"], path: string, read: ProcReader, parent: number): Promise<Proof> {
  if (release.fingerprint.toLowerCase() !== CLAUDE_RELEASE_FINGERPRINT) return no("the pinned release key is not the compiled-in one");
  if (verify === undefined) return no("no release verifier");
  if (read.real(dirname(path)) !== read.real(release.versionsDir)) return no("the parent binary is outside the pinned releases directory");
  const version = basename(path);
  if (!isVersion(version) || compareVersions(version, release.floor) < 0) return no("the parent binary is not a release at or above the pinned floor");
  const sha256 = read.exeSha256(parent);
  if (sha256 === null) return no("parent binary unreadable");
  return verify(version, sha256);
}

export async function verifyClaudeParent(check: Check): Promise<Proof> {
  const read = check.read ?? procReader;
  const parent = check.ppid();
  const started = read.startMs(parent);
  const ticks = read.ticks(parent);
  const exe = read.exe(parent);
  const args = read.cmdline(parent);
  if (started === null || ticks === null || exe === null) return no("parent unreadable");
  if (args === null) return no("parent command line unreadable");
  // The binary: the pinned file or a signed release; after an update it reads "(deleted)" while that version still runs.
  const path = exe.endsWith(DELETED) ? exe.slice(0, -DELETED.length) : exe;
  let baseUrls: Record<string, string> | null = null;
  let refused: Proof = no("no pinned claude binary");
  if (check.release !== null) {
    const proof = await signedRelease(check.release, check.verifyRelease, path, read, parent);
    if (proof.ok) baseUrls = check.release.baseUrls; else refused = proof;
  }
  if (baseUrls === null && check.pin !== null) {
    const proof = pinnedBinary(check.pin, path, read, parent);
    if (proof.ok) baseUrls = check.pin.baseUrls; else if (check.release === null) refused = proof;
  }
  if (baseUrls === null) return refused;
  // The API host: the parent's own environment, read from /proc, names the host the owner pinned for this connection.
  const entries = read.environ(parent);
  const pinned = baseUrls[check.connection];
  if (entries === null || pinned === undefined) return no("the parent is not pointed at the pinned API host");
  // A name that occurs twice could be read one way here and taken the other way by the process: refused, for every name
  // that is checked.
  const seen = new Set<string>();
  for (const [name] of entries) {
    if (seen.has(name) && (name === "ANTHROPIC_BASE_URL" || name === "NODE_TLS_REJECT_UNAUTHORIZED" || INTERCEPTING_ENV.test(name))) return no(`the parent's environment names ${name} twice`);
    seen.add(name);
  }
  const env = Object.fromEntries(entries);
  if (sameBase(env.ANTHROPIC_BASE_URL, pinned) !== true) return no("the parent is not pointed at the pinned API host");
  const intercepts = Object.entries(env).find(([name, value]) => INTERCEPTING_ENV.test(name) || (name === "NODE_TLS_REJECT_UNAUTHORIZED" && value === "0"));
  if (intercepts !== undefined) return no(`the parent's environment can put another party on the line: ${intercepts[0]}`);
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
    if (file === null) return no("settings unreadable");
    // A symlink in the path could be swapped without the file's own ctime moving: none is accepted.
    if (read.linked(file)) return no("settings path goes through a symlink");
    const seen = read.file(file);
    if (seen === null) return no("settings unreadable");
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
