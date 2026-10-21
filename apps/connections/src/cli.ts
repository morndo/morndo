// morndo-keys. The design names this morndo-connections; this build uses the name the manager asked for.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectiveIsolation, engineText, findConnection, spentOf, type Actor, type Connection, type Directory, type Mode } from "@morndo/domain";
import { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand } from "@morndo/protocol";
import { findPreset as presetOf, firstPartyHost, floorOf } from "./application/catalog.ts";
import { loginKeyRefused } from "./application/login-key.ts";
import { LOGIN_KEY_REFUSAL } from "./login-refusal.ts";
import { openHome, type Opened } from "./compose.ts";
import { fetchModelIds, launchChoice, modelMissing, sameModel, smallModel, wantedModel } from "./adapters/models.ts";
import { turnStopper } from "./reader-gone.ts";
import { selfHolder, selfId } from "./adapters/processes.ts";
import { baseUrlProblem, childEnv, ClaudeRuntime, isStatusRefusal, isThirdPartyAnthropicBase, keysProgram, loginEnv } from "./adapters/runtime-claude.ts";
import { readCodexLimits, usageReport } from "./adapters/usage-codex.ts";
import { productVersion } from "@morndo/service-kit";
import { poolCommand } from "./pool-cli.ts";
import { CodexRuntime, helperParts } from "./adapters/runtime-codex.ts";
import { CursorRuntime } from "./adapters/runtime-cursor.ts";
import { HELPER_LIMIT, HELPER_TTL_MS } from "./adapters/runtime-limits.ts";
import { streamRedactor } from "./adapters/redact.ts";
import { catalogTokenCost, costFromOutput, modelFromOutput } from "./adapters/spend.ts";
import { resetEngines } from "./adapters/engines-file.ts";
import { commandShape } from "./adapters/engines-bin.ts";
import { adoptLayer, gateBin, gateCommand, publishOwned } from "./application/engines-sync.ts";
import { FileRefused } from "./adapters/file-mode.ts";
import { parsePin, pinFor, procReader, verifyClaudeParent } from "./adapters/caller-proof.ts";
import { DatabaseFromFuture } from "./adapters/store-migrations.ts";

const ACTOR: Actor = { kind: "principal", command: "cli" };
const GATE = new Set(["off", "terms", "expired", "repo", "isolation", "dialect", "leases", "budget"]);
const LEASES = 8;
// The claude binary the owner pinned, in the connections home (adapters/caller-proof.ts); the lease reads it, not the env.
const PIN_FILE = "claude-pin.json";
const USAGE_WORDS = new Set(["missing argument", "isolation"]);

// `gone`: aborted when the reader of stdout or stderr has closed its end (reader-gone.ts); a run then stops its turn.
// `tty`: the command runs at an interactive terminal (stdin and stdout), which only pin-claude asks for.
export type Io = { stdout: (text: string) => void; stderr: (text: string) => void; stdin?: string; gone?: AbortSignal; tty?: boolean };

export type Parsed = { cmd: string; positionals: string[]; rest: string[]; get(name: string): string | undefined; all(name: string): string[] };

// `morndo-keys help`: what a run does when the reader of its output goes away, and where that stops working. Printed before
// the store is opened, so it works on a machine with no connections yet.
export const HELP = `morndo-keys run --connection <name> [--role R] [--workspace DIR] [--reserve USD] -- <agent arguments>
morndo-keys pool exec --runtime codex [--lane L] [--account A] -- exec … <prompt>
  Run the agent on a connection's key (or a pool account's sign-in) and relay its output.

  When the reader of the output has gone (\`… | head\`), or the terminal has (SIGHUP), the agent and the processes it started are
  stopped: SIGTERM, SIGKILL after 3 s, and the lease is closed with what the turn used. run then exits 1, pool exec 143, and both
  129 when the terminal went away. nohup does not exempt a run: Node resets an inherited SIGHUP ignore when it starts, for the bin
  and for the agent it starts. A run's agent stays in the terminal's own session, so Ctrl-C, Ctrl-Z and /dev/tty work as for any
  command (a pool turn has a process group of its own, as it always had, and is stopped as a group).

  A reader that is gone is noticed only when the bin writes to it. An agent that prints once at the end (claude with
  --output-format json) or goes quiet is not stopped before its next output, so its turn can be paid for in full: Node 24 has
  no way to see a pipe's reader close without a write. Use a streaming output format where this matters.

morndo-keys lease --connection <name> [--lane L] [--role R] [--workspace DIR] [--isolation none|rules|os]
  lease prints a key connection's key on stdout and nothing else, so it can be an apiKeyHelper: Claude Code runs the
  command through the shell and reads its stdout as the credential (a non-zero exit is failure, the output is cached for
  the TTL). One call is one lease — the gate runs, a KeyServed audit line is written, the lease closes; a call killed
  before that is swept at the next lease, run or check. A refusal names its reason on stderr and exits 1, or 75 when the
  gate refuses (off, terms, expired, repo, isolation, dialect, leases, budget).
  morndo-keys pin-claude [--path P] pins the claude binary a lease may be served to: its real path and its content (sha256,
  size, mtime, ctime, inode) and the API host of each connection it may serve (add a connection, pin again). Once, by the owner, at a terminal; an update needs a new pin. The terminal is advisory: it
  keeps an agent's plain tool call (which has none) from pinning, not a process of the same user that runs under a pty.
  The helper line is: ulimit -c 0; exec morndo-keys lease --connection <name> --lane <lane> --workspace <dir> --isolation os
  The ulimit keeps a crash from dumping the key (Node can neither wipe a string nor set its own core limit); the exec makes
  Claude Code the lease's parent, which is what it checks. For a connection whose floor is os (Z.ai today) the parent must
  be the pinned binary (its path and content, read from /proc), started with --strict-mcp-config (and no --mcp-config), one
  --settings (a file or inline JSON) and
  --setting-sources "" (no user, project or local settings merge in), whose sandbox is enabled, failIfUnavailable true,
  allowUnsandboxedCommands false and excludedCommands empty, with this node's vault, connections.db and identity in
  sandbox.filesystem.denyRead and as Read rules in permissions.deny, not re-opened by allowRead or opened by allowWrite;
  a settings file must not have changed since the parent started, be reached through no symlink and be in
  sandbox.filesystem.denyWrite; the settings carry only the keys a lane turn may (apiKeyHelper, permissions.deny, and under
  sandbox: enabled, failIfUnavailable, allowUnsandboxedCommands, filesystem.{denyRead,allowWrite,denyWrite},
  network.allowedDomains): no hooks, env, statusLine, plugins, proxy or weakening key; and the parent's environment has
  ANTHROPIC_BASE_URL set to the API host pinned for the connection (pin-claude records it from the preset). Anything else
  is refused with isolation.
  --workspace are the caller's claims. run keeps its own helper, \`helper --lease <id>\`.
`;

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const parsed = parse(argv);
  if (parsed.cmd === "help") { io.stdout(HELP); return 0; }
  try {
    if (parsed.cmd === "helper") return await helper(env, parsed, io);
    return await command(env, parsed, io);
  } catch (error) {
    // A store from a newer helper is a configuration the caller must fix, not a crash to retry into: EX_CONFIG (78),
    // the exit the hub's main gives the same refusal. A file this helper refuses to touch keeps 70.
    if (parsed.cmd === "helper") return error instanceof FileRefused ? 70 : error instanceof DatabaseFromFuture ? 78 : 1;
    // A lease prints a reason word only: an error's message can carry a path (T-340).
    io.stderr(parsed.cmd === "lease" ? `${error instanceof Error && USAGE_WORDS.has(error.message) ? error.message : "failed"}\n` : error instanceof Error ? error.message : "failed");
    return error instanceof FileRefused ? 70 : error instanceof DatabaseFromFuture ? 78 : 1;
  }
}

async function command(env: NodeJS.ProcessEnv, parsed: Parsed, io: Io): Promise<number> {
  const home = openHome(env);
  try {
    // A call killed with SIGKILL never closes its lease: the next lease, run or check ends the ones whose holder is gone.
    if (parsed.cmd === "lease" || parsed.cmd === "run" || parsed.cmd === "check") home.leases.sweep();
    const code = await dispatch(home, parsed, io);
    return code;
  } finally { home.close(); }
}

async function dispatch(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = parsed.positionals[0];
  switch (parsed.cmd) {
    case "add": return add(home, parsed, io);
    case "import": return importKey(home, parsed, io);
    case "list": return list(home, io);
    case "ack": return done(home.connections.acknowledge(need(name), parsed.get("by") ?? "", ACTOR), io);
    case "repos": return repos(home, need(name), parsed, io);
    case "isolation": return done(home.connections.setIsolation(need(name), isolationOf(parsed.positionals[1]), ACTOR), io);
    case "on": return done(home.connections.turnOn(need(name), ACTOR), io);
    case "off": return done(home.connections.turnOff(need(name)), io);
    case "budget": return done(home.connections.setBudget(need(name), budgetOf(parsed.positionals[1]), ACTOR), io);
    case "expiry": return done(home.connections.setExpiry(need(name), expiryOf(parsed.positionals[1]), ACTOR), io);
    case "models": return models(home, need(name), io);
    case "check": return check(home, need(parsed.get("connection") ?? name), parsed, io);
    case "run": return launch(home, parsed, io);
    case "lease": return leaseKey(home, parsed, io);
    case "pin-claude": return pinClaude(home, parsed, io);
    case "spend": return spend(home, need(name), io);
    case "usage": return usage(home, parsed, io);
    case "pool": return poolCommand(home, parsed, io);
    case "log": return log(home, name, io);
    case "revoke": return done(home.connections.revoke(need(name), ACTOR), io);
    case "rotate": return rotate(home, need(name), io);
    case "page": return pageJson(home, io);
    case "apply": return applyWire(home, parsed, io);
    case "priority": return priority(home, parsed, io);
    case "role": return role(home, parsed, io);
    case "picks": return picks(home, parsed, io);
    case "drift": return reportDrift(home, io);
    case "adopt": return adopt(home, io);
    case "engines": return engines(home, parsed);
    case "gate": return gate(home, parsed, io);
    default:
      io.stderr("unknown command");
      return 1;
  }
}

async function add(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.positionals[0]);
  const vendor = need(parsed.get("vendor"));
  const runtime = need(parsed.get("runtime"));
  if (parsed.get("subscription") === "true") {
    return done(home.connections.addSubscription({
      name, vendor, runtime, configDir: parsed.get("config-dir") ?? null,
    }, ACTOR), io);
  }
  if (loginKeyRefused(home.catalog.presets(), runtime, "api-key", "morndo")) return fail(io, LOGIN_KEY_REFUSAL);
  const text = (io.stdin ?? "").trim();
  if (text === "") { io.stderr("key missing"); return 1; }
  const ref = freshRef(name, home.now());
  await home.seal(ref, text);
  const added = await home.connections.addKey({
    name, vendor, runtime, ref, billing: billingOf(parsed.get("billing")), budget: budgetOf(parsed.get("budget")), expiry: expiryOf(parsed.get("expires")),
  }, ACTOR);
  if (!added.ok) home.vault.remove(ref);
  return done(added, io);
}

async function importKey(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.positionals[0]);
  if (loginKeyRefused(home.catalog.presets(), need(parsed.get("runtime")), "api-key", "morndo")) return fail(io, LOGIN_KEY_REFUSAL);
  const file = need(parsed.get("from-file"));
  const bytes = readFileSync(file);
  const old = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const ref = freshRef(name, home.now());
  await home.seal(ref, bytes.toString("utf8").trim());
  const added = await home.connections.addKey({
    name, vendor: need(parsed.get("vendor")), runtime: need(parsed.get("runtime")), ref,
    billing: billingOf(parsed.get("billing")), budget: budgetOf(parsed.get("budget")), expiry: expiryOf(parsed.get("expires")),
  }, ACTOR);
  if (!added.ok) { home.vault.remove(ref); return done(added, io); }
  const next = await home.vault.fingerprint(ref);
  io.stdout(`${JSON.stringify({ old, new: next })}\n`);
  return 0;
}

function list(home: Opened, io: Io): number {
  for (const connection of home.store.load().directory.connections) io.stdout(`${JSON.stringify(view(connection))}\n`);
  return 0;
}

function repos(home: Opened, name: string, parsed: Parsed, io: Io): number {
  return done(home.connections.setRepo(name, { allow: parsed.all("allow"), deny: parsed.all("deny") }, ACTOR), io);
}

function models(home: Opened, name: string, io: Io): Promise<number> {
  return probe(home, name, io, async connection => {
    const preset = presetOf(home.catalog, connection.vendor);
    if (!preset) return fail(io, "missing");
    let key = "";
    if (connection.custody === "morndo" && connection.kind === "api-key") key = await home.open(connection.ref);
    const ids = await fetchModelIds(preset, key);
    home.models.write(connection.vendor, ids);
    const pick = preset.defaultPicks["*"];
    if (modelMissing(ids, pick, preset.idPatterns ?? {})) home.engines.mark(connection.name, `model ${wantedModel(pick)} missing`, home.now() + 3_600_000);
    for (const id of ids) io.stdout(`${id}\n`);
    return 0;
  });
}

function check(home: Opened, name: string, parsed: Parsed, io: Io): number {
  const granted = ask(home, name, parsed, true, 0);
  if (!granted.ok) return fail(io, granted.problem, granted.exit);
  const closed = home.leases.close(name, granted.id, "done", null);
  return closed.ok ? 0 : fail(io, closed.error.problem, closed.error.exit);
}

async function launch(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.get("connection"));
  const loaded = home.store.load().directory;
  const connection = findConnection(loaded, name);
  if (!connection || connection.custody !== "morndo") return fail(io, "missing");
  if (loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return fail(io, LOGIN_KEY_REFUSAL);
  const preset = presetOf(home.catalog, connection.vendor);
  if (!preset) return fail(io, "missing");
  const baseUrl = preset.runtimes.find(item => item.runtime === connection.runtime)?.baseUrl ?? "";
  const party = firstPartyHost(home.catalog.presets());
  if (connection.kind === "api-key" && connection.runtime === "claude") {
    const problem = baseUrlProblem(baseUrl);
    if (problem) return fail(io, problem);
  }
  const choice = launchChoice(preset.defaultPicks, parsed.get("role") ?? "run");
  const model = choice.model;
  const listed = preset.models.source === "static" ? preset.models.ids : preset.prices.map(row => row.model);
  const small = smallModel(listed, model) ?? "";
  const reserve = Number(parsed.get("reserve") ?? "5");
  const granted = ask(home, name, parsed, false, reserve, choice.model || "default");
  if (!granted.ok) return fail(io, granted.problem, granted.exit);
  const row = findConnection(home.store.load().directory, name);
  const lease = row && row.custody === "morndo" ? row.leases.find(item => item.id === granted.id) : undefined;
  if (!lease) return fail(io, "missing");
  const keys = keysProgram(home.env.HOME ?? "", home.env.MORNDO_KEYS, existsSync, {
    command: process.execPath,
    args: ["--experimental-strip-types", join(import.meta.dirname, "main.ts")],
  });
  const helperLine = [keys.command, ...keys.args, "helper", "--lease", lease.id].join(" ");
  const subscription = connection.kind === "subscription";
  const configDir = connection.kind === "subscription" ? connection.configDir : join(home.dir, "runtime", name);
  const plan = {
    lease: lease.id, connection: name, ref: connection.kind === "api-key" ? connection.ref : null,
    configDir, model, effort: choice.effort, smallModel: small, workspace: parsed.get("workspace") ?? home.env.PWD ?? process.cwd(),
    deny: [home.vaultDir, home.db, home.identity, ...(connection.repo?.deny ?? [])],
    reservation: lease.reservation, probe: false, subscription,
  };
  const bin = connection.runtime === "codex" ? home.env.MORNDO_CODEX_BIN ?? "codex" : home.env.MORNDO_CLAUDE_BIN ?? "claude";
  const saved = home.env;
  let released = false;
  let refusal: number | null = null;
  let status = 1;
  let stdout = "";
  let failure = "";
  let outRedactor = streamRedactor([""]);
  let errRedactor = streamRedactor([""]);
  const stopper = turnStopper(io);
  let hungUp = false;
  try {
    const secret = connection.kind === "api-key" ? await home.open(connection.ref) : "";
    outRedactor = streamRedactor([secret]);
    errRedactor = streamRedactor([secret]);
    home.close();
    released = true;
    const hooks = {
      onStdout: (chunk: string) => { io.stdout(outRedactor.push(chunk)); },
      onStderr: (chunk: string) => { io.stderr(errRedactor.push(chunk)); },
      onStart: (pid: number) => { stopper.started(pid); },
      proceed: () => stopper.proceed(),
    };
    const codexHelper = helperParts(keys.command, lease.id);
    const child = connection.runtime === "codex"
      ? await new CodexRuntime({
        bin, profilePath: saved.MORNDO_CODEX_CONFIG ?? join(home.dir, "codex-profile.toml"), configDir,
        command: codexHelper.command, args: [...keys.args, ...codexHelper.args], baseUrl, parent: saved,
      }).execute(plan, parsed.rest, hooks)
      : connection.runtime === "cursor"
        ? await new CursorRuntime(saved.MORNDO_CURSOR_BIN ?? "agent", saved).execute(plan, parsed.rest, hooks)
        : await new ClaudeRuntime(bin, helperLine, saved, baseUrl, party).execute(plan, parsed.rest, hooks);
    status = child.status;
    stdout = child.stdout;
  } catch (error) {
    failure = error instanceof Error ? error.message : "run failed";
    if (isStatusRefusal(error)) refusal = 75;
    io.stderr(errRedactor.push(failure));
    status = 1;
  } finally {
    await stopper.settle();                                  // what the agent started is gone before the books close
    if (stopper.cut() && status === 0) status = 1;           // a launcher may exit 0 on SIGTERM: a turn cut short is not done
    hungUp = stopper.cut() && stopper.hungUp();
    io.stdout(outRedactor.flush());
    io.stderr(errRedactor.flush());
    const again = released ? openHome(saved) : home;
    try {
      const outcome = failure !== "" ? failure : status === 0 ? "done" : "failed";
      const catalogPrices = preset.spend.includes("token-price") && connection.runtime === "claude" && !subscription && isThirdPartyAnthropicBase(baseUrl, party);
      const cost = catalogPrices ? catalogTokenCost(stdout, preset.prices, model) : costFromOutput(stdout);
      again.leases.close(name, lease.id, outcome, cost);
      const seen = modelFromOutput(stdout);
      if (seen && model !== "" && !sameModel(model, seen, preset.idPatterns ?? {})) again.engines.mark(name, `model ${seen} missing`, again.now() + 3_600_000);
    } finally { if (released) again.close(); stopper.done(); }
  }
  if (refusal !== null) return refusal;
  if (hungUp) return 129;                                  // the terminal went away (SIGHUP): 128 + 1
  // 70, 75 and 78 are this launcher's own words (§8.4: one meaning per exit code) — its file refusal, its deferral,
  // its refusal of a store from a newer helper — so a child that exits one of them comes out as a plain failure.
  // The old wrapper's fallback on 70 then still means only what the launcher itself decided.
  return status === 70 || status === 75 || status === 78 ? 1 : status;
}

// `morndo-keys lease --connection <name>`: one call is one lease, as an apiKeyHelper takes it — the gate runs, the key
// is printed once and nothing else, a KeyServed audit line is written, the lease closes.
// Isolation: for a connection that has to run under os (its floor, ADR-0018 Q3), the caller's parent is read and must be a
// Claude Code process started with a sandbox that is on, fail-closed and denies the vault and the key files
// (adapters/caller-proof.ts); a bare --isolation never lifts it, and without the proof the gate refuses (`isolation`). For
// a lower need, --isolation (default none) is the caller's claim and the audit line says `claimed`. --lane and --workspace
// are claims too: the repo gate guards a mistake, not a lie. The key is in this process's memory for as long as it takes to
// print it; Node can neither wipe a string nor set its own core limit, so the helper line sets `ulimit -c 0` and `exec`s.
async function leaseKey(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.get("connection"));
  const connection = findConnection(home.store.load().directory, name);
  if (!connection) return fail(io, "missing");
  if (connection.status === "revoked") return fail(io, "revoked");
  if (connection.custody !== "morndo" || connection.kind !== "api-key" || connection.runtime !== "claude" || loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return fail(io, "not_leasable");
  const preset = presetOf(home.catalog, connection.vendor);
  if (!preset) return fail(io, "missing");
  const holder = selfHolder(parsed.get("lane") ?? null);
  if (!holder) return fail(io, "holder");
  const vouched = isolationOf(parsed.get("isolation") ?? "none");
  let seen = vouched;
  let proof: "verified" | "claimed" = "claimed";
  if (effectiveIsolation(connection, floorOf(preset)) === "os") {
    const pinFile = join(home.dir, PIN_FILE);
    const checked = verifyClaudeParent({
      ppid: () => process.ppid, connection: name, pin: parsePin(procReader.file(pinFile)?.body ?? null),
      want: { denied: [home.vaultDir, home.db, home.identity], writeProtected: [home.vaultDir, home.db, home.identity, pinFile] },
    });
    seen = checked.ok ? "os" : "none";
    proof = checked.ok ? "verified" : "claimed";
  }
  home.runtime.current = { isolation: () => seen, dialects: () => ["anthropic"], loginStatus: () => Promise.resolve("unknown" as const), launch: () => Promise.resolve({ id: "" }) };
  const workspace = parsed.get("workspace") ?? home.env.PWD ?? process.cwd();
  const granted = home.leases.lease(name, {
    role: parsed.get("role") ?? "lease", entry: "lease", holder, workspacePath: workspace,
    limit: LEASES, reserve: 0, margin: 0, probe: true,
  });
  if (!granted.ok) return fail(io, granted.error.problem, granted.error.exit);
  let outcome = "failed";
  try {
    const secret = await home.open(connection.ref);
    const served = home.leases.serve(name, granted.value.id, { pid: process.pid, ppid: process.ppid, lane: holder.lane, workspace, isolation: seen, proof });
    if (!served.ok) return fail(io, served.error.problem);
    io.stdout(`${secret}\n`);
    outcome = "done";
    return 0;
  } catch {
    io.stderr("failed\n");
    return 1;
  } finally { home.leases.close(name, granted.value.id, outcome, null); }
}

// `morndo-keys pin-claude [--path P]`: the owner says which claude binary a lease may be served to (P, else `claude` on this
// shell's PATH), once, at a terminal: an agent's tool call has none, so it can't pin the binary it wants (advisory: a
// process of the same user can run under a pty). It pins the file
// itself, not its name: the real path, the sha256 of its content, and its size, mtime, ctime and inode, and the API host of
// each connection it may serve. The pin goes to the
// connections home, which an agent's sandbox denies, and what it pins is printed.
function pinClaude(home: Opened, parsed: Parsed, io: Io): number {
  if (io.tty !== true) return fail(io, "tty");
  // For each key connection a lease may serve (a claude runtime), the API host its preset names: its claude is started
  // with that ANTHROPIC_BASE_URL, and the lease reads the parent's environment against this, not against its own.
  const baseUrls: Record<string, string> = {};
  for (const connection of home.store.load().directory.connections) {
    if (connection.custody !== "morndo" || connection.kind !== "api-key" || connection.runtime !== "claude") continue;
    const url = presetOf(home.catalog, connection.vendor)?.runtimes.find(item => item.runtime === "claude")?.baseUrl ?? "";
    if (url !== "") baseUrls[connection.name] = url;
  }
  const pin = pinFor(parsed.get("path") ?? "claude", home.env.PATH, baseUrls);
  if (pin === null) return fail(io, "missing");
  writeFileSync(join(home.dir, PIN_FILE), `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  io.stdout(`${JSON.stringify(pin)}\n`);
  return 0;
}

async function helper(env: NodeJS.ProcessEnv, parsed: Parsed, io: Io): Promise<number> {
  const home = openHome(env);
  try {
    const id = parsed.get("lease");
    if (!id) return 1;
    const found = leased(home.store.load().directory, id);
    if (!found || found.connection.custody !== "morndo" || found.connection.kind !== "api-key") return 1;
    const refreshed = home.leases.refresh(found.connection.name, id);
    if (!refreshed.ok) return 1;
    const caller = selfId();
    if (!caller) return 1;
    const noted = home.leases.helper(found.connection.name, id, caller, HELPER_LIMIT, HELPER_TTL_MS);
    if (!noted.ok) return 1;
    const after = leased(home.store.load().directory, id);
    if (!after || after.lease.authority !== "live") return 1;
    io.stdout(`${await home.open(found.connection.ref)}\n`);
    return 0;
  } finally { home.close(); }
}

function spend(home: Opened, name: string, io: Io): number {
  const connection = findConnection(home.store.load().directory, name);
  if (!connection || connection.kind !== "api-key" || connection.custody !== "morndo") return fail(io, "missing");
  io.stdout(`${JSON.stringify({ name, spent: spentOf(connection.spend) })}\n`);
  return 0;
}

// A Codex subscription's usage windows, one line of the status-line JSON the hub's Usage route takes (ADR-0028 decision 5).
// Nothing on stdout and exit 1 when they can't be read, so a caller that posts only on exit 0 sends nothing (a bare pipe would
// still send an empty body). The child gets childEnv: no key variable,
// and the Connection's own CODEX_HOME.
async function usage(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.get("connection") ?? parsed.positionals[0]);
  const connection = findConnection(home.store.load().directory, name);
  if (!connection || connection.status === "revoked") return fail(io, "missing");
  if (connection.custody !== "morndo" || connection.kind !== "subscription" || connection.runtime !== "codex") {
    return fail(io, "usage reads a Codex subscription only");
  }
  const env = childEnv(home.env, loginEnv("codex", connection.configDir));
  // A pool member takes one turn at a time (PL13): a read of its account waits for no turn and is refused while one runs.
  const slot = home.pool.list("codex").seats.some(seat => seat.member === name) ? randomUUID() : null;
  if (slot !== null) {
    const holder = selfHolder(null);
    const held = holder ? home.pool.hold("codex", name, slot, holder) : null;
    if (!held?.ok) return fail(io, "busy");
  }
  let reading: Awaited<ReturnType<typeof readCodexLimits>>;
  try { reading = await readCodexLimits({ bin: home.env.MORNDO_CODEX_BIN ?? "codex", env, version: productVersion() }); }
  finally { if (slot !== null) home.pool.release("codex", slot); }
  if (!reading.ok) return fail(io, reading.problem);
  io.stdout(`${JSON.stringify(usageReport(reading.limits, `${name}-limits`))}\n`);
  return 0;
}

const MODES: readonly Mode[] = ["subscriptions-first", "keys-first", "subscriptions-only", "keys-only", "custom"];

function isMode(value: string | undefined): value is Mode {
  return MODES.some(mode => mode === value);
}

function pageJson(home: Opened, io: Io): number {
  io.stdout(`${JSON.stringify(home.commands.page())}\n`);
  return 0;
}

function applyWire(home: Opened, parsed: Parsed, io: Io): number {
  const kind = parsed.positionals[0];
  const command = parsed.positionals[1] ?? "";
  if (command === "") return fail(io, "command");
  let raw: unknown;
  try { raw = JSON.parse(io.stdin ?? ""); } catch { return fail(io, "invalid"); }
  const result = kind === "priority" ? checked(PriorityCommand, raw, body => home.commands.priority(body, command))
    : kind === "role" ? checked(RoleCommand, raw, body => home.commands.role(body, command))
      : kind === "revoke" ? checked(RevokeCommand, raw, body => home.commands.revoke(body, command))
        : kind === "narrow" ? checked(NarrowCommand, raw, body => home.commands.narrow(body, command))
          : null;
  if (result === null) return fail(io, "command");
  if (!result.ok) return fail(io, result.problem);
  return 0;
}

function checked<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: unknown, run: (body: T) => { ok: true } | { ok: false; problem: string }): { ok: true } | { ok: false; problem: string } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: "invalid" };
  return run(parsed.data);
}

function priority(home: Opened, parsed: Parsed, io: Io): number {
  const action = parsed.positionals[0];
  const current = home.store.load().policy.priority;
  if (action === "show") {
    io.stdout(`${current.mode}${current.order.length === 0 ? "" : ` ${current.order.join(" ")}`}\n`);
    return 0;
  }
  if (action !== "set" || !isMode(parsed.positionals[1])) return fail(io, "priority");
  const order = parsed.positionals.slice(2);
  const set = home.routing.setPriority(parsed.positionals[1], order.length === 0 ? current.order : order, "cli");
  if (!set.ok) return done(set, io);
  return done(save(home), io);
}

function role(home: Opened, parsed: Parsed, io: Io): number {
  if (parsed.get("all") === "true") return followAll(home, parsed, io);
  const name = need(parsed.positionals[0]);
  const override = parsed.positionals[1];
  if (override === "follow" || override === "hand") {
    const set = home.routing.setOverride(name, override, null, "cli");
    if (!set.ok) return done(set, io);
    return done(save(home), io);
  }
  if (override !== "own" || !isMode(parsed.positionals[2])) return fail(io, "role");
  const order = parsed.positionals.slice(3);
  const current = home.store.load().policy.priority.order;
  const set = home.routing.setOverride(name, "own", { mode: parsed.positionals[2], order: order.length === 0 ? current : order }, "cli");
  if (!set.ok) return done(set, io);
  return done(save(home), io);
}

function followAll(home: Opened, parsed: Parsed, io: Io): number {
  if (parsed.positionals[0] !== "follow") return fail(io, "role");
  const before = home.engines.chains();
  const names = [...new Set([...home.store.load().policy.roles.map(row => row.role), ...before.map(row => row.role)])];
  const saved = home.routing.followAll(names, before);
  if (!saved.ok) return done(saved, io);
  publish(home);
  const after = home.engines.chains();
  for (const name of names) {
    const was = before.find(row => row.role === name);
    const now = after.find(row => row.role === name);
    io.stdout(`${name} ${(was?.chain ?? []).join(",")} -> ${(now?.chain ?? []).join(",")}\n`);
    if ((was?.risk?.length ?? 0) > 0 || (now?.risk?.length ?? 0) > 0) {
      io.stdout(`  risk ${(was?.risk ?? []).join(",")} -> ${(now?.risk ?? []).join(",")}\n`);
    }
  }
  return 0;
}

function picks(home: Opened, parsed: Parsed, io: Io): number {
  const name = need(parsed.positionals[0]);
  const action = parsed.positionals[1];
  const entry = need(parsed.positionals[2]);
  if (action !== "add" && action !== "remove") return fail(io, "picks");
  const row = home.store.load().policy.roles.find(item => item.role === name);
  const main = row ? row.picks.map(engineText) : [];
  const risk = row?.riskPicks ? row.riskPicks.map(engineText) : [];
  const onRisk = parsed.get("risk") === "true";
  const target = onRisk ? risk : main;
  const next = action === "add" ? [...target.filter(text => text !== entry), entry] : target.filter(text => text !== entry);
  if (action === "remove" && next.length === target.length) return fail(io, "missing");
  const texts = onRisk ? main : next;
  const riskArg = onRisk ? (next.length === 0 ? null : next) : (row?.riskPicks == null ? null : risk);
  const set = home.routing.setPicks(name, texts, riskArg, "cli");
  if (!set.ok) return done(set, io);
  return done(save(home), io);
}

function adopt(home: Opened, io: Io): number {
  const adopted = adoptLayer(home.store.load().directory, home.catalog, home.engines, input => home.connections.addLayer(input, ACTOR));
  if (!adopted.ok) return done(adopted, io);
  for (const name of adopted.value) io.stdout(`${name}\n`);
  return 0;
}

function reportDrift(home: Opened, io: Io): number {
  for (const role of home.routing.drift()) io.stdout(`${role}\n`);
  return 0;
}

function save(home: Opened) {
  publishNew(home);
  const result = home.routing.save();
  if (result.ok) publish(home);
  return result;
}

function publishNew(home: Opened): void {
  const have = new Set(home.engines.providerNames());
  const directory = home.store.load().directory;
  publishOwned(
    { ...directory, connections: directory.connections.filter(connection => !have.has(connection.name)) },
    home.catalog, home.models, home.engines,
  );
}

function publish(home: Opened): void {
  publishOwned(home.store.load().directory, home.catalog, home.models, home.engines);
}

function gate(home: Opened, parsed: Parsed, io: Io): number {
  const action = parsed.positionals[0];
  const name = need(parsed.positionals[1]);
  const current = home.engines.provider(name);
  if (!current) return fail(io, "missing");
  const path = join(home.dir, "gate", `${name}.json`);
  if (action === "on") {
    if (!existsSync(path) && (gateCommand(name, current.bin) || gateCommand(name, current.probe))) return fail(io, "gate command");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify({ bin: current.bin, probe: current.probe })}\n`, { mode: 0o600 });
    }
    const next = gateBin(name);
    home.engines.setProviderCommand(name, next.bin, next.probe);
    io.stdout(`${JSON.stringify({ name, bin: next.bin, rollback: `morndo-keys gate off ${name}` })}\n`);
    return 0;
  }
  if (action === "off") {
    if (!existsSync(path)) return fail(io, "missing");
    const saved = JSON.parse(readFileSync(path, "utf8")) as { bin?: unknown; probe?: unknown };
    const bin = commandShape(saved.bin);
    home.engines.setProviderCommand(name, bin, commandShape(saved.probe));
    unlinkSync(path);
    io.stdout(`${JSON.stringify({ name, bin })}\n`);
    return 0;
  }
  return fail(io, "missing");
}

function engines(home: Opened, parsed: Parsed): number {
  if (parsed.positionals[0] !== "reset") return 1;
  resetEngines(join(home.dir, "engines.json"));
  return 0;
}

function log(home: Opened, name: string | undefined, io: Io): number {
  for (const event of home.store.load().directory.events) {
    if (name && "name" in event && event.name !== name) continue;
    io.stdout(`${JSON.stringify(event)}\n`);
  }
  return 0;
}

async function rotate(home: Opened, name: string, io: Io): Promise<number> {
  const text = (io.stdin ?? "").trim();
  if (text === "") { io.stderr("key missing"); return 1; }
  const current = findConnection(home.store.load().directory, name);
  if (!current || current.kind !== "api-key" || current.custody !== "morndo") return fail(io, "missing");
  const ref = freshRef(name, home.now(), current.ref);
  await home.seal(ref, text);
  const rotated = await home.connections.rotate(name, ref, ACTOR);
  if (!rotated.ok) { home.vault.remove(ref); return done(rotated, io); }
  // The rotation is committed: an old file that can't be removed, or is gone already, is named as left to clean, never
  // thrown in place of the rotation (round 3, point 1).
  let left: string | null = null;
  try { home.vault.remove(current.ref); } catch (error) { left = error instanceof Error ? error.message : "failed"; }
  io.stdout(`${JSON.stringify({ fingerprint: await home.vault.fingerprint(ref) })}\n`);
  if (left === null) return 0;
  io.stderr(`left to clean: vault: ${left}\n`);
  return PARTIAL;
}

async function probe(home: Opened, name: string, io: Io, body: (connection: Connection) => Promise<number>): Promise<number> {
  const connection = findConnection(home.store.load().directory, name);
  if (!connection) return fail(io, "missing");
  if (loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return fail(io, LOGIN_KEY_REFUSAL);
  const holder = selfHolder(null);
  if (!holder) return fail(io, "holder");
  home.runtime.current = gateRuntime(home, connection.runtime);
  const granted = home.leases.lease(name, {
    role: "probe", entry: "probe", holder, workspacePath: home.env.PWD ?? process.cwd(),
    limit: LEASES, reserve: 0, margin: 0, probe: true,
  });
  if (!granted.ok) return fail(io, granted.error.problem, granted.error.exit);
  try { return await body(connection); }
  finally { home.leases.close(name, granted.value.id, "done", null); }
}

export function ask(home: Opened, name: string, parsed: Parsed, probeLease: boolean, reserve: number, entry?: string): { ok: true; id: string } | { ok: false; problem: string; exit?: number } {
  const connection = findConnection(home.store.load().directory, name);
  if (!connection) return { ok: false, problem: "missing" };
  if (loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return { ok: false, problem: LOGIN_KEY_REFUSAL };
  const holder = selfHolder(parsed.get("lane") ?? null);
  if (!holder) return { ok: false, problem: "holder" };
  home.runtime.current = gateRuntime(home, connection.runtime);
  const workspace = parsed.get("workspace") ?? home.env.PWD ?? process.cwd();
  const recorded = entry ?? (launchChoice(presetOf(home.catalog, connection.vendor)?.defaultPicks ?? {}, parsed.get("role") ?? "run").model || "default");
  const granted = home.leases.lease(name, {
    role: parsed.get("role") ?? "run",
    entry: recorded,
    holder, workspacePath: workspace, limit: LEASES, reserve, margin: 0, probe: probeLease,
  });
  if (!granted.ok) return { ok: false, problem: granted.error.problem, ...(granted.error.exit === undefined ? {} : { exit: granted.error.exit }) };
  return { ok: true, id: granted.value.id };
}

function gateRuntime(home: Opened, runtime: string) {
  if (runtime === "codex") {
    return new CodexRuntime({
      bin: home.env.MORNDO_CODEX_BIN ?? "codex",
      profilePath: home.env.MORNDO_CODEX_CONFIG ?? join(home.dir, "codex-profile.toml"),
      configDir: home.dir, command: process.execPath, args: [], baseUrl: "", parent: home.env,
    });
  }
  if (runtime === "claude") return new ClaudeRuntime(home.env.MORNDO_CLAUDE_BIN ?? "claude", "helper", home.env);
  if (runtime === "cursor") return new CursorRuntime(home.env.MORNDO_CURSOR_BIN ?? "agent", home.env);
  return { isolation: () => "none" as const, dialects: () => [], loginStatus: () => Promise.resolve("unknown" as const), launch: () => Promise.resolve({ id: "" }) };
}

function leased(directory: Directory, id: string): { connection: Connection; lease: { id: string; authority: "live" | "ended" } } | null {
  for (const connection of directory.connections) {
    if (connection.custody !== "morndo") continue;
    const lease = connection.leases.find(item => item.id === id);
    if (lease) return { connection, lease };
  }
  return null;
}

function view(connection: Connection): { name: string; kind: string; vendor: string; runtime: string; status: string; fingerprint: string | null } {
  const fingerprint = connection.kind === "api-key" && connection.custody === "morndo" ? connection.fingerprint : null;
  return { name: connection.name, kind: connection.kind, vendor: connection.vendor, runtime: connection.runtime, status: connection.status, fingerprint };
}

// Done, with something left to clean that the command names on stderr, as morndo-secrets says it.
const PARTIAL = 3;

function done(result: { ok: true } | { ok: false; error: { problem: string; role?: string; exit?: number } }, io: Io): number {
  if (result.ok) return 0;
  return fail(io, result.error.problem, result.error.exit, result.error.role);
}

export function fail(io: Io, problem: string, exit?: number, role?: string): number {
  io.stderr(`${role ? `${problem} ${role}` : problem}\n`);
  if (exit !== undefined) return exit;
  return GATE.has(problem) ? 75 : 1;
}

export function freshRef(name: string, now: number, current = "", bytes: () => Buffer = () => randomBytes(4)): string {
  let ref = current;
  do {
    const stamp = `${now}-${bytes().toString("hex")}`;
    const room = 80 - `key--${stamp}`.length;
    ref = `key-${name.slice(0, Math.max(1, room))}-${stamp}`;
  } while (ref === current);
  return ref;
}

export function need(value: string | undefined): string {
  if (!value) throw new Error("missing argument");
  return value;
}

function billingOf(value: string | undefined): "metered" | "prepaid" {
  if (value === "prepaid" || value === "metered") return value;
  throw new Error("billing");
}

function budgetOf(value: string | undefined): { kind: "unlimited" } | { kind: "capped"; amount: number } {
  if (value === "unlimited") return { kind: "unlimited" };
  const amount = Number(value);
  if (value === undefined || !Number.isFinite(amount) || amount <= 0) throw new Error("budget: give an amount or unlimited");
  return { kind: "capped", amount };
}

function expiryOf(value: string | undefined): number | null {
  if (value === undefined || value === "none") return null;
  const at = Number(value);
  if (!Number.isFinite(at)) throw new Error("expiry");
  return at;
}

function isolationOf(value: string | undefined): "none" | "rules" | "os" {
  if (value === "none" || value === "rules" || value === "os") return value;
  throw new Error("isolation");
}

function parse(argv: readonly string[]): Parsed {
  const cut = argv.indexOf("--");
  const ours = cut < 0 ? [...argv] : argv.slice(0, cut);
  const rest = cut < 0 ? [] : argv.slice(cut + 1);
  const cmd = ours[0] ?? "";
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  for (let i = 1; i < ours.length; i++) {
    const token = ours[i] ?? "";
    if (token === "--subscription" || token === "--all" || token === "--risk" || token === "--json" || token === "--report" || token === "--notify" || token === "--yes" || token === "--keep") {
      values.set(token.slice(2), ["true"]);
      continue;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const value = ours[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing ${name}`);
      values.set(name, [...(values.get(name) ?? []), value]);
      i += 1;
      continue;
    }
    positionals.push(token);
  }
  return {
    cmd, positionals, rest,
    get: name => values.get(name)?.at(-1),
    all: name => values.get(name) ?? [],
  };
}
