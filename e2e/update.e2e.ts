// The end-to-end run on a throwaway machine (design §13, e2e/update-vm/): a whole systemd in a Docker container,
// Morndo installed into it as install.sh would, then one update that commits, one rollback, one update that
// fails health and rolls the machine back — every step a JSON check line from the scenario inside the machine
// (e2e/update-vm/scenario.ts). The host side builds the three Releases (e2e/update-vm/build.ts), builds the
// machine, copies the bundle in, runs the scenario under the unpacked A tree's own Node, and copies the
// evidence out. Nothing of this run touches the host's own Morndo, and nothing is left behind: the container is
// removed in the finally block and the run asserts no container with its label remains.
//
// The rules the run holds itself to (PR 5d): every container and image carries the label morndo-c2-e2e; no host
// mounts, no host network, no published ports — files move by docker cp only; no other container, image or
// volume is ever named. A hard power loss is not tested here (docker kill is not one); that stays manual QA.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "./update-vm/build.ts";

const ROOT = join(import.meta.dirname, "..");
const IMAGE = "morndo-c2-e2e:local";
const LABEL = "morndo-c2-e2e";
const CONTAINER = `morndo-c2-e2e-${randomBytes(4).toString("hex")}`;

function docker(args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const done = spawnSync("docker", args, { encoding: "utf8", timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: done.status ?? -1, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
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
try {
  // ---- the three Releases, signed, and the three publish points (build.ts does it the pipeline's way).
  process.stdout.write(`building the three releases (this takes a few minutes)…\n`);
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

  // ---- the machine itself, and the bundle into it.
  process.stdout.write(`building the machine…\n`);
  const built = docker(["build", "-t", IMAGE, "--label", `${LABEL}=1`, join(ROOT, "e2e/update-vm")], { timeoutMs: 600_000 });
  if (built.code !== 0) throw new Error(`docker build failed: ${built.err}`);

  const startedRun = docker([
    "run", "-d", "--name", CONTAINER, "--label", `${LABEL}=1`, "--privileged", "--cgroupns=private",
    "-e", "container=docker", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp", IMAGE,
  ]);
  if (startedRun.code !== 0) throw new Error(`docker run failed: ${startedRun.err}`);
  containerStarted = true;
  process.stdout.write(`machine ${CONTAINER} up; waiting for systemd…\n`);

  // systemd's own word for itself: "running" or "degraded" (a failed unit of ours would degrade it — the
  // scenario's checks say which); "starting" keeps us waiting.
  const bootDeadline = Date.now() + 180_000;
  for (;;) {
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

  // ---- the scenario, inside the machine, under the unpacked A tree's own Node.
  process.stdout.write(`running the scenario inside the machine (several minutes)…\n`);
  const scenarioRun = docker([
    "exec", "-u", "worker:1000",
    "-e", "HOME=/srv/worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
    "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
    CONTAINER, "/srv/worker/e2e/tree-a/node/bin/node", "/srv/worker/e2e/scenario.ts",
  ], { timeoutMs: 45 * 60_000 });
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
  if (containerStarted) {
    const removed = docker(["rm", "-f", CONTAINER], { timeoutMs: 120_000 });
    if (removed.code !== 0) {
      process.stderr.write(`removing ${CONTAINER} failed: ${removed.err}\n`);
      process.exitCode = 1;
    }
  }
  const left = docker(["ps", "-a", "--filter", `label=${LABEL}`, "-q"]);
  if (left.out !== "") {
    process.stderr.write(`containers with the label ${LABEL} remain: ${left.out.split("\n").join(", ")}\n`);
    process.exitCode = 1;
  }
  if (scratch !== null && process.env.E2E_KEEP !== "1") rmSync(scratch, { recursive: true, force: true });
  process.stdout.write(`run took ${Math.round((Date.now() - started) / 1000)}s\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
