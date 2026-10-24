#!/usr/bin/env node
// morndo-usage-claude (S5, plan 4.4): the node-side collector. Reads ~/.config/morndo/usage-claude.json (path from
// MORNDO_USAGE_CLAUDE_CONFIG), and for each account asks the HUB — never the provider — for a lease every 30 s;
// only a granted lease spawns the headless read (usage-claude-run.ts), whose result is posted back as a reading or
// a failure with the lease id. The agent token is read from its file and never printed. `--once` does one pass (for
// tests and for QA).
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { killActiveReads, readClaude } from "./usage-claude-run.ts";

export type UsageClaudeAccount = { configDir: string };
export type UsageClaudeConfig = {
  hub: string;
  tokenFile: string;
  node: string;
  accounts: Record<string, UsageClaudeAccount>;
};

const LOOP_MS = 30_000;
const DEFAULT_CONFIG = () => join(homedir(), ".config", "morndo", "usage-claude.json");

function loadConfig(path: string): UsageClaudeConfig | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.hub !== "string" || typeof c.tokenFile !== "string" || typeof c.node !== "string"
    || typeof c.accounts !== "object" || c.accounts === null) return null;
  const accounts: Record<string, UsageClaudeAccount> = {};
  for (const [account, a] of Object.entries(c.accounts as Record<string, unknown>)) {
    if (account === "" || typeof a !== "object" || a === null || typeof (a as Record<string, unknown>).configDir !== "string") return null;
    accounts[account] = { configDir: (a as Record<string, unknown>).configDir as string };
  }
  return { hub: c.hub, tokenFile: c.tokenFile, node: c.node, accounts };
}

// One POST to the hub, with the agent token in the header — never in a body and never in a line of output. The
// answer's JSON, or null when the hub could not be asked.
async function post(hub: string, path: string, token: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${hub}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

// One pass over the config's accounts: a lease ask for each, and a read and a post only for a granted one. Returns
// the bin's exit code (0: the pass ran; 1: it could not). The token is read from tokenFile and never printed.
export async function collectOnce(p: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => number;
}): Promise<number> {
  const env = p.env ?? process.env;
  const stderr = p.stderr ?? (() => {});
  const now = p.now ?? Date.now;
  const configPath = p.configPath ?? env.MORNDO_USAGE_CLAUDE_CONFIG ?? process.env.MORNDO_USAGE_CLAUDE_CONFIG ?? DEFAULT_CONFIG();
  const config = loadConfig(configPath);
  if (config === null) { stderr(`morndo-usage-claude: no readable config at ${configPath}\n`); return 1; }
  let token = "";
  try { token = readFileSync(config.tokenFile, "utf8").trim(); } catch { stderr("morndo-usage-claude: the token file cannot be read\n"); return 1; }
  if (token === "") { stderr("morndo-usage-claude: the token file is empty\n"); return 1; }
  // The node's lock directory sits beside the config, one lock file per account.
  const lockDir = join(dirname(configPath), "usage-claude-locks");
  mkdirSync(lockDir, { recursive: true });
  let clean = true;
  for (const [account, a] of Object.entries(config.accounts)) {
    const headers = { "x-morndo-account": account, "x-morndo-lane": "usage-claude" };
    const lease = await post(config.hub, "/api/agent/usage/lease", token, headers, { account, source: "claude-usage", node: config.node });
    if (lease === null) { stderr(`morndo-usage-claude: the hub could not be asked about ${account}\n`); clean = false; continue; }
    if (lease.status !== "granted" || typeof lease.lease_id !== "string") continue;      // fresh or denied: nothing to do
    const read = await readClaude({ account, configDir: a.configDir, now, lockDir, env, ...(env.MORNDO_CLAUDE_BIN !== undefined ? { bin: env.MORNDO_CLAUDE_BIN } : {}) });
    const body: Record<string, unknown> = read.ok
      ? { source: "claude-usage", node: config.node, captured_at: Math.floor(now() / 1000), lease_id: lease.lease_id, windows: read.windows }
      : {
        source: "claude-usage", node: config.node, captured_at: Math.floor(now() / 1000), lease_id: lease.lease_id,
        failure: { reason: read.reason, hint: read.hint }, ...(read.retryAfterS !== null ? { retry_after_s: read.retryAfterS } : {}),
      };
    const posted = await post(config.hub, "/api/agent/usage/readings", token, headers, body);
    if (posted === null) { stderr(`morndo-usage-claude: the reading for ${account} could not be posted\n`); clean = false; }
  }
  return clean ? 0 : 1;
}

// The bin's own entry: `--once` for a single pass, else the loop every 30 s.
export async function runCollector(argv: readonly string[], env: NodeJS.ProcessEnv, io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  for (;;) {
    const code = await collectOnce({ env, stdout: (s: string) => { io.stdout(s); }, stderr: (s: string) => { io.stderr(s); } });
    if (argv.includes("--once")) return code;
    await new Promise(resolve => setTimeout(resolve, LOOP_MS));
  }
}

// Runs only when executed as the bin (node …/usage-claude-main.ts [--once]), never when a test imports this module.
if (process.argv[1]?.endsWith("usage-claude-main.ts")) {
  // The collector dies with its reads (fix round 2026-10-24, finding 4): SIGTERM, SIGINT and exit each kill every
  // active read's whole process group, so a collector stopped mid-read leaves no child running.
  const die = (): never => { killActiveReads(); process.exit(1); };
  process.on("SIGTERM", die);
  process.on("SIGINT", die);
  process.on("exit", killActiveReads);
  const code = await runCollector(process.argv.slice(2), process.env, {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  });
  process.exit(code);
}
