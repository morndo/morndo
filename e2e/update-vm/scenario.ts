// The machine side of the throwaway-machine run (design §13, e2e/update.e2e.ts): this runs INSIDE the container
// as the worker user, under the unpacked A tree's own Node (e2e/update.e2e.ts names it on its command line). It
// serves the feed over HTTPS on the container's own 127.0.0.1 — the port is baked into the signed documents by
// e2e/update-vm/build.ts, and the two must agree — through a directory link it repoints at feed-1, feed-2 and
// feed-3, so the machine's MORNDO_UPDATE_FEED never changes while the story moves on.
//
// Every check prints one JSON line on stdout — {"step": "...", "ok": true|false, "detail": ...} — and the host
// side reads exactly those. A failed check writes the units' journals into the evidence directory and the run
// goes on to cleanup: the machine is throwaway, but nothing of it is left running or half-applied.
//
// Constants that mirror product code (named here so this file stands alone in the container): the unit mark is
// apps/updater/src/adapters/services-systemd.ts's UNIT_MARK; the paths are design §5's.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const HUB_DB = join(HOME, ".local/share/morndo/morndo.db");
const FLEET_DB = join(HOME, ".local/share/morndo-fleet/fleet.db");
const NODE_DB = join(HOME, ".local/state/morndo-node/agent.db");
const UNIT_DIR = join(HOME, ".config/systemd/user");
// services-systemd.ts's UNIT_MARK: the first line of every unit file a render writes.
const UNIT_MARK = "# Morndo's own unit: every update rewrites it. Put changes in a drop-in (<unit>.d/*.conf).";
const VERSION_A = "0.1.0";
const VERSION_B = "0.2.0";
const VERSION_C = "0.3.0";
const NODE_NAME = "e2e-node";

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

// One command, one argument list, no shell. `input` feeds stdin (the typed word a terminal would answer with).
function run(file: string, args: string[], o: { timeoutMs?: number; input?: string } = {}):
  { code: number; out: string; err: string } {
  const done = spawnSync(file, args, { encoding: "utf8", env: ENV, input: o.input, timeout: o.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
  return { code: done.status ?? -1, out: done.stdout ?? "", err: done.stderr ?? "" };
}

// A principal command of the story: run(), and keep its whole word in the evidence directory whatever happened —
// the host copies the evidence out, so a failure's full story (Node's stack and all) leaves the machine with it.
function command(label: string, file: string, args: string[], o: { timeoutMs?: number; input?: string } = {}):
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
  const units = await waitUnits(["morndo-hub.service", "morndo-fleet.service", "morndo-node.service"], 90_000);
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

function pointFeedAt(which: "feed-1" | "feed-2" | "feed-3"): void {
  rmSync(FEED_LINK, { force: true });
  symlinkSync(join(FEEDS, which), FEED_LINK);
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

  // ---- 2: the update to B, the additive release, through feed-2.
  pointFeedAt("feed-2");
  const toB = command("2-update", MORNDO, ["update", "--yes"], { timeoutMs: 15 * 60_000 });
  check("2-committed", toB.code === 0 && (toB.out + toB.err).includes(`Committed ${VERSION_B}.`),
    `update --yes exited ${toB.code}: ${firstLines(toB)}`);
  if (failed) { journals("2-update"); return finish(server); }

  const links2 = linkName("current") === VERSION_B && linkName("previous") === VERSION_A && linkName("good") === VERSION_B;
  check("2-links", links2, `current=${linkName("current")} previous=${linkName("previous")} good=${linkName("good")}`);
  await servicesAt("2-services-healthy", VERSION_B);
  const marker = sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_b_marker'");
  const schema = sqlite(HUB_DB, "PRAGMA user_version");
  check("2-migration-ran", marker === "1" && Number(schema) === schemaA + 1, `e2e_b_marker rows=${marker} user_version=${schema} (A's was ${schemaA})`);
  const status2 = command("2-status", MORNDO, ["update", "--status", "--json"]);
  const updates2 = JSON.parse(status2.out || "{}") as { updates?: { target?: string; state?: string }[] };
  const latest2 = updates2.updates?.[0];
  check("2-status-committed", latest2?.target === VERSION_B && latest2?.state === "committed",
    `--status --json's newest update: ${JSON.stringify(latest2)}`);
  check("2-clean", !existsSync(join(UPDATE_STATE, "applying")) && !existsSync(join(UPDATE_STATE, "hold.json")),
    "the applying marker and the hold are gone");
  if (failed) { journals("2-end"); return finish(server); }

  // ---- 3: the rollback to A. The typed word on stdin meets the shipped binary's own guard first — a program
  // wired without a terminal cannot ask in — and the rollback then goes through with its explicit --yes.
  const typedWord = command("3-ask-guard", MORNDO, ["update", "--rollback"], { input: "rollback\n", timeoutMs: 60_000 });
  check("3-ask-guard", typedWord.code === 64 && (typedWord.err + typedWord.out).includes("needs --yes, or a terminal to ask in"),
    `without --yes the shipped binary refuses the ask (exit ${typedWord.code}), the typed word on stdin cannot reach it`);
  const back = command("3-rollback", MORNDO, ["update", "--rollback", "--yes"], { timeoutMs: 15 * 60_000 });
  check("3-rolled-back", back.code === 1 && (back.out + back.err).includes(`Rolled back to ${VERSION_A}.`),
    `update --rollback --yes exited ${back.code}: ${firstLines(back)}`);
  if (failed) { journals("3-rollback"); return finish(server); }

  check("3-links", linkName("current") === VERSION_A, `current=${linkName("current")}`);
  await servicesAt("3-services-healthy", VERSION_A);
  const markerStays = sqlite(HUB_DB, "SELECT count(*) FROM sqlite_master WHERE name = 'e2e_b_marker'");
  check("3-nothing-restored", markerStays === "1", `B's additive table is still there (rows=${markerStays}): nothing was restored`);
  if (failed) { journals("3-end"); return finish(server); }

  // ---- 4: the failed update to C, the breaking release whose hub will not come healthy, through feed-3. The
  // databases are dumped before, so the restore can be judged against the byte of what was there.
  pointFeedAt("feed-3");
  // What a restore must bring back (§11.4): the schema and the tables the hub had before C, without C's. Rows are not
  // compared: the restore renews the hub's store row (RL10), and A's services write again once they are back. The
  // dumps go into the evidence for a person to read.
  const tablesOf = (db: string) => sqlite(db, "SELECT group_concat(name, ',') FROM (SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name)");
  const hubBefore = { schema: sqlite(HUB_DB, "PRAGMA user_version"), tables: tablesOf(HUB_DB) };
  const fleetBefore = sqlite(FLEET_DB, "PRAGMA user_version");
  writeFileSync(join(EVIDENCE, "4-hub-before.sql"), sqlite(HUB_DB, ".dump"));
  const toC = command("4-update", MORNDO, ["update", "--yes"], { timeoutMs: 20 * 60_000 });
  check("4-rolled-back-from-c", toC.code === 1 && (toC.out + toC.err).includes(`Rolled back from ${VERSION_C}`),
    `update --yes exited ${toC.code}: ${firstLines(toC)}`);

  check("4-links", linkName("current") === VERSION_A, `current=${linkName("current")}`);
  await servicesAt("4-services-healthy", VERSION_A);
  writeFileSync(join(EVIDENCE, "4-hub-after.sql"), sqlite(HUB_DB, ".dump"));
  const hubAfter = { schema: sqlite(HUB_DB, "PRAGMA user_version"), tables: tablesOf(HUB_DB) };
  check("4-hub-restored", hubAfter.schema === hubBefore.schema && hubAfter.tables === hubBefore.tables && !hubAfter.tables.split(",").includes("e2e_c_marker"),
    `the hub is back at schema ${hubAfter.schema} (was ${hubBefore.schema}) with its tables as before C, e2e_c_marker gone`);
  const fleetAfter = sqlite(FLEET_DB, "PRAGMA user_version");
  const quick = (db: string) => sqlite(db, "PRAGMA quick_check");
  const quicks = [quick(HUB_DB), quick(FLEET_DB), quick(NODE_DB), quick(join(UPDATE_STATE, "update.db"))];
  check("4-quick-check", quicks.every(q => q === "ok") && fleetAfter === fleetBefore,
    `quick_check on every database: ${quicks.join(", ")}; the fleet's schema ${fleetAfter} (was ${fleetBefore}), not touched by C`);
  const bad = sqlite(join(UPDATE_STATE, "update.db"), `SELECT count(*) FROM bad WHERE version = '${VERSION_C}'`);
  const halted = sqlite(join(UPDATE_STATE, "update.db"), `SELECT count(*) FROM rollout_halts WHERE version = '${VERSION_C}'`);
  check("4-bad-and-halted", bad === "1" && halted === "1", `0.3.0 recorded bad (${bad}) and its rollout halted (${halted})`);
  const status4 = command("4-status", MORNDO, ["update", "--status", "--json"]);
  const updates4 = JSON.parse(status4.out || "{}") as { updates?: { target?: string; state?: string }[] };
  const latest4 = updates4.updates?.[0];
  check("4-status-rolled-back", latest4?.target === VERSION_C && latest4?.state === "rolled_back",
    `--status --json's newest update: ${JSON.stringify(latest4)}`);
  if (failed) { journals("4-end"); return finish(server); }

  // ---- 5: nothing left behind — no apply unit failed or still active, no applying marker.
  const applyUnits = run("systemctl", ["--user", "list-units", "morndo-update-apply@*", "--all", "--no-legend", "--plain"]);
  const leftBehind = applyUnits.out.split("\n").filter(l => l !== "" && /\b(active|failed)\b/.test(l));
  check("5-no-apply-units", leftBehind.length === 0, leftBehind.length === 0 ? "no apply unit is active or failed" : leftBehind.join("; "));
  check("5-applying-gone", !existsSync(join(UPDATE_STATE, "applying")), "the applying marker is gone");
  if (failed) journals("5-end");

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
