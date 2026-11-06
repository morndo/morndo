// The lanes' commands with an empty environment and the settings files in place (T-318, P1): each reaches the hub with the
// right token, the manager's window gets the manager's token and any other window the lane token, the environment wins
// when set, and with the files missing each says what it said before. Real processes, a stub hub on a local port, a
// home folder of its own. Every token is a made-up string and none may appear in any output.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
