// The lanes' commands with an empty environment and the settings files in place (T-318, P1): each reaches the hub with the
// right token, the manager's window gets the manager's token and any other window the lane token, the environment wins
// when set, and with the files missing each says what it said before. Real processes, a stub hub on a local port, a
// home folder of its own. Every token is a made-up string and none may appear in any output.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APPS = join(import.meta.dirname, "../..");
const PROGRAMS = {
  board: join(APPS, "board-cli/src/main.ts"),
  decide: join(APPS, "board-cli/src/decide-main.ts"),
  memory: join(APPS, "memory-cli/src/main.ts"),
  job: join(APPS, "node-agent/src/job-main.ts"),
  hub: join(APPS, "hub/src/main.ts"),
};
const LANE_TOKEN = "fake-lane-token-7f3a";
const MANAGER_TOKEN = "fake-manager-token-91c2";
const ENV_TOKEN = "fake-env-token-5d08";

let server: Server;
let hubUrl = "";
const seen: { url: string; authorization: string | undefined; lane: string | undefined }[] = [];
const homes: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization, lane: req.headers["x-morndo-lane"] as string | undefined });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  hubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function home(withFiles: boolean): string {
  const h = mkdtempSync(join(tmpdir(), "morndo-p1-"));
  homes.push(h);
  if (withFiles) {
    const dir = join(h, ".config/morndo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-hub"), `${hubUrl}\n`);
    writeFileSync(join(dir, "agent-node"), "build-pc\n");
    writeFileSync(join(dir, "agent-lanes.token"), `${LANE_TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "agent-manager.token"), `${MANAGER_TOKEN}\n`, { mode: 0o600 });
  }
  return h;
}

// One run of a program with exactly this environment (and a PATH, so nothing else leaks in).
function runProgram(program: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--no-warnings", program, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const noToken = (r: { out: string; err: string }) => {
  for (const t of [LANE_TOKEN, MANAGER_TOKEN, ENV_TOKEN]) expect(r.out + r.err, "no token in any output").not.toContain(t);
};

// The commands that call the hub, one per CLI that does.
const HUB_CALLS = {
  board: ["show", "T-1"],
  decide: ["show", "dr-1"],
  memory: ["search", "anything"],
} as const;

describe.each(Object.entries(HUB_CALLS))("morndo-%s with an empty environment and the settings files", (name, args) => {
  const program = PROGRAMS[name as keyof typeof HUB_CALLS];

  it("reaches the hub from the file and sends the lane token from a lane's window", async () => {
    seen.length = 0;
    const r = await runProgram(program, [...args], { HOME: home(true), MORNDO_LANE: "builder" });
    expect(seen.length, r.err).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === `Bearer ${LANE_TOKEN}`)).toBe(true);
    noToken(r);
  });

  it("sends the manager's token from the manager's window", async () => {
    seen.length = 0;
    const r = await runProgram(program, [...args], { HOME: home(true), MORNDO_LANE: "manager" });
    expect(seen.length, r.err).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === `Bearer ${MANAGER_TOKEN}`)).toBe(true);
    noToken(r);
  });

  it("uses the environment when it is set, whatever the files say", async () => {
    seen.length = 0;
    const r = await runProgram(program, [...args], { HOME: home(true), MORNDO_LANE: "manager", MORNDO_HUB: hubUrl, MORNDO_AGENT_TOKEN: ENV_TOKEN });
    expect(seen.length, r.err).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === `Bearer ${ENV_TOKEN}`)).toBe(true);
    noToken(r);
  });

  it("with no files and no environment says what it said before, and calls no hub", async () => {
    seen.length = 0;
    const r = await runProgram(program, [...args], { HOME: home(false), MORNDO_LANE: "builder" });
    expect(seen).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/MORNDO_HUB/);
    expect(r.err).toMatch(/MORNDO_AGENT_TOKEN/);
    noToken(r);
  });
});

describe("morndo-job with an empty environment", () => {
  const START = ["start", "--notify", "lane:builder", "--", "true"];

  it("finds its lane token in the files: it no longer stops for the missing token", async () => {
    const r = await runProgram(PROGRAMS.job, START, { HOME: home(true), MORNDO_LANE: "builder" });
    expect(r.err).not.toMatch(/MORNDO_AGENT_TOKEN/);
    expect(r.err).not.toMatch(/which lane/);
    noToken(r);
  });

  it("with no files it says what it said before: the hub has no token for this call", async () => {
    const r = await runProgram(PROGRAMS.job, START, { HOME: home(false), MORNDO_LANE: "builder" });
    expect(r.code).toBe(4);
    expect(r.err).toContain("the hub has no token for this call (MORNDO_AGENT_TOKEN)");
  });

  it("with no lane at all it still asks for one", async () => {
    const r = await runProgram(PROGRAMS.job, START, { HOME: home(true) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("which lane? set MORNDO_LANE");
  });
});

describe("morndo job through the morndo launcher", () => {
  it("runs the job program: a bare `job` prints the job usage and exits 2, as morndo-job does", async () => {
    const viaHub = await runProgram(PROGRAMS.hub, ["job"], { HOME: home(true) });
    const direct = await runProgram(PROGRAMS.job, [], { HOME: home(true) });
    expect(direct.code).toBe(2);
    expect(viaHub.code).toBe(2);
    expect(viaHub.err).toBe(direct.err);
    expect(viaHub.err).toContain("usage: morndo job start --notify");
  });

  it("hands over its arguments and its environment: the missing-token answer comes through", async () => {
    const r = await runProgram(PROGRAMS.hub, ["job", "start", "--notify", "lane:builder", "--", "true"], { HOME: home(false), MORNDO_LANE: "builder" });
    expect(r.code).toBe(4);
    expect(r.err).toContain("the hub has no token for this call (MORNDO_AGENT_TOKEN)");
  });
});

// The help of the CLIs that read these settings says where they come from.
describe.each([["board", ["help"]], ["decide", ["help"]], ["memory", ["help"]]] as const)("morndo-%s help", (name, args) => {
  it("names the settings files, so no one keeps exporting the token into every lane's environment", async () => {
    const r = await runProgram(PROGRAMS[name], [...args], { HOME: home(false) });
    expect(r.out).toContain("agent-hub");
    expect(r.out).toContain("~/.config/morndo");
  });
});

// The lane is the window of the pane the command runs in, not the window on screen: with the manager's window in front,
// a command in a lane's pane must still get the lane token, and the manager's pane the manager's token. A real tmux server of
// its own, on its own socket.
describe("morndo-board in real tmux panes", () => {
  const dir = mkdtempSync(join(tmpdir(), "morndo-p1-tmux-"));
  homes.push(dir);
  const socket = join(dir, "sock");
  const tmux = (...a: string[]) => execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...a], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", TMUX_TMPDIR: dir } }).trim();
  let tmuxEnv = "";
  const panes: Record<string, string> = {};

  beforeAll(() => {
    tmux("new-session", "-d", "-s", "t", "-n", "manager", "sleep 300");
    tmux("new-window", "-d", "-t", "t", "-n", "builder", "sleep 300");
    for (const line of tmux("list-panes", "-a", "-F", "#{window_name} #{pane_id}").split("\n")) {
      const [window, pane] = line.split(" ");
      if (window && pane) panes[window] = pane;
    }
    tmux("select-window", "-t", "t:manager");                       // the manager's window is the one on screen
    tmuxEnv = `${socket},${tmux("display-message", "-p", "#{pid}")},0`;
  });
  afterAll(() => { try { tmux("kill-server"); } catch { /* already gone */ } });

  it("a command in the lane's pane gets the lane token while the manager's window is in front", async () => {
    seen.length = 0;
    const r = await runProgram(PROGRAMS.board, ["show", "T-1"], { HOME: home(true), TMUX: tmuxEnv, TMUX_PANE: panes.builder! });
    expect(seen.length, r.err).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === `Bearer ${LANE_TOKEN}` && s.lane === "builder")).toBe(true);
    noToken(r);
  });

  it("a command in the manager's pane gets the manager's token and its name", async () => {
    seen.length = 0;
    const r = await runProgram(PROGRAMS.board, ["show", "T-1"], { HOME: home(true), TMUX: tmuxEnv, TMUX_PANE: panes.manager! });
    expect(seen.length, r.err).toBeGreaterThan(0);
    expect(seen.every(s => s.authorization === `Bearer ${MANAGER_TOKEN}` && s.lane === "manager")).toBe(true);
    noToken(r);
  });
});

// tmux is only asked when a command needs the lane, and only once; never for help. A stand-in tmux program that notes each call
// and answers nothing.
describe("how often tmux is started", () => {
  function standIn(): { bin: string; marker: string; calls: () => number } {
    const d = mkdtempSync(join(tmpdir(), "morndo-p1-stub-"));
    homes.push(d);
    const marker = join(d, "calls");
    writeFileSync(join(d, "tmux"), `#!/bin/sh\necho x >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    return { bin: d, marker, calls: () => { try { return readFileSync(marker, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } } };
  }
  const inTmux = (bin: string) => ({ PATH: `${bin}:${process.env.PATH ?? ""}`, TMUX: "/tmp/none,1,0", TMUX_PANE: "%9" });

  it.each([["board", ["help"]], ["decide", ["help"]], ["memory", ["help"]], ["board", ["prompt", "--role", "worker"]]] as const)("morndo-%s %j does not start tmux", async (name, args) => {
    const t = standIn();
    await runProgram(PROGRAMS[name], [...args], { HOME: home(true), ...inTmux(t.bin) });
    expect(t.calls()).toBe(0);
  });

  it.each([["board", ["show", "T-1"]], ["decide", ["show", "dr-1"]], ["memory", ["search", "anything"]]] as const)("morndo-%s %j asks tmux once for its lane, with its pane's query and the fallback after it", async (name, args) => {
    const t = standIn();
    await runProgram(PROGRAMS[name], [...args], { HOME: home(true), ...inTmux(t.bin) });
    expect(t.calls()).toBe(2);
  });

  it("morndo-board --role worker prompt starts no tmux: the command word is prompt, not worker", async () => {
    const t = standIn();
    await runProgram(PROGRAMS.board, ["--role", "worker", "prompt"], { HOME: home(true), ...inTmux(t.bin) });
    expect(t.calls()).toBe(0);
  });
});

describe("commands whose arguments look like a help request", () => {
  it("morndo-job start, with -h or --help in the job's own command, still loads its settings", async () => {
    for (const child of [["ls", "-h", "/tmp"], ["grep", "--help"]]) {
      const r = await runProgram(PROGRAMS.job, ["start", "--notify", "lane:builder", "--", ...child], { HOME: home(true), MORNDO_LANE: "builder" });
      expect(r.err, child.join(" ")).not.toMatch(/MORNDO_AGENT_TOKEN/);
    }
  });

  it("morndo-memory --kind help search x reaches the hub with the file's settings: help is a flag's value", async () => {
    seen.length = 0;
    const r = await runProgram(PROGRAMS.memory, ["--kind", "help", "search", "x"], { HOME: home(true), MORNDO_LANE: "builder" });
    expect(seen.length, r.err).toBeGreaterThan(0);
  });
});

describe("a token in the environment is not sent to a hub from a file", () => {
  it("with MORNDO_AGENT_TOKEN set and no MORNDO_HUB, morndo-board calls no hub and says what it said before", async () => {
    seen.length = 0;
    const r = await runProgram(PROGRAMS.board, ["show", "T-1"], { HOME: home(true), MORNDO_LANE: "builder", MORNDO_AGENT_TOKEN: ENV_TOKEN });
    expect(seen).toEqual([]);
    expect(r.err).toMatch(/MORNDO_HUB/);
    noToken(r);
  });

  it("with MORNDO_HUB set and no token, no token from a file is sent to it", async () => {
    seen.length = 0;
    const r = await runProgram(PROGRAMS.board, ["show", "T-1"], { HOME: home(true), MORNDO_LANE: "builder", MORNDO_HUB: hubUrl });
    expect(seen).toEqual([]);
    expect(r.err).toMatch(/MORNDO_AGENT_TOKEN/);
    noToken(r);
  });
});

describe("a node name from the file that is no node name", () => {
  it("does not stop morndo-memory with an error about MORNDO_NODE or print the file's content", async () => {
    seen.length = 0;
    const h = home(true);
    writeFileSync(join(h, ".config/morndo/agent-node"), "Build_PC\n");
    const r = await runProgram(PROGRAMS.memory, ["remember", "--kind", "fact", "--title", "t", "--body", "b"], { HOME: h, MORNDO_LANE: "builder" });
    expect(r.err).not.toMatch(/MORNDO_NODE/);
    expect(r.err).not.toContain("Build_PC");
    expect(seen.length, r.err).toBeGreaterThan(0);
  });
});

describe("morndo --help", () => {
  it("lists morndo job", async () => {
    const r = await runProgram(PROGRAMS.hub, ["help"], { HOME: home(true) });
    expect(r.out).toMatch(/morndo job\b/);
  });
});
