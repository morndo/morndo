// The machine side of the two-machine fleet run (PR 6d, e2e/update-fleet.e2e.ts): this runs INSIDE each container
// as the worker, one step per invocation, under the unpacked A tree's own Node — the host names the step on the
// command line (`fleet-steps.ts <step> [arg]`) and reads exactly the JSON check lines this prints
// ({"step": "...", "ok": true|false, "detail": ...}, one per check, as e2e/update-vm/scenario.ts prints them).
// The same file runs on both machines; the hostname tells them apart ("cp" is the control plane, "node" the node),
// and a step that does not belong on this machine says so and fails its one check.
//
// The story (updates design §13's second machine, the fleet half): install A on cp and join the node; B soaks and
// the node defers; the principal's "Update now" skips the soak; G breaks the node's agent and its rollback halts
// the Rollout; the principal resumes; H is held by the skew gate until the node is revoked; nothing is left
// behind. The feed is served on each machine's own 127.0.0.1:8443 by a feed-server.ts the host started detached,
// and the transport between the machines is the forward.ts pipe (see e2e/update-fleet.e2e.ts).
//
// Every principal command's whole word goes to ~/e2e/evidence, with a snapshot of state.json and
// `morndo update --status --json` per step; the host copies the directory out. Constants that mirror product code
// are named here so this file stands alone in the machine (scenario.ts's own rule).
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { request as httpRequest } from "node:http";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

const HOME = homedir();
const E2E = join(HOME, "e2e");
const FEEDS = join(E2E, "feeds");
const FEED_LINK = join(E2E, "feed");
const EVIDENCE = join(E2E, "evidence");
const FEED_URL = "https://127.0.0.1:8443/";                   // build.ts's FEED_URL; the two must agree
const MORNDO = join(HOME, ".local/bin/morndo");
const MORNDO_FLEET = join(HOME, ".local/bin/morndo-fleet");
const MORNDO_NODE = join(HOME, ".local/bin/morndo-node");
const MORNDO_UPDATE = join(HOME, ".local/bin/morndo-update");   // its tick is "update tick": argv[0] must be update (cli.ts), the same door `morndo update` opens
const RELEASES = join(HOME, ".local/share/morndo-releases");
const UPDATE_STATE = join(HOME, ".local/state/morndo-update");
const UPDATE_DB = join(UPDATE_STATE, "update.db");
const STATE_JSON = join(UPDATE_STATE, "state.json");
const FLEET_SOCK = join(HOME, ".local/state/morndo-fleet/fleet.sock");
const HUB_PORT = 18790;                                       // cp only: the hub's own port, forwarded to the host
const UNIT_DIR = join(HOME, ".config/systemd/user");
const IS_CP = hostname() === "cp";
const MACHINE = IS_CP ? "cp" : "node";
// services-systemd.ts's UNIT_MARK: the first line of every unit file a render writes.
const UNIT_MARK = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).";
const VERSION_A = "0.1.0";
const VERSION_B = "0.2.0";
const VERSION_G = "0.3.0";
const VERSION_H = "0.4.0";
const NODE_NAME = "e2e-node";
const CP_NODE_NAME = "e2e-cp";                                  // the control plane's own node, joined in step 1 (#109's own step 1 joins it)
const SERVICE_UNITS = IS_CP ? ["morndo-hub.service", "morndo-fleet.service"] : ["morndo-node.service"];
// Once cp's own node is joined, every cp apply restarts the agent with the rest (the safe point probes it), so
// cp's applies wait for all three — #109's single machine waits for all three too.
const APPLY_UNITS = IS_CP ? [...SERVICE_UNITS, "morndo-node.service"] : SERVICE_UNITS;

const ENV = {
  ...process.env, HOME,
  PATH: `${join(HOME, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`,
  MORNDO_UPDATE_FEED: FEED_URL,
  NODE_EXTRA_CA_CERTS: join(E2E, "tls/ca.pem"),
  ...(IS_CP ? { MORNDO_PORT: String(HUB_PORT) } : {}),        // the hub's web port, and the updater's own probe of it
};

type Check = { step: string; ok: boolean; detail: string };
const checks: Check[] = [];
let failed = false;

function check(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`);
}

// One command, one argument list, no shell (scenario.ts's own rule); `input` feeds stdin a typed word.
function run(file: string, args: string[], o: { timeoutMs?: number; input?: string } = {}):
  { code: number; out: string; err: string } {
  const done = spawnSync(file, args, { encoding: "utf8", env: ENV, input: o.input, timeout: o.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { code: done.status ?? -1, out: done.stdout ?? "", err: done.stderr ?? "" };
}

// A principal command of the story: run(), and keep its whole word in the evidence directory whatever happened.
function command(label: string, file: string, args: string[], o: { timeoutMs?: number; input?: string } = {}):
  { code: number; out: string; err: string } {
  const r = run(file, args, o);
  writeFileSync(join(EVIDENCE, `command-${MACHINE}-${label}.txt`),
    `$ ${file} ${args.join(" ")}${o.input === undefined ? "" : `  (stdin: ${JSON.stringify(o.input)})`}\nexit ${r.code}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`);
  return r;
}

// The first lines of a command's word, for a check's detail line (scenario.ts's own cut).
const firstLines = (r: { out: string; err: string }, n = 14): string => (r.err || r.out).split("\n").slice(0, n).join(" | ");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitUntil(what: string, deadlineMs: number, probe: () => Promise<string | null> | string | null): Promise<string | null> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const answer = await probe();
    if (answer !== null) return answer;
    if (Date.now() >= end) return null;
    await sleep(1000);
  }
}

const unitActive = (name: string) => run("systemctl", ["--user", "is-active", name]).out.trim() === "active";

async function waitUnits(names: readonly string[], timeoutMs: number): Promise<string | null> {
  return waitUntil("units", timeoutMs, () => {
    const not = names.filter(n => !unitActive(n));
    return not.length === 0 ? "" : null;
  });
}

// The health doors exactly as the updater's own probes read them (§6.3): the hub on HTTP (cp, on its own port),
// the fleet on its socket (cp), the agent from the status file it rewrites (both machines' own agent).
async function hubVersion(): Promise<string | null> {
  try {
    const answer = await fetch(`http://127.0.0.1:${HUB_PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return null;
    const doc = await answer.json() as { version?: unknown };
    return typeof doc.version === "string" ? doc.version : null;
  } catch { return null; }
}

// One GET over the fleet's Unix socket, answered as JSON (GET /v1/nodes, /v1/rollout, /v1/alerts).
function fleetGet<T>(path: string): Promise<T | null> {
  return new Promise(resolve => {
    const req = httpRequest({ socketPath: FLEET_SOCK, path, method: "GET", timeout: 3000 },
      res => {
        const parts: Buffer[] = [];
        res.on("data", c => parts.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(parts).toString()) as T); }
          catch { resolve(null); }
        });
      });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function fleetVersion(): Promise<string | null> {
  return fleetGet<{ version?: unknown }>("/v1/health").then(doc => (typeof doc?.version === "string" ? doc.version : null));
}

function nodeVersion(): string | null {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, ".local/state/morndo-node/status.json"), "utf8")) as { version?: unknown; state?: unknown };
    return typeof doc.version === "string" && doc.state === "online" ? doc.version : null;
  } catch { return null; }
}

// The updater's own record of where it stands (§7): state.json, as the fleet and the hub read it too.
type StateFile = { state?: unknown; version?: unknown; target?: unknown; reason?: unknown; attempt?: unknown; at?: unknown; soakMinutes?: unknown };
function stateFile(): StateFile | null {
  try { return JSON.parse(readFileSync(STATE_JSON, "utf8")) as StateFile; }
  catch { return null; }
}

const linkName = (name: "current" | "previous" | "good"): string | null => {
  try { return basename(readlinkSync(join(RELEASES, name))); } catch { return null; }
};

function sqlite(db: string, sql: string): string {
  return run("sqlite3", ["-readonly", db, sql]).out.trim();
}

// Both machines' state.json and `morndo update --status --json` at each step, into the evidence (the brief's own
// ask); a missing state file is said, not guessed at.
function snapshot(label: string): void {
  try { copyFileSync(STATE_JSON, join(EVIDENCE, `${MACHINE}-${label}-state.json`)); }
  catch { writeFileSync(join(EVIDENCE, `${MACHINE}-${label}-state.json`), "(no state.json yet)\n"); }
  const status = run(MORNDO, ["update", "--status", "--json"]);
  writeFileSync(join(EVIDENCE, `${MACHINE}-${label}-status.json`), `exit ${status.code}\n${status.out}\n${status.err}\n`);
}

function pointFeedAt(which: "feed-1" | "feed-2" | "feed-3" | "feed-4"): void {
  rmSync(FEED_LINK, { force: true });
  symlinkSync(join(FEEDS, which), FEED_LINK);
}

function journals(title: string): void {
  const dump = run("journalctl", ["--user", "-u", "morndo-*", "--no-pager", "-n", "200"]);
  const status = run("systemctl", ["--user", "--no-pager", "--full", "list-units", "morndo-*", "--all"]);
  const units = run("systemctl", ["--user", "--no-pager", "--full", "--failed"]);
  writeFileSync(join(EVIDENCE, `journal-${MACHINE}-${title}.txt`), [
    `$ systemctl --user list-units 'morndo-*' --all\n${status.out}\n${status.err}\n`,
    `$ systemctl --user --failed\n${units.out}\n${units.err}\n`,
    `$ journalctl --user -u 'morndo-*' -n 200\n${dump.out}\n${dump.err}\n`,
  ].join("\n"));
}

// One HTTPS status answer with Node's own certificate checks against the test CA (scenario.ts's own probe).
function httpsStatus(url: string, ca: string): Promise<number> {
  return new Promise(resolve => {
    const req = httpsGet(url, { ca, timeout: 5000 }, res => {
      const code = res.statusCode ?? 0;
      res.resume();
      resolve(code);
    });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}

// ---- the steps. Each prints its checks and leaves; the exit code says whether they all passed.

// The environment the services will inherit (scenario.ts's step 0, one per machine): the feed's address and the
// test CA everywhere, and the hub's own port on the control plane — before install, so the hub the installer
// starts serves on the port the host's forwarder reaches.
async function stepSetup(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  const lines = [`MORNDO_UPDATE_FEED=${FEED_URL}\n`, `NODE_EXTRA_CA_CERTS=${join(E2E, "tls/ca.pem")}\n`];
  if (IS_CP) lines.push(`MORNDO_PORT=${HUB_PORT}\n`);
  mkdirSync(join(HOME, ".config/environment.d"), { recursive: true });
  writeFileSync(join(HOME, ".config/environment.d/morndo-e2e.conf"), lines.join(""));
  run("systemctl", ["--user", "daemon-reexec"]);
  run("systemctl", ["--user", "set-environment", ...lines.map(l => l.trim())]);
  const managerEnv = run("systemctl", ["--user", "show-environment"]);
  const envOk = managerEnv.out.includes("MORNDO_UPDATE_FEED=") && managerEnv.out.includes("NODE_EXTRA_CA_CERTS=")
    && (!IS_CP || managerEnv.out.includes(`MORNDO_PORT=${HUB_PORT}`));
  check("setup-environment", envOk, `the user manager on ${MACHINE} carries the feed, the CA${IS_CP ? ` and MORNDO_PORT=${HUB_PORT}` : ""}`);
  pointFeedAt("feed-1");
  const probe = await httpsStatus(`${FEED_URL}keys/1.json`, readFileSync(join(E2E, "tls/ca.pem"), "utf8"));
  check("setup-feed", probe === 200, `the feed answers on ${FEED_URL}keys/1.json inside ${MACHINE} (HTTP ${probe})`);
}

// Step 1a: install A on the control plane, then join the machine's own node agent as e2e-cp — the install prints
// "the agent waits to join", and without the agent no cp apply ever finds its safe point (the walk defers
// "node: no_answer" and ends abandoned, run 2's evidence). #109's own step 1 joins it on the single machine the
// same way; the skew gate never counts it, because it moves with the control plane's own install (4b069d5).
async function stepInstallCp(): Promise<void> {
  if (!IS_CP) { check("install-cp", false, "this step belongs on the control plane, not the node"); return; }
  const tree = join(E2E, "tree-a");
  if (!existsSync(join(tree, "bin", "morndo"))) { check("install-cp", false, `the unpacked A tree is not at ${tree}`); return; }
  for (const name of readdirSync(join(tree, "bin"))) chmodSync(join(tree, "bin", name), 0o555);
  const install = command("1-install", join(tree, "bin", "morndo"), ["install", "--role", "control-plane"], { timeoutMs: 300_000 });
  const installed = install.code === 0 && install.out.includes(`Morndo ${VERSION_A} installed (control-plane, channel stable).`);
  check("1-install-cp", installed, `install exited ${install.code}: ${firstLines(install)}`);
  snapshot("1-install-cp");
  if (!installed) return journals("1-install-cp");
  const units = await waitUnits(SERVICE_UNITS, 90_000);
  const hub = units === null ? null : await waitUntil("hub", 90_000, () => hubVersion());
  const fleet = units === null ? null : await waitUntil("fleet", 90_000, () => fleetVersion());
  check("1-cp-healthy", units !== null && hub === VERSION_A && fleet === VERSION_A,
    units === null ? "the hub and fleet units did not come active" : `hub ${hub} fleet ${fleet} (want ${VERSION_A})`);
  if (failed) return journals("1-install-cp");
  const ownAdded = command("1-cp-node-add", MORNDO_FLEET, ["node", "add", CP_NODE_NAME]);
  const ownJoinLine = ownAdded.out.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  const ownJoined = ownJoinLine === "" ? { code: 1, out: "", err: `no join string in: ${ownAdded.out}` }
    : command("1-cp-node-join", MORNDO_NODE, ["join", ownJoinLine], { timeoutMs: 60_000 });
  check("1-cp-node-joined", ownJoined.code === 0 && ownJoined.out.includes("Joined the fleet"),
    `cp's own node add/join as ${CP_NODE_NAME}: ${firstLines(ownJoined)}`);
  if (failed) return journals("1-install-cp");
  run("systemctl", ["--user", "start", "morndo-node.service"]);
  const ownOnline = await waitUntil("cp's own node online", 90_000, () => nodeVersion());
  check("1-cp-node-online", ownOnline === VERSION_A,
    `cp's own node agent reports ${ownOnline ?? "nothing"} (want online at ${VERSION_A})`);
  if (failed) return journals("1-install-cp");
  const links = linkName("current") === VERSION_A && linkName("good") === VERSION_A;
  check("1-cp-links", links, `current=${linkName("current")} good=${linkName("good")}`);
  const unitFiles = readdirSync(UNIT_DIR).filter(n => n.startsWith("morndo-") && (n.endsWith(".service") || n.endsWith(".timer")));
  const marked = unitFiles.filter(n => readFileSync(join(UNIT_DIR, n), "utf8").startsWith(`${UNIT_MARK}\n`));
  check("1-cp-unit-mark", unitFiles.length > 0 && marked.length === unitFiles.length, `${marked.length}/${unitFiles.length} unit files carry Morndo's mark`);
  const upToDate = command("1-update-check", MORNDO, ["update", "--check"], { timeoutMs: 120_000 });
  check("1-cp-up-to-date", upToDate.code === 0 && upToDate.out.includes(`Up to date: ${VERSION_A}.`),
    `update --check against feed-1 exited ${upToDate.code}: ${firstLines(upToDate)}`);
  run("systemctl", ["--user", "disable", "--now", "morndo-update.timer"]);
  check("1-cp-tick-timer-off", run("systemctl", ["--user", "is-enabled", "morndo-update.timer"]).code !== 0,
    "the tick's timer is off on cp for this run; every apply below is typed by hand");
  if (failed) journals("1-install-cp");
}

// Step 1b: the join string for the node, printed by the fleet's own console on cp and handed to the node machine
// by the host (a file the host reads out, so nothing crosses by guesswork).
async function stepNodeAdd(): Promise<void> {
  if (!IS_CP) { check("node-add", false, "this step belongs on the control plane, not the node"); return; }
  const added = command("1-node-add", MORNDO_FLEET, ["node", "add", NODE_NAME]);
  const joinLine = added.out.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  if (joinLine !== "") writeFileSync(join(E2E, "join-string.txt"), `${joinLine}\n`);
  check("1-node-add", added.code === 0 && joinLine !== "", `node add exited ${added.code}: ${firstLines(added, 3)}`);
}

// Step 1c: install A on the node machine and join it with cp's string. The forwarder to cp is already listening
// on this machine's 127.0.0.1:8791 (the host started it), so the ordinary join string dials through it.
async function stepInstallNode(): Promise<void> {
  if (IS_CP) { check("install-node", false, "this step belongs on the node machine, not the control plane"); return; }
  const joinString = process.argv[3] ?? "";
  if (joinString === "" || !joinString.startsWith("morndo-join:1:")) { check("install-node", false, "no join string on the command line"); return; }
  const tree = join(E2E, "tree-a");
  if (!existsSync(join(tree, "bin", "morndo"))) { check("install-node", false, `the unpacked A tree is not at ${tree}`); return; }
  for (const name of readdirSync(join(tree, "bin"))) chmodSync(join(tree, "bin", name), 0o555);
  const install = command("1-install", join(tree, "bin", "morndo"), ["install", "--role", "node"], { timeoutMs: 300_000 });
  const installed = install.code === 0 && install.out.includes(`Morndo ${VERSION_A} installed (node, channel stable).`);
  check("1-install-node", installed, `install exited ${install.code}: ${firstLines(install)}`);
  snapshot("1-install-node");
  if (!installed) return journals("1-install-node");
  const joined = command("1-node-join", MORNDO_NODE, ["join", joinString], { timeoutMs: 60_000 });
  check("1-node-joined", joined.code === 0 && joined.out.includes("Joined the fleet"), `node join exited ${joined.code}: ${firstLines(joined)}`);
  if (failed) return journals("1-install-node");
  run("systemctl", ["--user", "start", "morndo-node.service"]);
  const online = await waitUntil("node online", 90_000, () => nodeVersion());
  check("1-node-online", online === VERSION_A, `the node agent reports ${online ?? "nothing"} (want online at ${VERSION_A})`);
  if (failed) return journals("1-install-node");
  const links = linkName("current") === VERSION_A && linkName("good") === VERSION_A;
  check("1-node-links", links, `current=${linkName("current")} good=${linkName("good")}`);
  const upToDate = command("1-update-check", MORNDO, ["update", "--check"], { timeoutMs: 120_000 });
  check("1-node-up-to-date", upToDate.code === 0 && upToDate.out.includes(`Up to date: ${VERSION_A}.`),
    `update --check against feed-1 exited ${upToDate.code}: ${firstLines(upToDate)}`);
  run("systemctl", ["--user", "disable", "--now", "morndo-update.timer"]);
  check("1-node-tick-timer-off", run("systemctl", ["--user", "is-enabled", "morndo-update.timer"]).code !== 0,
    "the tick's timer is off on the node for this run; every apply below is typed by hand");
  if (failed) journals("1-install-node");
}

// Step 1d: the nodes as the fleet sees them (updates §7): online, the protocol its hello named, its updater's
// last report (null before it ever applied anything — an honest word, not a guess). The control plane's own
// e2e-cp (joined in step 1a) sits beside the node machine's e2e-node.
async function stepNodesView(): Promise<void> {
  if (!IS_CP) { check("nodes-view", false, "this step belongs on the control plane, not the node"); return; }
  type Row = { name?: unknown; status?: unknown; proto?: unknown; update?: { state?: unknown; version?: unknown } | null };
  const rows = await waitUntil("nodes", 30_000, async () => {
    const list = await fleetGet<Row[]>("/v1/nodes");
    return list !== null && list.some(n => n.name === NODE_NAME) && list.some(n => n.name === CP_NODE_NAME) ? "" : null;
  });
  const list = await fleetGet<Row[]>("/v1/nodes");
  const seen = (name: string): Row | null => list?.find(n => n.name === name) ?? null;
  const rowOk = (row: Row | null): boolean => row !== null && row.status === "online"
    && (Array.isArray(row.proto) ? row.proto as unknown[] : []).includes(1)
    && ((row.update ?? null) === null || row.update?.state === "current");
  const nodeRow = seen(NODE_NAME), cpRow = seen(CP_NODE_NAME);
  const ok = rows !== null && rowOk(nodeRow) && rowOk(cpRow);
  check("1-nodes-view", ok, `GET /v1/nodes: ${NODE_NAME} ${JSON.stringify(nodeRow)}; ${CP_NODE_NAME} ${JSON.stringify(cpRow)}`);
}

// Step 2a: cp's own soak, two minutes (§4.5's settings key, UpdateConfigSchema's soakMinutes) — the number the
// control plane's `current` record carries into the fleet, and the story's own clock.
async function stepSoakTwo(): Promise<void> {
  if (!IS_CP) { check("soak-2", false, "this step belongs on the control plane, not the node"); return; }
  const configDir = join(HOME, ".config/morndo-update");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ soakMinutes: 2 }, null, 2)}\n`);
  const read = run("cat", [join(configDir, "config.json")]).out;
  check("2-soak-2min", read.includes('"soakMinutes": 2'), `cp's updater settings: ${read.replace(/\n/g, " ")}`);
}

// The feed switches: one symlink on each machine, named for the story's next publish point.
async function stepFeed(which: string): Promise<void> {
  if (which !== "feed-1" && which !== "feed-2" && which !== "feed-3" && which !== "feed-4") {
    check("feed", false, `no feed named '${which}'`);
    return;
  }
  pointFeedAt(which);
  const at = readlinkSync(FEED_LINK);
  check(which, at === join(FEEDS, which), `${MACHINE}'s feed link -> ${at}`);
}

// Step 2b: a principal's `--check` on the node stages the offered Version (§8.3: the check always asks the feed).
async function stepCheckStages(version: string): Promise<void> {
  if (IS_CP) { check("node-staged", false, "this step belongs on the node machine, not the control plane"); return; }
  const staged = command(`check-${version}`, MORNDO, ["update", "--check"], { timeoutMs: 120_000 });
  const row = sqlite(UPDATE_DB, `SELECT count(*) FROM versions WHERE version = '${version}'`);
  check(`node-staged-${version}`, staged.code === 0 && row === "1",
    `update --check exited ${staged.code}; the versions row for ${version}: ${row}; ${firstLines(staged, 3)}`);
  snapshot(`check-${version}`);
}

// Step 2c: the node's tick before the control plane has moved. The deferral is the story (a node never applies on
// the feed's word alone): exit 75, a waiting record whose reason names why, and the machine still on A.
async function stepTickDefersEarly(): Promise<void> {
  if (IS_CP) { check("tick-defers-early", false, "this step belongs on the node machine, not the control plane"); return; }
  const tick = command("tick-early", MORNDO_UPDATE, ["update", "tick"], { timeoutMs: 120_000 });
  const state = stateFile();
  const reason = typeof state?.reason === "string" ? state.reason : "(none)";
  const accepted = ["node_ahead", "not_committed", "waiting_control_plane"];   // fleet-follow.ts's words for a Rollout the control plane has not committed
  const ok = tick.code === 75 && state?.state === "waiting" && accepted.includes(reason)
    && linkName("current") === VERSION_A && nodeVersion() === VERSION_A;
  check("2-node-defers-early", ok,
    `tick exited ${tick.code}; state.json ${JSON.stringify(state)}; the node still runs ${linkName("current")} / ${nodeVersion() ?? "nothing"}: ${firstLines(tick, 2)}`);
  snapshot("tick-early");
}

// Step 2d: the control plane takes B and commits it — the Rollout begins, and its soak (two minutes) rides the
// commit into the fleet (§4.5).
async function stepCpTo(version: string, label: string): Promise<void> {
  if (!IS_CP) { check(label, false, "this step belongs on the control plane, not the node"); return; }
  const update = command(`update-${version}`, MORNDO, ["update", "--yes"], { timeoutMs: 20 * 60_000 });
  const committed = update.code === 0 && (update.out + update.err).includes(`Committed ${version}.`);
  check(`${label}-committed`, committed, `update --yes exited ${update.code}: ${firstLines(update)}`);
  snapshot(`update-${version}`);
  if (!committed) return journals(`update-${version}`);
  const units = await waitUnits(APPLY_UNITS, 120_000);
  const hub = units === null ? null : await waitUntil("hub", 120_000, () => hubVersion());
  const fleet = units === null ? null : await waitUntil("fleet", 120_000, () => fleetVersion());
  check(`${label}-healthy`, units !== null && hub === version && fleet === version,
    units === null ? "the hub and fleet units did not come active" : `hub ${hub} fleet ${fleet} (want ${version})`);
  const state = stateFile();
  const stateOk = state?.state === "current" && state.version === version
    && (version === VERSION_B ? state.soakMinutes === 2 : true);               // B's commit is the one that carries the story's soak
  check(`${label}-state`, stateOk, `cp's state.json: ${JSON.stringify(state)}`);
  check(`${label}-links`, linkName("current") === version && linkName("good") === version,
    `current=${linkName("current")} good=${linkName("good")}`);
  if (failed) journals(`update-${version}`);
}

// Step 2e: the node's tick inside the soak — the same deferral, the soak's own word.
async function stepTickDefersSoak(): Promise<void> {
  if (IS_CP) { check("tick-defers-soak", false, "this step belongs on the node machine, not the control plane"); return; }
  const tick = command("tick-soak", MORNDO_UPDATE, ["update", "tick"], { timeoutMs: 120_000 });
  const state = stateFile();
  const ok = tick.code === 75 && state?.state === "waiting" && state.reason === "waiting_soak"
    && linkName("current") === VERSION_A && nodeVersion() === VERSION_A;
  check("2-node-defers-soak", ok,
    `tick exited ${tick.code}; state.json ${JSON.stringify(state)}; the node still runs ${linkName("current")}`);
  snapshot("tick-soak");
}

// Step 3b (the browser pressed the button in between): the node's own record reaches `current` at B — the apply
// unit the hub's ask started, judged to its end (the state file is the fleet's word too, §7).
async function stepNodeCurrentB(): Promise<void> {
  if (IS_CP) { check("node-current-b", false, "this step belongs on the node machine, not the control plane"); return; }
  const answer = await waitUntil("node current at B", 10 * 60_000, () => {
    const s = stateFile();
    return s?.state === "current" && s.version === VERSION_B ? "" : s?.state === "rolled_back" ? "rolled_back" : null;
  });
  const online = await waitUntil("node online", 90_000, () => nodeVersion());
  const state = stateFile();
  check("3-node-current-b", answer === "" && online === VERSION_B,
    `state.json ${JSON.stringify(state)}; the node agent reports ${online ?? "nothing"} (want online at ${VERSION_B})`);
  snapshot("node-current-b");
  if (failed) journals("node-current-b");
}

// Step 3c: the fleet's own view of the same — the node's updater report in GET /v1/nodes says current at B.
async function stepNodesCurrentB(): Promise<void> {
  if (!IS_CP) { check("nodes-current-b", false, "this step belongs on the control plane, not the node"); return; }
  type Row = { name?: unknown; update?: { state?: unknown; version?: unknown } | null };
  const answer = await waitUntil("nodes report", 3 * 60_000, async () => {
    const list = await fleetGet<Row[]>("/v1/nodes");
    const row = list?.find(n => n.name === NODE_NAME);
    return row?.update?.state === "current" && row.update.version === VERSION_B ? "" : null;
  });
  const list = await fleetGet<Row[]>("/v1/nodes");
  const row = list?.find(n => n.name === NODE_NAME) ?? null;
  check("3-nodes-current-b", answer !== null, `GET /v1/nodes: ${JSON.stringify(row)}`);
}

// The pair URL for the host's browser (§8.3's pairing), printed by the hub itself and handed out as one raw line
// (PAIRURL <url>) before the check line; the host opens exactly this origin through its forwarder.
async function stepPairUrl(): Promise<void> {
  if (!IS_CP) { check("pair-url", false, "this step belongs on the control plane, not the node"); return; }
  const pair = command("pair", MORNDO, ["pair"], { timeoutMs: 60_000 });
  const url = pair.out.split("\n").find(l => l.includes("/pair#t=")) ?? "";
  if (url !== "") writeFileSync(join(E2E, "pair-url.txt"), `${url}\n`);
  process.stdout.write(`PAIRURL ${url}\n`);
  check("pair-url", pair.code === 0 && url !== "", `morndo pair exited ${pair.code}; the URL is in ~/e2e/pair-url.txt`);
}

// Step 4a: the Rollout of G past its soak — cp watches the fleet's own word (GET /v1/rollout), not a blind sleep.
async function stepRolloutSoaked(): Promise<void> {
  if (!IS_CP) { check("rollout-soaked", false, "this step belongs on the control plane, not the node"); return; }
  type Wire = { rollout?: { version?: unknown; controlPlaneCommittedAt?: unknown; soakMinutes?: unknown } | null };
  const answer = await waitUntil("rollout past its soak", 6 * 60_000, async () => {
    const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
    if (r?.version !== VERSION_G || typeof r.controlPlaneCommittedAt !== "number") return null;
    const soakMs = (typeof r.soakMinutes === "number" ? r.soakMinutes : 0) * 60_000;
    return r.controlPlaneCommittedAt + soakMs <= Date.now() ? "" : null;
  });
  const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
  check("4-rollout-soaked", answer !== null, `GET /v1/rollout: ${JSON.stringify(r)} (its commit + soak now past)`);
}

// Step 4b: the test sets the node's drawn delay for G to the past — a row in update.db's rollout_jitter the
// updater's own INSERT OR IGNORE then keeps (nodeGate draws only when jitterOf finds nothing).
async function stepPinJitter(): Promise<void> {
  if (IS_CP) { check("pin-jitter", false, "this step belongs on the node machine, not the control plane"); return; }
  const until = Date.now() - 60_000;
  const write = run("sqlite3", [UPDATE_DB, `INSERT OR IGNORE INTO rollout_jitter (version, until) VALUES ('${VERSION_G}', ${until});`]);
  const row = sqlite(UPDATE_DB, `SELECT until FROM rollout_jitter WHERE version = '${VERSION_G}'`);
  check("4-jitter-pinned", write.code === 0 && row !== "" && Number(row) <= Date.now(),
    `the test sets the node's drawn delay for ${VERSION_G} to the past (rollout_jitter until=${row}); the updater keeps a row it finds`);
}

// Step 4c: the node's tick takes G, the planted failure breaks its agent, and the machine puts itself back —
// state.json rolled_back under the fleet-issued attempt, the links back on B, the agent online at B again.
async function stepTickAppliesG(): Promise<void> {
  if (IS_CP) { check("tick-applies-g", false, "this step belongs on the node machine, not the control plane"); return; }
  const tick = command("tick-g", MORNDO_UPDATE, ["update", "tick"], { timeoutMs: 20 * 60_000 });
  const state = stateFile();
  check("4-node-rolled-back-g",
    tick.code === 1 && (tick.out + tick.err).includes(`Rolled back from ${VERSION_G}`)
      && state?.state === "rolled_back" && state.version === VERSION_B && state.target === VERSION_G
      && typeof state.attempt === "string" && state.attempt !== "",
    `tick exited ${tick.code}; state.json ${JSON.stringify(state)}: ${firstLines(tick, 3)}`);
  snapshot("tick-g");
  const back = await waitUntil("node back on B", 5 * 60_000, () => nodeVersion());
  check("4-node-back-on-b", back === VERSION_B && linkName("current") === VERSION_B && linkName("good") === VERSION_B,
    `the node agent answers ${back ?? "nothing"}; current=${linkName("current")} good=${linkName("good")} (want ${VERSION_B})`);
  if (failed) journals("tick-g");
}

// Step 4d: the fleet's own word of the halt (RL12) — the Rollout of G halted by the node, and the two Alerts.
async function stepRolloutHalted(): Promise<void> {
  if (!IS_CP) { check("rollout-halted", false, "this step belongs on the control plane, not the node"); return; }
  type Wire = { rollout?: { version?: unknown; halted?: unknown; haltedBy?: unknown } | null };
  const answer = await waitUntil("the Rollout halted", 90_000, async () => {
    const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
    return r?.version === VERSION_G && r.halted === true && r.haltedBy === NODE_NAME ? "" : null;
  });
  const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
  check("4-rollout-halted", answer !== null, `GET /v1/rollout: ${JSON.stringify(r)}`);
  const alerts = await waitUntil("the halt's alerts", 90_000, async () => {
    const list = await fleetGet<Alert[]>("/v1/alerts");
    const text = (list ?? []).filter(a => a.kind === "rollout_halted" || a.kind === "update_rolled_back")
      .map(a => JSON.stringify(a.detail ?? {}));
    return text.some(t => t.includes(VERSION_G)) && text.some(t => t.includes(NODE_NAME) || t.includes("node")) ? "" : null;
  });
  const seen = ((await fleetGet<Alert[]>("/v1/alerts")) ?? [])
    .filter(a => a.kind === "rollout_halted" || a.kind === "update_rolled_back");
  check("4-halt-alerts", alerts !== null, `GET /v1/alerts: ${JSON.stringify(seen)}`);
}

// Step 4e: a second tick on the node refuses G — the Rollout is halted, and the machine's own bad record says why.
async function stepTickRefusesG(): Promise<void> {
  if (IS_CP) { check("tick-refuses-g", false, "this step belongs on the node machine, not the control plane"); return; }
  const tick = command("tick-g-refused", MORNDO_UPDATE, ["update", "tick"], { timeoutMs: 5 * 60_000 });
  const state = stateFile();
  const bad = sqlite(UPDATE_DB, `SELECT count(*) FROM bad WHERE version = '${VERSION_G}'`);
  check("4-node-refuses-g", tick.code === 75 && state?.state === "waiting" && state.reason === "halted" && bad === "1",
    `tick exited ${tick.code}; state.json ${JSON.stringify(state)}; bad rows for ${VERSION_G}: ${bad}: ${firstLines(tick, 2)}`);
  snapshot("tick-g-refused");
}

// Step 5b (the principal resumed the Rollout in the browser in between): the node's tick against a resumed
// Rollout of a Version it rolled back. RL7's word — "the target is marked bad on this machine and is not tried
// again automatically" — is the walk's own first gate since b1a0c22 (apply-service reads badVersions before
// anything is begun), so the tick defers: exit 75, state.json waiting with reason bad_here, the machine still on
// B, no new update record — and the Rollout stays resumed (step 5c says so).
async function stepTickAfterResume(): Promise<void> {
  if (IS_CP) { check("tick-after-resume", false, "this step belongs on the node machine, not the control plane"); return; }
  const before = sqlite(UPDATE_DB, "SELECT count(*) FROM updates");
  const tick = command("tick-after-resume", MORNDO_UPDATE, ["update", "tick"], { timeoutMs: 20 * 60_000 });
  const after = sqlite(UPDATE_DB, "SELECT count(*) FROM updates");
  const state = stateFile();
  const reason = typeof state?.reason === "string" ? state.reason : "(none)";
  const refused = tick.code === 75 && state?.state === "waiting" && reason === "bad_here"
    && linkName("current") === VERSION_B && after === before;
  check("5-node-refuses-g-forever", refused,
    `RL7's refusal: the tick deferred (exit ${tick.code}, reason ${reason}), still on ${VERSION_B}, update records ${before} -> ${after}, current=${linkName("current")}, state.json ${JSON.stringify(state)}: ${firstLines(tick, 3)}`);
  snapshot("tick-after-resume");
  if (!refused) journals("tick-after-resume");
}

// Step 5c: the fleet's side of the same — a node that refuses halts nothing, so the resumed Rollout stays resumed.
async function stepRolloutAfterNode(): Promise<void> {
  if (!IS_CP) { check("rollout-after-node", false, "this step belongs on the control plane, not the node"); return; }
  type Wire = { rollout?: { version?: unknown; halted?: unknown; haltedBy?: unknown } | null };
  const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
  check("5-rollout-stays-resumed", r?.version === VERSION_G && r.halted === false,
    `GET /v1/rollout after the node's tick: ${JSON.stringify(r)} (a refusal would have halted nothing; a re-apply and rollback halts it again)`);
}

// Step 5a (the principal clicked Resume in the browser in between): the Rollout of G, resumed — not halted.
async function stepRolloutResumed(): Promise<void> {
  if (!IS_CP) { check("rollout-resumed", false, "this step belongs on the control plane, not the node"); return; }
  type Wire = { rollout?: { version?: unknown; halted?: unknown; haltedBy?: unknown } | null };
  const r = (await fleetGet<Wire>("/v1/rollout"))?.rollout ?? null;
  check("5-rollout-resumed", r?.version === VERSION_G && r.halted === false, `GET /v1/rollout: ${JSON.stringify(r)}`);
}

// Step 6a: H is held by the skew gate (RL11) while the node still speaks protocol 1 — cp's own update exits 75,
// its state names e2e-node and nobody else (the control plane's own e2e-cp never holds the gate, 4b069d5), and
// the machine stays on G.
async function stepCpHeldH(): Promise<void> {
  if (!IS_CP) { check("cp-held-h", false, "this step belongs on the control plane, not the node"); return; }
  const update = command("update-h-held", MORNDO, ["update", "--yes"], { timeoutMs: 20 * 60_000 });
  const state = stateFile();
  const reason = typeof state?.reason === "string" ? state.reason : "(none)";
  const hub = await hubVersion();
  check("6-cp-holds-h",
    update.code === 75 && reason === `skew_blocked: ${NODE_NAME}`
      && linkName("current") === VERSION_G && hub === VERSION_G,
    `update --yes exited ${update.code}; state.json ${JSON.stringify(state)} — the hold names ${NODE_NAME} only, never cp's own ${CP_NODE_NAME}; cp runs ${linkName("current")}, hub ${hub}: ${firstLines(update, 3)}`);
  snapshot("update-h-held");
  if (failed) journals("update-h-held");
}

// Step 6b: the hold's Alert, with the Version and the node named in it.
async function stepSkewAlert(): Promise<void> {
  if (!IS_CP) { check("skew-alert", false, "this step belongs on the control plane, not the node"); return; }
  const answer = await waitUntil("the skew alert", 60_000, async () => {
    const list = await fleetGet<Alert[]>("/v1/alerts");
    return (list ?? []).some(a => a.kind === "update_skew_blocked"
      && JSON.stringify(a.detail ?? {}).includes(VERSION_H) && JSON.stringify(a.detail ?? {}).includes(NODE_NAME)) ? "" : null;
  });
  const seen = ((await fleetGet<Alert[]>("/v1/alerts")) ?? []).filter(a => a.kind === "update_skew_blocked").slice(-1);
  check("6-skew-alert", answer !== null, `GET /v1/alerts, update_skew_blocked: ${JSON.stringify(seen)}`);
}

// Step 6c: the node revoked — the fleet's node list no longer counts it, which is the skew gate's own word.
async function stepRevokeNode(): Promise<void> {
  if (!IS_CP) { check("revoke-node", false, "this step belongs on the control plane, not the node"); return; }
  const revoke = command("6-revoke-node", MORNDO_FLEET, ["node", "revoke", NODE_NAME]);
  type Row = { name?: unknown };
  const list = await fleetGet<Row[]>("/v1/nodes");
  const still = (list ?? []).some(n => n.name === NODE_NAME);
  check("6-node-revoked", revoke.code === 0 && (revoke.out + revoke.err).includes(`revoked ${NODE_NAME}`) && !still,
    `node revoke exited ${revoke.code}: ${firstLines(revoke, 2)}; GET /v1/nodes still lists ${NODE_NAME}: ${still}`);
}

// Step 7: nothing left behind (#109's step 11, both machines): the crash residue an operator clears, then the
// machine's own cleanliness — no apply unit active or failed, no applying marker, no hold.
async function stepClean(): Promise<void> {
  run("systemctl", ["--user", "reset-failed", "morndo-update-apply@*"]);
  const applyUnits = run("systemctl", ["--user", "list-units", "morndo-update-apply@*", "--all", "--no-legend", "--plain"]);
  const leftBehind = applyUnits.out.split("\n").filter(l => l !== "" && /\b(active|failed)\b/.test(l));
  check("7-no-apply-units", leftBehind.length === 0, leftBehind.length === 0 ? "no apply unit is active or failed" : leftBehind.join("; "));
  check("7-applying-gone", !existsSync(join(UPDATE_STATE, "applying")) && !existsSync(join(UPDATE_STATE, "hold.json")),
    `the applying marker and the hold are ${existsSync(join(UPDATE_STATE, "applying")) || existsSync(join(UPDATE_STATE, "hold.json")) ? "still there" : "gone"} on ${MACHINE}`);
}

// The last record: both machines' `morndo update --status` in full, human and JSON, into the evidence.
async function stepFinalStatus(): Promise<void> {
  const human = command("final-status", MORNDO, ["update", "--status"], { timeoutMs: 60_000 });
  check("final-status", human.code === 0, `update --status exited ${human.code}: ${firstLines(human, 3)}`);
  snapshot("final");
}

type Alert = { id?: unknown; at?: unknown; node?: unknown; kind?: unknown; detail?: unknown };

// One step per invocation; the host names it (fleet-steps.ts <step> [arg]) and reads the JSON lines back.
const STEPS: Record<string, (arg: string) => Promise<void> | void> = {
  setup: () => stepSetup(),
  "install-cp": () => stepInstallCp(),
  "node-add": () => stepNodeAdd(),
  "install-node": stepInstallNode,          // the join string rides the command line
  "nodes-view": () => stepNodesView(),
  "pair-url": () => stepPairUrl(),
  "soak-2": () => stepSoakTwo(),
  feed: stepFeed,                            // arg: feed-1 .. feed-4
  "node-stages": stepCheckStages,            // arg: the Version the check must stage
  "tick-defers-early": () => stepTickDefersEarly(),
  "cp-to-b": () => stepCpTo(VERSION_B, "2-cp-b"),
  "tick-defers-soak": () => stepTickDefersSoak(),
  "node-current-b": () => stepNodeCurrentB(),
  "nodes-current-b": () => stepNodesCurrentB(),
  "cp-to-g": () => stepCpTo(VERSION_G, "4-cp-g"),
  "rollout-soaked": () => stepRolloutSoaked(),
  "pin-jitter": () => stepPinJitter(),
  "tick-applies-g": () => stepTickAppliesG(),
  "rollout-halted": () => stepRolloutHalted(),
  "tick-refuses-g": () => stepTickRefusesG(),
  "rollout-resumed": () => stepRolloutResumed(),
  "tick-after-resume": () => stepTickAfterResume(),
  "rollout-after-node": () => stepRolloutAfterNode(),
  "cp-held-h": () => stepCpHeldH(),
  "skew-alert": () => stepSkewAlert(),
  "revoke-node": () => stepRevokeNode(),
  "cp-to-h": () => stepCpTo(VERSION_H, "6-cp-h"),
  clean: () => stepClean(),
  "final-status": () => stepFinalStatus(),
};

const named = process.argv[2] ?? "";
const step = STEPS[named];
if (step === undefined) check("dispatch", false, `no step named '${named}' (the host spells a step name wrong)`);
else await step(process.argv[3] ?? "");
process.exitCode = failed ? 1 : 0;


