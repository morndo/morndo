// The two-machine fleet updates end-to-end run (updates design §13's second machine, PR 6d): cp (a control
// plane: hub + fleet) and node, two containers from #109's machine image under THIS run's own tag and label —
// image morndo-c3-fleet-e2e:local, label morndo-c3-fleet-e2e on every container, network and image it makes. The
// label morndo-c2-e2e and its image belong to another lane's run and are never touched; the fleet run builds from
// its own copy of the Dockerfile (e2e/update-vm/Dockerfile.fleet) precisely so nothing here carries that label.
//
// The story (the brief's seven steps): install A on cp and join the node; B soaks (2 min) and the node's tick
// defers; the principal's "Update now" in the browser (step-up on a virtual authenticator) skips the soak and the
// node takes B; G breaks the node's agent — its rollback halts the Rollout (RL12); Resume through the web; H is
// held by the skew gate while the node speaks the dropped protocol (RL11), until the node is revoked; nothing
// left behind. Every machine-side check is a JSON line from e2e/update-vm/fleet-steps.ts (one step per docker
// exec, run under the unpacked A tree's own Node on each machine); the web steps' checks are this file's own.
//
// The rules, kept from #109 (PR 5d): no host mounts, no host network, no published ports, no --privileged —
// files move by docker cp only; a label sweep at the start and a finally block remove only this run's things
// (containers AND the network) and assert none remains. The transport this run stands in for the Tailscale link:
// the fleet stays on its product default 127.0.0.1:8791 on both machines, and e2e/update-vm/forward.ts — a
// plain TCP pipe started detached inside each machine as the worker — carries the node's agent to cp (cp's
// bridge address:18791 → cp's loopback:8791; the node's loopback:8791 → cp:18791). The browser reaches cp's hub
// through one host-side forwarder on 127.0.0.1:18790 (checked free first; a taken port refuses with one
// sentence), so the browser's origin is exactly the hub's own localhost origin and WebAuthn works. Each machine
// serves its own copy of the feed on its own 127.0.0.1:8443 (feed-server.ts, detached), because the signed
// entries name https://127.0.0.1:8443/.
//
// Run it with `npm run e2e:update-fleet` (kept out of `npm run e2e`); `--only install` runs steps 1 and 7 alone,
// to prove the transport before the whole story.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { pairedPage } from "./harness.ts";
import { buildWorld } from "./update-vm/build.ts";

const ROOT = join(import.meta.dirname, "..");
const IMAGE = "morndo-c3-fleet-e2e:local";
const LABEL = "morndo-c3-fleet-e2e";
const HEX = randomBytes(4).toString("hex");
const CP = `morndo-c3-fleet-cp-${HEX}`;
const NODE = `morndo-c3-fleet-node-${HEX}`;
const NETWORK = `morndo-c3-fleet-net-${HEX}`;
const HOST_PORT = 18790;                     // the host forwarder to cp's hub (the hub's own port inside cp)
const NODE_BIN = "/srv/worker/e2e/tree-a/node/bin/node";

function docker(args: string[], o: { timeoutMs?: number } = {}): { code: number; out: string; err: string } {
  const done = spawnSync("docker", args, { encoding: "utf8", timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: done.status ?? -1, out: (done.stdout ?? "").trim(), err: (done.stderr ?? "").trim() };
}

// The one long call (a machine step can wait minutes) runs without blocking, so a signal's cleanup can run during it.
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
  process.stderr.write(`e2e:update-fleet refuses to run: ${reason}\n`);
  process.exit(2);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// The evidence directory (e2e/harness.ts's own rule): a run's output is kept, never thrown away with the tmp.
const outDir = process.env.E2E_OUT ?? mkdtempSync(join(tmpdir(), "morndo-update-fleet-out-"));
mkdirSync(outDir, { recursive: true });

// This run's own check lines, in the machine steps' own shape ({"step","ok","detail"}), so the report can quote
// one stream. A failed check never stops the story: the machine is throwaway, the finding is the point.
type Line = { step: string; ok: boolean; detail: string };
const lines: Line[] = [];
function hostCheck(step: string, ok: boolean, detail: string): void {
  lines.push({ step, ok, detail });
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`);
}

if (process.platform !== "linux" || process.arch !== "x64") {
  refuse(`the throwaway machines are linux-x64; this host is ${process.platform}-${process.arch}`);
}
const dockerAnswers = docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000 });
if (dockerAnswers.code !== 0) refuse(`docker does not answer (${dockerAnswers.err || "no server"}); this run needs it`);

// The host port the browser's forwarder needs: checked before anything is built, refused with one sentence.
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", e => reject(new Error(`the host port ${HOST_PORT} is taken (${e instanceof Error ? e.message : String(e)}); the browser's forwarder to cp's hub needs it`)));
  probe.listen(HOST_PORT, "127.0.0.1", () => probe.close(() => resolve()));
}).catch(error => refuse((error as Error).message));

const started = Date.now();
let scratch: string | null = null;
let networkUp = false;
let cpUp = false;
let nodeUp = false;
let forwarder: ChildProcess | null = null;
let browser: Browser | null = null;

// What every way out does: this run's machines and network go, its scratch with them (unless E2E_KEEP=1), the
// host forwarder with them always.
function cleanUp(): void {
  forwarder?.kill("SIGKILL");
  forwarder = null;
  for (const [up, name] of [[cpUp, CP], [nodeUp, NODE]] as const) {
    if (!up) continue;
    const removed = docker(["rm", "-f", name], { timeoutMs: 120_000 });
    if (removed.code !== 0) {
      process.stderr.write(`removing ${name} failed: ${removed.err}\n`);
      process.exitCode = 1;
    }
  }
  cpUp = nodeUp = false;
  if (networkUp) {
    const gone = docker(["network", "rm", NETWORK], { timeoutMs: 120_000 });
    if (gone.code !== 0) {
      process.stderr.write(`removing ${NETWORK} failed: ${gone.err}\n`);
      process.exitCode = 1;
    }
    networkUp = false;
  }
  if (scratch !== null && process.env.E2E_KEEP !== "1") { rmSync(scratch, { recursive: true, force: true }); scratch = null; }
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    process.stderr.write(`\n${signal}: removing the machines, the network and the scratch\n`);
    running?.kill("SIGKILL");
    cleanUp();
    process.exit(code);
  });
}

// A run killed outright cannot clean up after itself: its things are removed here, by the label only this
// harness puts on them — containers first, then the network. #109's morndo-c2-e2e label is never named.
const leftovers = docker(["ps", "-a", "--filter", `label=${LABEL}`, "-q"]).out.split("\n").filter(id => id !== "");
for (const id of leftovers) {
  const gone = docker(["rm", "-f", id], { timeoutMs: 120_000 });
  process.stdout.write(`removed a container a killed run left behind (${id}): ${gone.code === 0 ? "ok" : gone.err}\n`);
}
for (const id of docker(["network", "ls", "--filter", `label=${LABEL}`, "-q"]).out.split("\n").filter(n => n !== "")) {
  const gone = docker(["network", "rm", id], { timeoutMs: 120_000 });
  process.stdout.write(`removed a network a killed run left behind (${id}): ${gone.code === 0 ? "ok" : gone.err}\n`);
}
// Its build scratch too (build.ts's morndo-fleet-build-*, about 1.5 GB each); a kept scratch (E2E_KEEP=1) is a
// person's to read and stays. Only a real directory named exactly build.ts's fleet prefix is ever removed.
if (process.env.E2E_KEEP !== "1") {
  for (const name of readdirSync(tmpdir()).filter(n => /^morndo-fleet-build-[A-Za-z0-9]{6}$/.test(n))) {
    const path = join(tmpdir(), name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      rmSync(path, { recursive: true, force: true });
      process.stdout.write(`removed the build scratch a killed run left behind (${name})\n`);
    } catch (error) {
      process.stdout.write(`could not remove ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
// The sweeps' own test (E2E_SWEEP_ONLY=1): stop here, with nothing built and no machine started.
if (process.env.E2E_SWEEP_ONLY === "1") process.exit(0);

// One machine step, one docker exec: fleet-steps.ts runs inside the machine under the unpacked A tree's own Node
// and prints its JSON check lines; this re-prints them with the machine named, keeps the step's whole word in the
// evidence directory, and says it plainly when a step printed no check line at all (a crash is a failed check).
async function machineStep(machine: "cp" | "node", step: string, o: { arg?: string; timeoutMs?: number } = {}): Promise<void> {
  const name = machine === "cp" ? CP : NODE;
  const argv = ["exec", "-u", "worker:1000", "-e", "HOME=/srv/worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
    "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", name, NODE_BIN, "/srv/worker/e2e/fleet-steps.ts", step,
    ...(o.arg === undefined ? [] : [o.arg])];
  const r = await dockerAsync(argv, o.timeoutMs ?? 10 * 60_000);
  mkdirSync(join(outDir, "steps"), { recursive: true });
  writeFileSync(join(outDir, "steps", `${machine}-${step}.txt`),
    `$ fleet-steps.ts ${step}${o.arg === undefined ? "" : " '<arg>'"}\nexit ${r.code}\n${r.out}\n${r.err}\n`);
  let saw = 0;
  for (const l of r.out.split("\n")) {
    if (!l.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(l) as { step?: unknown; ok?: unknown; detail?: unknown };
      if (typeof parsed.step !== "string" || typeof parsed.ok !== "boolean") continue;
      saw++;
      hostCheck(`${machine}:${parsed.step}`, parsed.ok, typeof parsed.detail === "string" ? parsed.detail : "");
    } catch { /* not a check line; its step file keeps it */ }
  }
  if (saw === 0) hostCheck(`${machine}:${step}`, false,
    `the step printed no check line (exit ${r.code}): ${(r.err || r.out).split("\n").slice(0, 3).join(" | ")}`);
}

// A file read out of a machine (the join string, the pair URL) — docker cp's little brother, one `cat`.
function readFrom(machine: "cp" | "node", path: string): string {
  return docker(["exec", "-u", "worker", "-e", "HOME=/srv/worker", machine === "cp" ? CP : NODE, "cat", path]).out;
}

// One container from the run's image: #109's own flags (systemd as PID 1 without --privileged) plus this run's
// two additions — the shared bridge network and the hostname the story reads ("cp" / "node"; the planted failure
// in G is gated on the machine being named "node").
const MACHINE_FLAGS = ["--cap-add", "SYS_ADMIN", "--cap-drop", "AUDIT_WRITE", "--cgroupns=private",
  "-e", "container=docker", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--tmpfs", "/tmp"] as const;

// systemd's own word for itself, then the worker's own manager (linger starts it): the updater's every door goes
// through it. A container that stopped is a machine that will never boot: its entrypoint's own words say why.
async function bootWait(name: string): Promise<void> {
  const bootDeadline = Date.now() + 180_000;
  for (;;) {
    const alive = docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name]);
    if (alive.out.startsWith("false")) {
      const said = docker(["logs", name]);
      throw new Error(`${name} stopped before systemd came up (exit ${alive.out.split(" ")[1]}): ${(said.out + said.err).trim().split("\n").slice(-3).join(" | ")}`);
    }
    const state = docker(["exec", name, "systemctl", "is-system-running"]);
    if (state.out === "running" || state.out === "degraded") break;
    if (Date.now() > bootDeadline) throw new Error(`systemd never came up in ${name} (${state.out || state.err})`);
    await sleep(2_000);
  }
  const userDeadline = Date.now() + 60_000;
  for (;;) {
    const env = docker(["exec", "-u", "worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
      "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", name, "systemctl", "--user", "show-environment"]);
    if (env.code === 0) break;
    if (Date.now() > userDeadline) throw new Error(`the worker's user manager in ${name} never answered (${env.err})`);
    await sleep(2_000);
  }
}

try {
  // ---- the four Releases (A, B, G, H), signed, and the four publish points; the web UI built into each.
  process.stdout.write(`building the four releases (this takes a few minutes)…\n`);
  const world = buildWorld(ROOT, "fleet");
  scratch = world.scratch;

  // The A tree unpacked on the host (install.sh's own extraction): both machines' step runner runs under this
  // tree's Node, so it must exist before anything starts inside them.
  const treeA = join(world.bundle, "tree-a");
  mkdirSync(treeA, { recursive: true });
  const extract = spawnSync("tar", ["-xzf", world.archiveA, "-C", treeA], { encoding: "utf8", timeout: 300_000 });
  if (extract.status !== 0) throw new Error(`unpacking the A archive failed: ${extract.stderr}`);
  if (!existsSync(join(treeA, "node/bin/node"))) throw new Error("the A tree ships no node/bin/node");
  for (const file of ["fleet-steps.ts", "feed-server.ts", "forward.ts"]) {
    const from = join(ROOT, "e2e/update-vm", file);
    if (!existsSync(from)) throw new Error(`e2e/update-vm/${file} is not where this run expects it`);
    copyFileSync(from, join(world.bundle, file));
  }

  // ---- the machines: the image (its Dockerfile carries this run's label; --label again for the build itself),
  // the network, then cp and node on it.
  process.stdout.write(`building the machine image and starting cp and node…\n`);
  const built = docker(["build", "-t", IMAGE, "--label", `${LABEL}=1`, "-f", join(ROOT, "e2e/update-vm/Dockerfile.fleet"), join(ROOT, "e2e/update-vm")], { timeoutMs: 600_000 });
  if (built.code !== 0) throw new Error(`docker build failed: ${built.err}`);
  const network = docker(["network", "create", "--label", `${LABEL}=1`, NETWORK]);
  if (network.code !== 0) throw new Error(`docker network create failed: ${network.err}`);
  networkUp = true;
  for (const [name, host, isCp] of [[CP, "cp", true], [NODE, "node", false]] as const) {
    const startedRun = docker(["run", "-d", "--name", name, "--label", `${LABEL}=1`, "--hostname", host,
      "--network", NETWORK, ...MACHINE_FLAGS, IMAGE]);
    if (startedRun.code !== 0) throw new Error(`docker run of ${name} failed: ${startedRun.err}`);
    if (isCp) cpUp = true; else nodeUp = true;
    await bootWait(name);
  }
  process.stdout.write(`cp and node up; copying the bundle into both…\n`);

  for (const name of [CP, NODE]) {
    docker(["exec", name, "mkdir", "-p", "/srv/worker/e2e/evidence"]);
    const copied = docker(["cp", `${world.bundle}/.`, `${name}:/srv/worker/e2e`], { timeoutMs: 600_000 });
    if (copied.code !== 0) throw new Error(`docker cp of the bundle into ${name} failed: ${copied.err}`);
    const owned = docker(["exec", name, "chown", "-R", "worker:worker", "/srv/worker/e2e"], { timeoutMs: 300_000 });
    if (owned.code !== 0) throw new Error(`chown of the bundle in ${name} failed: ${owned.err}`);
  }

  // ---- the transport. Each machine's own feed (the signed entries name https://127.0.0.1:8443/, so each machine
  // serves its own copy of the same bundle over the same CA), then the TCP pipes: cp's bridge address carries the
  // fleet's agent port and the hub's web port out to the network, the node's loopback carries its agent into cp.
  // cp's pipes bind the bridge address only — never 0.0.0.0, which would collide with the hub's and fleet's own
  // loopback binds.
  for (const name of [CP, NODE]) {
    const feed = docker(["exec", "-d", "-u", "worker", "-e", "HOME=/srv/worker", name, NODE_BIN,
      "/srv/worker/e2e/feed-server.ts", "/srv/worker/e2e/feed", "/srv/worker/e2e/tls/server.key",
      "/srv/worker/e2e/tls/server.pem", "/srv/worker/e2e/evidence/feed-requests.txt", "8443"]);
    if (feed.code !== 0) throw new Error(`starting the feed server in ${name} failed: ${feed.err}`);
  }
  const cpIP = docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", CP]).out;
  if (cpIP === "") throw new Error("could not read cp's address on the run's network");
  const forwardIn = (name: string, listenHost: string, listenPort: string, targetHost: string, targetPort: string): void => {
    const r = docker(["exec", "-d", "-u", "worker", "-e", "HOME=/srv/worker", name, NODE_BIN,
      "/srv/worker/e2e/forward.ts", listenHost, listenPort, targetHost, targetPort]);
    if (r.code !== 0) throw new Error(`starting the forwarder in ${name} (${listenHost}:${listenPort} -> ${targetHost}:${targetPort}) failed: ${r.err}`);
  };
  forwardIn(CP, cpIP, "18791", "127.0.0.1", "8791");      // the fleet's agent port, out to the network
  forwardIn(CP, cpIP, "18790", "127.0.0.1", "18790");     // the hub's web port, out to the network
  forwardIn(NODE, "127.0.0.1", "8791", cpIP, "18791");    // the node's agent, into cp's fleet
  process.stdout.write(`cp at ${cpIP}; the pipes and the feeds are up\n`);

  // The host's own pipe for the browser: 127.0.0.1:18790 (checked free before anything was built) to cp's hub, so
  // the browser's origin is exactly the hub's own localhost origin and WebAuthn works.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the host forwarder on 127.0.0.1:${HOST_PORT} never said it listens`)), 15_000);
    forwarder = spawn(process.execPath, [join(ROOT, "e2e/update-vm/forward.ts"), "127.0.0.1", String(HOST_PORT), cpIP, "18790"],
      { stdio: ["ignore", "pipe", "inherit"] });
    forwarder.stdout?.on("data", (b: Buffer) => { if (b.toString().includes("listening")) { clearTimeout(timer); resolve(); } });
    forwarder.once("exit", c => { clearTimeout(timer); reject(new Error(`the host forwarder exited ${c}`)); });
  });

  // ---- 1: install A on cp and join the node (the brief's step 1). The join string cp's fleet console prints
  // crosses machines only through this host (a file read out, a command line handed in).
  await machineStep("cp", "setup");
  await machineStep("node", "setup");
  await machineStep("cp", "install-cp", { timeoutMs: 12 * 60_000 });
  await machineStep("cp", "node-add");
  const joinString = readFrom("cp", "/srv/worker/e2e/join-string.txt").split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
  hostCheck("cp:join-string-out", joinString !== "", joinString === "" ? "cp's join string never reached the host" : "cp's join string for e2e-node is in the host's hand");
  await machineStep("node", "install-node", { arg: joinString, timeoutMs: 12 * 60_000 });
  await machineStep("cp", "nodes-view");
  await machineStep("cp", "pair-url");

  const ONLY = process.argv.includes("--only") ? (process.argv[process.argv.indexOf("--only") + 1] ?? "") : "";
  let page: Page | null = null;
  const ORIGIN = `http://localhost:${HOST_PORT}`;
  const nodeRow = () => page!.locator('li.card[data-machine="e2e-node"]');

  // The browser, paired with cp's hub through the host forwarder, and kept for every web step: the device stays
  // paired, exactly as a principal's phone would. A pairing needs a fresh console token (each is single-use), so
  // `morndo pair` runs inside cp again whenever a web step's page died and the browser must re-pair; the URL's
  // origin is the hub's own localhost, which on this host IS the forwarder.
  async function pairBrowser(): Promise<void> {
    if (page !== null) return;
    const r = docker(["exec", "-u", "worker:1000", "-e", "HOME=/srv/worker", "-e", "XDG_RUNTIME_DIR=/run/user/1000",
      "-e", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "-e", `MORNDO_PORT=${HOST_PORT}`,
      CP, "/srv/worker/.local/bin/morndo", "pair"], { timeoutMs: 60_000 });
    const pairUrl = r.code === 0 ? r.out.split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "" : "";
    if (pairUrl === "") throw new Error(`morndo pair inside cp printed no URL (exit ${r.code}: ${r.err.split("\n")[0]})`);
    browser ??= await chromium.launch();
    const paired = await pairedPage(browser, { pairUrl: () => pairUrl });
    page = paired.page;
  }

  if (ONLY !== "install") {
    // ---- 2: the order of the fleet. cp's soak set to two minutes; feeds to B on both machines; the node stages B
    // and its tick defers (the control plane has not moved); cp commits B (its state carries the two-minute soak);
    // the node's tick defers again — inside the soak now.
    await machineStep("cp", "soak-2");
    await machineStep("cp", "feed", { arg: "feed-2" });
    await machineStep("node", "feed", { arg: "feed-2" });
    await machineStep("node", "node-stages", { arg: "0.2.0" });
    await machineStep("node", "tick-defers-early");
    await machineStep("cp", "cp-to-b", { timeoutMs: 25 * 60_000 });
    await machineStep("node", "tick-defers-soak");

    // ---- 3: the principal's word through the web. /updates offers the node B with "Update now" (§8.3: the
    // principal's apply skips the soak and the jitter); the click runs the step-up on the virtual authenticator;
    // the node takes B and commits. Screenshots before and after, as the story's own record.
    try {
      await pairBrowser();
      await page!.goto(`${ORIGIN}/updates`);
      await nodeRow().getByRole("button", { name: "Update now" }).waitFor({ timeout: 30_000 });
      await page!.screenshot({ path: join(outDir, "web-updates-before-b.png"), fullPage: true });
      await nodeRow().getByRole("button", { name: "Update now" }).click();
      await page!.locator("p.ok").waitFor({ timeout: 3 * 60_000 });   // the hub's ask travels through the fleet to the node's updater
      hostCheck("web:update-now-b", true, "Update now clicked; the step-up ran; the hub asked e2e-node to take 0.2.0");
    } catch (e) {
      hostCheck("web:update-now-b", false, (e as Error).message.split("\n")[0] ?? String(e));
      page = null;                                     // a dead page is re-paired at the next web step
    }
    await machineStep("node", "node-current-b", { timeoutMs: 12 * 60_000 });
    await machineStep("cp", "nodes-current-b", { timeoutMs: 5 * 60_000 });
    try {
      await pairBrowser();
      await page!.goto(`${ORIGIN}/updates`);
      await nodeRow().getByText("up to date").waitFor({ timeout: 60_000 });
      await page!.screenshot({ path: join(outDir, "web-updates-after-b.png"), fullPage: true });
      hostCheck("web:node-at-b", true, "/updates shows e2e-node up to date at 0.2.0");
    } catch (e) {
      hostCheck("web:node-at-b", false, (e as Error).message.split("\n")[0] ?? String(e));
      page = null;
    }

    // ---- 4: the halt. Feeds to G; cp commits it (its own agent healthy — the planted failure is gated on the
    // hostname "node"); the soak waited out by the fleet's own word; the node's drawn delay set to the past by the
    // test; the node stages G and its tick applies it — health fails, the machine rolls back to B, and the Rollout
    // of G halts (RL12). A second tick refuses it.
    await machineStep("cp", "feed", { arg: "feed-3" });
    await machineStep("node", "feed", { arg: "feed-3" });
    await machineStep("cp", "cp-to-g", { timeoutMs: 25 * 60_000 });
    await machineStep("cp", "rollout-soaked", { timeoutMs: 8 * 60_000 });
    await machineStep("node", "pin-jitter");
    await machineStep("node", "node-stages", { arg: "0.3.0" });
    await machineStep("node", "tick-applies-g", { timeoutMs: 25 * 60_000 });
    await machineStep("cp", "rollout-halted");
    await machineStep("node", "tick-refuses-g");

    // ---- 5: the resume, through the web again. /updates shows the halted Rollout with Resume; the click runs the
    // step-up; the Rollout stands resumed. Then the node's tick — RL7's word is that a Version rolled back here is
    // bad on this machine and never tried again automatically; the machine step asserts that word and records
    // whatever the code does instead (see REPORT-6d.md's "Open finding").
    try {
      await pairBrowser();
      await page!.goto(`${ORIGIN}/updates`);
      await page!.locator("section.card[data-rollout]").getByText("halted by e2e-node").waitFor({ timeout: 30_000 });
      await page!.screenshot({ path: join(outDir, "web-updates-halted.png"), fullPage: true });
      await page!.locator("section.card[data-rollout]").getByRole("button", { name: "Resume" }).click();
      await page!.locator("p.ok").waitFor({ timeout: 3 * 60_000 });
      hostCheck("web:resume", true, "Resume clicked; the step-up ran; the Rollout of 0.3.0 resumed");
    } catch (e) {
      hostCheck("web:resume", false, (e as Error).message.split("\n")[0] ?? String(e));
      page = null;
    }
    await machineStep("cp", "rollout-resumed");
    await machineStep("node", "tick-after-resume", { timeoutMs: 25 * 60_000 });
    await machineStep("cp", "rollout-after-node");
    try {
      await pairBrowser();
      await page!.goto(`${ORIGIN}/updates`);
      await page!.locator("section.card[data-rollout]").waitFor({ timeout: 30_000 });
      const card = (await page!.locator("section.card[data-rollout]").innerText()).replace(/\n/g, " ");
      await page!.screenshot({ path: join(outDir, "web-updates-after-node-tick.png"), fullPage: true });
      hostCheck("web:rollout-after-node-tick", !card.includes("halted by e2e-node"),
        `RL7 wanted a refusal that halts nothing; /updates' Rollout card says: ${card}`);
    } catch (e) {
      hostCheck("web:rollout-after-node-tick", false, (e as Error).message.split("\n")[0] ?? String(e));
      page = null;
    }

    // ---- 6: the skew. Feeds to H (its agent protocol range drops what A–G's agents speak); cp's own apply exits
    // 75 with the node named, the machine stays on G, the alert carries it; /updates shows the control plane's row
    // waiting on the node. The node revoked, cp takes H.
    await machineStep("cp", "feed", { arg: "feed-4" });
    await machineStep("node", "feed", { arg: "feed-4" });
    await machineStep("cp", "cp-held-h", { timeoutMs: 25 * 60_000 });
    await machineStep("cp", "skew-alert");
    try {
      await pairBrowser();
      await page!.goto(`${ORIGIN}/updates`);
      const cpState = page!.locator('li.card[data-machine="control-plane"]').locator("p.state");
      await cpState.filter({ hasText: "waiting: " }).waitFor({ timeout: 30_000 });
      const said = (await cpState.innerText()).replace(/\n/g, " ");
      await page!.screenshot({ path: join(outDir, "web-updates-skew.png"), fullPage: true });
      hostCheck("web:cp-waiting", said.includes("waiting:") && said.includes("e2e-node"),
        `the control plane's row says: ${said}`);
    } catch (e) {
      hostCheck("web:cp-waiting", false, (e as Error).message.split("\n")[0] ?? String(e));
      page = null;
    }
    await machineStep("cp", "revoke-node");
    await machineStep("cp", "cp-to-h", { timeoutMs: 25 * 60_000 });
  }

  // ---- 7: nothing left behind, on both machines, and the last word of each into the evidence.
  await machineStep("cp", "clean");
  await machineStep("node", "clean");
  await machineStep("cp", "final-status");
  await machineStep("node", "final-status");

  // The evidence out of both machines, whatever happened: every command's whole word, every snapshot, the journals.
  for (const [machine, name] of [["cp", CP], ["node", NODE]] as const) {
    mkdirSync(join(outDir, `evidence-${machine}`), { recursive: true });
    docker(["cp", `${name}:/srv/worker/e2e/evidence/.`, join(outDir, `evidence-${machine}`)], { timeoutMs: 300_000 });
  }

  const failedLines = lines.filter(l => !l.ok);
  process.stdout.write(`\n${lines.length} checks, ${failedLines.length} failed\n`);
  for (const l of failedLines) process.stdout.write(`FAILED  ${JSON.stringify(l)}\n`);
  const exitOk = failedLines.length === 0 && lines.length > 0;
  process.stdout.write(`${exitOk ? "PASSED" : "FAILED"} in ${Math.round((Date.now() - started) / 1000)}s; evidence in ${outDir}\n`);
  process.exitCode = exitOk ? 0 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  // The machines are throwaway: they and the network go, and the run proves they went — by this run's label only.
  // The image stays (it is this run's own, and a rebuild costs minutes).
  if (browser !== null) await Promise.resolve(browser.close()).catch(() => {});
  cleanUp();
  const leftContainers = docker(["ps", "-a", "--filter", `label=${LABEL}`, "-q"]).out;
  if (leftContainers !== "") {
    process.stderr.write(`containers with the label ${LABEL} remain: ${leftContainers.split("\n").join(", ")}\n`);
    process.exitCode = 1;
  }
  const leftNetworks = docker(["network", "ls", "--filter", `label=${LABEL}`, "-q"]).out;
  if (leftNetworks !== "") {
    process.stderr.write(`networks with the label ${LABEL} remain: ${leftNetworks.split("\n").join(", ")}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(`run took ${Math.round((Date.now() - started) / 1000)}s\n`);
}

