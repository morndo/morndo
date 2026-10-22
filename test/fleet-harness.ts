// Shared spawning for the fleet's cross-app tests (test/fleet/*.test.ts), its two-node e2e (e2e/fleet-two-node.e2e.ts)
// and its QA helper (e2e/fleet-qa.ts). It runs:
// - a real `morndo-fleet`, real `morndo-node` agents and a real hub in fleet mode (MORNDO_FLEET_SOCKET);
// - each as a child process with its own temporary HOME, on random free ports;
// - every agent on its own isolated tmux server (`tmux -L test-<uuid>`);
// - lanes that are test/fixtures/fake-claude-pane.ts, never the real agent CLI.
// Nothing here reads or touches the owner's tmux servers, ~/.claude, ports 8787/8790/8791 or Morndo data. It imports no
// vitest: the e2e script uses it too. stopAll() stops everything it started, and an exit hook does the same if a test
// file dies.
// Why the repo root and not e2e/: e2e/ holds standalone scripts that need the built web app and Chromium (npm run e2e).
// These helpers also serve vitest files that CI's test step must run, and they span three apps, so no app's test folder
// owns them.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { endpointId, pairingTokenId, sessionId } from "@morndo/domain";
import { Store } from "../apps/hub/src/adapters/store.ts";
import { hashSecret } from "../apps/hub/src/application/access-service.ts";
import { FleetClient } from "../packages/fleet-client/src/index.ts";
import type { Control } from "./fixtures/fake-claude-pane.ts";
import { loadConfig, type AgentConfig } from "../apps/node-agent/src/config.ts";
import { agentPaths } from "../apps/node-agent/src/paths.ts";
import type { TestHooks } from "../apps/node-agent/src/test-hooks.ts";
import type { FleetConfig } from "../apps/fleet/src/config.ts";
import { exactSession, tmuxArgv, tmuxLiteral } from "../packages/node-ops/src/tmux-cli.ts";
import { isolatedTmux } from "../packages/node-ops/test/isolated-tmux.ts";
import { OP_NAMES, type Delivery as DrillDelivery, type Expect, type HookEvent, type OpName, type Pane } from "../packages/protocol/src/fleet.ts";
import { parseWorkerId } from "../packages/protocol/src/worker-id.ts";

export { sleep };
export const ROOT = join(import.meta.dirname, "..");
export const AGENT_MAIN = join(ROOT, "apps/node-agent/src/main.ts");
export const FLEET_MAIN = join(ROOT, "apps/fleet/src/main.ts");
export const HUB_MAIN = join(ROOT, "apps/hub/src/main.ts");
export const FAKE_CLAUDE = join(ROOT, "test/fixtures/fake-claude-pane.ts");

const ALL_OPS: OpName[] = [...OP_NAMES];

// ---- bookkeeping: everything started here is stopped by stopAll(), or by the exit hook below if a test file dies.
const procs = new Set<Proc>();
const servers = new Map<string, () => Promise<void>>();   // tmux socket name → kill (waits, then removes the socket file)
const dirs = new Set<string>();
const closers: (() => void | Promise<void>)[] = [];

export function tempDir(prefix: string, base = tmpdir()): string {
  const d = mkdtempSync(join(base, prefix));
  dirs.add(d);
  return d;
}
const tmuxEnv = (): NodeJS.ProcessEnv => { const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE; return env; };

// Kills every tmux server the way isolatedTmux().kill() does (waits until it is gone, then removes its socket file under
// /tmp/tmux-<uid>/), whatever else failed.
async function killServers(): Promise<void> {
  await Promise.all([...servers.values()].map(async kill => { try { await kill(); } catch { /* already gone */ } }));
  servers.clear();
}
// Failure-safe: the tmux servers are killed and the temp dirs removed even if closing something or stopping a process
// rejects (the error still reaches the caller).
export async function stopAll(): Promise<void> {
  try {
    for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* already gone */ } }
    await Promise.all([...procs].map(p => p.stop()));
  } finally {
    await killServers();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.clear();
  }
}
process.once("exit", () => {
  for (const p of procs) { try { p.child.kill("SIGKILL"); } catch { /* gone */ } }
  // An exit handler can't wait, so only killServers' synchronous part runs: each server is sent kill-server. Nothing
  // waits for a server to exit or removes its socket file; stopAll() does both.
  void killServers();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A child's environment: the test's own, minus anything that could point it at the owner's system, with its own HOME.
// Every CLAUDE* variable goes (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_CONFIG_DIR, ...): these tests run inside a Claude Code
// session, and its environment must not reach the children.
const DROP = /^(MORNDO_|CLAUDE|TMUX$|TMUX_PANE$|XDG_(CONFIG|STATE|DATA|RUNTIME)_)/;
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  return { ...env, HOME: home, ...extra };
}

export const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

// Waits until f returns something truthy. On timeout the error names what it waited for, the last error f threw, and
// the tail of every live process's log.
class Fatal extends Error {}   // thrown by a check inside until(): stop waiting at once
export async function until<T>(what: string, f: () => T | Promise<T>, ms = 10_000, every = 100): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  let last: unknown = null;
  for (;;) {
    try { const v = await f(); if (v) return v as NonNullable<T>; } catch (e) { if (e instanceof Fatal) throw e; last = e; }
    if (performance.now() > end) {
      const logs = [...procs].map(p => `--- ${p.name} (${p.log})\n${p.tail(15)}`).join("\n");
      throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}\n${logs}`);
    }
    await sleep(every);
  }
}

// ---- child processes
export type Proc = {
  name: string; child: ChildProcess; log: string;
  alive(): boolean; stop(signal?: NodeJS.Signals): Promise<void>; pause(): void; resume(): void; tail(lines?: number): string;
};
function startProc(name: string, args: string[], env: NodeJS.ProcessEnv, log: string): Proc {
  const child = spawn(process.execPath, ["--no-warnings", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => appendFileSync(log, d));
  child.stderr?.on("data", (d: Buffer) => appendFileSync(log, d));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let paused = false;
  const p: Proc = {
    name, child, log,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop(signal = "SIGTERM") {
      procs.delete(p);
      if (!p.alive()) return;
      if (paused) { child.kill("SIGCONT"); paused = false; }                 // a stopped process can't act on SIGTERM
      child.kill(signal);
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    },
    pause() { child.kill("SIGSTOP"); paused = true; },
    resume() { child.kill("SIGCONT"); paused = false; },
    tail: (lines = 20) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-lines).join("\n") : ""),
  };
  procs.add(p);
  return p;
}

// ---- isolated tmux servers and lanes (tmux(1): -L, new-session/new-window -P -F, a command given as several arguments
// runs without sh -c, user options start with @; https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-06).
// node-ops' rules (Task 2): every call passes -u, a session target is "=name", every argument tmux expands as a format
// (a window name, a new session's name, the start directory) goes through tmuxLiteral ("#" as "##"), and a pane is
// targeted by its %N, never by a window name; and the shared isolatedTmux, whose kill() waits until the server is gone,
// so a drill can start a new one at once.
export type TmuxServer = { socket: string; run(...args: string[]): string; has(session: string): boolean; stamp(): string | null; kill(): Promise<void> };
export function tmuxServer(): TmuxServer {
  const t = isolatedTmux();
  servers.set(t.socket, () => t.kill());
  const quiet = (args: string[]) => spawnSync("tmux", tmuxArgv(t.socket, args), { env: tmuxEnv(), encoding: "utf8" });
  return {
    socket: t.socket,
    run: (...args) => t.tmux(...args),
    has: session => quiet(["has-session", "-t", exactSession(session)]).status === 0,
    stamp: () => {
      const r = quiet(["show-options", "-gqv", "@morndo-server"]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    kill: () => { return t.kill(); },   // stays registered: a server recreated on this socket is stopped by stopAll too
  };
}

function openWindow(t: TmuxServer, session: string, window: string, cwd: string, command: string[]): string {
  const where = t.has(session)
    ? ["new-window", "-d", "-t", `${exactSession(session)}:`, "-n", tmuxLiteral(window)]
    : ["new-session", "-d", "-s", tmuxLiteral(session), "-n", tmuxLiteral(window), "-x", "100", "-y", "30"];
  return t.run(...where, "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...command).trim();
}

export type Lane = {
  window: string; paneId: string; dir: string; sessionId: string | null; transcript: string | null;
  submitted(): string[]; screen(): string; draft(text: string): void; clear(): void;
  control(c: Control): Promise<void>;          // what Claude Code does next (test/fixtures/fake-claude-pane.ts, Control)
  entries(): Record<string, unknown>[];         // its transcript's lines, parsed
  enters(): number;                             // Enter presses since the last bracketed paste ended
};
// The box whose state dir is `dir` applies `c` (and every command before it) before this returns. A lane's state dir is its
// window's working directory, so a lane that lane.start opened is reached by the directory it was started in.
export async function controlAt(dir: string, c: Control): Promise<void> {
  const file = join(dir, "control.jsonl");
  const n = (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0) + 1;
  appendFileSync(file, `${JSON.stringify(c)}\n`);
  const done = join(dir, "applied");
  await until(`the box in ${dir} to apply ${JSON.stringify(c)}`, () => existsSync(done) && Number(readFileSync(done, "utf8")) >= n, 5000, 20);
}
export const submittedAt = (dir: string): string[] => {
  const file = join(dir, "submitted.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : [];
};
// A lane: one window running the fake input box. With `claudeHome` (an agent's HOME), the box writes its session file and
// transcript into <claudeHome>/.claude, so the agent reports its session and status and serves its transcript.
// `startDelayMs`: the box shows Claude Code starting for that long; `wait: false` returns before the box is drawn.
export async function fakeLane(t: TmuxServer, o: {
  window: string; session?: string; prose?: string; claudeHome?: string; offsetMs?: number; startDelayMs?: number; wait?: boolean;
}): Promise<Lane> {
  const session = o.session ?? "qa";
  const dir = tempDir("morndo-lane-");
  if (o.prose) writeFileSync(join(dir, "prose.txt"), o.prose);
  const sessionId = o.claudeHome ? randomUUID() : null;
  const claude = o.claudeHome ? join(o.claudeHome, ".claude") : null;
  const paneId = openWindow(t, session, o.window, dir, [process.execPath, "--no-warnings", FAKE_CLAUDE, dir,
    ...(claude && sessionId ? [`--claude=${claude}`, `--session=${sessionId}`, `--tmux-session=${session}`] : []),
    ...(o.offsetMs ? [`--offset=${o.offsetMs}`] : []), ...(o.startDelayMs ? [`--start-delay=${o.startDelayMs}`] : [])]);
  const screen = () => t.run("capture-pane", "-p", "-t", paneId);
  if (o.wait !== false) await until(`${o.window}'s input box`, () => screen().includes("❯"), 10_000 + (o.startDelayMs ?? 0));
  const transcript = claude && sessionId ? join(claude, "projects", "-qa", `${sessionId}.jsonl`) : null;
  return {
    window: o.window, paneId, dir, sessionId, transcript,
    submitted: () => submittedAt(dir),
    screen,
    draft: text => { t.run("send-keys", "-t", paneId, "-l", text); },
    clear: () => { t.run("send-keys", "-t", paneId, "C-u"); },
    control: c => controlAt(dir, c),
    entries: () => (transcript && existsSync(transcript)
      ? readFileSync(transcript, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : []),
    enters: () => {
      const raw = existsSync(join(dir, "raw.bin")) ? readFileSync(join(dir, "raw.bin")).toString("latin1") : "";
      const end = raw.lastIndexOf("\x1b[201~");
      return end === -1 ? 0 : raw.slice(end).split("\r").length - 1;
    },
  };
}
// A plain shell window; `split` adds a second pane (a window with two panes is no lane, spec §4).
export function shellLane(t: TmuxServer, o: { window: string; session?: string; split?: boolean }): { window: string; paneId: string } {
  const paneId = openWindow(t, o.session ?? "qa", o.window, tmpdir(), ["bash", "--norc", "--noprofile"]);
  if (o.split) t.run("split-window", "-d", "-t", paneId, "bash", "--norc", "--noprofile");
  return { window: o.window, paneId };
}

// ---- the fleet service
export type Fleet = {
  home: string; port: number; portsTried: number[]; socketPath: string; config: FleetConfig; client: FleetClient; proc(): Proc;
  cli(...args: string[]): { code: number | null; out: string; err: string };
  addNode(name: string): string; revoke(name: string): void;
  // Stops the service (SIGKILL by default), runs `whileDown` while nothing listens, then serves again on the same database.
  restart(signal?: NodeJS.Signals, whileDown?: () => Promise<void>): Promise<void>;
};
// How long a fleet may take to open its client API. It is a deadline on an event, not a pace: a fleet that exits is
// seen at once (Fatal below), so only a hung one waits it out. A fleet started beside a dozen other processes on a loaded
// machine printed nothing for over 15 s (ENOENT on its socket, 2 of 20 runs of drills-deliveries under load).
const FLEET_START_MS = 45_000;   // below the fleet project's hookTimeout (60 s, vitest.config.ts): a hung start fails with this message, not the hook's
export async function startFleet(o: {
  subscribers?: FleetConfig["subscribers"]; stickyLanes?: string[]; laneEvents?: Partial<FleetConfig["laneEvents"]>;
  laneWatch?: Partial<FleetConfig["laneWatch"]>;
  // Where the first port comes from; a test of the retry hands in one that is taken. Default: freePort.
  port?: () => Promise<number>;
} = {}): Promise<Fleet> {
  const home = tempDir("morndo-fleet-");
  // The client socket's path must fit sockaddr_un.sun_path: 103 bytes on macOS, 107 on Linux
  // (https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections, read 2026-10-06). A temp
  // HOME on macOS is ~60 already, so the socket gets a short directory under /tmp, mode 0700 (mkdtemp), owned by us, as
  // the fleet requires (spec §5.6). The agent endpoint listens on loopback with a ws:// public URL to loopback: the only
  // plain ws:// the fleet's config (Task 10) and the agent (fleetUrlOk, Task 7) accept.
  const sockDir = tempDir("mf-", "/tmp");
  let port = await (o.port ?? freePort)();
  const portsTried = [port];
  const config: FleetConfig = {
    listen: { host: "127.0.0.1", port }, socketPath: join(sockDir, "fleet.sock"),
    dbPath: join(home, ".local/share/morndo-fleet/fleet.db"), keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [],
    stickyLanes: o.stickyLanes ?? ["manager"],
    // Off unless a test turns it on: a lane-event batch typed into a lane named "manager" would land in drills that count
    // what that lane received (the fleet core's retry drills have one).
    laneEvents: { deliverTo: null, header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000, ...o.laneEvents },
    // Nudges off unless a test turns them on, for the same reason.
    laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: false, ...o.laneWatch },
  };
  mkdirSync(join(home, ".config/morndo-fleet"), { recursive: true });
  const writeConfig = () => writeFileSync(join(home, ".config/morndo-fleet/config.json"), JSON.stringify(config, null, 2));
  writeConfig();
  const env = cleanEnv(home);
  const client = new FleetClient(config.socketPath);
  let proc: Proc | null = null;
  const serve = async () => {
    proc = startProc("fleet", [FLEET_MAIN, "serve"], env, join(home, "fleet.log"));
    const p = proc;
    await until("the fleet's client API", async () => {
      if (!p.alive()) throw new Fatal(`the fleet exited during startup (${p.child.exitCode ?? p.child.signalCode})\n${p.tail(15)}`);
      return (await client.caps()).api.includes(1);
    }, FLEET_START_MS);
  };
  // freePort() answers a port that was free when it asked: it closes the socket first, so a process that binds it
  // later can lose it to another (a parallel test's server, or the kernel's pick for an outgoing connection: main CI
  // run 39673017200, EADDRINUSE 127.0.0.1:39547). The fleet that finds its port taken exits at once; ask for another
  // port and serve again, a few times, rather than fail a test that never depended on that port.
  for (let attempt = 1; ; attempt++) {
    try { await serve(); break; }
    catch (e) {
      if (attempt >= 5 || !/EADDRINUSE/.test(String((e as Error).message))) throw e;
      port = await freePort();
      portsTried.push(port);
      config.listen.port = port;
      config.publicUrl = `ws://127.0.0.1:${port}/agent`;
      writeConfig();
    }
  }
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", FLEET_MAIN, ...args], { env, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  return {
    home, port, portsTried, socketPath: config.socketPath, config, client, cli,
    proc: () => { if (!proc) throw new Error("the fleet isn't running"); return proc; },
    addNode(name) {
      const r = cli("node", "add", name);
      const line = r.out.split("\n").map(l => l.trim()).find(l => l.startsWith("morndo-join:1:"));
      if (r.code !== 0 || !line) throw new Error(`morndo-fleet node add ${name} exited ${r.code}: ${r.err}`);
      return line;
    },
    revoke(name) {
      const r = cli("node", "revoke", name);
      if (r.code !== 0) throw new Error(`morndo-fleet node revoke ${name} exited ${r.code}: ${r.err}`);
    },
    async restart(signal = "SIGKILL", whileDown) { await proc?.stop(signal); await whileDown?.(); await serve(); },
  };
}

// ---- node agents
export type Agent = {
  node: string; home: string; configPath: string; readonly relayPort: number;
  config(): AgentConfig; proc(): Proc | null;
  run(hooks?: TestHooks, o?: { env?: Record<string, string> }): Promise<void>; stop(signal?: NodeJS.Signals): Promise<void>;
  waitOnline(ms?: number): Promise<void>; waitOffline(ms?: number): Promise<void>;
  resetDatabase(hooks?: TestHooks): Promise<void>; clone(): Promise<Agent>;
  copyDatabase(hooks?: TestHooks): Promise<string>; putBackDatabase(copy: string, hooks?: TestHooks, whileStopped?: () => Promise<void>): Promise<void>;
};
// `node add` → `join` in a fresh HOME, then this test's relay port goes into config.json and its tmux server and session
// into policy.json (the agent keeps the two apart, Task 6: a policy written into config.json would be ignored, and the
// agent would act on the default tmux server). Not run yet.
export async function joinAgent(fleet: Fleet, node: string, o: { tmux: TmuxServer; session?: string; policy?: Partial<AgentConfig["policy"]> }): Promise<Agent> {
  const home = tempDir(`morndo-node-${node}-`);
  const joinString = fleet.addNode(node);
  // The fleet is a child process, so waiting on `join` synchronously blocks nothing it needs.
  const r = spawnSync(process.execPath, ["--no-warnings", AGENT_MAIN, "join", joinString], { env: cleanEnv(home), encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`morndo-node join ${node} exited ${r.status}: ${r.stderr}${r.stdout}`);
  const paths = agentPaths(home);
  const stored = JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
  writeFileSync(paths.configFile, JSON.stringify({ ...stored, relayPort: await freePort() }, null, 2), { mode: 0o600 });
  writeFileSync(paths.policyFile, JSON.stringify({
    ops: ALL_OPS, session: o.session ?? "qa", tmuxSocket: o.tmux.socket, repoRoots: [join(home, "repos")], lockedPanes: {}, ...o.policy,
  }, null, 2), { mode: 0o600 });
  // A test agent never runs on anyone's default tmux server: read the config back as the agent will.
  const loaded = loadConfig(home);
  if (loaded.policy.tmuxSocket !== o.tmux.socket) throw new Error(`${node}'s policy names tmux socket ${String(loaded.policy.tmuxSocket)}, not the test's`);
  return agentAt(fleet, node, home);
}

function agentAt(fleet: Fleet, node: string, home: string): Agent {
  const configPath = agentPaths(home).configFile;
  const config = () => loadConfig(home);
  const status = async () => (await fleet.client.nodes()).find(n => n.name === node)?.status ?? null;
  let proc: Proc | null = null;
  const a: Agent = {
    node, home, configPath, config,
    get relayPort() { return config().relayPort; },
    proc: () => proc,
    async run(hooks, o = {}) {
      // The agent refuses test hooks unless NODE_ENV is "test" and its HOME isn't the account's own (Task 8 of the fleet core).
      const extra: Record<string, string> = { ...(hooks ? { MORNDO_NODE_TEST_HOOKS: JSON.stringify(hooks), NODE_ENV: "test" } : {}), ...o.env };
      proc = startProc(`agent ${node} (${home})`, [AGENT_MAIN, "run"], cleanEnv(home, extra), join(home, "agent.log"));
    },
    async stop(signal = "SIGTERM") { await proc?.stop(signal); proc = null; },
    // Online, and answering: a read through the fleet (op.status starts nothing, and moves no store sequence) answers
    // ok twice, 300 ms apart, from one store, with the node still online after. A connection the agent turns down
    // answers neither, and a new store after it shows as another store. (A restored agent is welcomed, turns the
    // welcome down to start a new store, and redials: "online" alone can be that first connection's.)
    async waitOnline(ms = 15_000) {
      await until(`${node} online and answering`, async () => {
        if ((await status()) !== "online") return false;
        const first = await fleet.client.op({ node }, "op.status", { key: "hub:wait-online" });
        if (!first.ok) return false;
        await sleep(300);
        const again = await fleet.client.op({ node }, "op.status", { key: "hub:wait-online" });
        return again.ok && again.store === first.store && (await status()) === "online";
      }, ms);
    },
    async waitOffline(ms = 15_000) { await until(`${node} not online`, async () => (await status()) !== "online", ms); },
    async resetDatabase(hooks) {
      await a.stop();
      await a.waitOffline();
      const db = config().dbPath;
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      await a.run(hooks);
      await a.waitOnline();
    },
    // A backup of the agent's database as an owner takes one: the agent stopped (closing it folds the -wal into the file
    // and removes it), the file copied aside with cp, the agent run again. Returns the copy's path.
    async copyDatabase(hooks) {
      await a.stop();
      await a.waitOffline();
      const db = config().dbPath;
      const copy = join(home, `agent.db.copy-${randomBytes(4).toString("hex")}`);
      execFileSync("cp", [db, copy]);
      await a.run(hooks);
      await a.waitOnline();
      return copy;
    },
    // That copy restored in place, as `cp backup agent.db` does: the agent stopped, the copy written over the file (its
    // inode, so the file's identity and the store id in it, kept), no -wal or -shm of the newer database left beside it,
    // `whileStopped` (a fleet restart, say), the agent run again. Throws if the inode changed: the drill is about a
    // restore the file's identity can't see.
    async putBackDatabase(copy, hooks, whileStopped) {
      await a.stop();
      await a.waitOffline();
      const db = config().dbPath;
      const inode = statSync(db).ino;
      for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      execFileSync("cp", [copy, db]);
      if (statSync(db).ino !== inode) throw new Error(`cp replaced ${db} instead of writing over it`);
      await whileStopped?.();
      await a.run(hooks);
      await a.waitOnline();
    },
    // A cloned machine: the same config, policy and private key in another HOME, with its own relay port (a clone has its
    // own loopback) and a fresh database (copying a live WAL database could tear it, and the conflict doesn't depend on it).
    async clone() {
      const twin = tempDir(`morndo-node-${node}-twin-`);
      const original = config();
      const moved = JSON.parse(readFileSync(configPath, "utf8").replaceAll(home, twin)) as Record<string, unknown> & { keyPath: string };
      mkdirSync(dirname(moved.keyPath), { recursive: true });
      cpSync(original.keyPath, moved.keyPath);
      cpSync(agentPaths(home).policyFile, agentPaths(twin).policyFile);
      writeFileSync(agentPaths(twin).configFile, JSON.stringify({ ...moved, relayPort: await freePort() }, null, 2), { mode: 0o600 });
      return agentAt(fleet, node, twin);
    },
  };
  return a;
}
// The agent's policy.json with these fields changed, before run() (the agent reads it at start). A policy the agent would
// refuse fails here, with the setting named, not in the agent's log.
export function updatePolicy(agent: Agent, patch: Partial<AgentConfig["policy"]>): void {
  const file = agentPaths(agent.home).policyFile;
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>), ...patch }, null, 2), { mode: 0o600 });
  loadConfig(agent.home);
}

// Every status flip of one node from now on ("online" | "stale" | "offline"), from the fleet's events. A new events
// subscription first replays each registered node's current status (Contracts, `WS /v1/events`): that frame is not a
// flip, so it is awaited and discarded before this returns. Awaiting it also means the subscription is live, so a drop
// that follows is seen (a subscription still connecting would miss it). A reconnect of the subscription (a fleet
// restart) replays the status again, recorded like a flip; the drills that restart the fleet don't use this.
export async function statuses(fleet: Fleet, node: string): Promise<string[]> {
  const seen: string[] = [];
  let replayed = false;
  closers.push(fleet.client.events(e => {
    if (e.t !== "status" || e.node !== node) return;
    if (!replayed) { replayed = true; return; }
    seen.push((e.body as { status: string }).status);
  }));
  await until(`${node}'s current status replayed to a new events subscription`, () => replayed);
  return seen;
}

export async function paneOf(client: FleetClient, node: string, window: string): Promise<Pane> {
  const r = await client.op({ node }, "inventory.get", {});
  if (!r.ok) throw new Error(`inventory.get on ${node}: ${r.error.code}`);
  const p = r.result.panes.find(x => x.window === window);
  if (!p) throw new Error(`no pane "${window}" on ${node}: ${r.result.panes.map(x => x.window).join(", ")}`);
  return p;
}
export function expectOf(p: Pane): Expect {
  const ref = parseWorkerId(p.workerId);
  if (!ref) throw new Error(`not a worker id: ${p.workerId}`);
  return { server: ref.server, window: p.window, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
}

// ---- the hook relay and a test subscriber on the hook bus
export async function hook(agent: Agent, path: HookEvent["path"], body: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${agent.relayPort}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
export const keyParts = (key: string) => {
  const [node = "", streamId = "", seq = "0"] = key.split(":");
  return { node, streamId, seq: Number(seq) };
};
export type Delivery = { key: string; event: HookEvent; got: number; path: string; headers: Record<string, string> };
export type Subscriber = { url: string; received: Delivery[]; unique(): Map<string, Delivery> };
// Records each request before it answers, after `delayMs`, so a fleet killed mid-request redelivers it (at least once).
// `answer` picks each answer's status (default 200): a subscriber that refuses, as kira did while Telegram blocked it.
// `path`: the URL's path, "/hook" by default (the doc test uses kira's, "/fleet/hook").
export async function subscriber(o: { delayMs?: number; path?: string; answer?: (d: Delivery) => number } = {}): Promise<Subscriber> {
  const received: Delivery[] = [];
  const server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
      const d: Delivery = {
        key: headers["idempotency-key"] ?? "", event: JSON.parse(Buffer.concat(parts).toString()) as HookEvent, got: performance.now(),
        path: (req.url ?? "/").split("?")[0] ?? "/", headers,
      };
      received.push(d);
      setTimeout(() => res.writeHead(o.answer?.(d) ?? 200).end(), o.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${o.path ?? "/hook"}`,
    received,
    unique: () => { const m = new Map<string, Delivery>(); for (const d of received) if (!m.has(d.key)) m.set(d.key, d); return m; },
  };
}

// Deliveries as the fleet publishes them (`delivery` events) and mirrors them (GET /v1/deliveries/<id>). `states` keeps
// every state an id went through, so a drill can tell it waited for a menu after it has moved on; `until` polls the mirror
// and also accepts a state already published.
export type DeliveryWatch = {
  states(id: string): (DrillDelivery & { stale: boolean })[];
  until(id: string, what: (d: DrillDelivery) => boolean, ms?: number): Promise<DrillDelivery>;
};
export async function watchDeliveries(fleet: Fleet): Promise<DeliveryWatch> {
  const seen = new Map<string, (DrillDelivery & { stale: boolean })[]>();
  let open = false;
  closers.push(fleet.client.events(e => {
    if (e.t !== "delivery") return;
    const d = e.body as DrillDelivery & { stale: boolean };
    seen.set(d.id, [...(seen.get(d.id) ?? []), d]);
  }, { onOpen: () => { open = true; } }));
  await until("the fleet's events subscription", () => open);
  return {
    states: id => seen.get(id) ?? [],
    until: (id, what, ms = 30_000) => until(`delivery ${id}: ${what.toString().slice(0, 100)}`, async () => {
      const now = await fleet.client.delivery(id);
      if (now && what(now)) return now;
      return seen.get(id)?.find(what) ?? null;
    }, ms, 200),
  };
}

// ---- the hub in fleet mode
export type FeedWatch = {
  workers(): { id: string; name: string }[];
  seen: Set<string>; names: Set<string>;                        // every worker id and name the hub ever listed here
  screens: { worker: string; text: string; got: number }[];    // screen frames of the watched worker
  watch(worker: string | null): void; close(): void;
};
export type Reply = { status: number; body: Record<string, unknown> };
export type Hub = {
  base: string; origin: string; port: number; home: string; cookie: string; env: NodeJS.ProcessEnv;
  post(path: string, body: unknown): Promise<Reply>;
  send(workerId: string, text: string, requestId?: string): Promise<Reply>;
  answer(id: string, key: string, requestId?: string): Promise<Reply>;
  feed(): Promise<FeedWatch>; audit(): string; pairUrl(): string; stop(): Promise<void>;
  get(path: string): Promise<Reply>;                      // a GET with the seeded session's cookie
  log(): string;                                          // the hub's log so far, every start included
  // Stops the hub (SIGTERM by default), runs `whileStopped`, and serves again on the same HOME, port and database, with the
  // manager queue switched as asked (unchanged when not given); resolves once it listens again.
  restart(o?: { signal?: NodeJS.Signals; managerQueue?: boolean; whileStopped?: () => Promise<void> }): Promise<void>;
};

// A device and a verified session written straight into the hub's database before it starts, as e2e/qa-session.ts
// does, so a test can steer with a cookie and no passkey.
function seedSession(home: string): string {
  const store = new Store(home);
  const now = Date.now();
  const secret = randomBytes(32).toString("base64url");
  const id = `fleet-test-${randomBytes(4).toString("hex")}`;
  store.transaction(() => {
    store.saveEndpoint({
      id: endpointId(id), name: "fleet test", credential: { id, publicKey: new Uint8Array([0]), counter: 0, transports: [] },
      pairedAt: now, pairedWith: pairingTokenId("fleet-test-seeded"), lastSeenAt: now, revokedAt: null,
    });
    store.saveSession({ id: sessionId(hashSecret(secret)), endpointId: endpointId(id), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null });
  });
  store.close();
  return secret;
}

export async function startHub(fleet: Fleet, o: { pollMs?: number; web?: "stub" | "build"; ledger?: unknown; vnc?: string; managerQueue?: boolean } = {}): Promise<Hub> {
  const home = tempDir("morndo-hub-");
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  let web = join(ROOT, "apps/web/build");
  if (o.web !== "build") {
    web = join(home, "web");
    mkdirSync(web);
    writeFileSync(join(web, "200.html"), "<!doctype html><html><body>stub</body></html>");
  }
  // The hub's own TMPDIR, inside its HOME: what a SIGKILLed hub leaves (its staging dir) goes with the HOME.
  const scratch = join(home, "tmp");
  mkdirSync(scratch);
  const extra: Record<string, string> = {
    TMPDIR: scratch, MORNDO_HOME: home, MORNDO_PORT: String(port), MORNDO_ORIGIN: origin, MORNDO_FLEET_SOCKET: fleet.socketPath,
    MORNDO_POLL_MS: String(o.pollMs ?? 400), MORNDO_QUIET_AFTER_MS: "2000", MORNDO_WEB_DIR: web, MORNDO_INBOX: join(home, "inbox"),
  };
  if (o.vnc !== undefined) extra.MORNDO_VNC = o.vnc;
  // The hub as it ships: with a fleet, the manager's queue (MORNDO_MANAGER_QUEUE) is on unless a drill turns it off.
  if (o.managerQueue === false) extra.MORNDO_MANAGER_QUEUE = "off";
  if (o.ledger !== undefined) {
    const ledger = join(home, "ledger.json");
    writeFileSync(ledger, JSON.stringify(o.ledger));
    extra.MORNDO_LEDGER = ledger;
  }
  const env = cleanEnv(home, extra);
  const secret = seedSession(home);
  const log = join(home, "hub.log");
  const logText = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const starts = () => logText().split("morndo hub on").length - 1;
  let current = env;
  let proc: Proc | null = null;
  // The hub on this HOME, port and database; listening once its log says "morndo hub on" once more than before.
  const serve = async (e: NodeJS.ProcessEnv) => {
    const before = starts();
    const p = startProc("hub", [HUB_MAIN, "serve"], e, log);
    proc = p;
    await until("the hub listening", () => {
      if (!p.alive()) throw new Fatal(`the hub exited during startup (${p.child.exitCode ?? p.child.signalCode})\n${p.tail(15)}`);
      return starts() > before;
    }, 30_000);
  };
  await serve(env);
  const headers = { origin, "content-type": "application/json", cookie: `__Host-morndo=${secret}` };
  const post = async (path: string, body: unknown): Promise<Reply> => {
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const get = async (path: string): Promise<Reply> => {
    const r = await fetch(base + path, { headers });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", HUB_MAIN, ...args], { env: current, encoding: "utf8", timeout: 30_000 }).stdout ?? "";
  return {
    base, origin, port, home, env, cookie: secret, post, get,
    send: (workerId, text, requestId = randomUUID()) => post(`/api/workers/${encodeURIComponent(workerId)}/send`, { text, requestId, seen: "none" }),
    answer: (id, key, requestId = randomUUID()) => post(`/api/escalations/${encodeURIComponent(id)}/answer`, { key, requestId }),
    feed: () => openFeed(base, origin, secret),
    audit: () => cli("audit", "200"),
    pairUrl: () => cli("pair").split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "",
    log: logText,
    stop: async () => { await proc?.stop(); },
    async restart(o = {}) {
      await proc?.stop(o.signal ?? "SIGTERM");
      await o.whileStopped?.();
      if (o.managerQueue !== undefined) {
        // On is the hub's own default with a fleet (Task 12): the setting is left out; off is "off".
        const { MORNDO_MANAGER_QUEUE: _, ...rest } = current;
        current = o.managerQueue ? rest : { ...rest, MORNDO_MANAGER_QUEUE: "off" };
      }
      await serve(current);
    },
  };
}

type FeedFrame = {
  t: string; workers?: { id: string; name: string }[]; worker?: string; text?: string;
  events?: { body: { type: string; worker?: { id: string; name: string }; workerId?: string; name?: string } }[];
};
async function openFeed(base: string, origin: string, secret: string): Promise<FeedWatch> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/feed`, { headers: { origin, cookie: `__Host-morndo=${secret}` } });
  const roster = new Map<string, string>();
  const seen = new Set<string>();
  const names = new Set<string>();
  const screens: FeedWatch["screens"] = [];
  let snapshots = 0;
  const add = (id: string, name: string) => { roster.set(id, name); seen.add(id); names.add(name); };
  ws.on("message", raw => {
    const m = JSON.parse((Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8")) as FeedFrame;   // as apps/hub/test frameText
    if (m.t === "snapshot") { roster.clear(); for (const w of m.workers ?? []) add(w.id, w.name); snapshots++; }
    else if (m.t === "events") {
      for (const { body: b } of m.events ?? []) {
        if (b.type === "WorkerAppeared" && b.worker) add(b.worker.id, b.worker.name);
        else if (b.type === "WorkerRenamed" && b.workerId && b.name) add(b.workerId, b.name);
        else if (b.type === "WorkerGone" && b.workerId) roster.delete(b.workerId);
      }
    } else if (m.t === "screen" && m.worker && typeof m.text === "string") screens.push({ worker: m.worker, text: m.text, got: performance.now() });
  });
  ws.on("error", () => { /* a hub that went away: the test's own checks say what failed */ });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`the feed refused the upgrade: ${res.statusCode}`)));
  });
  closers.push(() => ws.close());
  ws.send(JSON.stringify({ t: "hello" }));
  await until("the hub's first snapshot", () => snapshots > 0);
  return {
    workers: () => [...roster].map(([id, name]) => ({ id, name })),
    seen, names, screens,
    watch: worker => ws.send(JSON.stringify({ t: "watch", worker })),
    close: () => ws.close(),
  };
}
