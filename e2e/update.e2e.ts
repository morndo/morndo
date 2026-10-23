// The end-to-end run on a throwaway machine (design §13, e2e/update-vm/): a whole systemd in a Docker container,
// Morndo installed into it as install.sh would, then the whole update story — one update that commits, one
// rollback, one update that fails health and rolls the machine back, the first update killed mid-walk for the
// recovery timer to finish alone, kills before and after the swap answered by `update recover`, a migration that
// throws, a Version that dies in probation with revocations typed across its restore, and a full disk under the
// Backup — every step a JSON check line from the scenario inside the machine (e2e/update-vm/scenario.ts). The
// host side builds the six Releases (e2e/update-vm/build.ts), builds the machine, copies the bundle in, runs the
// scenario under the unpacked A tree's own Node, and copies the evidence out. Nothing of this run touches the
// host's own Morndo, and nothing is left behind: the container is removed in the finally block and the run
// asserts no container with its label remains.
//
// The rules the run holds itself to (PR 5d): every container and image carries the label morndo-c2-e2e; no host
// mounts, no host network, no published ports — files move by docker cp only; no other container, image or
// volume is ever named. The container is not --privileged (that gives every host device and capability): it gets
// what systemd as PID 1 needs and nothing more (systemd.io/CONTAINER_INTERFACE, read 2026-10-22) — CAP_SYS_ADMIN
// (Docker's defaults already hold CAP_MKNOD), no audit capability (CAP_AUDIT_WRITE dropped, so systemd does not
// try to audit), a private cgroup namespace whose tree the entrypoint remounts writable before it execs
// /sbin/init (Docker mounts it read-only without --privileged), and tmpfs for /run, /run/lock and /tmp. /dev is
// Docker's own container /dev: no host device. A host whose AppArmor profile forbids the remount refuses here:
// systemd says so in the boot wait. The container is removed on every way out — the end of the run, an error,
// SIGINT or SIGTERM — and each run first removes what a killed run left behind: only a gone run's, by the owner
// label (pid and start time) each container carries, so two runs on one box leave each other alone. The one
// extra mount the full-disk step needs is a tmpfs of the container's own memory
// (/mnt/tiny, 64k), not a host mount. A hard power loss is not tested here (docker kill is not one); that stays
// manual QA.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "./update-vm/build.ts";
import { OWNER_LABEL, ownerOf, ownerText, sweepContainers, sweepScratch } from "./update-vm/checks.ts";

const ROOT = join(import.meta.dirname, "..");
const IMAGE = "morndo-c2-e2e:local";
const LABEL = "morndo-c2-e2e";
const CONTAINER = `morndo-c2-e2e-${randomBytes(4).toString("hex")}`;
const OWNER = ownerText(ownerOf(process.pid));                    // this run, as its container's label names it

function docker(args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const done = spawnSync("docker", args, { encoding: "utf8", timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: done.status ?? -1, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
}

// The one long call (the scenario, up to 50 minutes) runs without blocking, so a signal's cleanup can run during it.
let running: ChildProcess | null = null;
function dockerAsync(args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    running = child;
    let out = "", err = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", code => { clearTimeout(timer); running = null; resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }); });
  });
}

function refuse(reason: string): never {
  process.stderr.write(`e2e:update refuses to run: ${reason}\n`);
  process.exit(2);
}

// The evidence directory (e2e/harness.ts's own rule): a run's output is kept, never thrown away with the tmp.
const outDir = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-update-e2e-out-"));
mkdirSync(outDir, { recursive: true });

if (process.platform !== "linux" || process.arch !== "x64") {
  refuse(`the throwaway machine is linux-x64; this host is ${process.platform}-${process.arch}`);
}
const dockerAnswers = docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
if (dockerAnswers.code !== 0) refuse(`docker does not answer (${dockerAnswers.err || "no server"}); this run needs it`);

const started = Date.now();
let scratch: string | null = null;
let containerStarted = false;

// What every way out does: this run's container goes, its scratch with it (unless E2E_KEEP=1).
function cleanUp(): void {
  if (containerStarted) {
    const removed = docker(["rm", "-f", CONTAINER], { timeoutMs: 120_000 });
    if (removed.code !== 0) {
      process.stderr.write(`removing ${CONTAINER} failed: ${removed.err}\n`);
      process.exitCode = 1;
    }
    containerStarted = false;
  }
  if (scratch !== null && process.env.E2E_KEEP !== "1") { rmSync(scratch, { recursive: true, force: true }); scratch = null; }
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    process.stderr.write(`\n${signal}: removing the machine and the scratch\n`);
    running?.kill("SIGKILL");
    cleanUp();
    process.exit(code);
  });
}

// A run killed outright (SIGKILL, a lost terminal) cannot clean up after itself: what it left (its container,
// its build scratch) is removed here — only a gone run's, by the owner each carries; a run going on now on this
// box keeps its own (checks.ts).
sweepContainers({
  list: () => docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.ID}} {{.Label "${OWNER_LABEL}"}}`]).out
    .split("\n").filter(l => l.trim() !== "").map(l => { const [id = "", owner = ""] = l.trim().split(" "); return { id, owner }; }),
  remove: id => { const r = docker(["rm", "-f", id], { timeoutMs: 120_000 }); return { ok: r.code === 0, err: r.err }; },
  say: line => process.stdout.write(`${line}\n`),
});
sweepScratch(tmpdir(), { keep: process.env.E2E_KEEP === "1", say: line => process.stdout.write(`${line}\n`) });

try {
  // ---- the six Releases, signed, and the six publish points (build.ts does it the pipeline's way).
  process.stdout.write(`building the six releases (this takes a few minutes)…\n`);
  const world = buildWorld(ROOT);
  scratch = world.scratch;

  // The A tree unpacked on the host (install.sh's own extraction): the scenario runs under this tree's Node, so
  // it must exist before anything starts inside the machine. bin/ is chmod 0555 as install.sh does.
  const treeA = join(world.bundle, "tree-a");
  mkdirSync(treeA, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", world.archiveA, "-C", treeA], { encoding: "utf8", timeout: 300_000 });
  if (extract.status !== 0) throw new Error(`unpacking the A archive failed: ${extract.stderr}`);
  if (!existsSync(join(treeA, "node/bin/node"))) throw new Error("the A tree ships no node/bin/node");
  const scenario = join(ROOT, "e2e/update-vm/scenario.ts");
  if (!existsSync(scenario)) throw new Error("e2e/update-vm/scenario.ts is not where this run expects it");
  copyFileSync(scenario, join(world.bundle, "scenario.ts"));
  copyFileSync(join(ROOT, "e2e/update-vm/feed-server.ts"), join(world.bundle, "feed-server.ts"));   // its feed host
  copyFileSync(join(ROOT, "e2e/update-vm/checks.ts"), join(world.bundle, "checks.ts"));             // its judgements

  // ---- the machine itself, and the bundle into it.
  process.stdout.write(`building the machine…\n`);
  const built = docker(["build", "-t", IMAGE, "--label", `${LABEL}=1`, join(ROOT, "e2e/update-vm")], { timeoutMs: 600_000 });
  if (built.code !== 0) throw new Error(`docker build failed: ${built.err}`);

  // /mnt/tiny is the full-disk step's own little disk: 64k of the container's memory, owned by the worker, so
  // the Backup that lands on it cannot fit. A tmpfs is not a host mount (nothing of the host is in it).
  const startedRun = docker([
    "run", "-d", "--name", CONTAINER, "--label", `${LABEL}=1`, "--label", `${OWNER_LABEL}=${OWNER}`,
    "--cap-add", "SYS_ADMIN", "--cap-drop", "AUDIT_WRITE", "--cgroupns=private",
    "-e", "container=docker", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp",
    "--tmpfs", "/mnt/tiny:size=64k,uid=1000,gid=1000,mode=0700", IMAGE,
  ]);
  if (startedRun.code !== 0) throw new Error(`docker run failed: ${startedRun.err}`);
  containerStarted = true;
  process.stdout.write(`machine ${CONTAINER} up; waiting for systemd…\n`);

  // systemd's own word for itself: "running" or "degraded" (a failed unit of ours would degrade it — the
  // scenario's checks say which); "starting" keeps us waiting.
  const bootDeadline = Date.now() + 180_000;
  for (;;) {
    // A container that stopped is a machine that will never boot: its entrypoint's own words say why (the e2e-init
    // remount, refused by a host's security profile, exits 77) — read at once, not after the wall below.
    const alive = docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", CONTAINER]);
    if (alive.out.startsWith("false")) {
      const said = docker(["logs", CONTAINER]);
      throw new Error(`the machine stopped before systemd came up (exit ${alive.out.split(" ")[1]}): ${(said.out + said.err).trim().split("\n").slice(-3).join(" | ")}`);
    }
    const state = docker(["exec", CONTAINER, "systemctl", "is-system-running"]);
    if (state.out === "running" || state.out === "degraded") break;
    if (Date.now() > bootDeadline) throw new Error(`systemd never came up (${state.out || state.err})`);
    await sleep(2_000);
  }
  // The worker's own manager (linger starts it): the updater's every door goes through it.
  const userDeadline = Date.now() + 60_000;
  for (;;) {
    const env = docker(["exec", "-u", "worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
      "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", CONTAINER, "systemctl", "--user", "show-environment"]);
    if (env.code === 0) break;
    if (Date.now() > userDeadline) throw new Error(`the worker's user manager never answered (${env.err})`);
    await sleep(2_000);
  }

  const into = docker(["exec", CONTAINER, "mkdir", "-p", "/srv/worker/e2e"]);
  if (into.code !== 0) throw new Error(`mkdir inside the machine failed: ${into.err}`);
  const copied = docker(["cp", `${world.bundle}/.`, `${CONTAINER}:/srv/worker/e2e`], { timeoutMs: 600_000 });
  if (copied.code !== 0) throw new Error(`docker cp of the bundle failed: ${copied.err}`);
  const owned = docker(["exec", CONTAINER, "chown", "-R", "worker:worker", "/srv/worker/e2e"], { timeoutMs: 300_000 });
  if (owned.code !== 0) throw new Error(`chown of the bundle failed: ${owned.err}`);

  // ---- the scenario, inside the machine, under the unpacked A tree's own Node. The story waits minutes on the
  // recovery timer alone, so the wall is the story's own: 50 minutes.
  process.stdout.write(`running the scenario inside the machine (a good half hour)…\n`);
  const scenarioRun = await dockerAsync([
    "exec", "-u", "worker:1000",
    "-e", "HOME=/srv/worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
    "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
    CONTAINER, "/srv/worker/e2e/tree-a/node/bin/node", "/srv/worker/e2e/scenario.ts",
  ], 50 * 60_000);
  process.stdout.write(`${scenarioRun.out}\n`);
  if (scenarioRun.err !== "") process.stderr.write(`${scenarioRun.err}\n`);
  mkdirSync(join(outDir, "evidence"), { recursive: true });
  const summaryLine = scenarioRun.out.split("\n").filter(l => l.trim().startsWith("{")).at(-1) ?? "{}";
  let summary: { step?: string; ok?: boolean; detail?: string } = {};
  try { summary = JSON.parse(summaryLine) as typeof summary; } catch { /* no summary line: every check is unknown */ }
  const allLines = scenarioRun.out.split("\n").filter(l => l.trim().startsWith("{"));
  const checkLines = allLines.filter(l => { try { return (JSON.parse(l) as { step?: string }).step !== "summary"; } catch { return false; } });
  const failed = checkLines.filter(l => { try { return !(JSON.parse(l) as { ok?: boolean }).ok; } catch { return true; } });
  process.stdout.write(`\n${summary.detail ?? `${checkLines.length} checks, ${failed.length} failed`}\n`);
  for (const line of failed) process.stdout.write(`FAILED  ${line}\n`);

  // The evidence out, whatever happened: journals, the feed's access log, the machine's own status.
  docker(["cp", `${CONTAINER}:/srv/worker/e2e/evidence/.`, join(outDir, "evidence")]);
  const exitOk = scenarioRun.code === 0 && summary.ok === true;
  process.stdout.write(`${exitOk ? "PASSED" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)}s; evidence in ${outDir}\n`);
  process.exitCode = exitOk ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  // The machine is throwaway: it goes, and the run proves it went. The image stays (it is this run's own, and a
  // rebuild costs minutes); only containers with the label are named, only this run's own container is removed.
  cleanUp();
  // This run's own: another run going on now on this box keeps its container until its own end.
  const left = docker(["ps", "-a", "--filter", `label=${OWNER_LABEL}=${OWNER}`, "-q"]);
  if (left.out !== "") {
    process.stderr.write(`this run's containers remain: ${left.out.split("\n").join(", ")}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(`run took ${Math.round((Date.now() - started) / 1000)}s\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
