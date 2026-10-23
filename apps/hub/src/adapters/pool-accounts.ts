// Anti-corruption adapter over the pool's usage file (ADR-0034): JSON Lines, one object per account, which the pool
// alone writes; the hub only reads, and only when MORNDO_POOL_USAGE names the file. Of each line only the name, email,
// org, plan and tier are read — never an org id or anything else (the account's own files stay unopened, as ADR-0016
// ruled). The pool's vendor words ("claude_team", the tier names) are translated here and live nowhere else.
import { readFileSync, statSync } from "node:fs";
import { ACCOUNT_NAME, cleanProfile, type AccountProfile } from "@morndo/domain";

// "claude_team" is a Team seat; any other non-empty org is a personal subscription.
const orgOf = (v: unknown): "team" | "personal" | null =>
  typeof v !== "string" || v.trim() === "" ? null : v === "claude_team" ? "team" : "personal";
// The two named tiers have words; any other or missing tier shows the plan as the file writes it.
const planOf = (tier: unknown, plan: unknown): string | null =>
  tier === "default_claude_max_5x" ? "Max 5x" : tier === "default_claude_max_20x" ? "Max 20x" : typeof plan === "string" ? plan : null;

export function parsePoolAccounts(text: string): Map<string, AccountProfile> {
  const out = new Map<string, AccountProfile>();
  for (const line of text.split("\n")) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }   // a bad line is one account, not the file
    if (row == null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== "string" || !ACCOUNT_NAME.test(r.name)) continue;
    const profile = cleanProfile({ email: r.email, org: orgOf(r.org), plan: planOf(r.tier, r.plan) });
    if (profile) out.set(r.name, profile);                // a line with nothing to show leaves the name alone
  }
  return out;
}

const EMPTY: ReadonlyMap<string, AccountProfile> = new Map();

// The profiles as a getter, re-read only when the file changed (the ledger's rule). No path: always empty. A file that
// isn't there is no pool (ENOENT is normal, nothing said); any other read error is said once per distinct failure, and
// the last good map stays, so a bad moment doesn't blank the labels.
export function poolProfiles(path: string | null, log?: { warn(msg: string, e?: unknown): void }): () => ReadonlyMap<string, AccountProfile> {
  if (path === null) return () => EMPTY;
  let cache: ReadonlyMap<string, AccountProfile> = EMPTY;
  let stamp: { mtimeMs: number; size: number } | null = null;
  let saidFailure = "";
  const failed = (e: unknown): ReadonlyMap<string, AccountProfile> => {
    const code = (e as NodeJS.ErrnoException).code ?? "unreadable";
    if (code === "ENOENT") { cache = EMPTY; stamp = null; return cache; }   // gone between the stat and the read
    if (code !== saidFailure) { saidFailure = code; log?.warn(`pool usage file ${path} can't be read (${code})`); }
    return cache;
  };
  return () => {
    let st: { mtimeMs: number; size: number };
    try {
      const s = statSync(path);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (e) { return failed(e); }
    if (stamp && stamp.mtimeMs === st.mtimeMs && stamp.size === st.size) return cache;
    try {
      cache = parsePoolAccounts(readFileSync(path, "utf8"));
      stamp = st;
      saidFailure = "";
      return cache;
    } catch (e) { return failed(e); }
  };
}
