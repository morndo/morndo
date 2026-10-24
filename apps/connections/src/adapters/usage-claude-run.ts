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
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeReport, type ClaudeReadResult } from "./usage-claude.ts";

export const CLAUDE_USAGE_TIMEOUT_MS = 180_000;
export const CLAUDE_LOCK_MS = 210_000;
export const SIGNED_OUT_GATE_MS = 6 * 3_600_000;
// `--tools ""` runs the read with no tools at all (fix round 2026-10-24, finding 4): the lane confirmed the real CLI
// still prints the usage report with it, and a reader that cannot be talked into a tool is a reader that can only read.
export const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--tools", "", "--output-format", "stream-json", "--verbose", "--no-session-persistence"] as const;
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

// The node's own rationing, shared by every read this process starts.
const semaphore: { tail: Promise<unknown> } = { tail: Promise.resolve() };      // one headless read at a time on the node
const signedOutUntil = new Map<string, number>();                              // per account: when the auth gate opens again
// Every headless read this process has running (fix round 2026-10-24, finding 4): the collector kills them all —
// each by its whole process group — on SIGTERM, SIGINT and exit, so a collector that dies mid-read leaves nothing
// running, and removes the working directory each one was given (a process that exits does not run the read's own
// cleanup). Each read is kept with that directory and cleared as it ends.
const activeReads = new Map<Spawned, string>();

// Kills every active read's whole process group (finding 4) and removes its working directory. Safe to call at any
// time, and from an exit handler.
export function killActiveReads(): void {
  for (const [proc, cwd] of [...activeReads]) {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* the read's own cleanup will try again */ }
  }
}

// The spawner this reader uses unless a test hands it its own: the CLI as its own process group, stdin and stderr
// thrown away, stdout a pipe. A bin that is itself a JS file (the fake CLI a test selects with MORNDO_CLAUDE_BIN)
// runs under this node; the real CLI is a binary and runs as itself.
const spawnCli: Spawner = (bin, args, o) => {
  const script = /\.[cm]?[jt]s$/.test(bin);
  const child = nodeSpawn(script ? process.execPath : bin, script ? [bin, ...args] : [...args], { env: o.env, cwd: o.cwd, stdio: ["ignore", "pipe", "ignore"], detached: o.detached });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));   // no binary, no permissions: never a reading
  });
  const stdout: AsyncIterable<Uint8Array> = child.stdout === null
    ? (async function* () {})()
    : (async function* () { for await (const chunk of child.stdout!) yield chunk as Buffer; })();
  return {
    pid: child.pid ?? -1,
    stdout,
    kill(signal = "SIGKILL") {
      // The whole group, so a hook's child cannot outlive the read it was holding open.
      const sig = signal as NodeJS.Signals;
      try { if (child.pid != null && child.pid > 0) process.kill(-child.pid, sig); } catch { child.kill(sig); }
    },
    exited,
  };
};

// The parent's environment minus every token variable, plus the account's own config directory.
function childEnvOf(parent: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, CLAUDE_CONFIG_DIR: configDir };
  for (const key of TOKEN_ENV) delete env[key];
  return env;
}

// Whether a pid still runs: a signal probe nobody answers is gone; one another user's process refuses (EPERM) lives.
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// One account's lock file: a holder writes its pid and when it started, and — once its read is running — the read's
// own process group id; a finished read leaves the file with no holder, so the next read of the account takes it
// again. A pid that is gone, or a start older than CLAUDE_LOCK_MS, is a stale holder anybody may take over, and the
// group a stale lock names dies with the takeover (finding 4): a collector that died mid-read leaves nothing running.
function lockPathOf(lockDir: string, account: string): string {
  return join(lockDir, `claude-usage-${account}.lock`);
}
function readLock(path: string): { pid: number; startedAt: number; pgid: number } {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; startedAt?: unknown; pgid?: unknown };
    return {
      pid: typeof lock.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0 ? lock.pid : 0,
      startedAt: typeof lock.startedAt === "number" ? lock.startedAt : 0,
      pgid: typeof lock.pgid === "number" && Number.isInteger(lock.pgid) && lock.pgid > 0 ? lock.pgid : 0,
    };
  } catch { return { pid: 0, startedAt: 0, pgid: 0 }; }                // no lock, or not JSON: nobody holds it
}
function lockHeld(path: string, now: number): boolean {
  const { pid, startedAt } = readLock(path);
  return pid > 0 && now - startedAt < CLAUDE_LOCK_MS && pidAlive(pid);
}
// Kills the process group a lock names, if it names one and the group is alive (finding 4). Errors are ignored: the
// group may be gone already, or never have been the caller's to kill.
function killLockGroup(path: string): void {
  const { pgid } = readLock(path);
  if (pgid > 0) { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }
}

// `<bin> auth status`: local, no network. Exit 0 means signed in.
async function authStatus(bin: string, spawner: Spawner, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  const proc = spawner(bin, ["auth", "status"], { env, cwd, stdin: "ignore", stderr: "ignore", detached: false });
  let timer: NodeJS.Timeout | undefined;
  try {
    const ended = await Promise.race([
      proc.exited,
      new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); }),
    ]);
    if (ended === "timeout") { proc.kill(); return false; }
    return ended.code === 0;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// Reads once, rationed on this node: the lock and the semaphore first, then the spawn, then the parse. `bin` comes
// from opts, else the MORNDO_CLAUDE_BIN of the environment the caller named (its own, else this process's), else
// "claude". The lock lives in lockDir; `now` is injected so a test can age a lock.
export async function readClaude(opts: {
  account: string;
  configDir: string;
  bin?: string;
  timeoutMs?: number;
  now: () => number;
  lockDir: string;
  spawn?: Spawner;
  env?: NodeJS.ProcessEnv;
}): Promise<ClaudeReadResult> {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? env.MORNDO_CLAUDE_BIN ?? process.env.MORNDO_CLAUDE_BIN ?? "claude";
  const spawn = opts.spawn ?? spawnCli;
  const timeoutMs = opts.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS;
  const now = opts.now();
  const childEnv = childEnvOf(env, opts.configDir);

  // The signed_out gate: after a signed-out read, no spawn for this account until the CLI's own auth status says the
  // full login is back, or six hours passed.
  const gate = signedOutUntil.get(opts.account);
  if (gate !== undefined) {
    if (now >= gate) signedOutUntil.delete(opts.account);
    else if (!(await authStatus(bin, spawn, childEnv, process.cwd())))
      return { ok: false, reason: "signed_out", retryAfterS: null, hint: null };
  }

  // The per-account lock, before the semaphore: a second read of a running account is answered here, without
  // queueing behind the running one.
  mkdirSync(opts.lockDir, { recursive: true });
  const lockPath = lockPathOf(opts.lockDir, opts.account);
  if (lockHeld(lockPath, now)) return { ok: false, reason: "unreachable", retryAfterS: null, hint: null };
  killLockGroup(lockPath);                 // a stale holder's read may still run: its group dies with the takeover
  writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, startedAt: now })}\n`);
  const release = () => writeFileSync(lockPath, `${JSON.stringify({ pid: 0, startedAt: 0 })}\n`);

  // The node-wide semaphore: one headless read at a time, whichever account.
  const run = semaphore.tail.then(async (): Promise<ClaudeReadResult> => {
    const cwd = mkdtempSync(join(tmpdir(), "morndo-usage-claude-"));
    try {
      const proc = spawn(bin, CLAUDE_USAGE_ARGS, { env: childEnv, cwd, stdin: "ignore", stderr: "ignore", detached: true });
      activeReads.set(proc, cwd);               // the collector's death kills this whole group (finding 4)
      if (proc.pid > 0) writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, pgid: proc.pid, startedAt: now })}\n`);
      const chunks: Uint8Array[] = [];
      const collect = (async () => { try { for await (const chunk of proc.stdout) chunks.push(chunk); } catch { /* a killed run's pipe */ } })();
      let timer: NodeJS.Timeout | undefined;
      try {
        const ended = await Promise.race([
          proc.exited,
          new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); }),
        ]);
        if (ended === "timeout") {
          proc.kill();                     // the whole group, not only the CLI
          await proc.exited;
          return { ok: false, reason: "timeout", retryAfterS: null, hint: null };
        }
        // The pipe closes with the process; a hook's child holding it open cannot hold the read.
        await Promise.race([collect, new Promise(resolve => { setTimeout(resolve, 2_000); })]);
        if (ended.signal !== null || ended.code === null)
          return { ok: false, reason: "unreachable", retryAfterS: null, hint: null };
        const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(l => l !== "");
        const result = parseClaudeReport(lines);
        if (result.ok) signedOutUntil.delete(opts.account);
        else if (result.reason === "signed_out") signedOutUntil.set(opts.account, opts.now() + SIGNED_OUT_GATE_MS);
        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        activeReads.delete(proc);
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  semaphore.tail = run.then(() => undefined, () => undefined);
  try {
    return await run;
  } finally {
    release();
  }
}
