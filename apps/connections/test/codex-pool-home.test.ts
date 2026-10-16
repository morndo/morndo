// A pool turn's run home (ADR-0029, §6.5): the account's login is linked, never copied; the conversation store and Codex's own
// writer locks are shared by every account's runs; the thread index stays in the run home. Temporary homes only.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { poolRunHome, poolStore, SHARED_LINKS } from "../src/adapters/codex-pool-home.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "morndo-pool-home-")); dirs.push(dir); return dir; };

function login(config = 'cli_auth_credentials_store = "file"\n'): string {
  const dir = scratch();
  writeFileSync(join(dir, "auth.json"), "{}", { mode: 0o600 });
  writeFileSync(join(dir, "config.toml"), config);
  return dir;
}

describe("codex pool home", () => {
  it("links the account's login and the shared store, and keeps the thread index out of the shared store", () => {
    const shared = poolStore(scratch(), "codex");
    expect(statSync(shared).mode & 0o777).toBe(0o700);
    expect(readdirSync(shared).sort()).toEqual(["archived_sessions", "history.jsonl", "sessions", "thread-writer-locks"]);
    writeFileSync(join(shared, "AGENTS.md"), "Be brief.\n");
    const account = login();
    const home = poolRunHome(account, shared, 'sandbox_mode = "danger-full-access"\n', []);
    dirs.push(home);
    expect(readlinkSync(join(home, "auth.json"))).toBe(join(account, "auth.json"));
    for (const name of SHARED_LINKS) expect(readlinkSync(join(home, name))).toBe(join(shared, name));
    const config = readFileSync(join(home, "config.toml"), "utf8");
    // A shared index would keep each thread's rollout path inside this run home, which is removed after the turn, so the next
    // turn's resume would fail with "no rollout found" (live, 2026-10-16). Without it, resume finds the thread in `sessions`.
    expect(config).not.toContain("sqlite_home");
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(existsSync(join(home, "models_cache.json"))).toBe(false);
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("leaves AGENTS.md out when the store has none", () => {
    const shared = poolStore(scratch(), "codex");
    const home = poolRunHome(login(), shared, "", []);
    dirs.push(home);
    expect(readdirSync(home).sort()).toEqual(["archived_sessions", "auth.json", "config.toml", "history.jsonl", "sessions", "thread-writer-locks"]);
  });

  it("refuses a login kept in a keyring", () => {
    const shared = poolStore(scratch(), "codex");
    expect(() => poolRunHome(login('cli_auth_credentials_store = "keyring"\n'), shared, "", [])).toThrow(/keyring login stays in its own directory/);
    expect(() => poolRunHome(login('cli_auth_credentials_store = "auto"\n'), shared, "", [])).toThrow(/keyring/);
    mkdirSync(join(shared, "x"), { recursive: true });
  });
});
