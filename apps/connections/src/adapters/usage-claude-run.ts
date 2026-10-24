// The spawn half of the Claude usage read (plan 4.4): runs the CLI's own headless `/usage` under the account's own
// config directory and hands parseClaudeReport (usage-claude.ts) its stdout. The child gets the parent's environment
// minus every token variable (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN deleted) plus
// CLAUDE_CONFIG_DIR; stdin is /dev/null, stderr is never read or logged, and the run is its own process group, the
// whole group killed at the timeout (the read took 120.8 s on a loaded box, so the timeout is 180 s). Rationed on
// the node: one headless read at a time (a node-wide semaphore) and a per-account lock file
// `${lockDir}/claude-usage-${account}.lock` holding { pid, startedAt }; a lock whose pid is gone, or older than
// 210 s, is stale and taken over; a live fresh one answers "unreachable" without spawning. After a signed_out result
// the reader checks `<bin> auth status` (local, no network; exit 0 means signed in) before the next spawn for that
// account, and spawns again only when it reports signed in or 6 hours passed.
import type { ClaudeReadResult } from "./usage-claude.ts";

export const CLAUDE_USAGE_TIMEOUT_MS = 180_000;
export const CLAUDE_LOCK_MS = 210_000;
export const SIGNED_OUT_GATE_MS = 6 * 3_600_000;
export const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--output-format", "stream-json", "--verbose", "--no-session-persistence"] as const;
// The token variables never passed to the child (plan 4.4): the read is the account's own login under its config
// directory, never a token this process holds.
export const TOKEN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

// What a spawn returns: enough to read stdout, to kill the whole group and to know how it ended. A test's fake
// spawner implements the same shape.
export type Spawned = {
  pid: number;
  stdout: AsyncIterable<Uint8Array>;
  kill(signal?: string): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
};
export type Spawner = (bin: string, args: readonly string[], o: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: "ignore";
  stderr: "ignore";
  detached: boolean;
}) => Spawned;

// Reads once, rationed on this node: the lock and the semaphore first, then the spawn, then the parse. `bin` comes
// from opts, else the MORNDO_CLAUDE_BIN of this process's environment, else "claude". The lock lives in lockDir;
// `now` is injected so a test can age a lock.
export async function readClaude(opts: {
  account: string;
  configDir: string;
  bin?: string;
  timeoutMs?: number;
  now: () => number;
  lockDir: string;
  spawn?: Spawner;
}): Promise<ClaudeReadResult> {
  void opts;
  throw new Error("not implemented");
}
