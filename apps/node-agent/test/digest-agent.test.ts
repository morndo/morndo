// The reply style ask inside a whole agent (T-308): the manager's Stop is checked against the hub's board, read with a
// token from a file, and that token never reaches a lane's environment. A fake hub stands in for /api/agent/board.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { replyStyleReason } from "../src/relay/digest-check.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

const TOKEN = "mgr_secret-token-for-the-board";
const BOARD = { merged: [{ key: "T-310", live: false, label: "merged, not live", merges: [{ repo: "morndo/morndo", sha: "5b354d6aaa", at: 1, by: "manager", override: null }] }] };
const DIGEST = "### Digest\n- [x] T-310 merged\nOne lane needs a key.";
const NOT_LIVE = replyStyleReason("digest", ['"T-310" listed as done, but the board has the merge not live yet']);

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let hub: Server;
let hubUrl = "";
let seen: { url: string; auth: string; lane: string }[] = [];
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
const savedToken = process.env.MORNDO_AGENT_TOKEN;
beforeEach(async () => {
  delete process.env.MORNDO_AGENT_TOKEN;
  seen = [];
  hub = createServer((req, res) => {
    req.resume();
    seen.push({ url: req.url ?? "", auth: req.headers.authorization ?? "", lane: String(req.headers["x-morndo-lane"]) });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(BOARD));
  });
  await new Promise<void>(resolve => hub.listen(0, "127.0.0.1", () => resolve()));
  const address = hub.address();
  if (!address || typeof address === "string") throw new Error("hub");
  hubUrl = `http://127.0.0.1:${address.port}`;
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket, hubUrl);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await new Promise(resolve => hub.close(() => resolve(undefined)));
  await fleet.close();
  await t.kill();
  home.cleanup();
  if (savedToken === undefined) delete process.env.MORNDO_AGENT_TOKEN; else process.env.MORNDO_AGENT_TOKEN = savedToken;
});
const tokenFile = () => agentPaths(home.home).boardTokenFile;
const writeToken = (mode = 0o600) => { mkdirSync(dirname(tokenFile()), { recursive: true }); writeFileSync(tokenFile(), `${TOKEN}\n`, { mode }); chmodSync(tokenFile(), mode); };
const stop = (message: string, window = "manager") => ({ session_id: "no-such-session", hook_event_name: "Stop", stop_hook_active: false, window, last_assistant_message: message });

describe("the board token of the reply style ask", () => {
  it("reads the board with the token from its file, and the manager's digest that lists a not-live merge as done is asked once", async () => {
    writeToken();
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    const asked = await post("/hook/stop", stop(DIGEST));
    expect(await asked.json()).toEqual({ decision: "block", reason: NOT_LIVE });
    expect(seen).toEqual([{ url: "/api/agent/board", auth: `Bearer ${TOKEN}`, lane: "manager" }]);
    const after = await post("/hook/stop", { ...stop(DIGEST), stop_hook_active: true });
    expect(await after.json()).toEqual({ ok: true, queued: true });
    expect(seen).toHaveLength(1);                                                // the Stop after the ask reads nothing
  });

  it("reads the file when it is used: a token written after the agent started is the one sent", async () => {
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await (await post("/hook/stop", stop(DIGEST))).json()).toEqual({ ok: true, queued: true });   // no file yet: only length and jargon
    expect(seen).toEqual([]);
    writeToken();
    expect(await (await post("/hook/stop", stop(DIGEST))).json()).toEqual({ decision: "block", reason: NOT_LIVE });
    expect(seen.map(s => s.auth)).toEqual([`Bearer ${TOKEN}`]);
  });

  it("does not use a token file that other users can read", async () => {
    writeToken(0o644);
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await (await post("/hook/stop", stop(DIGEST))).json()).toEqual({ ok: true, queued: true });
    expect(seen).toEqual([]);
  });

  it("does not read the token from the environment: it would reach every lane the node starts, so it is ignored and said so", async () => {
    process.env.MORNDO_AGENT_TOKEN = TOKEN;
    const { agent, post, lines } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await (await post("/hook/stop", stop(DIGEST))).json()).toEqual({ ok: true, queued: true });
    expect(seen).toEqual([]);
    expect(lines.join("\n")).toMatch(/MORNDO_AGENT_TOKEN is set in the node's environment and is ignored/);
  });

  it("a lane started after it has read the token has no token in its environment, and the agent put none in its own", async () => {
    writeToken();
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await (await post("/hook/stop", stop(DIGEST))).json()).toEqual({ decision: "block", reason: NOT_LIVE });
    const out = join(home.home, "lane-env.txt");
    t.tmux("new-window", "-d", "-t", "main", "-n", "worker", `env > '${out}'; sleep 600`);
    expect(await until(() => existsSync(out) && readFileSync(out, "utf8").includes("PATH="))).toBe(true);
    expect(readFileSync(out, "utf8")).not.toContain(TOKEN);
    expect(readFileSync(out, "utf8")).not.toContain("MORNDO_AGENT_TOKEN");
    expect(Object.entries(process.env).filter(([, v]) => v?.includes(TOKEN))).toEqual([]);
  });
});
