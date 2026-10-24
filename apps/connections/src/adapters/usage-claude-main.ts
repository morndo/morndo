#!/usr/bin/env node
// morndo-usage-claude (S5, plan 4.4): the node-side collector. Reads ~/.config/morndo/usage-claude.json (path from
// MORNDO_USAGE_CLAUDE_CONFIG), and for each account asks the HUB — never the provider — for a lease every 30 s;
// only a granted lease spawns the headless read (usage-claude-run.ts), whose result is posted back as a reading or
// a failure with the lease id. The agent token is read from its file and never printed. `--once` does one pass (for
// tests and for QA). This file is round 1's stub: the types and the bin wiring are real, the pass itself is not yet.
export type UsageClaudeAccount = { configDir: string };
export type UsageClaudeConfig = {
  hub: string;
  tokenFile: string;
  node: string;
  accounts: Record<string, UsageClaudeAccount>;
};

// One pass over the config's accounts: a lease ask for each, and a read and a post only for a granted one. Returns
// the bin's exit code (0: the pass ran; 1: it could not). The token is read from tokenFile and never printed.
export async function collectOnce(p: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => number;
}): Promise<number> {
  void p;
  throw new Error("not implemented");
}

// The bin's own entry: `--once` for a single pass, else the loop every 30 s.
export async function runCollector(argv: readonly string[], env: NodeJS.ProcessEnv, io: { stdout(text: string): void; stderr(text: string): void }): Promise<number> {
  void argv; void env; void io;
  throw new Error("not implemented");
}

// Runs only when executed as the bin (node …/usage-claude-main.ts [--once]), never when a test imports this module.
if (process.argv[1]?.endsWith("usage-claude-main.ts")) {
  const code = await runCollector(process.argv.slice(2), process.env, {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
  });
  process.exit(code);
}
