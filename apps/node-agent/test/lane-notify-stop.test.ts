// The Stop hook script (hooks/lane-notify-stop): the turn end is posted before tmux or git can use up Claude Code's
// 20 s hook timeout (T-422). A stub relay records the POST; shims stand in for tmux, git and lanes.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { firstLineOf, statusLineOf } from "@morndo/protocol";
import type { StatusContract } from "../src/config.ts";
import { STATUS_ASK, statusAsk } from "../src/relay/status-ask.ts";
import { until } from "./helpers.ts";

const SCRIPT = join(import.meta.dirname, "../hooks/lane-notify-stop");
const ASK: StatusContract = { mode: "ask", exempt: ["manager"] };

// Resolved before any test puts the git shim on PATH.
const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

type Hit = { method: string; url: string; body: unknown; at: number };
type HookInput = {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  stop_hook_active: boolean;
  background_tasks: unknown[];
  session_crons: unknown[];
  transcript_path: string;
  last_assistant_message: string;
};

const children: ChildProcess[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.length = 0;
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  servers.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function writeExe(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t422-"));
  dirs.push(dir);
  return dir;
}

function runDir(dir: string): string {
  return join(dir, "run");
}

function relay(): Promise<{ port: number; hits: Hit[]; hold: () => void; reply: (status: number, body: string) => void }> {
  const hits: Hit[] = [];
  let mode: { status: number; body: string } | "hold" = { status: 200, body: '{"ok":true,"queued":true}' };
  const server = createServer((req, res) => {
    const at = performance.now();
    const chunks: Buffer[] = [];
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* the stub still records a non-JSON body */ }
      hits.push({ method: req.method ?? "", url: req.url ?? "", body, at });
      if (mode === "hold") return;
      res.writeHead(mode.status, { "content-type": "application/json" });
      res.end(mode.body);
    });
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hits,
        hold: () => { mode = "hold"; },
        reply: (status, body) => { mode = { status, body }; },
      });
    });
  });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function gitEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function initRepo(dir: string): { repo: string; branch: string } {
  writeFileSync(join(dir, "gitconfig"), "");
  const repo = mkdtempSync(join(dir, "repo-"));
  const run = (args: string[]) => {
    const result = spawnSync(realGit, args, { cwd: repo, encoding: "utf8", env: gitEnv(dir) });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  };
  run(["init", "-q", "-b", "fixture"]);
  writeFileSync(join(repo, "f.txt"), "f\n");
  const as = ["-c", "user.name=Lane Fixture", "-c", "user.email=lane-fixture@example.com", "-c", "commit.gpgsign=false"];
  run([...as, "add", "f.txt"]);
  run([...as, "commit", "-q", "-m", "init"]);
  const branch = spawnSync(realGit, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8", env: gitEnv(dir) }).stdout.trim();
  return { repo, branch };
}

function installShims(dir: string): { lanes: string; log: string } {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExe(join(bin, "tmux"), `#!/bin/sh
if [ "\${FAKE_TMUX_SLEEP:-0}" != 0 ]; then
  sleep "$FAKE_TMUX_SLEEP"
fi
printf '%s\\n' lane-x
`);
  writeExe(join(bin, "git"), `#!/bin/sh
if [ -n "\${FAKE_PID_DIR:-}" ]; then
  sleep 30 &
  printf '%s\\n' "$!" > "$FAKE_PID_DIR/child.pid"
  printf '%s\\n' "$$" > "$FAKE_PID_DIR/shim.pid"
  printf '%s %s\\n' "$$" "$!" >> "$FAKE_PID_DIR/all"
  wait
fi
if [ "\${FAKE_GIT_SLEEP:-0}" != 0 ]; then
  sleep "$FAKE_GIT_SLEEP"
fi
exec ${realGit} "$@"
`);
  const log = join(dir, "lanes.log");
  const lanes = join(dir, "lanes");
  writeExe(lanes, `#!/bin/sh
if [ "\${FAKE_LANES_SLEEP:-0}" != 0 ]; then
  sleep "$FAKE_LANES_SLEEP"
fi
printf 'CALL\\n' >> ${JSON.stringify(log)}
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
`);
  return { lanes, log };
}

function hookInput(cwd: string, message: string, over: Partial<HookInput> = {}): HookInput {
  return {
    session_id: "sess-t422",
    cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
    background_tasks: [{ id: "b1" }],
    session_crons: [{ id: "c1" }, { id: "c2" }],
    transcript_path: join(cwd, "transcript.jsonl"),
    last_assistant_message: message,
    ...over,
  };
}

function startHook(dir: string, port: string, lanes: string, body: HookInput, extra: Record<string, string> = {}, pane: string | null = "%1"): { child: ChildProcess; started: number; stdout: () => string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
    HOME: dir,
    MORNDO_RELAY_PORT: port,
    MORNDO_LANES: lanes,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.MORNDO_RELAY_URL;
  delete env.MORNDO_HOOK_LOOKUP_S;
  delete env.MORNDO_HOOK_POST_S;
  delete env.MORNDO_HOOK_NOTIFY_S;
  delete env.FAKE_GIT_SLEEP;
  delete env.FAKE_TMUX_SLEEP;
  delete env.FAKE_LANES_SLEEP;
  delete env.FAKE_PID_DIR;
  delete env.BASH_ENV;
  delete env.TMPDIR;
  const runtime = runDir(dir);
  mkdirSync(runtime, { recursive: true });
  env.XDG_RUNTIME_DIR = runtime;
  Object.assign(env, extra);
  if (pane !== null) env.TMUX_PANE = pane;
  const started = performance.now();
  const child = spawn(SCRIPT, { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { out += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(body));
  return { child, started, stdout: () => out };
}

async function waitExit(child: ChildProcess, deadline: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(child.exitCode), Math.max(0, deadline - performance.now()));
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

function posted(hit: Hit): Record<string, unknown> {
  expect(hit.method).toBe("POST");
  expect(hit.url).toBe("/hook/stop");
  expect(hit.body && typeof hit.body === "object" && !Array.isArray(hit.body)).toBe(true);
  return hit.body as Record<string, unknown>;
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function recordedPids(pidDir: string): number[] {
  const out: number[] = [];
  for (const name of ["shim.pid", "child.pid", "all"]) {
    let text = "";
    try { text = readFileSync(join(pidDir, name), "utf8"); } catch { continue; }
    for (const word of text.split(/\s+/)) {
      if (/^\d+$/.test(word)) out.push(Number(word));
    }
  }
  return out;
}

const INPUT_KEYS = ["session_id", "cwd", "hook_event_name", "stop_hook_active", "background_tasks", "session_crons", "transcript_path", "last_assistant_message"] as const;

describe("lane-notify-stop", () => {
  it("posts the finished event with the old script's fields", async () => {
    const dir = scratchDir();
    const { repo, branch } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const message = "The lane finished the turn.";
    const hook = hookInput(repo, message);
    const run = startHook(dir, String(stub.port), lanes, hook);
    const deadline = run.started + 8_000;
    expect(await until(() => stub.hits.length === 1, 5_000)).toBe(true);
    expect(await waitExit(run.child, deadline)).toBe(0);
    expect(run.stdout()).toBe("");
    expect(stub.hits).toHaveLength(1);
    const body = posted(stub.hits[0]!);
    expect(body.window).toBe("lane-x");
    expect(body.text).toBe(message);
    expect(body.last_assistant_message).toBe(message);
    expect(body.background).toBe(hook.background_tasks.length);
    expect(body.crons).toBe(hook.session_crons.length);
    expect(body.branch).toBe(branch);
    expect(body.changed).toBe(0);
    expect(body.ahead).toBe(0);
    for (const key of INPUT_KEYS) expect(body[key]).toEqual(hook[key]);

    writeFileSync(join(repo, "note.txt"), "untracked\n");
    stub.hits.length = 0;
    const again = startHook(dir, String(stub.port), lanes, hook);
    expect(await until(() => stub.hits.length === 1, 5_000)).toBe(true);
    expect(await waitExit(again.child, again.started + 8_000)).toBe(0);
    expect(again.stdout()).toBe("");
    expect(posted(stub.hits[0]!).changed).toBe(1);
  });

  it("prints the relay's block decision for Claude Code", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const answer = '{"decision":"block","reason":"R"}';
    stub.reply(200, answer);
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "no status line"));
    expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
    expect(run.stdout()).toBe(`${answer}\n`);
    expect(stub.hits).toHaveLength(1);
  });

  it("posts first and within the budget when git hangs (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "hung git"), {
      FAKE_GIT_SLEEP: "30",
      MORNDO_HOOK_LOOKUP_S: "1",
      MORNDO_HOOK_POST_S: "3",
    });
    expect(await until(() => stub.hits.length >= 1, 3_000)).toBe(true);
    expect(stub.hits[0]!.at - run.started).toBeLessThan(3_000);
    expect(await waitExit(run.child, run.started + 6_000)).toBe(0);
    expect(performance.now() - run.started).toBeLessThan(6_000);
    const body = posted(stub.hits[0]!);
    expect(body.window).toBe("lane-x");
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("changed");
    expect(body).not.toHaveProperty("ahead");
    expect(stub.hits).toHaveLength(1);
  }, 20_000);

  it("ends inside its budget when tmux, git and the relay all hang and the fallback hangs too", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    stub.hold();
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "everything hung"), {
      FAKE_GIT_SLEEP: "30",
      FAKE_TMUX_SLEEP: "30",
      FAKE_LANES_SLEEP: "30",
      MORNDO_HOOK_LOOKUP_S: "1",
      MORNDO_HOOK_POST_S: "1",
      MORNDO_HOOK_NOTIFY_S: "1",
    });
    expect(await waitExit(run.child, run.started + 5_000)).toBe(0);
    expect(performance.now() - run.started).toBeLessThan(5_000);
  }, 20_000);

  it("falls back to lanes notify when the relay is down", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes, log } = installShims(dir);
    const port = await closedPort();
    const message = "alpha report of the turn";
    const run = startHook(dir, String(port), lanes, hookInput(repo, message));
    expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
    const text = readFileSync(log, "utf8");
    const calls = text.split("\n").filter(line => line === "CALL");
    expect(calls).toHaveLength(1);
    const notifyAt = text.indexOf("notify\n");
    expect(notifyAt).toBeGreaterThan(-1);
    expect(text.slice(notifyAt)).toContain("lane-x finished");
    expect(text.slice(notifyAt)).toContain(message);
  });

  it("skips sessions outside tmux", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes, log } = installShims(dir);
    const stub = await relay();
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "outside"), {}, null);
    expect(await waitExit(run.child, run.started + 3_000)).toBe(0);
    expect(stub.hits).toEqual([]);
    expect(() => readFileSync(log, "utf8")).toThrow();
  });

  it("keeps the hook budget under Claude Code's 20 s", () => {
    const text = readFileSync(SCRIPT, "utf8");
    const lookup = text.match(/MORNDO_HOOK_LOOKUP_S:-(\d+)/);
    const post = text.match(/MORNDO_HOOK_POST_S:-(\d+)/);
    const notify = text.match(/MORNDO_HOOK_NOTIFY_S:-(\d+)/);
    expect(lookup).not.toBeNull();
    expect(post).not.toBeNull();
    expect(notify).not.toBeNull();
    expect(Number(lookup?.[1]) + Number(post?.[1]) + Number(notify?.[1])).toBeLessThanOrEqual(15);
    expect(text.includes("~/")).toBe(false);
    const code = text.split("\n").filter(line => !line.trimStart().startsWith("#"));
    expect(code.filter(line => /^\s*(git|tmux) /.test(line))).toEqual([]);
    const curls = code.filter(line => /\bcurl\b/.test(line));
    expect(curls).toHaveLength(1);
    expect(curls[0]).toContain('"$RELAY/hook/stop"');
    const lookedUp = code.filter(line => /\bgit\b|\btmux\b/.test(line));
    expect(lookedUp.length).toBeGreaterThan(0);
    expect(lookedUp.every(line => line.trimStart().startsWith("start ") || line.includes("GIT_OPTIONAL_LOCKS"))).toBe(true);
    expect(code.some(line => /(^|[;&|(]\s*)wait\b/.test(line))).toBe(false);
    expect(text).toContain("set -m");
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("the status line of the answer reads as before (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const messages = [
      "STATUS: NEEDS DECISION T-7 checkpoint: fixes #12 abc1234; reviewer re-checks",
      "STATUS: DONE T-12 ran the suite",
      "STATUS: WAITING CI for 20 min",
      "I pushed the branch.",
    ];
    for (const message of messages) {
      stub.hits.length = 0;
      const hook = hookInput(repo, message, { background_tasks: [], session_crons: [] });
      const run = startHook(dir, String(stub.port), lanes, hook);
      expect(await until(() => stub.hits.length === 1, 5_000)).toBe(true);
      expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
      const body = posted(stub.hits[0]!);
      const want = statusLineOf(firstLineOf(message));
      expect(statusLineOf(firstLineOf(String(body.text)))).toEqual(want);
      expect(statusLineOf(firstLineOf(String(body.last_assistant_message)))).toEqual(want);
      const asked = statusAsk(body, "lane-x", ASK);
      expect(asked).toBe(want === null ? STATUS_ASK : null);
    }
  });

  it("does not wait for a lookup that survives its kill (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const killless = join(dir, "killless.sh");
    writeFileSync(killless, "kill() { :; }\n");
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "unkillable lookup"), {
      BASH_ENV: killless,
      FAKE_GIT_SLEEP: "6",
      MORNDO_HOOK_LOOKUP_S: "1",
      MORNDO_HOOK_POST_S: "3",
    });
    expect(await until(() => stub.hits.length >= 1, 3_000)).toBe(true);
    expect(stub.hits[0]!.at - run.started).toBeLessThan(3_000);
    expect(await waitExit(run.child, run.started + 5_000)).toBe(0);
    expect(performance.now() - run.started).toBeLessThan(5_000);
    const body = posted(stub.hits[0]!);
    expect(body.window).toBe("lane-x");
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("changed");
    expect(body).not.toHaveProperty("ahead");
  }, 20_000);

  it("kills the whole process group of a lookup at the bound (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const pidDir = join(dir, "pids");
    mkdirSync(pidDir);
    const stub = await relay();
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "group kill"), {
      FAKE_PID_DIR: pidDir,
      MORNDO_HOOK_LOOKUP_S: "1",
    });
    try {
      expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
      const shim = Number(readFileSync(join(pidDir, "shim.pid"), "utf8").trim());
      const grandchild = Number(readFileSync(join(pidDir, "child.pid"), "utf8").trim());
      expect(Number.isInteger(shim) && shim > 0).toBe(true);
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
      const recorded = recordedPids(pidDir);
      expect(recorded.length).toBeGreaterThanOrEqual(2);
      expect(await until(() => recorded.every(isGone), 3_000)).toBe(true);
    } finally {
      for (const pid of recordedPids(pidDir)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 20_000);

  it("leaves no directory of its own behind, and removes an old one left by a killed hook (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("process.getuid unavailable");
    const base = join(runDir(dir), `morndo-hook-${uid}`);
    const oldRun = join(base, "run.OLD");
    const freshRun = join(base, "run.FRESH");
    mkdirSync(oldRun, { recursive: true });
    mkdirSync(freshRun, { recursive: true });
    const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
    utimesSync(oldRun, twoHoursAgo, twoHoursAgo);
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "sweep leftovers"));
    expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
    expect(await until(() => !existsSync(oldRun), 3_000)).toBe(true);
    expect(existsSync(freshRun)).toBe(true);
    expect(readdirSync(base).filter(name => name.startsWith("run."))).toEqual(["run.FRESH"]);
  }, 20_000);

  it("still posts when the runtime directory cannot be created (T-422)", async () => {
    const dir = scratchDir();
    const { repo } = initRepo(dir);
    const { lanes } = installShims(dir);
    const stub = await relay();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x\n");
    const run = startHook(dir, String(stub.port), lanes, hookInput(repo, "no runtime dir"), {
      XDG_RUNTIME_DIR: join(blocker, "nested"),
    });
    expect(await until(() => stub.hits.length === 1, 5_000)).toBe(true);
    expect(await waitExit(run.child, run.started + 8_000)).toBe(0);
    expect(stub.hits).toHaveLength(1);
    const body = posted(stub.hits[0]!);
    expect(body.window).toBe("");
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("changed");
    expect(body).not.toHaveProperty("ahead");
  });
});
