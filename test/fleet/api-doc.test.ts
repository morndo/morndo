// docs/fleet-api.md runs as tests (fleet clients spec §8, §12 "Contract", §15.3): every example in it, in the order written,
// against a real fleet, a real node agent and lanes that stand in for the CLI (test/fleet-harness.ts: temporary HOMEs,
// random ports, an isolated tmux server; test/fixtures/fake-claude-pane.ts). The doc's section 4 says how an example reads,
// and test/api-doc-examples.ts parses and matches them. The setup the doc's section 4 names is made here; an example that
// needs a lane in another state (a menu open, a busy turn) gets it from BEFORE, by the example's name, and back from AFTER.
// The doc names the node's hook relay by its default address, http://127.0.0.1:8787; requests to it go to this agent's own
// relay port, and nothing here connects to 8787.
// Also checked: the doc covers every route, every relay path, every op the client API takes, every error code with its
// `executed`, every event type, every lane event and every alert kind. The lists come from packages/protocol where they
// live there, so a new one fails here until it is documented.
// Negative controls: test/fleet/api-doc-matcher.test.ts ("(negative control) an altered answer fails"), and
// scripts/negative-controls.ts fc15-doc-answer and fc15-doc-executed, which alter the doc itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERROR_EXECUTED, OP_NAMES, type AlertKind, type LaneEventName } from "../../packages/protocol/src/fleet.ts";
import { matchAnswer, matchEvents, matchReceived, parseExamples, substitute, type Answer, type Example, type Http, type Vars, type Verdict } from "../api-doc-examples.ts";
import {
  FAKE_CLAUDE, ROOT, cleanEnv, fakeLane, joinAgent, paneOf, shellLane, sleep, startFleet, stopAll, subscriber, tempDir, tmuxServer, until,
  updatePolicy, type Agent, type Fleet, type Lane, type Subscriber,
} from "../fleet-harness.ts";

const doc = readFileSync(join(ROOT, "docs/fleet-api.md"), "utf8");
const examples = parseExamples(doc);
const RELAY = "http://127.0.0.1:8787";
const HOOK_PATHS = ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] as const;
const GRACE_MS = 5000;              // the agent's start grace for a pane with no session, shortened (deliveryStartGraceMs)

let fleet: Fleet;
let agent: Agent;
let sub: Subscriber;
let w1: Lane;
let sh1At = 0;
let events: WebSocket | null = null;
const recorded: unknown[] = [];     // every message on one /v1/events subscription, opened before the agent first connects
const vars: Vars = new Map();

const text = (raw: RawData) => (Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8");
// A WebSocket to /v1/events over the fleet's socket, through ws's createConnection option as packages/fleet-client does it.
function openEvents(into: unknown[]): Promise<WebSocket> {
  const ws = new WebSocket("ws://fleet/v1/events", { createConnection: () => createConnection(fleet.socketPath) });
  ws.on("message", raw => into.push(JSON.parse(text(raw)) as unknown));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// The doc's setup (its section 4): node n1 with manager and w1 (the box, idle), sh1 (a shell), two windows named dup;
// n2 and n3 joined and offline; a file, a git repository and two empty lane folders on n1 (w3's marked untrusted).
beforeAll(async () => {
  sub = await subscriber({ path: "/fleet/hook" });
  fleet = await startFleet({ subscribers: [{ name: "doc", url: sub.url, paths: [...HOOK_PATHS] }] });   // lane events: published only
  events = await openEvents(recorded);
  const tmux = tmuxServer();
  agent = await joinAgent(fleet, "n1", { tmux });
  await joinAgent(fleet, "n2", { tmux });
  await joinAgent(fleet, "n3", { tmux });
  updatePolicy(agent, {
    launch: { command: [process.execPath, "--no-warnings", FAKE_CLAUDE, ".", `--claude=${join(agent.home, ".claude")}`, "--session=auto"], via: "direct" },
    protected: ["manager"],
  });
  const manager = await fakeLane(tmux, { window: "manager", claudeHome: agent.home });
  w1 = await fakeLane(tmux, { window: "w1", claudeHome: agent.home });
  shellLane(tmux, { window: "sh1" });
  sh1At = Date.now();
  shellLane(tmux, { window: "dup" });
  shellLane(tmux, { window: "dup" });
  const home = realpathSync(agent.home);
  mkdirSync(join(home, "notes"));
  writeFileSync(join(home, "notes/hello.txt"), "hello\n");
  const repo = join(home, "repos/r1");
  mkdirSync(repo, { recursive: true });
  const env = { ...cleanEnv(agent.home), GIT_AUTHOR_NAME: "doc", GIT_AUTHOR_EMAIL: "doc@example.invalid", GIT_COMMITTER_NAME: "doc", GIT_COMMITTER_EMAIL: "doc@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { env });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README"), "r1\n");
  git("add", "README");
  git("commit", "-q", "-m", "r1");
  const w2 = tempDir("morndo-doc-w2-");
  const w3 = tempDir("morndo-doc-w3-");
  writeFileSync(join(w3, "untrusted"), "");
  await agent.run({ deliveryStartGraceMs: GRACE_MS });
  await agent.waitOnline();
  const lanes = await until("n1's lanes, dup in conflict", async () => {
    const l = await fleet.client.lanes();
    return l.some(x => x.name === "dup" && x.conflict) && ["manager", "w1", "sh1"].every(n => l.some(x => x.name === n && x.workerId)) ? l : null;
  }, 20_000);
  for (const name of ["manager", "w1", "sh1"]) vars.set(name, lanes.find(l => l.name === name)?.workerId);
  for (const w of ["manager", "w1"]) await until(`${w} idle`, async () => (await paneOf(fleet.client, "n1", w)).status === "idle", 15_000);
  vars.set("manager-session", manager.sessionId);
  vars.set("w1-session", w1.sessionId);
  vars.set("notes", join(home, "notes/hello.txt"));
  vars.set("repo", repo);
  vars.set("w2-dir", w2);
  vars.set("w3-dir", w3);
}, 120_000);
afterAll(async () => { events?.close(); await stopAll(); });

const statusIs = (window: string, s: string) =>
  until(`${window} ${s} in n1's inventory`, async () => (await paneOf(fleet.client, "n1", window)).status === s, 15_000);
const BEFORE: Record<string, () => Promise<void>> = {
  "deliver-menu": async () => { await w1.control({ status: "waiting" }); await statusIs("w1", "waiting"); },
  "deliver-busy": async () => { await w1.control({ status: "busy" }); await statusIs("w1", "busy"); },
  "delivery-held-delivered": async () => { await w1.control({ dequeue: true }); await w1.control({ prompt: true, status: "idle" }); },
  "deliver-silent": async () => { await w1.control({ silent: true }); },
  "deliver-no-session": async () => { await sleep(Math.max(0, sh1At + GRACE_MS + 1000 - Date.now())); },
  "err-menu-open": async () => { await w1.control({ status: "waiting" }); await statusIs("w1", "waiting"); },
  "err-draft-present": async () => { w1.draft("half a thought"); await until("the draft on w1", () => w1.screen().includes("half a thought")); },
  // the control plane's own rollback, as its updater's state file records it: the fleet halts that Version (§5.4)
  "events-rollout": async () => {
    const { controlPlane } = await fleet.client.rollout();
    const dir = join(fleet.home, ".local", "state", "morndo-update");
    mkdirSync(dir, { recursive: true });
    // it ran a pre-release of the Version before (lower by SemVer precedence), and rolled back from that Version
    const before = controlPlane.version.includes("-") ? controlPlane.version.replace(/-.*$/, "-0") : `${controlPlane.version}-0`;
    // its updater announced its own random attempt id when it began applying, then rolled back under it
    const attempt = "docAttemptQ1w2E3r4T5y6U7";
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "applying", version: before, target: controlPlane.version, attempt, at: Date.now() }));
    await sleep(1500);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "rolled_back", version: before, target: controlPlane.version, failedCheck: "fleet health", attempt, at: Date.now() + 1 }));
    await until("the halt from the control plane's own rollback", async () => (await fleet.client.rollout()).rollout?.halted === true, 15_000);
  },
};
const AFTER: Record<string, () => Promise<void>> = {
  "delivery-expired": async () => { await w1.control({ status: "idle" }); await statusIs("w1", "idle"); },
  "delivery-uncertain": async () => { await w1.control({ silent: false }); },
  "err-menu-open": async () => { await w1.control({ status: "idle" }); await statusIs("w1", "idle"); },
  "err-draft-present": async () => { w1.clear(); await until("w1's box empty", () => !w1.screen().includes("half a thought")); },
};

async function send(req: Http): Promise<Answer> {
  const target = substitute(req.target, vars);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, substitute(v, vars)]));
  const body = substitute(req.body, vars);
  if (target.includes("://")) {
    if (!target.startsWith(`${RELAY}/`)) throw new Error(`${target}: an example names only the fleet's socket and the relay at ${RELAY}`);
    const r = await fetch(`http://127.0.0.1:${agent.relayPort}${target.slice(RELAY.length)}`, { method: req.method, headers, ...(body ? { body } : {}) });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  }
  return new Promise((resolve, reject) => {
    const q = request({ socketPath: fleet.socketPath, agent: false, method: req.method, path: target, headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"),
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
      }));
    });
    q.on("error", reject);
    q.end(body || undefined);
  });
}
const commit = (v: Verdict): true => {
  if (!v.ok) throw new Error(v.why);
  for (const [k, x] of v.vars) vars.set(k, x);
  return true;
};

async function run(ex: Example): Promise<void> {
  if (ex.kind === "http") {
    const end = performance.now() + (ex.poll ? 20_000 : 0);
    for (;;) {
      const got = await send(ex.request);
      const v = matchAnswer(ex.answer, got, vars);
      if (v.ok) { commit(v); return; }
      if (performance.now() > end) throw new Error(`${ex.name}: ${v.why}\n  the answer: ${got.status} ${got.body.slice(0, 3000)}`);
      await sleep(250);
    }
  }
  if (ex.kind === "events") {
    await until(`${ex.name} on /v1/events`, () => commit(matchEvents(ex.messages, recorded, vars)), 20_000);
    return;
  }
  if (ex.kind === "subscriber") {
    await until(`${ex.name} at the subscriber`, () => commit(matchReceived(ex.request, sub.received, vars)), 20_000);
    return;
  }
  expect(ex.request.target).toBe("/v1/events");
  const got: unknown[] = [];
  const ws = await openEvents(got);
  try { await until(`${ex.name}: its messages`, () => commit(matchEvents(ex.messages, got, vars)), 10_000); }
  finally { ws.close(); }
}

describe("docs/fleet-api.md: every example against a real fleet, in the order written", () => {
  for (const ex of examples) {
    it(ex.name, async () => {
      await BEFORE[ex.name]?.();
      await run(ex);
      await AFTER[ex.name]?.();
    }, 60_000);
  }
});

// Each list below is checked complete by the type checker: a kind the protocol adds fails to compile until listed.
const ALERT_KINDS = {
  instance_conflict: true, source_changed: true, clock_offset: true, rate_limited: true, lane_conflict: true, dead_letter: true,
  backlog_full: true, unrouted_hook: true, delivery_waiting: true, subscriber_lagging: true, job_failed: true, job_unnoticed: true, connection: true,
  engine_fallback: true, draft_stashed: true, rollout_halted: true, update_rolled_back: true, update_rollback_failed: true, update_skew_blocked: true,
} satisfies Record<AlertKind, true>;
const LANE_EVENTS = { finished: true, needs_input: true, answered: true, stop_failure: true, stale: true } satisfies Record<LaneEventName, true>;
const EVENT_TYPES = ["status", "inventory", "health", "conflict", "alert", "delivery", "lane", "run", "rollout"];
const ROUTES: RegExp[] = [
  /^GET \/v1\/caps$/, /^GET \/v1\/nodes$/, /^POST \/v1\/nodes\/[^/]+\/revoke$/, /^GET \/v1\/lanes$/, /^GET \/v1\/lanes\/[^/]+$/,
  /^GET \/v1\/alerts$/, /^POST \/v1\/op$/, /^GET \/v1\/files\/[^/]+\/[^/]+$/, /^POST \/v1\/deliveries$/, /^GET \/v1\/deliveries\/[^/?]+$/,
  /^GET \/v1\/deliveries\?/, /^POST \/v1\/deliveries\/[^/]+\/cancel$/, /^GET \/v1\/lane-events\?since=/, /^GET \/v1\/lane-watch$/, /^GET \/v1\/runs$/, /^WS \/v1\/events$/,
  /^GET \/v1\/rollout$/, /^POST \/v1\/rollout\/committed$/, /^POST \/v1\/rollout\/halt$/, /^POST \/v1\/rollout\/resume$/,
];

describe("docs/fleet-api.md covers the whole client API", () => {
  const targets = examples.flatMap(e => (e.kind === "http" || e.kind === "ws" ? [`${e.request.method} ${e.request.target}`] : []));
  it("an example for every route and every path of the hook relay", () => {
    for (const route of ROUTES) expect(targets.some(t => route.test(t)), String(route)).toBe(true);
    for (const p of HOOK_PATHS) expect(targets, p).toContain(`POST ${RELAY}${p}`);
  });
  it("an example for every op, the two that POST /v1/op refuses included", () => {
    for (const op of OP_NAMES) expect(doc, op).toContain(`"op": "${op}"`);
  });
  it("every error code in the errors table, with whether it ran", () => {
    for (const [code, executed] of Object.entries(ERROR_EXECUTED)) expect(doc).toContain(`| \`${code}\` | ${executed} |`);
  });
  it("every event type in an example, every lane event in an example, every alert kind in the alerts table", () => {
    for (const t of EVENT_TYPES) expect(doc, t).toContain(`{"t":"${t}"`);
    for (const e of Object.keys(LANE_EVENTS)) expect(doc, e).toContain(`"event": "${e}"`);
    for (const k of Object.keys(ALERT_KINDS)) expect(doc, k).toContain(`| \`${k}\` |`);
  });
  it("names the relay only by its default address, which this test never dials", () => {
    for (const t of targets.filter(x => x.includes("://"))) expect(t.startsWith(`POST ${RELAY}/`), t).toBe(true);
  });
});
