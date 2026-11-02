import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIGNIN_ACCOUNT, type SignInRuntime } from "@morndo/domain";
import { tmuxArgv } from "@morndo/node-ops";


export type CreatedHomeRecord = { runtime: SignInRuntime; account: string };

const filePath = (stateDir: string) => join(stateDir, "signin-created-homes.json");

function readRecords(stateDir: string): CreatedHomeRecord[] {
  try {
    const raw = readFileSync(filePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is CreatedHomeRecord =>
      r !== null && typeof r === "object"
      && (r as CreatedHomeRecord).runtime === "claude"
      && typeof (r as CreatedHomeRecord).account === "string"
      && SIGNIN_ACCOUNT.test((r as CreatedHomeRecord).account)
      && (r as CreatedHomeRecord).account !== "main");
  } catch { return []; }
}

function writeRecords(stateDir: string, rows: CreatedHomeRecord[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath(stateDir), `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  try { chmodSync(filePath(stateDir), 0o600); } catch { /* best effort */ }
}

export function recordSignInCreatedHome(stateDir: string, row: CreatedHomeRecord): void {
  const rows = readRecords(stateDir);
  if (rows.some(r => r.runtime === row.runtime && r.account === row.account)) return;
  rows.push(row);
  writeRecords(stateDir, rows);
}

function maybeRemoveClaudeHome(agentHome: string, account: string): void {
  if (!SIGNIN_ACCOUNT.test(account) || account === "main") return;
  const dir = join(agentHome, ".claude-accounts", account);
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return;
    if (existsSync(join(dir, ".credentials.json"))) return;
    rmSync(dir, { recursive: true, force: true });
  } catch { /* leave alone */ }
}

export function reconcileSignInLeftovers(o: { stateDir: string; agentHome: string; tmuxSocket: string }): void {
  // Synchronous, so it is over before the node takes a sign-in; no server (the usual case) is an error caught here, never
  // an unhandled rejection (the agent exits on one).
  try { execFileSync("tmux", tmuxArgv(o.tmuxSocket, ["kill-server"]), { stdio: "ignore", timeout: 5000 }); } catch { /* no server */ }
  // A cleanup at start never stops the agent: whatever it cannot do now waits for the next start.
  try {
    for (const row of readRecords(o.stateDir)) {
      if (row.runtime === "claude") maybeRemoveClaudeHome(o.agentHome, row.account);
    }
    writeRecords(o.stateDir, []);
  } catch { /* left for the next start */ }
}
