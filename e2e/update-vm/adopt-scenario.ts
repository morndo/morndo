// The machine side of the adoption rehearsal (C6-0, e2e/update-adopt.e2e.ts): this runs INSIDE the container as the
// worker user, under the unpacked A tree's own Node. It builds the state of the machines today (an old release
// folder, three unmarked units, three real wrapper files, databases made by the old services, a lane's tmux in its
// own scope), takes the backup, arms the dead-man's switch, runs `morndo install` over it, proves the adopted
// machine, lets the dead-man fire twice (a changed schema rolled back unattended with exit 0, then a failed database copy that keeps its service stopped) and proves the restore, and installs again to prove the switch does nothing when
// the ok marker exists. Three things are only observed and written down (finding-wrappers, finding-restart,
// finding-reinstall): their checks are always ok, the detail is the finding.
//
// Every check prints one JSON line on stdout — {"step": "...", "ok": true|false, "detail": ...} — and the host
// side reads exactly those. Made-up names only: machine "m1", node "node-demo", lane "lane-demo", folder abc1234.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { missingRows, runsFromLauncher, sameListing, sameProcess, unitAdopted } from "./adopt-checks.ts";
import { ownerOf } from "./checks.ts";

const HOME = homedir();
const E2E = join(HOME, "e2e");
const EVIDENCE = join(E2E, "evidence");
const FEED_DIR = join(E2E, "feeds", "feed-1");
const FEED_URL = "https://127.0.0.1:8443/";                   // build.ts's FEED_URL; the two must agree
const BIN = join(HOME, ".local/bin");
const RELEASES = join(HOME, ".local/share/morndo-releases");
const UPDATE_STATE = join(HOME, ".local/state/morndo-update");
const UPDATE_CONFIG_DIR = join(HOME, ".config/morndo-update");
const HUB_DB = join(HOME, ".local/share/morndo/morndo.db");
const FLEET_DB = join(HOME, ".local/share/morndo-fleet/fleet.db");
const NODE_DB = join(HOME, ".local/state/morndo-node/agent.db");
const MEMORY_DB = join(HOME, ".local/share/morndo/memory.db");   // the hub's second database: backup.sh refused the backup until it was named
const UNIT_DIR = join(HOME, ".config/systemd/user");
const OLD_FOLDER = join(HOME, "morndo/releases/abc1234");
const OLD_NODE_REL = ".nvm/versions/node/v24.0.0/bin/node";
const OLD_NODE = join(HOME, OLD_NODE_REL);
const BACKUP = join(HOME, "c6-backup/m1-demo");
const ASIDE = join(HOME, "c6-wrappers-aside");
const VERSION_A = "0.1.0";
const OLD_VERSION = "0.0.0";                                   // a tree with no build.json reports the root package.json's
const NODE_NAME = "node-demo";
const LANE = "lane-demo";
// The dead-man's first run only has to outlast the installs and the proofs (a naive install measured about 276 s; the
// install over running legacy units may also wait 90 s per service for a health answer, finding-restart): twice that
// and more. It is disarmed after the findings and a fresh short one is armed for the firing, so the timing margin of
// the firing does not depend on how long the installs took.
const DEADMAN_SECONDS = 1500;
const FIRING_SECONDS = 120;
const OLD_DROPIN = "[Service]\nMemoryMax=1G\n";
const DROPIN_DIR = join(UNIT_DIR, "morndo-node.service.d");
const SERVICES = [
  { unit: "morndo-hub.service", app: "hub", cmd: "serve", wrapper: "morndo" },
  { unit: "morndo-fleet.service", app: "fleet", cmd: "serve", wrapper: "morndo-fleet" },
  { unit: "morndo-node.service", app: "node-agent", cmd: "run", wrapper: "morndo-node" },
] as const;
const SERVICE_UNITS = SERVICES.map(s => s.unit);

const ENV = {
  ...process.env, HOME,
  PATH: `${BIN}:/usr/local/bin:/usr/bin:/bin`,
  MORNDO_UPDATE_FEED: FEED_URL,
  NODE_EXTRA_CA_CERTS: join(E2E, "tls/ca.pem"),
  C6_NODE: process.execPath,
};

type Check = { step: string; ok: boolean; detail: string };
const checks: Check[] = [];
let failed = false;

// `soft`: a failure is counted in the summary but does not end the story (the rest of the rehearsal is still worth its run).
function check(step: string, ok: boolean, detail: string, soft = false): void {
  checks.push({ step, ok, detail });
  if (!ok && !soft) failed = true;
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`);
}

function run(file: string, args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const done = spawnSync(file, args, { encoding: "utf8", env: ENV, timeout: o.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { code: done.status ?? -1, out: done.stdout ?? "", err: done.stderr ?? "" };
}

// A principal command: run(), and keep its whole word in the evidence directory whatever happened.
function command(label: string, file: string, args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const r = run(file, args, o);
  writeFileSync(join(EVIDENCE, `command-${label}.txt`),
    `$ ${file} ${args.join(" ")}\nexit ${r.code}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`);
  return r;
}

const firstLines = (r: { out: string; err: string }, n = 8): string => `${r.out}${r.err}`.split("\n").filter(l => l.trim() !== "").slice(0, n).join(" | ");
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitUntil(deadlineMs: number, probe: () => Promise<string | null>): Promise<string | null> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const answer = await probe();
    if (answer !== null) return answer;
    if (Date.now() >= end) return null;
    await sleep(1000);
  }
}

const unitActive = (name: string) => run("systemctl", ["--user", "is-active", name]).out.trim() === "active";

// The three health doors as the updater's own probes read them: the hub on HTTP, the fleet on its socket, the agent
// from the status file it rewrites.
async function hubVersion(): Promise<string | null> {
  try {
    const answer = await fetch("http://127.0.0.1:8790/api/health", { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return null;
    const doc = await answer.json() as { version?: unknown };
    return typeof doc.version === "string" ? doc.version : null;
  } catch { return null; }
}

function fleetVersion(): Promise<string | null> {
  return new Promise(resolve => {
    const req = httpRequest({ socketPath: join(HOME, ".local/state/morndo-fleet/fleet.sock"), path: "/v1/health", method: "GET", timeout: 3000 },
      res => {
        const parts: Buffer[] = [];
        res.on("data", c => parts.push(c));
        res.on("end", () => {
          try {
            const doc = JSON.parse(Buffer.concat(parts).toString()) as { version?: unknown };
            resolve(typeof doc.version === "string" ? doc.version : null);
          } catch { resolve(null); }
        });
      });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function nodeVersion(): string | null {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, ".local/state/morndo-node/status.json"), "utf8")) as { version?: unknown; state?: unknown };
    return typeof doc.version === "string" && doc.state === "online" ? doc.version : null;
  } catch { return null; }
}

const healthNow = async (): Promise<string> => `hub=${await hubVersion()} fleet=${await fleetVersion()} node=${nodeVersion()}`;

async function waitHealthy(which: "hub" | "fleet" | "node", atVersion: string, timeoutMs: number): Promise<boolean> {
  const probe = which === "hub" ? hubVersion : which === "fleet" ? fleetVersion : async () => nodeVersion();
  return (await waitUntil(timeoutMs, probe)) === atVersion;
}

// All three units active and all three answering with that version.
async function servicesHealthy(version: string, timeoutMs = 90_000): Promise<{ ok: boolean; detail: string }> {
  const active = await waitUntil(timeoutMs, async () => (SERVICE_UNITS.every(unitActive) ? "" : null));
  if (active === null) return { ok: false, detail: `units not active: ${SERVICE_UNITS.filter(u => !unitActive(u)).join(", ")}` };
  const ok = (await waitHealthy("hub", version, timeoutMs)) && (await waitHealthy("fleet", version, timeoutMs)) && (await waitHealthy("node", version, timeoutMs));
  return { ok, detail: ok ? `all three units active and healthy at ${version}` : `not all healthy at ${version}: ${await healthNow()}` };
}

function sqlite(db: string, sql: string): string {
  return run("sqlite3", ["-cmd", ".timeout 5000", db, sql]).out.trim();
}
const quickCheck = (db: string) => sqlite(db, "PRAGMA quick_check");

function journals(title: string): void {
  const dump = run("journalctl", ["--user", "-u", "morndo-*", "-u", "c6-deadman-*", "--no-pager", "-n", "300"]);
  const status = run("systemctl", ["--user", "--no-pager", "--full", "list-units", "morndo-*", "c6-deadman-*", "--all"]);
  writeFileSync(join(EVIDENCE, `journal-${title}.txt`), [
    `$ systemctl --user list-units 'morndo-*' 'c6-deadman-*' --all\n${status.out}\n${status.err}\n`,
    `$ journalctl --user -u 'morndo-*' -u 'c6-deadman-*' -n 300\n${dump.out}\n${dump.err}\n`,
  ].join("\n"));
}

// The main process's command line, as the kernel holds it: which tree a unit really runs.
function cmdlineOf(unit: string): string {
  const pid = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit]).out.trim();
  if (!/^\d+$/.test(pid) || pid === "0") return "(no main process)";
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim(); } catch { return "(gone)"; }
}
const runsNew = (cmdline: string) => cmdline.includes("morndo-releases");
const runsOld = (cmdline: string) => cmdline.includes("releases/abc1234");

// `path size` for every entry under a folder (links by their own size), sorted: the old release folder before and after.
function listing(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else lines.push(`${rel} ${st.size}`);
    }
  };
  walk(root, "");
  return `${lines.join("\n")}\n`;
}

// ---- today's state ------------------------------------------------------------------------------------------

const legacyUnitText = (s: (typeof SERVICES)[number]): string => [
  `[Unit]`,
  `Description=Morndo ${s.app}`,
  `After=network.target`,
  ``,
  `[Service]`,
  `ExecStart=%h/${OLD_NODE_REL} --no-warnings %h/morndo/releases/abc1234/apps/${s.app}/src/main.ts ${s.cmd}`,
  `Environment=PATH=%h/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin:/bin`,
  `Restart=on-failure`,
  `RestartSec=5`,
  `RestartPreventExitStatus=78`,
  `MemoryMax=1G`,
  ``,
  `[Install]`,
  `WantedBy=default.target`,
  ``,
].join("\n");

const legacyWrapperText = (s: (typeof SERVICES)[number]): string => [
  `#!/usr/bin/env bash`,
  `exec "$HOME/${OLD_NODE_REL}" --no-warnings "$HOME/morndo/releases/abc1234/apps/${s.app}/src/main.ts" "$@"`,
  ``,
].join("\n");

const OLD_UNITS = new Map(SERVICES.map(s => [s.unit, legacyUnitText(s)]));
const OLD_WRAPPERS = new Map(SERVICES.map(s => [s.wrapper, legacyWrapperText(s)]));
const OLD_ENV_LINE = "Environment=PATH=%h/.nvm/versions/node/v24.0.0/bin:/usr/local/bin:/usr/bin:/bin";

// A legacy unit of ours that is not a shipped one (the install ignores it) and is neither running nor enabled at backup
// time: the restore has to leave it stopped even though something started it after the backup.
const SPARE_UNIT = "morndo-spare.service";
// A second spare WITH an [Install] section, not enabled at backup time: the install is simulated enabling it by hand, and the
// restore must disable it again (a unit with no [Install] reports "static" from is-enabled, so the first spare cannot show this).
const SPARE2_UNIT = "morndo-spare2.service";
const SPARE2_TEXT = "[Unit]\nDescription=Morndo spare with an install section (rehearsal)\n\n[Service]\nExecStart=/bin/sleep 100000\n\n[Install]\nWantedBy=default.target\n";
const SPARE_TEXT = "[Unit]\nDescription=Morndo spare (rehearsal)\n\n[Service]\nExecStart=/bin/sleep 100000\n";

const DBS = [["hub", HUB_DB], ["fleet", FLEET_DB], ["node", NODE_DB]] as const;
const MARKERS = [LANE, NODE_NAME];

type Baseline = { listing: string; lanePid: number; lane: { pid: number; started: string } };

// ---- the proofs, run on the adopted machine twice -----------------------------------------------------------------

async function proofs(p: string, base: Baseline): Promise<void> {
  const listed = readdirSync(UNIT_DIR);
  const verdicts = SERVICES.map(s => {
    const text = readFileSync(join(UNIT_DIR, s.unit), "utf8");
    return unitAdopted(s.unit, text, listed);
  });
  const kept = SERVICES.every(s => {
    try { return readFileSync(join(UNIT_DIR, `${s.unit}.before-morndo`), "utf8") === OLD_UNITS.get(s.unit); } catch { return false; }
  });
  const carried = SERVICES.every(s => {
    try { return readFileSync(join(UNIT_DIR, `${s.unit}.d`, "before-morndo.conf"), "utf8").split("\n").includes(OLD_ENV_LINE); } catch { return false; }
  });
  check(`${p}-units-adopted`, verdicts.every(v => v.ok) && kept && carried,
    `${verdicts.map(v => v.detail).join("; ")}; old text kept byte for byte: ${kept}; before-morndo.conf carries the old Environment= line: ${carried}`);

  const launcher = SERVICES.map(s => runsFromLauncher(readFileSync(join(UNIT_DIR, s.unit), "utf8")));
  const cmdlines = SERVICES.map(s => cmdlineOf(s.unit));
  check(`${p}-runs-from-launcher`, launcher.every(Boolean) && cmdlines.every(runsNew),
    `ExecStart is the launcher: ${launcher.join("/")}; running: ${SERVICES.map((s, i) => `${s.app} ${cmdlines[i]}`).join(" || ")}`);

  const quicks = DBS.map(([n, path]) => `${n}=${quickCheck(path)}`);
  check(`${p}-db-quick-check`, quicks.every(q => q.endsWith("=ok")), quicks.join(" "));
  const lacks = DBS.map(([n, path]) => ({ n, lacking: missingRows(sqlite(path, "SELECT v FROM c6_marker"), MARKERS) }));
  check(`${p}-db-rows-kept`, lacks.every(l => l.lacking.length === 0),
    lacks.every(l => l.lacking.length === 0) ? `the marker rows (${MARKERS.join(", ")}) are in the hub, fleet and node databases`
      : lacks.filter(l => l.lacking.length > 0).map(l => `${l.n} lacks ${l.lacking.join(",")}`).join("; "));
  const healthy = await servicesHealthy(VERSION_A);
  check(`${p}-services-healthy`, healthy.ok, healthy.detail);

  const lane = sameProcess(base.lane, ownerOf(base.lanePid));
  const hasSession = run("tmux", ["has-session", "-t", LANE]).code === 0;
  check(`${p}-lane-kept`, lane.ok && hasSession, `${lane.detail}; tmux session ${LANE} ${hasSession ? "answers" : "is gone"}`);

  const folder = sameListing(base.listing, listing(OLD_FOLDER));
  check(`${p}-old-folder-unchanged`, folder.ok, folder.detail);

  const status = command(`${p}-update-status`, join(BIN, "morndo"), ["update", "--status"]);
  check(`${p}-status`, status.code === 0 && status.out.includes("install: updater") && status.out.includes("channel: stable") && status.out.includes(`current: ${VERSION_A}`),
    `update --status exited ${status.code}: ${firstLines(status, 4)}`);
  // Not a pass/fail of the adoption: a fresh install is not "clean" for the doctor today (see the plan, section 8), so the
  // word is recorded as a finding and the story goes on.
  const doctor = command(`${p}-doctor`, join(BIN, "morndo"), ["doctor"]);
  check(`finding-doctor-${p}`, true, `doctor exited ${doctor.code}: ${firstLines(doctor, 6)}`);
}

// ---- the dead-man's switch --------------------------------------------------------------------------------------------

// The journal's word on a deadman's service: it ran and ended with exit 0 (systemd collects a finished transient unit).
// A restore.sh that does its work runs `daemon-reload` inside its own transient unit: the manager then logs "Failed to
// open /run/user/…/transient/c6-deadman-<machine>.service" for the unit it is running in, and the "Deactivated
// successfully" line may never be written. So the fired restore is judged by its effects and by the absence of a failed result.
function deadmanJournal(machine: string): { ranOk: boolean; failedRun: boolean; text: string } {
  const text = run("journalctl", ["--user", "-u", `c6-deadman-${machine}.service`, "--no-pager", "-o", "cat"]).out;
  // The user manager does not log a clean exit at all (only "Started"): a transient unit that ended with exit 0 is gone,
  // one that failed stays loaded in the failed state until reset-failed. Started, not failed, no failed result = exit 0.
  const failedList = run("systemctl", ["--user", "list-units", "--failed", "--all", "--no-legend", "--plain"]).out;
  const result = run("systemctl", ["--user", "show", "-p", "Result", "--value", `c6-deadman-${machine}.service`]).out.trim();
  const failedRun = (result !== "" && result !== "success") || /Failed with result|status=[1-9]|code=exited, status=[1-9]/.test(text) || failedList.includes(`c6-deadman-${machine}.service`);
  return {
    // a persistent oneshot unit logs "Starting" and "Finished" (a transient one logged "Started")
    ranOk: (text.includes(`Finished c6-deadman-${machine}.service`) || text.includes(`Started c6-deadman-${machine}.service`)) && !failedRun,
    failedRun,
    text: text.trim().split("\n").slice(-6).join(" | "),
  };
}

// How many times the machine's dead-man service has been started (its journal outlives a firing, so a second firing is
// waited for by a count above the one seen before it was armed).
const deadmanStarts = (machine: string): number => {
  const log = run("journalctl", ["--user", "-u", `c6-deadman-${machine}.service`, "--no-pager", "-o", "cat"]).out;
  return log.split("\n").filter(l => l.includes(`Starting c6-deadman-${machine}.service`) || l.includes(`Started c6-deadman-${machine}.service`)).length;
};

async function waitDeadmanGone(machine: string, timeoutMs: number, startsBefore = 0): Promise<boolean> {
  const gone = await waitUntil(timeoutMs, async () => {
    const service = run("systemctl", ["--user", "is-active", `c6-deadman-${machine}.service`]).out.trim();
    // A persistent timer whose calendar time has passed stays "active (elapsed)" when restore.sh did not disable it (the ok
    // marker exits first), so "fired" is the service's own journal: it was started (and it is not running any more).
    const fired = deadmanStarts(machine) > startsBefore;
    return fired && service !== "active" && service !== "activating" ? "gone" : null;
  });
  return gone !== null;
}

const moveWrappersAside = (): string => {
  mkdirSync(ASIDE, { recursive: true });
  const moved: string[] = [];
  for (const s of SERVICES) {
    const p = join(BIN, s.wrapper);
    try { if (!lstatSync(p).isSymbolicLink()) { renameSync(p, join(ASIDE, s.wrapper)); moved.push(s.wrapper); } } catch { /* not there */ }
  }
  return moved.join(", ");
};

const installOnce = (label: string) => {
  const t0 = Date.now();
  const r = command(label, join(E2E, "tree-a/bin/morndo"), ["install", "--role", "control-plane"], { timeoutMs: 600_000 });
  return { ...r, seconds: Math.round((Date.now() - t0) / 1000) };
};

type FeedHost = { close(): void };
function serveFeed(): Promise<FeedHost> {
  const child = spawn(process.execPath, [join(E2E, "feed-server.ts"), FEED_DIR, join(E2E, "tls/server.key"),
    join(E2E, "tls/server.pem"), join(EVIDENCE, "feed-requests.txt"), "8443"], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`the feed server exited ${code} before it listened`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve({ close: () => { child.kill("SIGTERM"); } });
    });
  });
}

function httpsStatus(url: string, ca: string): Promise<number> {
  return new Promise(resolve => {
    const req = httpsGet(url, { ca, timeout: 5000 }, res => { const code = res.statusCode ?? 0; res.resume(); resolve(code); });
    req.on("timeout", () => { req.destroy(); resolve(0); });
    req.on("error", () => resolve(0));
  });
}

async function main(): Promise<number> {
  mkdirSync(EVIDENCE, { recursive: true });

  // ---- a: the manager's environment and the feed.
  mkdirSync(join(HOME, ".config/environment.d"), { recursive: true });
  writeFileSync(join(HOME, ".config/environment.d/morndo-e2e.conf"),
    `MORNDO_UPDATE_FEED=${FEED_URL}\nNODE_EXTRA_CA_CERTS=${join(E2E, "tls/ca.pem")}\n`);
  run("systemctl", ["--user", "daemon-reexec"]);
  run("systemctl", ["--user", "set-environment", `MORNDO_UPDATE_FEED=${FEED_URL}`, `NODE_EXTRA_CA_CERTS=${join(E2E, "tls/ca.pem")}`]);
  const managerEnv = run("systemctl", ["--user", "show-environment"]);
  check("a-environment", managerEnv.out.includes(`MORNDO_UPDATE_FEED=${FEED_URL}`) && managerEnv.out.includes("NODE_EXTRA_CA_CERTS="),
    "the user manager carries MORNDO_UPDATE_FEED and NODE_EXTRA_CA_CERTS");
  const server = await serveFeed();
  const selfProbe = await httpsStatus(`${FEED_URL}keys/1.json`, readFileSync(join(E2E, "tls/ca.pem"), "utf8"));
  check("a-feed-server", selfProbe === 200, `the feed answers on ${FEED_URL}keys/1.json (HTTP ${selfProbe})`);
  if (failed) return finish(server);

  // ---- b: today's state.
  const tree = join(E2E, "tree-a");
  if (!existsSync(join(tree, "bin", "morndo"))) { check("b-tree", false, `the unpacked A tree is not at ${tree}`); return finish(server); }
  for (const name of readdirSync(join(tree, "bin"))) chmodSync(join(tree, "bin", name), 0o555);
  mkdirSync(join(HOME, "morndo/releases"), { recursive: true });
  cpSync(join(tree, "app"), OLD_FOLDER, { recursive: true, verbatimSymlinks: true });
  rmSync(join(OLD_FOLDER, "build.json"), { force: true });
  rmSync(join(OLD_FOLDER, "VERSION"), { force: true });
  mkdirSync(join(HOME, ".nvm/versions/node/v24.0.0/bin"), { recursive: true });
  copyFileSync(join(tree, "node/bin/node"), OLD_NODE);
  chmodSync(OLD_NODE, 0o755);
  mkdirSync(UNIT_DIR, { recursive: true });
  mkdirSync(BIN, { recursive: true });
  for (const s of SERVICES) {
    writeFileSync(join(UNIT_DIR, s.unit), OLD_UNITS.get(s.unit)!);
    writeFileSync(join(BIN, s.wrapper), OLD_WRAPPERS.get(s.wrapper)!, { mode: 0o755 });
  }
  run("systemctl", ["--user", "daemon-reload"]);
  const wrappersReal = SERVICES.every(s => !lstatSync(join(BIN, s.wrapper)).isSymbolicLink());
  check("b-old-state", !existsSync(join(OLD_FOLDER, "build.json")) && !existsSync(join(OLD_FOLDER, "VERSION")) && wrappersReal && existsSync(OLD_NODE),
    `old folder ${OLD_FOLDER} has no build.json and no VERSION; three real wrapper files; node at ${OLD_NODE}`);

  // The hub and the fleet make their databases at first start; the node joins as the first scenario does (node add, join).
  run("systemctl", ["--user", "enable", "--now", "morndo-hub.service", "morndo-fleet.service"]);
  check("b-hub-fleet-up", (await waitHealthy("hub", OLD_VERSION, 90_000)) && (await waitHealthy("fleet", OLD_VERSION, 90_000)),
    `the old hub and fleet answer health: ${await healthNow()}`);
  if (failed) { journals("b-hub-fleet"); return finish(server); }
  const added = command("b-node-add", join(BIN, "morndo-fleet"), ["node", "add", NODE_NAME]);
  const joinLine = added.out.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  const joined = joinLine === "" ? { code: 1, out: "", err: `no join string in: ${added.out}${added.err}` }
    : command("b-node-join", join(BIN, "morndo-node"), ["join", joinLine], { timeoutMs: 60_000 });
  check("b-node-joined", joined.code === 0 && joined.out.includes("Joined the fleet"), `node add/join: ${firstLines(joined, 3)}`);
  if (failed) { journals("b-join"); return finish(server); }
  run("systemctl", ["--user", "enable", "--now", "morndo-node.service"]);
  const baseHealthy = await servicesHealthy(OLD_VERSION);
  check("b-baseline-healthy", baseHealthy.ok, `${baseHealthy.detail} (the old folder reports ${OLD_VERSION}: no build.json)`);
  const unmarked = SERVICES.every(s => !readFileSync(join(UNIT_DIR, s.unit), "utf8").startsWith("# Morndo's own unit"));
  const oldCmd = SERVICES.every(s => runsOld(cmdlineOf(s.unit)));
  check("b-baseline-unmarked", unmarked && oldCmd, `units carry no mark: ${unmarked}; all three run the old folder: ${oldCmd}`);
  if (failed) { journals("b-baseline"); return finish(server); }

  // The marker rows: a separate table in each database, written by sqlite3 while the old service holds it open.
  for (const [, path] of DBS) sqlite(path, `CREATE TABLE IF NOT EXISTS c6_marker (v TEXT); INSERT INTO c6_marker VALUES ('${LANE}'); INSERT INTO c6_marker VALUES ('${NODE_NAME}');`);
  const seeded = DBS.every(([, path]) => missingRows(sqlite(path, "SELECT v FROM c6_marker"), MARKERS).length === 0);
  check("b-markers", seeded, `marker rows ${MARKERS.join(", ")} written into the hub, fleet and node databases`);

  // The lane: a tmux server in its own transient scope, the way the node agent starts one.
  const spawned = run("systemd-run", ["--user", "--scope", "--quiet", "tmux", "new-session", "-d", "-s", LANE, "sleep 100000"]);
  const tmuxPid = Number(run("tmux", ["display-message", "-p", "-t", LANE, "#{pid}"]).out.trim());
  const lane = ownerOf(tmuxPid);
  const baseline: Baseline = { listing: listing(OLD_FOLDER), lanePid: tmuxPid, lane };
  writeFileSync(join(EVIDENCE, "old-folder-listing.txt"), baseline.listing);
  const scope = run("systemctl", ["--user", "list-units", "--type=scope", "--no-legend", "--plain"]).out.split("\n").filter(l => l.includes("run-")).slice(0, 3).join(" | ");
  check("b-lane", spawned.code === 0 && Number.isInteger(tmuxPid) && tmuxPid > 0 && lane.started !== "",
    `tmux server pid ${tmuxPid} started ${lane.started} in its own scope (${scope}); the old folder lists ${baseline.listing.split("\n").length - 1} files`);
  if (failed) return finish(server);

  // ---- c: the backup and the dead-man's switch (no ok marker). The node unit has a drop-in folder, as a tuned machine does.
  mkdirSync(DROPIN_DIR, { recursive: true });
  writeFileSync(join(DROPIN_DIR, "limits.conf"), OLD_DROPIN);
  writeFileSync(join(UNIT_DIR, SPARE_UNIT), SPARE_TEXT);
  writeFileSync(join(UNIT_DIR, SPARE2_UNIT), SPARE2_TEXT);
  run("systemctl", ["--user", "daemon-reload"]);
  const backed = command("c-backup", "sh", [join(E2E, "scripts/c6/backup.sh"), BACKUP, ...DBS.flatMap(([n, p]) => ["--db", `${n}=${p}`]), "--db", `memory=${MEMORY_DB}`]);
  const backedOk = backed.code === 0 && existsSync(join(BACKUP, "restore.sh")) && existsSync(join(BACKUP, "ROLLBACK.md"))
    && DBS.every(([n]) => existsSync(join(BACKUP, `dbs/${n}.db`)) && missingRows(sqlite(join(BACKUP, `dbs/${n}.db`), "SELECT v FROM c6_marker"), MARKERS).length === 0)
    && existsSync(join(BACKUP, "units/morndo-node.service.d/limits.conf"))
    && SERVICES.every(s => existsSync(join(BACKUP, "units", s.unit)) && existsSync(join(BACKUP, "wrappers", s.wrapper)))
    && readFileSync(join(BACKUP, "state.txt"), "utf8").split("\n").some(l => l.startsWith(`${SPARE_UNIT} active=no `))
    && readFileSync(join(BACKUP, "state.txt"), "utf8").split("\n").some(l => l === `${SPARE2_UNIT} active=no enabled=no`);
  check("c-backup", backedOk, `backup.sh exited ${backed.code}: ${firstLines(backed, 2)}; units: ${readdirSync(join(BACKUP, "units")).join(", ")}; wrappers: ${readdirSync(join(BACKUP, "wrappers")).join(", ")}`);
  if (failed) return finish(server);
  const armed = command("c-arm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "m1", BACKUP, "--seconds", String(DEADMAN_SECONDS)]);
  check("c-deadman-armed", armed.code === 0 && run("systemctl", ["--user", "is-active", "c6-deadman-m1.timer"]).out.trim() === "active" && !existsSync(join(BACKUP, "ok")),
    `armed for ${DEADMAN_SECONDS} s, no ok marker: ${firstLines(armed, 3)}`);
  if (failed) return finish(server);

  // ---- d: install over the machine.
  const refused = installOnce("d-install-with-wrappers");
  const installedAnyway = existsSync(join(RELEASES, "current"));
  check("finding-wrappers", true,
    `install over real-file wrappers exited ${refused.code}: ${firstLines(refused, 3)}; ~/.local/share/morndo-releases/current exists: ${installedAnyway}`);
  const moved = moveWrappersAside();
  const installed = installOnce("d-install");
  check("d-installed", installed.code === 0 && installed.out.includes(`Morndo ${VERSION_A} installed (control-plane, channel stable).`),
    `wrappers moved aside (${moved}); install exited ${installed.code} after ${installed.seconds} s: ${firstLines(installed, 8)}`);
  if (failed) { journals("d-install"); return finish(server); }

  // Finding 2, observed without acting: do the running units run the new tree within about 20 s of the install's end?
  const sawNew = await waitUntil(20_000, async () => {
    const cmd = SERVICES.map(s => cmdlineOf(s.unit));
    return cmd.every(runsNew) && (await hubVersion()) === VERSION_A && (await fleetVersion()) === VERSION_A && nodeVersion() === VERSION_A ? "new" : null;
  });
  const cmdAfter = SERVICES.map(s => `${s.app}: ${cmdlineOf(s.unit)}`);
  const restartObserved = `within 20 s of the install the three units ${sawNew === "new" ? "ran the NEW tree" : "did NOT all run the new tree"}; health ${await healthNow()}; install took ${installed.seconds} s and its output said: ${installed.out.split("\n").filter(l => l.includes("healthy") || l.includes("no answer")).join(" | ") || "(no health lines)"}; processes: ${cmdAfter.join(" || ")}`;
  check("finding-restart", true, restartObserved);
  if (sawNew !== "new") {
    for (const s of SERVICES) command(`d-restart-${s.app}`, "systemctl", ["--user", "restart", s.unit]);
  }
  const afterRestart = await servicesHealthy(VERSION_A);
  check("d-services-healthy", afterRestart.ok && SERVICES.every(s => runsNew(cmdlineOf(s.unit))),
    `${sawNew === "new" ? "no restart needed" : "after systemctl --user restart of the three units"}: ${afterRestart.detail}`);
  if (failed) { journals("d-restart"); return finish(server); }
  // Simulates the install (or anyone) starting a unit that was stopped at backup time.
  run("systemctl", ["--user", "start", SPARE_UNIT]);
  run("systemctl", ["--user", "enable", SPARE2_UNIT]);
  check("d-spare-started", unitActive(SPARE_UNIT), `${SPARE_UNIT} (stopped and not enabled at backup time) was started by hand after the install`);

  // ---- e: the proofs on the adopted machine.
  await proofs("e", baseline);
  if (failed) journals("e-proofs");

  // ---- f: the dead-man fires. The long switch comes off, a fresh short one goes on, then one more row after the backup.
  const disarmed = command("f-disarm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "--disarm", "m1"]);
  const rearmed = command("f-rearm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "m1", BACKUP, "--seconds", String(FIRING_SECONDS)]);
  const armedAt = Date.now();
  check("f-rearmed", disarmed.code === 0 && rearmed.code === 0, `long switch disarmed (${disarmed.code}), fresh ${FIRING_SECONDS} s switch armed (${rearmed.code}): ${firstLines(rearmed, 2)}`);
  // An extra row in a database whose schema does not change (the dead-man must leave it alone), and a migration of the
  // node database after the install (a new column and a row): the dead-man must keep a copy of it, put the old one back,
  // start every service again and END WITH EXIT 0 (the clean unattended rollback; the failed-copy firing is f2, below).
  sqlite(HUB_DB, "INSERT INTO c6_marker VALUES ('after-backup')");
  sqlite(NODE_DB, "ALTER TABLE c6_marker ADD COLUMN extra TEXT; INSERT INTO c6_marker (v) VALUES ('after-migration')");
  const remaining = FIRING_SECONDS - Math.round((Date.now() - armedAt) / 1000);
  check("f-armed-still-pending", remaining > 0 && run("systemctl", ["--user", "is-active", "c6-deadman-m1.timer"]).out.trim() === "active",
    `an extra row is written into the hub database and the node database gets a new column and a row after the backup; the timer has ${remaining} s left`);
  if (failed) return finish(server);
  const fired = await waitDeadmanGone("m1", (Math.max(remaining, 0) + 150) * 1000);
  await sleep(2000);
  const dm1 = deadmanJournal("m1");
  writeFileSync(join(EVIDENCE, "deadman-m1-journal.txt"), dm1.text);
  check("f-deadman-fired", fired, `the timer fired; last journal lines: ${dm1.text}`);
  const result1 = run("systemctl", ["--user", "show", "-p", "Result", "--value", "c6-deadman-m1.service"]).out.trim();
  const reportText = (() => { try { return readFileSync(join(BACKUP, "deadman-report.txt"), "utf8"); } catch { return ""; } })();
  const failedLines = reportText.split("\n").filter(l => l.includes("FAILED"));
  check("f-rollback-exit-0", fired && dm1.ranOk && !dm1.failedRun && result1 === "success" && reportText !== "" && failedLines.length === 0,
    `the changed schema was rolled back unattended: the unit ended with Result=${result1 || "(none)"}, failed run: ${dm1.failedRun}; FAILED lines in deadman-report.txt: ${failedLines.length} (${failedLines.join(" | ").slice(0, 300)})`);
  run("systemctl", ["--user", "reset-failed", "c6-deadman-m1.service"]);
  const unitsBack = SERVICES.every(s => readFileSync(join(UNIT_DIR, s.unit), "utf8") === OLD_UNITS.get(s.unit));
  const morndoUnits = readdirSync(UNIT_DIR).filter(n => n.startsWith("morndo-")).sort();
  const expectedUnits = [...SERVICES.map(s => s.unit), SPARE_UNIT, SPARE2_UNIT, "morndo-node.service.d"].sort();
  check("f-units-restored", unitsBack && JSON.stringify(morndoUnits) === JSON.stringify(expectedUnits),
    `the three units are the old unmarked text again: ${unitsBack}; morndo-* in the unit folder: ${morndoUnits.join(", ")}`);
  const dropinFiles = existsSync(DROPIN_DIR) ? readdirSync(DROPIN_DIR).sort() : [];
  const dropinText = (() => { try { return readFileSync(join(DROPIN_DIR, "limits.conf"), "utf8"); } catch { return null; } })();
  check("f-dropin-restored", dropinText === OLD_DROPIN && JSON.stringify(dropinFiles) === JSON.stringify(["limits.conf"]) && !existsSync(join(DROPIN_DIR, "before-morndo.conf")),
    `limits.conf is byte-identical to the old drop-in: ${dropinText === OLD_DROPIN}; the install's before-morndo.conf is gone; the folder holds: ${dropinFiles.join(", ") || "(nothing)"}`);
  const wrappersBack = SERVICES.every(s => {
    try { return !lstatSync(join(BIN, s.wrapper)).isSymbolicLink() && readFileSync(join(BIN, s.wrapper), "utf8") === OLD_WRAPPERS.get(s.wrapper); } catch { return false; }
  });
  check("f-wrappers-restored", wrappersBack, `the three wrappers are real files with the old text again: ${wrappersBack}`);
  // Nothing was started by hand: every service the backup found running is running again as the restore left it.
  const running = SERVICES.map(s => `${s.unit}=${unitActive(s.unit)}`);
  check("f-rollback-all-running", SERVICES.every(s => unitActive(s.unit)), `right after the unattended rollback, with no manual start: ${running.join(" ")}`);
  const backHealthy = await servicesHealthy(OLD_VERSION, 120_000);
  const backCmd = SERVICES.map(s => cmdlineOf(s.unit));
  check("f-old-folder-running", backHealthy.ok && backCmd.every(runsOld), `${backHealthy.detail}; processes: ${backCmd.join(" || ")}`);
  const quicksF = DBS.map(([n, path]) => `${n}=${quickCheck(path)}`);
  const extra = missingRows(sqlite(HUB_DB, "SELECT v FROM c6_marker"), ["after-backup", ...MARKERS]);
  check("f-extra-row-kept", quicksF.every(q => q.endsWith("=ok")) && extra.length === 0,
    `the row written after the backup is still in the hub database, whose schema did not change (missing: ${extra.join(",") || "none"}); quick_check ${quicksF.join(" ")}`);
  const nodeColumns = sqlite(NODE_DB, "SELECT name FROM pragma_table_info('c6_marker')").split("\n");
  const nodeRows = sqlite(NODE_DB, "SELECT v FROM c6_marker").split("\n");
  const asides = readdirSync(BACKUP).filter(n => n.startsWith("aside-")).sort();
  const asideFiles = asides.flatMap(a => readdirSync(join(BACKUP, a)).map(f => `${a}/${f}`));
  const asideNode = asides.map(a => join(BACKUP, a, "node.db")).find(f => existsSync(f));
  const asideRows = asideNode === undefined ? [] : sqlite(asideNode, "SELECT v FROM c6_marker").split("\n");
  const asideColumns = asideNode === undefined ? [] : sqlite(asideNode, "SELECT name FROM pragma_table_info('c6_marker')").split("\n");
  check("f-changed-schema-node-restored", !nodeColumns.includes("extra") && !nodeRows.includes("after-migration") && missingRows(nodeRows.join("\n"), MARKERS).length === 0,
    `the node database is the backup's again: columns ${nodeColumns.join(",")}, rows ${nodeRows.join(",")}`);
  check("f-changed-schema-aside-copy", asideNode !== undefined && asideRows.includes("after-migration") && asideColumns.includes("extra") && quickCheck(asideNode) === "ok",
    `copies in the backup folder: ${asideFiles.join(", ") || "(none)"}; the node copy holds the post-install row: ${asideRows.includes("after-migration")} and the new column: ${asideColumns.includes("extra")}`);
  check("f-changed-schema-report", reportText.includes("node") && asides.length > 0 && asides.every(a => reportText.includes(a)),
    `deadman-report.txt: ${reportText.split("\n").filter(l => l.trim() !== "").slice(-4).join(" | ")}`);
  const leftoversF = DBS.flatMap(([, path]) => readdirSync(join(path, "..")).filter(n => n.includes("c6-")));
  check("f-no-temp-files", leftoversF.length === 0, `no c6-* temp or aside file beside the databases: ${leftoversF.join(",") || "none"}`);
  const spareText = (() => { try { return readFileSync(join(UNIT_DIR, SPARE_UNIT), "utf8"); } catch { return null; } })();
  const spareState = run("systemctl", ["--user", "is-active", SPARE_UNIT]).out.trim();
  check("f-spare-stays-stopped", spareState !== "active" && spareText === SPARE_TEXT,
    `${SPARE_UNIT} was started after the install; after the restore it is ${spareState}; its unit file is byte-identical: ${spareText === SPARE_TEXT}`);
  // The restore disables a service the install enabled that was disabled at backup time.
  const spare2Enabled = run("systemctl", ["--user", "is-enabled", SPARE2_UNIT]).out.trim();
  check("f-spare-service-disabled", spare2Enabled === "disabled" && !unitActive(SPARE2_UNIT),
    `${SPARE2_UNIT} has an [Install] section, was disabled at backup time and enabled by hand after the install; after the restore is-enabled says "${spare2Enabled}" and it is active: ${unitActive(SPARE2_UNIT)}`);
  const laneF = sameProcess(baseline.lane, ownerOf(baseline.lanePid));
  check("f-lane-kept", laneF.ok, laneF.detail);
  check("f-no-ok-marker", !existsSync(join(BACKUP, "ok")), "no ok marker was in the backup folder when the switch fired");
  if (failed) { journals("f-deadman"); return finish(server); }

  // ---- f2: a second firing on the same (restored) machine: a database copy that fails. A fresh short switch is armed; the
  // fleet database changes its schema (so the dead-man must put it back) and the backup's copy of it is corrupted first (the
  // good file is kept outside the backup folder and put back after the check). The dead-man must keep morndo-fleet.service
  // stopped, say so in deadman-report.txt, exit non-zero and leave the live fleet database alone, while the hub and the node
  // are started again. A timer that fires inside the restore window is not forced here (it cannot be timed in a container):
  // that property is covered by scripts/c6/backup.test.ts only.
  const disarmed2 = command("f2-disarm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "--disarm", "m1"]);
  const rearmed2 = command("f2-rearm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "m1", BACKUP, "--seconds", String(FIRING_SECONDS)]);
  const armedAt2 = Date.now();
  const startsBefore2 = deadmanStarts("m1");
  check("f2-rearmed", disarmed2.code === 0 && rearmed2.code === 0, `switch disarmed (${disarmed2.code}), fresh ${FIRING_SECONDS} s switch armed (${rearmed2.code}): ${firstLines(rearmed2, 2)}`);
  sqlite(FLEET_DB, "ALTER TABLE c6_marker ADD COLUMN extra TEXT; INSERT INTO c6_marker (v) VALUES ('after-migration')");
  const FLEET_BACKUP_COPY = join(BACKUP, "dbs/fleet.db");
  const FLEET_GOOD = join(HOME, "fleet-backup-copy.good");
  copyFileSync(FLEET_BACKUP_COPY, FLEET_GOOD);
  writeFileSync(FLEET_BACKUP_COPY, "this is no longer a database, long enough to look like a file ".repeat(100));
  const remaining2 = FIRING_SECONDS - Math.round((Date.now() - armedAt2) / 1000);
  check("f2-armed-still-pending", remaining2 > 0 && run("systemctl", ["--user", "is-active", "c6-deadman-m1.timer"]).out.trim() === "active",
    `the fleet database got a new column and a row, its backup copy is corrupted; the timer has ${remaining2} s left`);
  if (failed) return finish(server);
  const fired2 = await waitDeadmanGone("m1", (Math.max(remaining2, 0) + 150) * 1000, startsBefore2);
  await sleep(2000);
  const dm1b = deadmanJournal("m1");
  writeFileSync(join(EVIDENCE, "deadman-m1-failed-copy-journal.txt"), dm1b.text);
  check("f2-deadman-fired", fired2, `the timer fired (the run ended with a failed result, as the corrupted fleet copy makes it: ${dm1b.failedRun}); last journal lines: ${dm1b.text}`);
  run("systemctl", ["--user", "reset-failed", "c6-deadman-m1.service"]);
  const reportText2 = (() => { try { return readFileSync(join(BACKUP, "deadman-report.txt"), "utf8"); } catch { return ""; } })();
  const failedLines2 = reportText2.split("\n").filter(l => l.startsWith("FAILED:"));
  const fleetDir = join(HOME, ".local/share/morndo-fleet");
  const leftovers = readdirSync(fleetDir).filter(n => n.includes("c6-") || n.endsWith(".tmp"));
  const fleetCols = sqlite(FLEET_DB, "SELECT name FROM pragma_table_info('c6_marker')").split("\n");
  check("f2-failed-copy-service-stays-stopped",
    dm1b.failedRun && !unitActive("morndo-fleet.service") && unitActive("morndo-hub.service") && unitActive("morndo-node.service")
      && /database fleet was NOT put back/.test(reportText2) && /the service morndo-fleet\.service stays stopped/.test(reportText2) && failedLines2.length > 0 && failedLines2.every(l => l.includes("fleet"))
      && fleetCols.includes("extra") && quickCheck(FLEET_DB) === "ok" && leftovers.length === 0,
    `the run failed: ${dm1b.failedRun}; morndo-fleet.service active: ${unitActive("morndo-fleet.service")}; hub active: ${unitActive("morndo-hub.service")}; node active: ${unitActive("morndo-node.service")}; FAILED lines in the report: ${failedLines2.length} (${failedLines2.join(" | ").slice(0, 300)}); live fleet database still migrated: ${fleetCols.includes("extra")}, quick_check ${quickCheck(FLEET_DB)}; temp files beside it: ${leftovers.join(",") || "none"}`);
  // What the report tells the operator to do, done by hand: the good backup copy back into the folder and onto the live
  // database (the service is stopped), then the service started. The later steps need the fleet again.
  copyFileSync(FLEET_GOOD, FLEET_BACKUP_COPY);
  copyFileSync(FLEET_GOOD, FLEET_DB);
  rmSync(`${FLEET_DB}-wal`, { force: true });
  rmSync(`${FLEET_DB}-shm`, { force: true });
  run("systemctl", ["--user", "start", "morndo-fleet.service"]);
  const repaired = await servicesHealthy(OLD_VERSION, 120_000);
  check("f2-repaired-by-hand", repaired.ok, `after the copy by hand and the start: ${repaired.detail}`);
  if (failed) { journals("f2-deadman"); return finish(server); }

  // ---- g: the second install (rehearsal-only reset), then the dead-man that does nothing.
  const again = installOnce("g-reinstall-after-restore");
  check("finding-reinstall", true, `install after the restore (nothing reset) exited ${again.code}: ${firstLines(again, 3)}; releases/current exists: ${existsSync(join(RELEASES, "current"))}`);
  run("chmod", ["-R", "u+w", RELEASES]);                  // an installed Version is read-only (directories 0555)
  rmSync(RELEASES, { recursive: true, force: true });
  rmSync(UPDATE_STATE, { recursive: true, force: true });
  rmSync(UPDATE_CONFIG_DIR, { recursive: true, force: true });
  const movedAgain = moveWrappersAside();
  // The corrected procedure the first install showed the need of: the three services stopped before the install (the
  // lane's tmux sits in its own scope), so the install starts them on the new tree.
  run("systemctl", ["--user", "stop", ...SERVICE_UNITS]);
  const second = installOnce("g-install");
  check("g-installed", second.code === 0 && second.out.includes(`Morndo ${VERSION_A} installed (control-plane, channel stable).`),
    `after the reset (releases, update state, update config removed), wrappers moved aside (${movedAgain}), services stopped: install exited ${second.code} after ${second.seconds} s: ${firstLines(second, 8)}`);
  if (failed) { journals("g-install"); return finish(server); }
  let secondHealthy = await servicesHealthy(VERSION_A, 60_000);
  if (!secondHealthy.ok) {
    for (const s of SERVICES) command(`g-restart-${s.app}`, "systemctl", ["--user", "restart", s.unit]);
    secondHealthy = await servicesHealthy(VERSION_A);
  }
  check("g-services-healthy", secondHealthy.ok && SERVICES.every(s => runsNew(cmdlineOf(s.unit))), secondHealthy.detail);
  if (failed) { journals("g-restart"); return finish(server); }

  // Arm first (arm-deadman.sh refuses while the ok marker exists), then sign off: the firing finds the marker.
  const armed2 = command("g-arm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "m1b", BACKUP, "--seconds", "60"]);
  writeFileSync(join(BACKUP, "ok"), "");
  check("g-deadman-armed", armed2.code === 0, `armed for 60 s, then the ok marker put in place: ${firstLines(armed2, 2)}`);
  const firedB = await waitDeadmanGone("m1b", 5 * 60_000);
  await sleep(2000);
  const dm2 = deadmanJournal("m1b");
  writeFileSync(join(EVIDENCE, "deadman-m1b-journal.txt"), dm2.text);
  check("g-deadman-noop", firedB && dm2.ranOk && !dm2.failedRun && existsSync(join(BACKUP, "ok")), `the timer unit ran and exited 0; the ok marker is still there: ${dm2.text}`);
  // The ok step as the runbook gives it: the marker is there, then the switch is taken away.
  const off = command("g-disarm", "sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "--disarm", "m1b"]);
  check("g-disarmed", off.code === 0 && !existsSync(join(UNIT_DIR, "c6-deadman-m1b.timer")) && !existsSync(join(UNIT_DIR, "c6-deadman-m1b.service")) && existsSync(join(BACKUP, "ok")),
    `--disarm exited ${off.code}; the timer and service files are gone and the ok marker stays`);
  const unitsStill = SERVICES.every(s => readFileSync(join(UNIT_DIR, s.unit), "utf8").startsWith("# Morndo's own unit")) && existsSync(join(UNIT_DIR, "morndo-update.timer"));
  check("g-unchanged", unitsStill && SERVICES.every(s => lstatSync(join(BIN, s.wrapper)).isSymbolicLink()), "units still marked, update timer still there, launchers still links");
  await proofs("g", baseline);
  if (failed) journals("g-proofs");

  // ---- h: the control plane's window step.
  const before = command("h-status-before", join(BIN, "morndo"), ["update", "--status"]);
  const set = command("h-window", join(BIN, "morndo"), ["update", "window", "03:30-05:00"]);
  const after = command("h-status-after", join(BIN, "morndo"), ["update", "--status"]);
  const windowLine = (r: { out: string }) => r.out.split("\n").map(l => l.split(" · ").find(p => p.startsWith("window:")) ?? "").find(l => l !== "") ?? "(no window line)";
  check("h-window", before.out.includes("window: any hour") && set.code === 0 && after.out.includes("window: 03:30-05:00"),
    `before: ${windowLine(before)}; window command exited ${set.code}: ${firstLines(set, 2)}; after: ${windowLine(after)}`);
  return finish(server);
}

function finish(server: FeedHost): number {
  const status = run(join(BIN, "morndo"), ["update", "--status"]);
  writeFileSync(join(EVIDENCE, "status.txt"), `morndo update --status:\n${status.out}\n${status.err}\n`);
  run("tmux", ["kill-server"]);
  for (const m of ["m1", "m1b"]) run("sh", [join(E2E, "scripts/c6/arm-deadman.sh"), "--disarm", m]);
  server.close();
  const passed = checks.filter(c => c.ok).length;
  process.stdout.write(`${JSON.stringify({ step: "summary", ok: passed === checks.length, detail: `${passed}/${checks.length} checks passed` })}\n`);
  return passed === checks.length ? 0 : 1;
}

process.exit(await main());
