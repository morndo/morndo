// A pool turn's run home (ADR-0029, §6.5). Like `subscriptionRunHome`, it links the account's login instead of copying it, and
// adds links to one conversation store shared by every account, so a session can go on under another account:
// - `sessions` is linked as a whole directory: Codex follows a linked sessions root but skips links inside it
//   (codex-rs/rollout/src/list.rs#L1456-1463, tag rust-v0.161.0);
// - `thread-writer-locks` is Codex's own per-thread writer lock, "Coordinates writer ownership within one Codex home"
//   (codex-rs/rollout/src/writer_lock.rs), so one directory makes it cover every account's runs;
// - the thread index (SQLite) is not shared: it records each thread's rollout under this run home's own path, and the run
//   home is removed after the turn, so a shared index sent the next turn's resume to a missing file ("no rollout found",
//   0.161.0, live 2026-10-16). Each run keeps its own index, and resume finds the thread by scanning the linked `sessions`.
// Not shared: auth.json, models_cache.json (its key must change with the account) and secrets/.
// https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/rollout/src/list.rs
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatusRefused } from "./runtime-claude.ts";
import { codexConfig, keyringLogin } from "./runtime-codex.ts";

export const SHARED_LINKS: readonly string[] = ["sessions", "archived_sessions", "history.jsonl", "thread-writer-locks", "AGENTS.md"];
const DIRECTORIES = ["sessions", "archived_sessions", "thread-writer-locks"];

// <data>/<runtime>, mode 0700, with its directories made.
export function poolStore(dataDir: string, runtime: string): string {
  const store = join(dataDir, runtime);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  for (const name of DIRECTORIES) mkdirSync(join(store, name), { recursive: true, mode: 0o700 });
  const history = join(store, "history.jsonl");
  if (!existsSync(history)) writeFileSync(history, "", { mode: 0o600 });
  return store;
}

export function poolRunHome(login: string, shared: string, profile: string, deny: readonly string[]): string {
  let text = "";
  try { text = readFileSync(join(login, "config.toml"), "utf8"); } catch { /* no config: the file store is the default */ }
  if (keyringLogin(text)) throw new StatusRefused("a keyring login stays in its own directory; this run uses another home and cannot find it");
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-run-"));
  const auth = join(login, "auth.json");
  // A link, as in subscriptionRunHome: a token refresh writes through it into the account's own file.
  if (existsSync(auth)) symlinkSync(auth, join(dir, "auth.json"));
  for (const name of SHARED_LINKS) {
    const target = join(shared, name);
    if (name === "AGENTS.md" && !existsSync(target)) continue;
    if (!existsSync(target) && DIRECTORIES.includes(name)) mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, join(dir, name));
  }
  writeFileSync(join(dir, "config.toml"), codexConfig(profile, deny, ""), { mode: 0o600 });
  return dir;
}
