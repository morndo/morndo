// The machine side of the throwaway-machine run (design §13, e2e/update.e2e.ts): this runs INSIDE the container
// as the worker user, under the unpacked A tree's own Node (e2e/update.e2e.ts names it on its command line). It
// serves the feed over HTTPS on the container's own 127.0.0.1 — the port is baked into the signed documents by
// e2e/update-vm/build.ts, and the two must agree — through a directory link it repoints at feed-1 … feed-6, so
// the machine's MORNDO_UPDATE_FEED never changes while the story moves on.
//
// The story: install A; the first update this machine ever sees, killed at `stopping`, for the recovery timer to
// finish on its own; two kills before the swap (draining, backing_up), each answered by `update recover`; B
// commits; a rollback to A; C breaks the hub and rolls back; 0.3.1's migration throws inside the hub and rolls
// back leaving the databases untouched; 0.3.2 dies in probation, its revocations typed while it stands there,
// and its rollback restores around them; a full disk under 0.4.0's Backup abandons before the swap; a kill
// after the swap at `starting`, recovered whole; and nothing left behind.
//
// Not here (§13): a hard power loss — docker kill is not one, that stays manual QA; the hub's `uncertain`
// answer to a Command retried across a restore (apps/hub/test/steering-store-stamp.test.ts holds it); a second
// machine (PR 6).
//
// Every check prints one JSON line on stdout — {"step": "...", "ok": true|false, "detail": ...} — and the host
// side reads exactly those. A failed check writes the units' journals into the evidence directory and the run
// goes on to cleanup: the machine is throwaway, but nothing of it is left running or half-applied.
//
// Constants that mirror product code (named here so this file stands alone in the container): the unit mark is
// apps/updater/src/adapters/services-systemd.ts's UNIT_MARK; the paths are design §5's.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
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
const RELEASES = join(HOME, ".local/share/morndo-releases");
const UPDATE_STATE = join(HOME, ".local/state/morndo-update");
const UPDATE_DB = join(UPDATE_STATE, "update.db");
const HUB_DB = join(HOME, ".local/share/morndo/morndo.db");
const FLEET_DB = join(HOME, ".local/share/morndo-fleet/fleet.db");
const NODE_DB = join(HOME, ".local/state/morndo-node/agent.db");
const UNIT_DIR = join(HOME, ".config/systemd/user");
const SERVICE_UNITS = ["morndo-hub.service", "morndo-fleet.service", "morndo-node.service"];
// services-systemd.ts's UNIT_MARK: the first line of every unit file a render writes.
const UNIT_MARK = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).";
const VERSION_A = "0.1.0";
const VERSION_B = "0.2.0";
const VERSION_C = "0.3.0";
const VERSION_D = "0.3.1";   // the failing migration: its hub's `up` throws, so the hub never starts
const VERSION_E = "0.3.2";   // dies in probation: healthy, then gone after 20 s — and it breaks the hub schema, so its rollback restores
const VERSION_F = "0.4.0";   // healthy: B's change plus one more additive hub migration
const NODE_NAME = "e2e-node";
const NODE2_NAME = "e2e-node-2";

const ENV = {
  ...process.env, HOME,
  PATH: `${join(HOME, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`,
  MORNDO_UPDATE_FEED: FEED_URL,
  NODE_EXTRA_CA_CERTS: join(E2E, "tls/ca.pem"),
};

type Check = { step: string; ok: boolean; detail: string };
const checks: Check[] = [];
let failed = false;

function check(step: string, ok: boolean, detail: string): void {
  checks.push({ step, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`);
}

// One command, one argument list, no shell. `input` feeds stdin (the typed word a terminal would answer with);
// `env` replaces the scenario's own environment (a second HOME, for a node enrolled beside the first).
function run(file: string, args: string[], o: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}):
  { code: number; out: string; err: string } {
  const done = spawnSync(file, args, { encoding: "utf8", env: o.env ?? ENV, input: o.input, timeout: o.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { code: done.status ?? -1, out: done.stdout ?? "", err: done.stderr ?? "" };
}

// A principal command of the story: run(), and keep its whole word in the evidence directory whatever happened —
// the host copies the evidence out, so a failure's full story (Node's stack and all) leaves the machine with it.
function command(label: string, file: string, args: string[], o: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {}):
  { code: number; out: string; err: string } {
  const r = run(file, args, o);
  writeFileSync(join(EVIDENCE, `command-${label}.txt`),
    `$ ${file} ${args.join(" ")}${o.input === undefined ? "" : `  (stdin: ${JSON.stringify(o.input)})`}\nexit ${r.code}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`);
  return r;
}

// The first lines of a command's word, for a check's detail line: enough to name the failure on the console —
// Node's own crash header is four lines before the Error and its stack begin.
const firstLines = (r: { out: string; err: string }, n = 14): string => (r.err || r.out).split("\n").slice(0, n).join(" | ");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitUntil(what: string, deadlineMs: number, probe: () => Promise<string | null>): Promise<string | null> {
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
  const missing = await waitUntil("units", timeoutMs, async () => {
    const not = names.filter(n => !unitActive(n));
    return not.length === 0 ? "" : null;
  });
  return missing;
}

// The three health doors exactly as the updater's own probes read them (§6.3): the hub on HTTP, the fleet on its
// socket, the agent from the status file it rewrites.
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

async function waitHealthy(which: "hub" | "fleet" | "node", atVersion: string, timeoutMs: number): Promise<boolean> {
  const probe = which === "hub" ? hubVersion : which === "fleet" ? fleetVersion : async () => nodeVersion();
  const answer = await waitUntil(which, timeoutMs, probe);
  return answer === atVersion;
}

// A whole story of services at a version: all three units active, all three answering with that version.
async function servicesAt(step: string, version: string): Promise<void> {
  const units = await waitUnits(SERVICE_UNITS, 90_000);
  const healthy = units === null ? false
    : (await waitHealthy("hub", version, 90_000)) && (await waitHealthy("fleet", version, 90_000)) && (await waitHealthy("node", version, 90_000));
  check(step, healthy, units === null ? "units not active" : healthy ? `all three services healthy at ${version}` : `a service is not healthy at ${version}`);
}

const linkName = (name: "current" | "previous" | "good"): string | null => {
  try { return basename(readlinkSync(join(RELEASES, name))); } catch { return null; }
};

function sqlite(db: string, sql: string): string {
  return run("sqlite3", [db, sql]).out.trim();
}

// A database's own health word, asked the way the product asks it (§11.3): quick_check must answer ok.
const quickCheck = (db: string) => sqlite(db, "PRAGMA quick_check");

function journals(title: string): void {
  const dump = run("journalctl", ["--user", "-u", "morndo-*", "--no-pager", "-n", "200"]);
  const status = run("systemctl", ["--user", "--no-pager", "--full", "list-units", "morndo-*", "--all"]);
  const units = run("systemctl", ["--user", "--no-pager", "--full", "--failed"]);
  writeFileSync(join(EVIDENCE, `journal-${title}.txt`), [
    `$ systemctl --user list-units 'morndo-*' --all\n${status.out}\n${status.err}\n`,
    `$ systemctl --user --failed\n${units.out}\n${units.err}\n`,
    `$ journalctl --user -u 'morndo-*' -n 200\n${dump.out}\n${dump.err}\n`,
  ].join("\n"));
}

function pointFeedAt(which: "feed-1" | "feed-2" | "feed-3" | "feed-4" | "feed-5" | "feed-6"): void {
  rmSync(FEED_LINK, { force: true });
  symlinkSync(join(FEEDS, which), FEED_LINK);
}

// The record's own word, read out of update.db the way a watcher may: read-only, never a writer. The record is
// the apply's running story (RL4) — the kill helper below times itself on it, and the after-crash checks read
// what the recovery left it saying.
const versionText = (v: unknown): string | null => {
  if (v === null || typeof v !== "object") return null;
  const { major, minor, patch } = v as Record<string, unknown>;
  return typeof major === "number" && typeof minor === "number" && typeof patch === "number"
    ? `${major}.${minor}.${patch}` : null;
};

function recordOf(sql: string): { target: string | null; state: string; mark: string | null; hubBackupDone: boolean } | null {
  const row = run("sqlite3", ["-readonly", UPDATE_DB, sql]).out.trim();
  if (row === "") return null;
  try {
    const doc = JSON.parse(row) as { target?: unknown; state?: unknown; mark?: unknown; backups?: unknown };
    const backups = Array.isArray(doc.backups) ? doc.backups as { database?: unknown; done?: unknown }[] : [];
    return {
      target: versionText(doc.target),
      state: typeof doc.state === "string" ? doc.state : "?",
      mark: typeof doc.mark === "string" ? doc.mark : null,
      hubBackupDone: backups.some(b => b.database === "hub" && b.done === true),
    };
  } catch { return null; }
}
const openRecord = () => recordOf("SELECT record FROM updates WHERE finished_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1");
const lastRecord = () => recordOf("SELECT record FROM updates ORDER BY started_at DESC, rowid DESC LIMIT 1");

// The apply's own step order, packages/domain's UPDATE_MARKS: what the kill helper counts "at or after" with.
const UPDATE_MARKS = ["draining", "stopping", "backing_up", "swapping", "starting", "committing", "rolling_back"] as const;
const markAt = (mark: string | null): number => (mark === null ? -1 : (UPDATE_MARKS as readonly string[]).indexOf(mark));

// An unattended `morndo update --yes`: spawn, not the spawnSync every other principal command uses, because the
// story has to move while it runs — a kill to time, a revocation to type in a probation. Its whole word goes to
// the evidence like any principal command's, whenever it ends.
type Running = { exited: () => boolean; wait: (note?: string) => Promise<{ code: number; out: string; err: string }> };
function startUpdate(label: string): Running {
  const child = spawn(MORNDO, ["update", "--yes"], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "", gone = false;
  child.stdout!.on("data", (c: Buffer) => { out += c; });
  child.stderr!.on("data", (c: Buffer) => { err += c; });
  const word = new Promise<{ code: number; out: string; err: string }>(resolve => {
    child.once("exit", code => { gone = true; resolve({ code: code ?? -1, out, err }); });
    child.once("error", () => { gone = true; resolve({ code: -1, out, err }); });
  });
  return {
    exited: () => gone,
    wait: async note => {
      const r = await word;
      writeFileSync(join(EVIDENCE, `command-${label}.txt`),
        `$ ${MORNDO} update --yes\nexit ${r.code}\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n${note ?? ""}`);
      return r;
    },
  };
}

// §13's crash: the update runs unattended, the open record is polled every 50 ms, and the apply UNIT — the
// process the updater really runs in — is SIGKILLed the moment the record shows the wanted mark. A fast step may
// already be passed when the poll first sees it; the observed mark is what the evidence names, and the step's
// check counts "killed at or after" where the recovery table draws its line before the swap.
async function killAtMark(o: { label: string; version: string; at: (typeof UPDATE_MARKS)[number]; budgetMs?: number }):
  Promise<{ observed: string | null; update: { code: number; out: string; err: string } }> {
  const running = startUpdate(o.label);
  const end = Date.now() + (o.budgetMs ?? 5 * 60_000);
  let observed: string | null = null;
  for (;;) {
    const open = openRecord();
    if (open !== null && open.target === o.version && markAt(open.mark) >= UPDATE_MARKS.indexOf(o.at)) { observed = open.mark; break; }
    if (running.exited() || Date.now() >= end) break;
    await sleep(50);
  }
  let killWord = "the record never showed the mark before the update ended on its own";
  if (observed !== null) {
    const killed = run("systemctl", ["--user", "kill", "--signal=SIGKILL", `morndo-update-apply@${o.version}.service`]);
    killWord = `the record stood at ${JSON.stringify(observed)} when the apply unit was killed (wanted: ${o.at})`;
    writeFileSync(join(EVIDENCE, `kill-${o.label}.txt`),
      `${killWord}\n$ systemctl --user kill --signal=SIGKILL morndo-update-apply@${o.version}.service\nexit ${killed.code}\n${killed.out}${killed.err}\n`);
  }
  const update = await running.wait(`${killWord}\n`);
  return { observed, update };
}

// What every crash must end in (§6.6): the machine whole on ONE Version — the old one still current and all
// three services healthy at it, or the target committed — never a mix, every database sound, no applying marker.
async function machineWhole(o: { versionA: string; versionV: string }): Promise<{ ok: boolean; where: string | null; detail: string }> {
  const current = linkName("current");
  if (current !== o.versionA && current !== o.versionV)
    return { ok: false, where: current, detail: `current=${current} (neither ${o.versionA} nor ${o.versionV})` };
  const parts: string[] = [];
  const units = await waitUnits(SERVICE_UNITS, 120_000);
  let healthy = units !== null;
  if (units === null) parts.push("units not active");
  for (const which of ["hub", "fleet", "node"] as const) {
    if (!healthy) break;
    if (await waitHealthy(which, current!, 120_000)) parts.push(`${which} healthy at ${current}`);
    else { healthy = false; parts.push(`${which} NOT healthy at ${current}`); }
  }
  const quicks = [HUB_DB, FLEET_DB, NODE_DB, UPDATE_DB].map(quickCheck);
  const applying = existsSync(join(UPDATE_STATE, "applying"));
  const ok = healthy && quicks.every(q => q === "ok") && !applying;
  return { ok, where: current, detail: `${parts.join(", ")}; quick_check ${quicks.join(", ")}; the applying marker ${applying ? "is still there" : "is gone"}` };
}

// The feed host runs as its own process (feed-server.ts beside this file): every command below is a spawnSync,
// which holds this process's event loop, so a server in here would never answer the updater it waits on.
type FeedHost = { close(): void };
function serveFeed(): Promise<FeedHost> {
  const child = spawn(process.execPath, [join(E2E, "feed-server.ts"), FEED_LINK, join(E2E, "tls/server.key"),
    join(E2E, "tls/server.pem"), join(EVIDENCE, "feed-requests.txt"), "8443"], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`the feed server exited ${code} before it listened`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve({ close: () => { child.kill("SIGTERM"); } });
    });
  });
}

async function main(): Promise<number> {
  mkdirSync(EVIDENCE, { recursive: true });

  // ---- 0: the environment the services will inherit, and the feed host itself.
  mkdirSync(join(HOME, ".config/environment.d"), { recursive: true });
  writeFileSync(join(HOME, ".config/environment.d/morndo-e2e.conf"), [
    `MORNDO_UPDATE_FEED=${FEED_URL}\n`,
    `NODE_EXTRA_CA_CERTS=${join(E2E, "tls/ca.pem")}\n`,
  ].join(""));
  run("systemctl", ["--user", "daemon-reexec"]);
  run("systemctl", ["--user", "set-environment", `MORNDO_UPDATE_FEED=${FEED_URL}`, `NODE_EXTRA_CA_CERTS=${join(E2E, "tls/ca.pem")}`]);
  const managerEnv = run("systemctl", ["--user", "show-environment"]);
  check("0-environment", managerEnv.out.includes("MORNDO_UPDATE_FEED=") && managerEnv.out.includes("NODE_EXTRA_CA_CERTS="),
    "the user manager carries MORNDO_UPDATE_FEED and NODE_EXTRA_CA_CERTS");

  pointFeedAt("feed-1");
  const server = await serveFeed();
  const selfProbe = await httpsStatus(`${FEED_URL}keys/1.json`, readFileSync(join(E2E, "tls/ca.pem"), "utf8"));
  check("0-feed-server", selfProbe === 200, `the feed answers on ${FEED_URL}keys/1.json (HTTP ${selfProbe})`);
  if (failed) return finish(server);

  // ---- 1: install A by role, join the node, and see the machine whole at 0.1.0. The A tree arrives unpacked
  // (the host extracts the archive, as install.sh does — this scenario runs under that tree's own Node, so the
  // Node has to be there before anything inside the machine starts); install verifies it against its own signed
  // files.json before anything is written.
  const tree = join(E2E, "tree-a");
  if (!existsSync(join(tree, "bin", "morndo"))) {
    check("1-install", false, `the unpacked A tree is not at ${tree}`);
    return finish(server);
  }
  for (const name of readdirSync(join(tree, "bin"))) chmodSync(join(tree, "bin", name), 0o555);
  const install = command("1-install", join(tree, "bin", "morndo"), ["install", "--role", "control-plane"], { timeoutMs: 300_000 });
  check("1-install", install.code === 0 && install.out.includes(`Morndo ${VERSION_A} installed (control-plane, channel stable).`),
    `install exited ${install.code}: ${firstLines(install)}`);
  if (failed) { journals("1-install"); return finish(server); }

  // install waits for health only on a joined machine: the fleet the join dials may still be starting
  check("1-fleet-up", await waitHealthy("fleet", VERSION_A, 90_000), "the fleet answers its health at 0.1.0 before the join");
  if (failed) { journals("1-fleet"); return finish(server); }
  const added = command("1-node-add", MORNDO_FLEET, ["node", "add", NODE_NAME]);
  const joinLine = added.out.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  const joined = joinLine === "" ? { code: 1, out: "", err: `no join string in: ${added.out}` }
    : command("1-node-join", MORNDO_NODE, ["join", joinLine], { timeoutMs: 60_000 });
  check("1-node-joined", joined.code === 0 && joined.out.includes("Joined the fleet"),
    `node add/join: ${firstLines(joined)}`);
  if (failed) { journals("1-join"); return finish(server); }
  run("systemctl", ["--user", "start", "morndo-node.service"]);
  await servicesAt("1-services-healthy", VERSION_A);
  if (failed) { journals("1-services"); return finish(server); }
  const schemaA = Number(sqlite(HUB_DB, "PRAGMA user_version"));   // the hub at A has made its database; B's migration is the next

  const links1 = linkName("current") === VERSION_A && linkName("good") === VERSION_A;
  check("1-links", links1, `current=${linkName("current")} good=${linkName("good")}`);
  const unitFiles = readdirSync(UNIT_DIR).filter(n => n.startsWith("morndo-") && (n.endsWith(".service") || n.endsWith(".timer")));
  const marked = unitFiles.filter(n => readFileSync(join(UNIT_DIR, n), "utf8").startsWith(`${UNIT_MARK}\n`));
  check("1-unit-mark", unitFiles.length > 0 && marked.length === unitFiles.length,
    `${marked.length}/${unitFiles.length} unit files carry Morndo's mark`);
  const upToDate = command("1-update-check", MORNDO, ["update", "--check"], { timeoutMs: 120_000 });
  check("1-feed-up-to-date", upToDate.code === 0 && upToDate.out.includes(`Up to date: ${VERSION_A}.`),
    `update --check against feed-1 exited ${upToDate.code}: ${firstLines(upToDate)}`);
  if (failed) { journals("1-end"); return finish(server); }

  // The tick's timer goes off for this run: every apply here is typed by hand, and the story waits — with the
  // apply lock free — through the recovery timer's minutes, where a tick landing would begin its own apply (the
  // settings' default mode is apply) and race the very recovery this run tests. The unit stays installed; only
  // the machine's own operator switch keeps it out of the story.
  run("systemctl", ["--user", "disable", "--now", "morndo-update.timer"]);
  check("1-tick-timer-off", run("systemctl", ["--user", "is-enabled", "morndo-update.timer"]).code !== 0,
    "the tick's timer is off for this run; every apply below is typed by hand");
  if (failed) { journals("1-tick"); return finish(server); }

  // ---- 2: the first update this machine ever sees, killed at `stopping` — the services going down, nothing
  // moved, the record open. Nobody types recover here: the recovery timer (OnBootSec=2min, OnUnitActiveSec=5min,
  // and systemd's own AccuracySec a minute more) must notice the applying mark and put the machine back on A by
  // itself, inside the five minutes it promises plus one of slack (§6.6, §13).
  pointFeedAt("feed-2");
  check("2-recovery-timer", unitActive("morndo-update-recover.timer"), "the recovery watch's timer is active");
  const killed2 = await killAtMark({ label: "2-first-update", version: VERSION_B, at: "stopping", budgetMs: 5 * 60_000 });
  check("2-killed-at-stopping", killed2.observed !== null && markAt(killed2.observed) <= markAt("backing_up"),
    killed2.observed === null
      ? `the update ended on its own before the kill: ${firstLines(killed2.update)}`
      : `the record stood at ${killed2.observed} when the apply unit was killed (exit ${killed2.update.code}: ${firstLines(killed2.update, 3)})`);
  if (failed) { journals("2-kill"); return finish(server); }

  const timers2 = run("systemctl", ["--user", "list-timers", "--all", "morndo-update-recover.timer", "--no-pager"]);
  const recoverFrom = Date.now();
  let recovered2 = false;
  for (;;) {
    const open = openRecord();
    const applying = existsSync(join(UPDATE_STATE, "applying"));
    const healthyA = SERVICE_UNITS.every(unitActive)
      && (await hubVersion()) === VERSION_A && (await fleetVersion()) === VERSION_A && nodeVersion() === VERSION_A;
    if (open === null && !applying && healthyA) { recovered2 = true; break; }
    if (Date.now() - recoverFrom > 8 * 60_000) break;
    await sleep(5000);
  }
  const elapsed2 = Math.round((Date.now() - recoverFrom) / 1000);
  const recoverUnit2 = run("systemctl", ["--user", "show", "morndo-update-recover.service", "--no-pager",
    "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp"]);
  writeFileSync(join(EVIDENCE, "2-recovery-timer.txt"), [
    `$ systemctl --user list-timers --all morndo-update-recover.timer\n${timers2.out}\n${timers2.err}\n`,
    `$ systemctl --user show morndo-update-recover.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp\n${recoverUnit2.out}\n`,
  ].join("\n"));
  const last2 = lastRecord();
  check("2-timer-recovered", recovered2 && elapsed2 <= 370 && last2?.target === VERSION_B && last2?.state === "abandoned",
    recovered2
      ? `the recovery timer put the machine back on ${VERSION_A} by itself in ${elapsed2}s; the record is ${last2?.state}; the recover unit: ${recoverUnit2.out.replace(/\n/g, "; ")}`
      : `the machine was not back on ${VERSION_A} after ${elapsed2}s with no recover typed by hand; the timer said: ${timers2.out.replace(/\n/g, " | ")}`);
  check("2-good-and-staged", linkName("good") === VERSION_A && linkName("current") === VERSION_A
    && sqlite(UPDATE_DB, `SELECT count(*) FROM versions WHERE version = '${VERSION_B}'`) === "1",
    `good=${linkName("good")} current=${linkName("current")}; ${VERSION_B} still staged`);
  if (failed) { journals("2-recovery"); return finish(server); }

  // ---- 3: two kills before the swap — `draining` (nothing has even stopped) and `backing_up` (stopped, the
  // databases being copied) — each answered this time by `update recover` typed by hand: the recovery unit's own
  // command, from good, exactly as the unit runs it (§6.6). Both must end as the recovery table says: the
  // attempt abandoned, the old Version running, the staged target untouched and applicable. A kill the poll
  // reached late (at `swapping` or beyond) has crossed the line the table draws differently, so there the only
  // honest check is the generic one — the machine whole on one Version, never a mix.
  for (const mark of ["draining", "backing_up"] as const) {
    const killed3 = await killAtMark({ label: `3-${mark}`, version: VERSION_B, at: mark, budgetMs: 5 * 60_000 });
    const atOrAfter = killed3.observed !== null && markAt(killed3.observed) > UPDATE_MARKS.indexOf(mark);
    check(`3-killed-at-${mark}`, killed3.observed !== null,
      killed3.observed === null
        ? `the update ended on its own before the kill: ${firstLines(killed3.update)}`
        : `the record stood at ${killed3.observed} when the apply unit was killed${atOrAfter ? " (the mark was already passed: killed at or after)" : ""} (exit ${killed3.update.code})`);
    if (failed) { journals(`3-${mark}`); return finish(server); }
    const recover3 = command(`3-recover-${mark}`, join(RELEASES, "good", "bin", "morndo-update"), ["update", "recover"], { timeoutMs: 10 * 60_000 });
    const whole3 = await machineWhole({ versionA: VERSION_A, versionV: VERSION_B });
    const last3 = lastRecord();
    const abandoned3 = last3?.target === VERSION_B && last3?.state === "abandoned";
    const staged3 = sqlite(UPDATE_DB, `SELECT count(*) FROM versions WHERE version = '${VERSION_B}'`) === "1";
    check(`3-recovered-${mark}`,
      whole3.ok && (atOrAfter || (whole3.where === VERSION_A && abandoned3 && staged3 && recover3.code === 0)),
      `recover: ${firstLines(recover3, 2)}; ${whole3.detail}; the record is ${last3?.state} at ${last3?.target ?? "?"}${staged3 ? "" : `; ${VERSION_B} no longer staged`}`);
    if (failed) { journals(`3-${mark}`); return finish(server); }
  }

  // ---- 4: the update to B, the additive release, through feed-2.
  pointFeedAt("feed-2");
  const toB = command("4-update", MORNDO, ["update", "--yes"], { timeoutMs: 15 * 60_000 });
  check("4-committed", toB.code === 0 && (toB.out + toB.err).includes(`Committed ${VERSION_B}.`),
    `update --yes exited ${toB.code}: ${firstLines(toB)}`);
  if (failed) { journals("4-update"); return finish(server); }

  const links4 = linkName("current") === VERSION_B && linkName("previous") === VERSION_A && linkName("good") === VERSION_B;
  check("4-links", links4, `current=${linkName("current")} previous=${linkName("previous")} good=${linkName("good")}`);
  await servicesAt("4-services-healthy", VERSION_B);
  const marker = sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_b_marker'");
  const schema = sqlite(HUB_DB, "PRAGMA user_version");
  check("4-migration-ran", marker === "1" && Number(schema) === schemaA + 1, `e2e_b_marker rows=${marker} user_version=${schema} (A's was ${schemaA})`);
  const status4 = command("4-status", MORNDO, ["update", "--status", "--json"]);
  const updates4 = JSON.parse(status4.out || "{}") as { updates?: { target?: string; state?: string }[] };
  const latest4 = updates4.updates?.[0];
  check("4-status-committed", latest4?.target === VERSION_B && latest4?.state === "committed",
    `--status --json's newest update: ${JSON.stringify(latest4)}`);
  check("4-clean", !existsSync(join(UPDATE_STATE, "applying")) && !existsSync(join(UPDATE_STATE, "hold.json")),
    "the applying marker and the hold are gone");
  if (failed) { journals("4-end"); return finish(server); }

  // ---- 5: the rollback to A. The typed word on stdin meets the shipped binary's own guard first — a program
  // wired without a terminal cannot ask in — and the rollback then goes through with its explicit --yes.
  const typedWord = command("5-ask-guard", MORNDO, ["update", "--rollback"], { input: "rollback\n", timeoutMs: 60_000 });
  check("5-ask-guard", typedWord.code === 64 && (typedWord.err + typedWord.out).includes("needs --yes, or a terminal to ask in"),
    `without --yes the shipped binary refuses the ask (exit ${typedWord.code}), the typed word on stdin cannot reach it`);
  const back = command("5-rollback", MORNDO, ["update", "--rollback", "--yes"], { timeoutMs: 15 * 60_000 });
  check("5-rolled-back", back.code === 1 && (back.out + back.err).includes(`Rolled back to ${VERSION_A}.`),
    `update --rollback --yes exited ${back.code}: ${firstLines(back)}`);
  if (failed) { journals("5-rollback"); return finish(server); }

  check("5-links", linkName("current") === VERSION_A, `current=${linkName("current")}`);
  await servicesAt("5-services-healthy", VERSION_A);
  const markerStays = sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_b_marker'");
  check("5-nothing-restored", markerStays === "1", `B's additive table is still there (rows=${markerStays}): nothing was restored`);
  if (failed) { journals("5-end"); return finish(server); }

  // ---- 6: the failed update to C, the breaking release whose hub will not come healthy, through feed-3. The
  // databases are dumped before, so the restore can be judged against the byte of what was there.
  pointFeedAt("feed-3");
  // What a restore must bring back (§11.4): the schema and the tables the hub had before C, without C's. Rows are not
  // compared: the restore renews the hub's store row (RL10), and A's services write again once they are back. The
  // dumps go into the evidence for a person to read.
  const tablesOf = (db: string) => sqlite(db, "SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name)");
  const hubBefore = { schema: sqlite(HUB_DB, "PRAGMA user_version"), tables: tablesOf(HUB_DB) };
  const fleetBefore = sqlite(FLEET_DB, "PRAGMA user_version");
  writeFileSync(join(EVIDENCE, "6-hub-before.sql"), sqlite(HUB_DB, ".dump"));
  const toC = command("6-update", MORNDO, ["update", "--yes"], { timeoutMs: 20 * 60_000 });
  check("6-rolled-back-from-c", toC.code === 1 && (toC.out + toC.err).includes(`Rolled back from ${VERSION_C}`),
    `update --yes exited ${toC.code}: ${firstLines(toC)}`);

  check("6-links", linkName("current") === VERSION_A, `current=${linkName("current")}`);
  await servicesAt("6-services-healthy", VERSION_A);
  writeFileSync(join(EVIDENCE, "6-hub-after.sql"), sqlite(HUB_DB, ".dump"));
  const hubAfter = { schema: sqlite(HUB_DB, "PRAGMA user_version"), tables: tablesOf(HUB_DB) };
  check("6-hub-restored", hubAfter.schema === hubBefore.schema && hubAfter.tables === hubBefore.tables && !hubAfter.tables.split(",").includes("e2e_c_marker"),
    `the hub is back at schema ${hubAfter.schema} (was ${hubBefore.schema}) with its tables as before C, e2e_c_marker gone`);
  const fleetAfter = sqlite(FLEET_DB, "PRAGMA user_version");
  const quicks6 = [quickCheck(HUB_DB), quickCheck(FLEET_DB), quickCheck(NODE_DB), quickCheck(UPDATE_DB)];
  check("6-quick-check", quicks6.every(q => q === "ok") && fleetAfter === fleetBefore,
    `quick_check on every database: ${quicks6.join(", ")}; the fleet's schema ${fleetAfter} (was ${fleetBefore}), not touched by C`);
  const bad6 = sqlite(UPDATE_DB, `SELECT count(*) FROM bad WHERE version = '${VERSION_C}'`);
  const halted6 = sqlite(UPDATE_DB, `SELECT count(*) FROM rollout_halts WHERE version = '${VERSION_C}'`);
  check("6-bad-and-halted", bad6 === "1" && halted6 === "1", `0.3.0 recorded bad (${bad6}) and its rollout halted (${halted6})`);
  const status6 = command("6-status", MORNDO, ["update", "--status", "--json"]);
  const updates6 = JSON.parse(status6.out || "{}") as { updates?: { target?: string; state?: string }[] };
  const latest6 = updates6.updates?.[0];
  check("6-status-rolled-back", latest6?.target === VERSION_C && latest6?.state === "rolled_back",
    `--status --json's newest update: ${JSON.stringify(latest6)}`);
  if (failed) { journals("6-end"); return finish(server); }

  // ---- 7: the failed migration (§13): 0.3.1 carries a hub migration whose `up` throws. The runner wraps every
  // migration in one transaction, so the database keeps exactly what it had; the hub leaves at once on the
  // refused start and keeps leaving (systemd restarts it every 5 s), the apply's health walk fails at its wall,
  // and the rollback needs no restore — the migration moved nothing. update --yes must answer 1, rolled back.
  pointFeedAt("feed-4");
  const hubDump7 = sqlite(HUB_DB, ".dump");
  writeFileSync(join(EVIDENCE, "7-hub-before.sql"), hubDump7);
  const to31 = command("7-update", MORNDO, ["update", "--yes"], { timeoutMs: 20 * 60_000 });
  check("7-rolled-back-from-31", to31.code === 1 && (to31.out + to31.err).includes(`Rolled back from ${VERSION_D}`),
    `update --yes exited ${to31.code}: ${firstLines(to31)}`);
  const hubDump7After = sqlite(HUB_DB, ".dump");
  writeFileSync(join(EVIDENCE, "7-hub-after.sql"), hubDump7After);
  check("7-hub-unchanged", hubDump7After === hubDump7,
    "the hub database's .dump is the same as before: the throwing migration ran inside its one transaction and moved nothing");
  check("7-links", linkName("current") === VERSION_A && !existsSync(join(UPDATE_STATE, "applying")), `current=${linkName("current")}`);
  await servicesAt("7-services-healthy", VERSION_A);
  const quicks7 = [quickCheck(HUB_DB), quickCheck(FLEET_DB), quickCheck(NODE_DB), quickCheck(UPDATE_DB)];
  const bad7 = sqlite(UPDATE_DB, `SELECT count(*) FROM bad WHERE version = '${VERSION_D}'`);
  check("7-bad-and-sound", quicks7.every(q => q === "ok") && bad7 === "1",
    `quick_check: ${quicks7.join(", ")}; ${VERSION_D} recorded bad (${bad7})`);
  journals("7-failed-migration");   // the hub's own crash word under 0.3.1 — the run's evidence, kept also when the step passes
  if (failed) return finish(server);

  // ---- 8: revocations kept across a restore (§11.5, §13): 0.3.2 breaks the hub schema (C's breaking
  // migration), so its rollback restores the hub database — the exact case the revocation journals exist for.
  // Before the update: a second agent token and a second node, enrolled from a HOME of its own and never run.
  // While 0.3.2 stands in probation — its hub up and healthy, the hold on — both revocations are typed; the
  // restore must not bring either back.
  const made8 = command("8-agent-token-new", MORNDO, ["agent-token", "new", "the second token", "--role", "manager"]);
  const tokenId8 = made8.out.match(/Token ([0-9a-f-]{36}) \(/)?.[1] ?? "";
  check("8-token-made", made8.code === 0 && tokenId8 !== "", `agent-token new: ${firstLines(made8, 2)}`);
  const HOME2 = join(HOME, "e2e-home2");
  mkdirSync(HOME2, { recursive: true });
  const added8 = command("8-node-add", MORNDO_FLEET, ["node", "add", NODE2_NAME]);
  const joinLine8 = added8.out.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  const joined8 = joinLine8 === "" ? { code: 1, out: "", err: `no join string in: ${added8.out}` }
    : command("8-node-join", MORNDO_NODE, ["join", joinLine8], { timeoutMs: 60_000, env: { ...ENV, HOME: HOME2 } });
  check("8-node-2-joined", joined8.code === 0 && joined8.out.includes("Joined the fleet"), `the second node joins from ${HOME2}: ${firstLines(joined8, 2)}`);
  if (failed) { journals("8-setup"); return finish(server); }

  pointFeedAt("feed-5");
  const schema8 = sqlite(HUB_DB, "PRAGMA user_version");
  const store8 = sqlite(HUB_DB, "SELECT store FROM hub_store WHERE id = 1");
  const update8 = startUpdate("8-update");
  // The revocations land while 0.3.2 is in probation: its hub answers health at its own version, healthy, with
  // the hold on — a window of ~15 s before the planted exit takes the hub down.
  const inProbation = await waitUntil("0.3.2 healthy", 3 * 60_000, async () => (await hubVersion()) === VERSION_E ? "" : null);
  const tokenRevoked8 = command("8-agent-token-revoke", MORNDO, ["agent-token", "revoke", tokenId8]);
  const nodeRevoked8 = command("8-node-revoke", MORNDO_FLEET, ["node", "revoke", NODE2_NAME]);
  const done8 = await update8.wait(inProbation === null ? "the 0.3.2 hub never answered healthy in time\n" : "");
  check("8-rolled-back-from-32", inProbation !== null && done8.code === 1 && (done8.out + done8.err).includes(`Rolled back from ${VERSION_E}`),
    inProbation === null
      ? `the 0.3.2 hub never answered healthy, so the revocations were typed outside probation (token exit ${tokenRevoked8.code}, node exit ${nodeRevoked8.code})`
      : `update --yes exited ${done8.code}: ${firstLines(done8)}`);
  if (failed) { journals("8-update"); return finish(server); }

  await servicesAt("8-services-healthy", VERSION_A);
  const nodes8 = command("8-node-list", MORNDO_FLEET, ["node", "list"]);
  const tokens8 = command("8-token-list", MORNDO, ["agent-token", "list"]);
  const node2Revoked = nodes8.out.split("\n").some(l => l.includes(NODE2_NAME) && l.includes("REVOKED"));
  const tokenRevoked = tokens8.out.split("\n").some(l => l.startsWith(tokenId8) && l.includes("REVOKED"));
  check("8-revocations-kept", node2Revoked && tokenRevoked,
    `after the restore: node list says ${node2Revoked ? "revoked" : "NOT revoked"}, token list says ${tokenRevoked ? "revoked" : "NOT revoked"}`);
  // The restore really happened: the schema went back, the breaking marker is gone, and the hub's store row is a
  // new one (RL10) — and the record says the hub backup was taken.
  const restored8 = sqlite(HUB_DB, "PRAGMA user_version") === schema8
    && sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_c_marker'") === "0"
    && sqlite(HUB_DB, "SELECT store FROM hub_store WHERE id = 1") !== store8;
  const last8 = lastRecord();
  check("8-hub-was-restored", restored8 && last8?.target === VERSION_E && last8?.state === "rolled_back" && last8.hubBackupDone,
    `schema back at ${sqlite(HUB_DB, "PRAGMA user_version")}, e2e_c_marker gone, the store row renewed; the record is ${last8?.state} at ${last8?.target ?? "?"}, its hub backup done=${last8?.hubBackupDone}`);
  if (failed) { journals("8-end"); return finish(server); }

  // ---- 9: a full disk under the Backup (§13): the container carries a 64k tmpfs at /mnt/tiny — its own memory,
  // not a host mount. The backups directory is moved aside and replaced by a link to it, so the hub's copy
  // cannot fit (a fresh hub database is a few hundred 4k pages, far past 64k). The apply must abandon before the
  // swap — nothing stopped stays stopped — and 0.4.0 stays staged for a later, roomier day. The real directory
  // goes back the moment the command has answered. `update --yes` speaks in the record's word (75, "did not
  // finish (abandoned)"); the apply unit's own reason — Not applied: hub: … — is its apply-result.json.
  pointFeedAt("feed-6");
  check("9-tiny-mounted", existsSync("/mnt/tiny"), "/mnt/tiny is the container's 64k tmpfs (docker run gave it)");
  const BACKUPS = join(UPDATE_STATE, "backups");
  const ASIDE = join(UPDATE_STATE, "backups.aside");
  renameSync(BACKUPS, ASIDE);
  symlinkSync("/mnt/tiny", BACKUPS);
  const to40 = command("9-update", MORNDO, ["update", "--yes"], { timeoutMs: 15 * 60_000 });
  rmSync(BACKUPS);                            // the link only; whatever the failed copy left stays in the tmpfs
  renameSync(ASIDE, BACKUPS);
  let unitLines9: string[] = ["(no apply-result.json: the unit never answered)"];
  try {
    const applyResult9 = readFileSync(join(UPDATE_STATE, "apply-result.json"), "utf8");
    writeFileSync(join(EVIDENCE, "9-apply-result.json"), applyResult9);
    unitLines9 = ((JSON.parse(applyResult9) as { lines?: unknown }).lines ?? []) as string[];
  } catch { /* the check below says it in its own words */ }
  const last9 = lastRecord();
  check("9-not-applied", to40.code === 75 && (to40.out + to40.err).includes("The apply did not finish (abandoned)")
    && unitLines9.some(l => l.includes("Not applied: hub:"))
    && last9?.target === VERSION_F && last9.state === "abandoned"
    && linkName("current") === VERSION_A && !existsSync(join(UPDATE_STATE, "applying")),
    `update --yes exited ${to40.code}: ${firstLines(to40, 3)}; the apply unit said: ${unitLines9.join(" | ")}`);
  await servicesAt("9-services-healthy", VERSION_A);
  check("9-still-staged", sqlite(UPDATE_DB, `SELECT count(*) FROM versions WHERE version = '${VERSION_F}'`) === "1",
    `${VERSION_F} is still staged, applicable when the disk has room`);
  if (failed) { journals("9-full-disk"); return finish(server); }

  // ---- 10: the kill after the swap (§13): 0.4.0 still staged, killed at `starting` — the services coming up on
  // the target, the commit not made. `update recover` must land the machine whole on one side: 0.4.0 committed,
  // or back on A — never a mix.
  const killed10 = await killAtMark({ label: "10-starting", version: VERSION_F, at: "starting", budgetMs: 8 * 60_000 });
  check("10-killed-at-starting", killed10.observed === "starting",
    killed10.observed === null
      ? `the update ended on its own before the kill: ${firstLines(killed10.update)}`
      : `the record stood at ${killed10.observed} when the apply unit was killed (exit ${killed10.update.code})`);
  if (failed) { journals("10-kill"); return finish(server); }
  const recover10 = command("10-recover", join(RELEASES, "good", "bin", "morndo-update"), ["update", "recover"], { timeoutMs: 15 * 60_000 });
  const whole10 = await machineWhole({ versionA: VERSION_A, versionV: VERSION_F });
  const last10 = lastRecord();
  const committed10 = whole10.where === VERSION_F;
  check("10-machine-whole", whole10.ok && (!committed10 || (recover10.code === 0 && last10?.target === VERSION_F && last10?.state === "committed")),
    `recover: ${firstLines(recover10, 2)}; ${whole10.detail}; the record is ${last10?.state} at ${last10?.target ?? "?"}`);
  if (whole10.ok && committed10) {
    const markerF = sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_d_marker'");
    check("10-migration-ran", markerF === "1", `0.4.0's second marker table is there (rows=${markerF})`);
  }
  if (failed) { journals("10-recover"); return finish(server); }

  // ---- 11: nothing left behind. The kills of steps 2, 3 and 10 leave their apply units in systemd's failed
  // state — the crash's own residue, an operator's reset-failed clears it — so that word is typed first, and
  // what the check then demands is the machine's own cleanliness: no apply unit active or failed, no applying
  // marker, no hold.
  run("systemctl", ["--user", "reset-failed", "morndo-update-apply@*"]);
  const applyUnits = run("systemctl", ["--user", "list-units", "morndo-update-apply@*", "--all", "--no-legend", "--plain"]);
  const leftBehind = applyUnits.out.split("\n").filter(l => l !== "" && /\b(active|failed)\b/.test(l));
  check("11-no-apply-units", leftBehind.length === 0, leftBehind.length === 0 ? "no apply unit is active or failed" : leftBehind.join("; "));
  check("11-applying-gone", !existsSync(join(UPDATE_STATE, "applying")) && !existsSync(join(UPDATE_STATE, "hold.json")),
    "the applying marker and the hold are gone");
  if (failed) journals("11-end");

  return finish(server);
}

// One HTTPS status answer with Node's own certificate checks against the test CA — the same trust the updater
// itself will walk with (NODE_EXTRA_CA_CERTS joins the CA to Node's roots, it does not replace them).
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

function finish(server: FeedHost): number {
  const status = command("final-status", MORNDO, ["update", "--status"]);
  writeFileSync(join(EVIDENCE, "status.txt"), `morndo update --status:\n${status.out}\n${status.err}\n`);
  server.close();
  const passed = checks.filter(c => c.ok).length;
  process.stdout.write(`${JSON.stringify({ step: "summary", ok: passed === checks.length, detail: `${passed}/${checks.length} checks passed` })}\n`);
  return passed === checks.length ? 0 : 1;
}

process.exit(await main());
