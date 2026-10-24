#!/usr/bin/env node
// morndo-usage-claude (S5, plan 4.4): the node-side collector. Reads ~/.config/morndo/usage-claude.json (path from
// MORNDO_USAGE_CLAUDE_CONFIG), and for each account asks the HUB — never the provider — for a lease every 30 s;
// only a granted lease spawns the headless read (usage-claude-run.ts), whose result is posted back as a reading or
// a failure with the lease id. The agent token is read from its file and never printed. `--once` does one pass (for
// tests and for QA).
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { productVersion } from "@morndo/service-kit";
import type { UsageReason } from "@morndo/domain";
import { childEnv } from "./runtime-claude.ts";
import { hintOf } from "./usage-claude.ts";
import { killActiveReads, readClaude } from "./usage-claude-run.ts";
import { codexReadingBody, everyFor, readCodexLimits } from "./usage-codex.ts";

export type UsageClaudeAccount = { configDir: string };
// S6 (plan 4.6): a codex account in the same config — kind "codex", the CODEX_HOME directory it reads under, and
// optionally the binary to run when the PATH's own codex is not the one (MORNDO_CODEX_BIN overrides it).
export type UsageCodexAccount = { kind: "codex"; codexHome: string; codexBin?: string };
export type UsageAccount = UsageClaudeAccount | UsageCodexAccount;
export type UsageClaudeConfig = {
  hub: string;
  tokenFile: string;
  node: string;
  accounts: Record<string, UsageAccount>;
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
  const accounts: Record<string, UsageAccount> = {};
  for (const [account, a] of Object.entries(c.accounts as Record<string, unknown>)) {
    if (account === "" || typeof a !== "object" || a === null) return null;
    const e = a as Record<string, unknown>;
    if (e.kind === undefined) {
      // a claude account, as ever: its own config directory
      if (typeof e.configDir !== "string") return null;
      accounts[account] = { configDir: e.configDir };
    } else if (e.kind === "codex") {
      if (typeof e.codexHome !== "string") return null;
      const codex: UsageCodexAccount = { kind: "codex", codexHome: e.codexHome };
      if (e.codexBin !== undefined) {
        if (typeof e.codexBin !== "string") return null;
        codex.codexBin = e.codexBin;
      }
      accounts[account] = codex;
    } else return null;
  }
  return { hub: c.hub, tokenFile: c.tokenFile, node: c.node, accounts };
}

// One codex account's pass (S6, plan 4.6): the same lease, read and post loop as a claude account, asking for source
// "app-server" and reading the app server's own account/rateLimits (never a token, never a credentials file). The
// binary is the entry's own codexBin, else the MORNDO_CODEX_BIN of the environment, else the PATH's codex; the child
// runs under the account's CODEX_HOME with the same environment pool-cli's codexEnv builds. A refused read is
// classified by its words, as the claude classifier does, with a redacted hint.
export async function codexPass(o: {
  account: string;
  hub: string;
  token: string;
  node: string;
  entry: UsageCodexAccount;
  env: NodeJS.ProcessEnv;
  now: () => number;
  post: (hub: string, path: string, token: string, headers: Record<string, string>, body: unknown) => Promise<Record<string, unknown> | null>;
}): Promise<boolean> {
  const headers = { "x-morndo-account": o.account, "x-morndo-lane": "usage-claude" };
  const lease = await o.post(o.hub, "/api/agent/usage/lease", o.token, headers, { account: o.account, source: "app-server", node: o.node });
  if (lease === null) return false;                          // the hub could not be asked: the pass is not clean
  if (lease.status !== "granted" || typeof lease.lease_id !== "string") return true;   // fresh or denied: nothing to do
  const read = await readCodexLimits({
    bin: o.entry.codexBin ?? o.env.MORNDO_CODEX_BIN ?? "codex",
    env: childEnv(o.env, { CODEX_HOME: o.entry.codexHome }),
    version: productVersion(),
  });
  const body: Record<string, unknown> = read.ok
    ? {
      ...codexReadingBody(read.limits, {
        identity: read.limits.identity ?? null,
        ordinaryUsageAllowed: read.limits.ordinaryUsageAllowed ?? null,
        rateLimitReachedType: read.limits.rateLimitReachedType ?? null,
        now: o.now(), node: o.node,
      }),
      lease_id: lease.lease_id,
    }
    : {
      source: "app-server", node: o.node, captured_at: Math.floor(o.now() / 1000), lease_id: lease.lease_id,
      every_s: everyFor(null),                              // a failed read retries at the idle pace
      failure: { reason: codexReasonOf(read.problem), hint: codexHintOf(read.problem) },
    };
  return await o.post(o.hub, "/api/agent/usage/readings", o.token, headers, body) !== null;
}

// The read's own problem, classified by its words: a sign-in problem signed_out, a limit rate_limited, a timeout
// timeout, anything else unknown_screen — the same closed list the hub keeps, never a free string.
function codexReasonOf(problem: string): UsageReason {
  const words = problem.toLowerCase();
  if (words.includes("in time")) return "timeout";
  if (words.includes("login") || words.includes("sign in") || words.includes("signed in") || words.includes("sign-in")
    || words.includes("401") || words.includes("403") || words.includes("authentication")) return "signed_out";
  if (words.includes("429") || words.includes("rate limit")) return "rate_limited";
  return "unknown_screen";
}
// Only an unknown shape carries a hint, and only its redacted head.
function codexHintOf(problem: string): string | null {
  return codexReasonOf(problem) === "unknown_screen" ? hintOf(problem) : null;
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
    if ("kind" in a) {
      // S6 (plan 4.6): a codex account runs the same loop, reading the app server under the hub's lease.
      if (!(await codexPass({ account, hub: config.hub, token, node: config.node, entry: a, env, now, post }))) clean = false;
      continue;
    }
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
