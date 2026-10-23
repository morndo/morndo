// Anti-corruption adapter over the pool's usage file (ADR-0034): JSON Lines, one object per account, which the pool
// alone writes; the hub only reads, and only when MORNDO_POOL_USAGE names the file. Of each line only the name, email,
// org, plan and tier are read — never an org id or anything else (the account's own files stay unopened, as ADR-0016
// ruled). Only a regular file under POOL_FILE_MAX_BYTES is read, and never in the event loop's way: the file is
// opened without waiting for a writer (a named pipe would block), checked on the open handle, and read asynchronously.
// The pool's vendor words ("claude_team", the tier names) are translated here and live nowhere else.
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { ACCOUNT_NAME, cleanProfile, type AccountProfile } from "@morndo/domain";

// "claude_team" is a Team seat; any other non-empty org is a personal subscription.
const orgOf = (v: unknown): "team" | "personal" | null =>
  typeof v !== "string" || v.trim() === "" ? null : v === "claude_team" ? "team" : "personal";
// The two named tiers have words; any other or missing tier shows the plan as the file writes it.
const planOf = (tier: unknown, plan: unknown): string | null =>
  tier === "default_claude_max_5x" ? "Max 5x" : tier === "default_claude_max_20x" ? "Max 20x" : typeof plan === "string" ? plan : null;

// What the hub will read of the file: a pool of a few dozen accounts is a few KiB. Over it, the file is left alone.
export const POOL_FILE_MAX_BYTES = 1024 * 1024;

// A line that doesn't parse still names its account when the cut came after the name (the pool writes the name first).
const NAMED = /^\s*\{\s*"name"\s*:\s*"([^"\\]+)"/;

// `damaged`: accounts whose line is there but can't be read (a file caught mid-write). They are not "gone".
export function readPoolText(text: string): { profiles: Map<string, AccountProfile>; damaged: Set<string> } {
  const profiles = new Map<string, AccountProfile>();
  const damaged = new Set<string>();
  for (const line of text.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch {            // a bad line is one account, not the file
      const named = NAMED.exec(line)?.[1];
      if (named !== undefined && ACCOUNT_NAME.test(named)) damaged.add(named);
      continue;
    }
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== "string" || !ACCOUNT_NAME.test(r.name)) continue;
    const profile = cleanProfile({ email: r.email, org: orgOf(r.org), plan: planOf(r.tier, r.plan) });
    if (profile) profiles.set(r.name, profile);          // a line with nothing to show leaves the name alone
  }
  return { profiles, damaged };
}
export const parsePoolAccounts = (text: string): Map<string, AccountProfile> => readPoolText(text).profiles;

const EMPTY: ReadonlyMap<string, AccountProfile> = new Map();
const same = (a: ReadonlyMap<string, AccountProfile>, b: ReadonlyMap<string, AccountProfile>) => JSON.stringify([...a]) === JSON.stringify([...b]);

export type PoolProfiles = {
  current: () => ReadonlyMap<string, AccountProfile>;    // what the last look found; never reads, never waits
  refresh: () => Promise<boolean>;                        // look at the file again (when it changed); true when the profiles changed
};

// The profiles of the pool's file, looked at on demand and never in the event loop's way. No path: always empty. A file
// that isn't there is no pool (ENOENT is normal, nothing said). A file that is not a regular one, or over the cap, or
// can't be read is said once per distinct failure (path and size only, never content), and the last good profiles
// stay, so a bad moment doesn't blank the labels. A line cut in the middle keeps its account's last good profile.
export function poolProfiles(path: string | null, log?: { warn(msg: string, e?: unknown): void }): PoolProfiles {
  if (path === null) return { current: () => EMPTY, refresh: async () => false };
  let cache: ReadonlyMap<string, AccountProfile> = EMPTY;
  let stamp: { mtimeMs: number; size: number } | null = null;
  let said = "";
  let looking: Promise<boolean> | null = null;
  const say = (key: string, msg: string) => { if (key !== said) { said = key; log?.warn(msg); } };
  const take = (next: ReadonlyMap<string, AccountProfile>): boolean => {
    if (same(cache, next)) return false;
    cache = next;
    return true;
  };
  const readAll = async (h: FileHandle): Promise<string | null> => {
    const buf = Buffer.alloc(POOL_FILE_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await h.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    return n > POOL_FILE_MAX_BYTES ? null : buf.toString("utf8", 0, n);
  };
  const look = async (p: string): Promise<boolean> => {
    let h: FileHandle;
    try { h = await open(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
      if (code === "ENOENT") { stamp = null; said = ""; return take(EMPTY); }
      say(code, `pool usage file ${p} can't be read (${code})`);
      return false;
    }
    try {
      const st = await h.stat();                                   // on the open handle: nothing can swap in between
      if (!st.isFile()) { say("not-regular", `pool usage file ${p} is not a regular file`); return false; }
      if (st.size > POOL_FILE_MAX_BYTES) { say("too-large", `pool usage file ${p} is too large (${st.size} bytes)`); return false; }
      if (stamp && stamp.mtimeMs === st.mtimeMs && stamp.size === st.size) return false;
      const text = await readAll(h);
      if (text === null) { say("too-large", `pool usage file ${p} is too large (over ${POOL_FILE_MAX_BYTES} bytes)`); return false; }
      const { profiles, damaged } = readPoolText(text);
      for (const name of damaged) {
        const kept = cache.get(name);
        if (!profiles.has(name) && kept) profiles.set(name, kept);
      }
      stamp = { mtimeMs: st.mtimeMs, size: st.size };
      said = "";
      return take(profiles);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
      say(code, `pool usage file ${p} can't be read (${code})`);
      return false;
    } finally { await h.close().catch(() => {}); }
  };
  return {
    current: () => cache,
    refresh: () => (looking ??= look(path).finally(() => { looking = null; })),
  };
}
