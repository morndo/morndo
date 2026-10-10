// Which files may leave this machine's disk (ADR-0006 addendum "Files", ADR-0012 decision 5): anything over the size cap,
// anything that isn't a regular file, and anything where credentials or Morndo's own services keep their state (the
// deny list, checked on the resolved real path, so a symbolic link doesn't get around it) is refused, whatever asks for
// it. Moved from the hub's files.ts (fleet core, Task 2): the hub's copies and a node's file ops apply the same rules.
import { constants, readdirSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { LIMITS } from "@morndo/protocol";

export const MAX_FILE_BYTES = LIMITS.maxFileBytes;                  // 25 MiB: one definition, the protocol's
// Secrets by their name, wherever they are: keys, certificates, .env files and credentials files, Claude Code's own
// .credentials.json among them (~/.claude/.credentials.json, and each ~/.claude-accounts/<name>/.credentials.json), git's
// credential store (.git-credentials), Cargo's registry tokens (credentials.toml), PostgreSQL's passwords (.pgpass), and
// Claude Code's .claude.json (its account and MCP server settings; ~/.claude.json, one in each account's directory, and
// its .backup copies), and API-key files: `api-key`, `api_key`, `apikey`, `*_api_key`, `*-api-key`, or `key-` and digits
// (`key-1`), plus a backup suffix `.bak`, `.old`, `.txt` or `~`. A source or doc suffix (`.ts`, `.md`, `.py`) stays readable.
export const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|kdbx|keystore|jks)|\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.claude\.json(\..+)?|credentials\.toml|\.?credentials(\.json)?|(?:(?:.*[-_.])?api[-_]?key|key-[0-9]+)(?:\.(?:bak|old|txt)|~)?)$/i;

// Where the engine layer, Claude Code and the connections store keep their files, once the caller has resolved them.
// `enginesConfig` is the ENGINES_CONFIG file. `claudeConfigDir` is one or more Claude config directories (the
// environment's CLAUDE_CONFIG_DIR and MORNDO_CLAUDE_DIR together). `xdgConfigHome` is XDG_CONFIG_HOME. `storeConfig`
// is the connections store's own directory. `legacy` adds older credit-key directories; it does not replace the
// default ~/.config/claude-credits.
export type DenyConfig = {
  enginesConfig?: string | null;
  claudeConfigDir?: string | readonly string[] | null;
  xdgConfigHome?: string | null;
  storeConfig?: string | null;
  legacy?: readonly string[];
};

const given = (v: string | null | undefined): v is string => typeof v === "string" && v.length > 0;

function claudeDirs(config: DenyConfig): string[] {
  const raw = config.claudeConfigDir;
  if (typeof raw === "string") return given(raw) ? [raw] : [];
  if (raw == null) return [];
  return raw.filter(given);
}

// MORNDO_CLAUDE_DIR is added to the directory the environment already named. It never replaces that directory.
export function denyConfigWithClaudeDir(fromEnv: DenyConfig, claudeDir: string | null): DenyConfig {
  const listed = [...claudeDirs(fromEnv), ...(given(claudeDir) ? [claudeDir] : [])];
  const unique = listed.filter((p, i) => listed.indexOf(p) === i);
  if (unique.length === 0) {
    const { claudeConfigDir: _omit, ...rest } = fromEnv;
    return rest;
  }
  return { ...fromEnv, claudeConfigDir: unique };
}

export function denyConfigFromEnv(env: Record<string, string | undefined>): DenyConfig {
  return {
    ...(given(env.ENGINES_CONFIG) ? { enginesConfig: env.ENGINES_CONFIG } : {}),
    ...(given(env.CLAUDE_CONFIG_DIR) ? { claudeConfigDir: env.CLAUDE_CONFIG_DIR } : {}),
    ...(given(env.XDG_CONFIG_HOME) ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
    ...(given(env.MORNDO_CONNECTIONS_CONFIG) ? { storeConfig: env.MORNDO_CONNECTIONS_CONFIG } : {}),
    ...(given(env.MORNDO_LEGACY_KEY_DIR) ? { legacy: [env.MORNDO_LEGACY_KEY_DIR] } : {}),
  };
}

// Places that hold credentials, or the state of Morndo's own services: the hub's morndo.db, the fleet's fleet.db and
// key, a node agent's agent.db, key, config and policy (~/.local/share/morndo*, ~/.local/state/morndo*,
// ~/.config/morndo*), kira's state, the engine layer's settings and the connections store (under XDG_CONFIG_HOME, or
// ~/.config when it is unset), Claude config directories, the default credit-key directory plus any the caller adds,
// and the caller's own data directory. Nothing under them is ever read for someone else. An entry ending in
// "*" is a prefix: "~/.config/morndo*" covers morndo, morndo-fleet and morndo-node. HOME and the working directory
// are never roots. ENGINES_CONFIG denies that file, and its directory only when the directory is a dedicated config
// dir; a relative path is ignored.
function enginesPlaces(home: string, xdg: string, config: DenyConfig): string[] {
  const engines = [join(home, ".config", "engines"), join(xdg, "engines")];
  if (!given(config.enginesConfig)) return engines;
  if (!isAbsolute(config.enginesConfig)) {
    process.stderr.write(`ENGINES_CONFIG ignored: not an absolute path (${config.enginesConfig})\n`);
    return engines;
  }
  const file = normalize(config.enginesConfig);
  const homeN = normalize(home);
  const cwd = normalize(process.cwd());
  if (file === homeN || file === cwd || file === "/") {
    process.stderr.write(`ENGINES_CONFIG ignored: refusing to deny ${file}\n`);
    return engines;
  }
  engines.push(file);
  const dir = dirname(file);
  if (dir !== homeN && dir !== cwd && dir !== "/" && dir !== ".") engines.push(dir);
  return engines;
}

export function denyRoots(home: string, dataDir: string, config: DenyConfig = {}): string[] {
  const xdg = given(config.xdgConfigHome) ? config.xdgConfigHome : join(home, ".config");
  const store = given(config.storeConfig) ? config.storeConfig : join(xdg, "morndo-connections");
  const credits = join(home, ".config", "claude-credits");
  const legacy = [credits, ...(config.legacy ?? []).filter(p => p !== credits)];
  const banned = new Set([normalize(home), normalize(process.cwd()), "/"]);
  const roots = [
    ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".password-store", ".local/share/keyrings", ".claude/.credentials.json", ".claude.json", ".git-credentials", ".vnc",
      ".local/share/morndo*", ".local/state/morndo*", ".config/morndo*", ".local/share/kira", ".config/kira"].map(p => join(home, p)),
    ...enginesPlaces(home, xdg, config), store, join(xdg, "morndo*"),
    ...claudeDirs(config),
    ...legacy,
    "/etc", "/proc", "/sys", "/dev", "/root", dataDir,
  ];
  return roots.filter(r => !banned.has(normalize(r.endsWith("*") ? r.slice(0, -1) : r)));
}

// macOS and Windows volumes are case-insensitive by default, and realpath does not canonicalize case there: ".SSH/config"
// is the file ".ssh/config". Paths and roots are compared case-folded on those platforms (on a case-sensitive volume
// that over-denies, the safe side); elsewhere exactly. The one place deny roots are compared.
const caseless = process.platform === "darwin" || process.platform === "win32";
const fold = (p: string) => (caseless ? p.toLowerCase() : p);

// Whether `path` is one of `roots` or lies under one; a root ending in "*" covers every path that starts with the rest.
export function deniedBy(path: string, roots: readonly string[]): boolean {
  const p = fold(path);
  return roots.map(fold).some(r => (r.endsWith("*") ? p.startsWith(r.slice(0, -1)) : p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)));
}
// Each root as given and resolved: a real path never runs through a symbolic link, so a home behind one (macOS keeps
// its temporary folders under /var, a link to /private/var) is still caught. A "*" root resolves its directory. Whoever
// judges a resolved path (a real path) against deny roots passes the roots through here first (a node's lane.start too).
export const resolvedRoots = (roots: readonly string[]): string[] => roots.flatMap(r => {
  const star = r.endsWith("*");
  const base = star ? dirname(r) : r;
  let real: string;
  try { real = realpathSync.native(base); } catch { return [r]; }
  if (!star) return real === base ? [r] : [r, real];
  const out = [r];
  if (real !== base) out.push(join(real, basename(r)));                 // the "*" over the resolved parent
  const prefix = basename(r).slice(0, -1);                              // "morndo" from "morndo*"
  try {
    for (const name of readdirSync(real)) {
      if (!name.startsWith(prefix)) continue;
      const entry = join(real, name);
      try { const er = realpathSync.native(entry); if (er !== entry) out.push(er); } catch { /* gone meanwhile */ }
    }
  } catch { /* parent unreadable: fall back to the prefix root alone */ }
  return out;
});

type Refusal = { ok: false; reason: "missing" | "denied" | "secret" | "too_large" | "not_file" };

// Whether a file on this machine may be read for someone else (a node's file ops, its hook relay's copies), by the
// rules above: an absolute path; no secret's name, asked for or resolved; nothing under a deny root, asked for or
// resolved; a regular file of at most MAX_FILE_BYTES. With `roots` (a node policy's fileRoots), the resolved path must
// also lie under one of them. The path as asked for is judged before the disk is touched, so whether something exists
// under a deny root is never told.
export function confine(path: string, opts: { home: string; dataDir: string; roots?: string[]; deny?: DenyConfig }): { ok: true; real: string; size: number } | Refusal {
  const j = judge(path, opts);
  return j.ok ? { ok: true, real: j.real, size: j.size } : j;
}

// confine()'s rules, plus the identity (st_dev, st_ino) of the file they judged, so openConfined can prove the handle it
// opens is that same file (CERT FIO05-C: "The st_ino and st_dev fields, taken together, uniquely identify the file").
function judge(path: string, opts: { home: string; dataDir: string; roots?: string[]; deny?: DenyConfig }): { ok: true; real: string; size: number; dev: number; ino: number } | Refusal {
  if (!isAbsolute(path)) return { ok: false, reason: "denied" };
  const deny = resolvedRoots(denyRoots(opts.home, opts.dataDir, opts.deny));
  const asked = normalize(path);                                      // "a/../.ssh" judged as ".ssh", before the disk
  if (SECRET_NAME.test(basename(asked))) return { ok: false, reason: "secret" };
  if (deniedBy(asked, deny)) return { ok: false, reason: "denied" };
  let real: string;
  let st: Stats;
  try { real = realpathSync.native(path); st = statSync(real); } catch { return { ok: false, reason: "missing" }; }
  if (!st.isFile()) return { ok: false, reason: "not_file" };
  if (SECRET_NAME.test(basename(real))) return { ok: false, reason: "secret" };
  if (deniedBy(real, deny)) return { ok: false, reason: "denied" };
  if (opts.roots && !deniedBy(real, resolvedRoots(opts.roots))) return { ok: false, reason: "denied" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, real, size: st.size, dev: st.dev, ino: st.ino };
}

// Opens a resolved path for reading without following a link in its last component (O_NOFOLLOW, open(2)): a link put
// there after confine() looked fails with ELOOP instead of being followed.
export function openNoFollow(real: string): Promise<FileHandle> {
  return open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
}

// darwin's O_NOFOLLOW_ANY (xnu bsd/sys/fcntl.h: 0x20000000, "no symlinks allowed in path"; Node has no constant for it):
// an open through a link in ANY component of the path fails with ELOOP. Used alone: ORed with O_NOFOLLOW the open fails
// with EINVAL.
const O_NOFOLLOW_ANY = 0x20000000;

// Opens confine()'s real path (which holds no link) refusing a link anywhere in it where the system can (darwin, so a
// parent swapped for a link even before confine()'s stat is refused); elsewhere only in its last component
// (openNoFollow), and openConfined's dev/ino check catches a parent swapped after confine()'s stat. On Linux the kernel's
// path of the open file (openedAt) catches one swapped in before that stat too. Elsewhere that one window remains: a
// parent swapped for a link between confine()'s realpath and its stat (the stat already follows the link, so the
// identity judged is the link target's and the dev/ino check agrees with the open).
function openResolved(real: string): Promise<FileHandle> {
  return process.platform === "darwin" ? open(real, constants.O_RDONLY | O_NOFOLLOW_ANY) : openNoFollow(real);
}

// Linux: the path the kernel opened. /proc/self/fd/<fd> "is a symbolic link to the actual file" (proc_pid_fd(5)), so an
// open that went through a link swapped in anywhere in the path shows the link's target there; an unlinked file shows
// " (deleted)" appended (proc_pid_exe(5)). null when /proc can't be read.
function openedAt(fh: FileHandle): string | null {
  try { return readlinkSync(`/proc/self/fd/${fh.fd}`); } catch { return null; }
}

// confine(), then the file opened with openNoFollow and checked again on the open file (a regular file, at most
// MAX_FILE_BYTES): something swapped in after confine() looked is refused, never read. Every read a node does for
// someone else goes through here; the caller reads from `fh` and closes it.
export async function openConfined(path: string, opts: { home: string; dataDir: string; roots?: string[]; deny?: DenyConfig }):
  Promise<{ ok: true; fh: FileHandle; real: string; size: number } | Refusal> {
  const c = judge(path, opts);
  if (!c.ok) return c;
  let fh: FileHandle;
  try { fh = await openResolved(c.real); }
  catch (e) { return { ok: false, reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "denied" }; }   // ELOOP: a link now
  const st = await fh.stat();
  if (st.dev !== c.dev || st.ino !== c.ino) { await fh.close(); return { ok: false, reason: "denied" }; }   // a parent swapped between check and open
  if (process.platform === "linux") {                       // fails closed: another path, an unlinked file, no /proc
    const at = openedAt(fh);
    if (at === null || at !== c.real || at.endsWith(" (deleted)")) { await fh.close(); return { ok: false, reason: "denied" }; }
  }
  const reason = !st.isFile() ? "not_file" : st.size > MAX_FILE_BYTES ? "too_large" : null;
  if (reason) { await fh.close(); return { ok: false, reason }; }
  return { ok: true, fh, real: c.real, size: st.size };
}
