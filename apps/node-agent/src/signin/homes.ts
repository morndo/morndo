import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { SIGNIN_ACCOUNT, type SignInRuntime } from "@morndo/domain";

const exec = promisify(execFile);

export type ResolveOk = { claudeConfigDir: string | null; accountHome: string };
export type ResolveErr = { code: "not_allowed"; message: string };

export class AccountHomes {
  readonly home: string;
  readonly bins: { claude: string; cursor: string };
  readonly claudePool: string | null;

  constructor(o: { home: string; bins: { claude: string; cursor: string }; claudePool: string | null }) {
    this.home = o.home;
    this.bins = o.bins;
    this.claudePool = o.claudePool;
  }

  resolve(runtime: SignInRuntime, account: string, create: boolean): ResolveOk | ResolveErr {
    if (runtime === "cursor") {
      if (account !== "main") return { code: "not_allowed", message: "cursor_main_only" };
      return { claudeConfigDir: null, accountHome: this.home };
    }
    if (account === "main") return { claudeConfigDir: null, accountHome: join(this.home, ".claude") };
    const dir = join(this.home, ".claude-accounts", account);
    if (existsLink(dir)) return { code: "not_allowed", message: "bad_home" };
    const there = dirExists(dir);
    if (!there && !create) return { code: "not_allowed", message: "no_account" };
    if (there && create) return { code: "not_allowed", message: "exists" };
    return { claudeConfigDir: dir, accountHome: dir };
  }

  async ensure(runtime: SignInRuntime, account: string, create: boolean): Promise<ResolveOk | ResolveErr> {
    const r = this.resolve(runtime, account, create);
    if ("code" in r) return r;
    if (create && account !== "main" && runtime === "claude") {
      const dir = r.claudeConfigDir!;
      if (!dirExists(dir)) {
        if (this.claudePool) await exec(this.claudePool, ["add", account]);
        else mkdirSync(dir, { recursive: true });
      }
    }
    if (runtime === "claude" && account !== "main" && r.claudeConfigDir) chmodSync(r.claudeConfigDir, 0o700);
    return r;
  }

  listClaudeAccountNames(): string[] {
    const root = join(this.home, ".claude-accounts");
    let names: string[] = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && SIGNIN_ACCOUNT.test(d.name) && d.name !== "main")
        .map(d => d.name)
        .sort();
    } catch { /* no pool dir yet */ }
    return names;
  }
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function existsLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
