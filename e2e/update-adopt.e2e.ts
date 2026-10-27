// The adoption rehearsal (C6-0, docs/plans/2026-10-27-c6-0-adoption-rehearsal.md): a throwaway machine in the state of
// the machines today (an old release folder, three unmarked units, real wrapper files, databases, a lane's tmux),
// `morndo install` run over it, and the backup and dead-man scripts (scripts/c6) exercised for real. A whole systemd in
// a Docker container, as e2e/update.e2e.ts has it; the story is e2e/update-vm/adopt-scenario.ts, run inside it under
// the unpacked A tree's Node, one JSON check line per step.
//
// The container rules are update.e2e.ts's: labelled morndo-c6-adopt-e2e (container and image), not --privileged,
// SYS_ADMIN only, AUDIT_WRITE dropped, a private cgroup namespace, tmpfs for /run, /run/lock and /tmp, no host mounts,
// no host network, no published ports; files move by docker cp only. Dockerfile.adopt's entrypoint makes the cgroup
// tree writable by a fresh cgroup2 mount where rootless Docker refuses the remount. The container is removed on every
// way out, a killed run's leftovers are swept by label and owner at the start, and the image goes at the very end.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld } from "./update-vm/build.ts";
import { allowedSignersLine, parsePublished, sha256For } from "./update-vm/adopt-checks.ts";
import { makeOwnedScratch, ownerOf, ownerText, sweepContainers, sweepScratch } from "./update-vm/checks.ts";

const ROOT = join(import.meta.dirname, "..");
const IMAGE = "morndo-c6-adopt-e2e:local";
const LABEL = "morndo-c6-adopt-e2e";
const OWNER_LABEL = `${LABEL}.owner`;
const CONTAINER = `morndo-c6-adopt-e2e-${randomBytes(4).toString("hex")}`;
// `--published <version>`: the machine installs the PUBLISHED release by the README's commands, from the real feed.
const PUBLISHED = parsePublished(process.argv.slice(2));
const OWNER = ownerText(ownerOf(process.pid));                    // this run, as its container's label names it

function docker(args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const done = spawnSync("docker", args, { encoding: "utf8", timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: done.status ?? -1, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
}

// The one long call (the scenario, up to 40 minutes) runs without blocking, so a signal's cleanup can run during it.
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
  process.stderr.write(`e2e:update-adopt refuses to run: ${reason}\n`);
  process.exit(2);
}

// The evidence directory (e2e/harness.ts's own rule): a run's output is kept, never thrown away with the tmp.
const outDir = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-adopt-e2e-out-"));
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
sweepScratch(tmpdir(), { keep: process.env.E2E_KEEP === "1", prefix: "morndo-c6", say: line => process.stdout.write(`${line}\n`) });

try {
  let bundle: string;
  let treeA: string;
  if (PUBLISHED === null) {
    // ---- the one Release (A, 0.1.0), signed, and its publish point (build.ts does it the pipeline's way).
    process.stdout.write(`building the release (this takes a few minutes)…\n`);
    const world = buildWorld(ROOT, "adopt");
    scratch = world.scratch;
    bundle = world.bundle;

    // The A tree unpacked on the host (install.sh's own extraction): the scenario runs under this tree's Node, so
    // it must exist before anything starts inside the machine. bin/ is chmod 0555 as install.sh does.
    treeA = join(bundle, "tree-a");
    mkdirSync(treeA, { recursive: true });
    const extract = spawnSync("tar", ["-xzf", world.archiveA, "-C", treeA], { encoding: "utf8", timeout: 300_000 });
    if (extract.status !== 0) throw new Error(`unpacking the A archive failed: ${extract.stderr}`);
  } else {
    // ---- the published release: its archive from GitHub, checked against SHA256SUMS; no feeds, no TLS, no feed server.
    scratch = makeOwnedScratch(tmpdir(), ownerText(ownerOf(process.pid)), { prefix: "morndo-c6" });
    bundle = join(scratch, "bundle");
    mkdirSync(bundle, { recursive: true });
    const base = `https://github.com/morndo/morndo/releases/download/v${PUBLISHED}`;
    const archiveName = `morndo-${PUBLISHED}-linux-x64.tar.gz`;
    process.stdout.write(`downloading ${archiveName} and SHA256SUMS from ${base}/ …\n`);
    for (const name of ["SHA256SUMS", archiveName]) {
      const got = spawnSync("curl", ["-fsSL", "-o", join(scratch, name), `${base}/${name}`], { encoding: "utf8", timeout: 600_000 });
      if (got.status !== 0) throw new Error(`downloading ${name} failed (curl exit ${got.status}): ${got.stderr}`);
    }
    const wanted = sha256For(readFileSync(join(scratch, "SHA256SUMS"), "utf8"), archiveName);
    if (wanted === null) throw new Error(`SHA256SUMS has no line for ${archiveName}`);
    const actual = createHash("sha256").update(readFileSync(join(scratch, archiveName))).digest("hex");
    if (actual !== wanted) throw new Error(`the archive's sha256 ${actual} is not the ${wanted} that SHA256SUMS gives: refusing`);
    process.stdout.write(`${archiveName} sha256 ${actual} matches SHA256SUMS\n`);
    treeA = join(bundle, "tree-a");
    mkdirSync(treeA, { recursive: true });
    const extract = spawnSync("tar", ["-xzf", join(scratch, archiveName), "-C", treeA], { encoding: "utf8", timeout: 300_000 });
    if (extract.status !== 0) throw new Error(`unpacking the archive failed: ${extract.stderr}`);
    const key = allowedSignersLine(readFileSync(join(ROOT, "README.md"), "utf8"));
    if (key === null) throw new Error("README.md has no single `echo '...' > morndo.allowed_signers` line");
    writeFileSync(join(bundle, "allowed_signers"), `${key}\n`);
    const c6 = join(bundle, "scripts", "c6");
    mkdirSync(c6, { recursive: true });
    for (const name of readdirSync(join(ROOT, "scripts/c6")).filter(n => !n.endsWith(".test.ts"))) cpSync(join(ROOT, "scripts/c6", name), join(c6, name));
    for (const name of ["adopt-scenario.ts", "adopt-checks.ts", "checks.ts"]) cpSync(join(ROOT, "e2e/update-vm", name), join(bundle, name));
  }
  if (!existsSync(join(treeA, "node/bin/node"))) throw new Error("the A tree ships no node/bin/node");
  if (!existsSync(join(ROOT, "e2e/update-vm/adopt-scenario.ts"))) throw new Error("e2e/update-vm/adopt-scenario.ts is not where this run expects it");
  copyFileSync(join(ROOT, "e2e/update-vm/adopt-scenario.ts"), join(bundle, "adopt-scenario.ts"));   // (build.ts copies it too)

  // ---- the machine itself, and the bundle into it.
  process.stdout.write(`building the machine…\n`);
  const built = docker(["build", "-t", IMAGE, "--label", `${LABEL}=1`, "-f", join(ROOT, "e2e/update-vm/Dockerfile.adopt"), join(ROOT, "e2e/update-vm")], { timeoutMs: 600_000 });
  if (built.code !== 0) throw new Error(`docker build failed: ${built.err}`);

  const startedRun = docker([
    "run", "-d", "--name", CONTAINER, "--label", `${LABEL}=1`, "--label", `${OWNER_LABEL}=${OWNER}`,
    "--cap-add", "SYS_ADMIN", "--cap-drop", "AUDIT_WRITE", "--cgroupns=private",
    "-e", "container=docker", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp",
    IMAGE,
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
  const copied = docker(["cp", `${bundle}/.`, `${CONTAINER}:/srv/worker/e2e`], { timeoutMs: 600_000 });
  if (copied.code !== 0) throw new Error(`docker cp of the bundle failed: ${copied.err}`);
  const owned = docker(["exec", CONTAINER, "chown", "-R", "worker:worker", "/srv/worker/e2e"], { timeoutMs: 300_000 });
  if (owned.code !== 0) throw new Error(`chown of the bundle failed: ${owned.err}`);

  // ---- the scenario, inside the machine, under the unpacked A tree's own Node. The story waits minutes on the
  // recovery timer alone, so the wall is the story's own: 40 minutes.
  process.stdout.write(`running the scenario inside the machine (about ten minutes)…\n`);
  const scenarioRun = await dockerAsync([
    "exec", "-u", "worker:1000",
    "-e", "HOME=/srv/worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
    "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
    ...(PUBLISHED === null ? [] : ["-e", `C6_PUBLISHED=${PUBLISHED}`]),
    CONTAINER, "/srv/worker/e2e/tree-a/node/bin/node", "/srv/worker/e2e/adopt-scenario.ts",
  ], 40 * 60_000);
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
  // The machine is throwaway: it goes, and the run proves it went; the image goes with it. Only things with the label are
  // named, only this run's own container is removed.
  cleanUp();
  const imageGone = docker(["rmi", IMAGE], { timeoutMs: 120_000 });
  if (imageGone.code !== 0) process.stderr.write(`warning: removing ${IMAGE} failed: ${imageGone.err}\n`);
  // This run's own: another run going on now on this box keeps its container until its own end.
  const left = docker(["ps", "-a", "--filter", `label=${OWNER_LABEL}=${OWNER}`, "-q"]);
  if (left.out !== "") {
    process.stderr.write(`this run's containers remain: ${left.out.split("\n").join(", ")}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(`containers with the label left: [${docker(["ps", "-a", "--filter", `label=${LABEL}`, "-q"]).out}]\n`);
  process.stdout.write(`images of the run left: [${docker(["images", "--filter", `reference=${IMAGE}`, "-q"]).out}]\n`);
  process.stdout.write(`run took ${Math.round((Date.now() - started) / 1000)}s\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
