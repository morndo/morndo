// morndo-keys. The design names this morndo-connections; this build uses the name the manager asked for.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { effectiveIsolation, engineText, findConnection, spentOf, type Actor, type Connection, type Directory, type KeyConnection, type Lease, type Mode, type SubscriptionConnection } from "@morndo/domain";
import { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand, type VendorPreset } from "@morndo/protocol";
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
import { keyPoolCommand } from "./keypool-cli.ts";
import { readRunFailure } from "./adapters/outcome-anthropic.ts";
import { CodexRuntime, helperParts } from "./adapters/runtime-codex.ts";
import { CursorRuntime } from "./adapters/runtime-cursor.ts";
import { HELPER_LIMIT, HELPER_TTL_MS } from "./adapters/runtime-limits.ts";
import { streamRedactor } from "./adapters/redact.ts";
import { catalogTokenCost, costFromOutput, modelFromOutput } from "./adapters/spend.ts";
import { resetEngines } from "./adapters/engines-file.ts";
import { commandShape } from "./adapters/engines-bin.ts";
import { adoptLayer, gateBin, gateCommand, publishOwned } from "./application/engines-sync.ts";
import { sessionKey } from "./application/key-pool-service.ts";
import { FileRefused } from "./adapters/file-mode.ts";
import { parsePin, pinFor, procReader, verifyClaudeParent } from "./adapters/caller-proof.ts";
import { CLAUDE_RELEASE_FINGERPRINT, CLAUDE_RELEASE_FIRST_SIGNED } from "./adapters/claude-release-key.ts";
import { compareVersions, installedVersions, isVersion, fileShaCache, parseReleasePin, releaseAdmits, syncReleases, type Fetch } from "./adapters/release-manifest.ts";
import { DatabaseFromFuture } from "./adapters/store-migrations.ts";

const ACTOR: Actor = { kind: "principal", command: "cli" };
const GATE = new Set(["off", "terms", "expired", "repo", "isolation", "dialect", "leases", "budget"]);
const LEASES = 8;
// The claude binary the owner pinned, in the connections home (adapters/caller-proof.ts); the lease reads it, not the env.
const PIN_FILE = "claude-pin.json";
// The signed-release pin (T-346): the key, the directory releases are installed in, the lowest version.
const RELEASE_PIN_FILE = "claude-release-pin.json";
const USAGE_WORDS = new Set(["missing argument", "isolation"]);

// `gone`: aborted when the reader of stdout or stderr has closed its end (reader-gone.ts); a run then stops its turn.
// `tty`: the command runs at an interactive terminal (stdin and stdout), which only pin-claude asks for.
export type Io = { stdout: (text: string) => void; stderr: (text: string) => void; stdin?: string; gone?: AbortSignal; tty?: boolean; fetch?: Fetch };

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
  morndo-keys pin-claude --signed [--versions-dir D] [--floor V] pins Anthropic's release signing key (the fingerprint compiled
  into this build), the directory claude's versions are installed in and the lowest version to accept, instead of one binary: a
  lease then admits any version in that directory, at or above the floor, whose sha256 a signed manifest lists, so an update
  needs no new pin. morndo-keys claude-releases sync [--only V] is the node job (no secret; run it on a timer and before a lane
  starts) that fetches and verifies those manifests into the cache a lease reads; a lease makes no network call.
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
  ANTHROPIC_BASE_URL set to the API host pinned for the connection (pin-claude records it from the preset), and no proxy
  (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, any case), NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR or
  NODE_TLS_REJECT_UNAUTHORIZED=0. Anything else
  is refused with isolation.
  --workspace are the caller's claims. run keeps its own helper, \`helper --lease <id>\`.

morndo-keys keypool create <name> --vendor V --runtime R --by <who> [--mode round-robin|drain] [--recheck 24h] [--confirm-own-account] <key-connection>...
morndo-keys keypool add|remove|revive <pool> <connection> [--confirm-own-account]    keypool move <pool> <connection> --to N
morndo-keys keypool policy <pool> [--mode …] [--recheck …]    keypool list    keypool delete <pool>
morndo-keys keypool report <pool> --member M --outcome exhausted|failing|limited [--reason R] [--lease <id>]
morndo-keys keypool report <pool> --outcome exhausted|failing|limited --grant <id>
morndo-keys keypool sync
morndo-keys lease --pool <name> …        morndo-keys run --pool <name> [--role R] [--workspace DIR] [--reserve USD] -- <agent arguments>
morndo-keys check --pool <name>
  A key pool groups two or more of your API-key connections of one vendor and runtime behind one name (opt in; ADR-0037). It holds
  connection names and health, never a key. lease --pool and run --pool take the next member that can serve, in join order (round-robin) or
  the same member until it is out (drain); the member's own gate (terms, expiry, repo, isolation, budget) still runs, and a member the gate
  refuses is passed over. Naming a pool, never a key, is all a caller can do: lease --pool refuses --connection and --member.
  A member the provider refuses for lack of credit, or at a spend limit you set, is marked exhausted and skipped. A refused key or
  account (401, 403, on hold, the tier's monthly cap) marks it failing, which stops the whole pool until you revive that member
  or rotate its key: traffic never moves to another account because one account was refused. A failed headless run is read for such a
  refusal through the agent CLI's own JSON result only (never the text the model and its tools printed), and dropped; one that ended on
  an exhausted key before doing any work (no cost, one turn) goes once more on another member. A lane reports only for its own run: with --grant
  (the member is the grant's) or, with --lease, for the member of its own open lease; the machine's principal needs neither. A pooled run's helper is \`helper --pool <name> --grant <id>\`:
  it moves the run to the next member when the one it is on is reported dry (within the 60 s cache), the helper's call cap carries over,
  and a refused helper says its word on stderr. A pool
  holds only keys of accounts you hold: every member needs --confirm-own-account, and create needs --by, who read the terms line it shows.
  Exit 75 with a word: pool_empty, pool_blocked, terms, or the gate's word.
`;

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed: Parsed;
  try { parsed = parse(argv); } catch (error) {
    // A flag with no value (`--by` last, or before another flag) is a refusal with its word, not a stack trace.
    io.stderr(`${error instanceof Error ? error.message : "failed"}\n`);
    return 1;
  }
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
    // The grants of a pooled run whose holder is gone go the same way.
    if (parsed.cmd === "lease" || parsed.cmd === "run" || parsed.cmd === "check") home.keypools.sweepGrants();
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
    case "check": return check(home, parsed.get("connection") ?? name, parsed, io);
    case "run": return launch(home, parsed, io);
    case "lease": return leaseKey(home, parsed, io);
    case "pin-claude": return pinClaude(home, parsed, io);
    case "claude-releases": return claudeReleases(home, parsed, io);
    case "spend": return spend(home, need(name), io);
    case "usage": return usage(home, parsed, io);
    case "pool": return poolCommand(home, parsed, io);
    case "keypool": return keyPoolCommand(home, parsed, io);
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

async function check(home: Opened, name: string | undefined, parsed: Parsed, io: Io): Promise<number> {
  const pool = parsed.get("pool");
  if (pool !== undefined) {
    if (parsed.get("connection") !== undefined) return fail(io, "usage");
    // The same probe a `check --connection` takes, on each servable member, without moving the ring.
    const served = await home.keypools.canServe(pool, async member => {
      const granted = ask(home, member, parsed, true, 0);
      if (!granted.ok) return { ok: false, error: { problem: granted.problem, ...(granted.exit === undefined ? {} : { exit: granted.exit }) } };
      const closed = home.leases.close(member, granted.id, "done", null);
      return closed.ok ? { ok: true, value: undefined } : { ok: false, error: closed.error };
    });
    return served.ok ? 0 : fail(io, served.error.problem, served.error.exit);
  }
  const target = need(name);
  const granted = ask(home, target, parsed, true, 0);
  if (!granted.ok) return fail(io, granted.problem, granted.exit);
  const closed = home.leases.close(target, granted.id, "done", null);
  return closed.ok ? 0 : fail(io, closed.error.problem, closed.error.exit);
}

type Failed = { ok: false; error: { problem: string; exit?: number } };
type Started = { ok: true; value: { prep: RunPrep; lease: Lease } } | Failed;
// What a run needs from its Connection and its preset, read before the lease and kept for the run.
type RunPrep = {
  name: string; connection: SubscriptionConnection | KeyConnection; preset: VendorPreset; baseUrl: string; party: string;
  choice: { model: string; effort: string }; model: string; small: string;
};
// A run's end: its exit code, and what the child printed on stdout, for a pool to read the CLI's structured result from and drop (ADR-0037).
// Stderr and a thrown failure are never kept: they hold the model's and the tools' words as well as the provider's.
// `attributed` is the member a pooled run's grant named for a failure (KP18), read before the grant closed. Null when there was no grant.
type RunEnd = { code: number; output: string; attributed: string | null };

const failed = (problem: string, exit?: number): Failed => ({ ok: false, error: exit === undefined ? { problem } : { problem, exit } });

// `morndo-keys run --connection <name>`, or `run --pool <name>`: the first names the Connection, the second has the key pool pick it.
async function launch(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  if (parsed.get("pool") !== undefined) return launchPooled(home, parsed, io);
  const started = startRun(home, parsed, need(parsed.get("connection")));
  if (!started.ok) return fail(io, started.error.problem, started.error.exit);
  return (await runLeased(home, parsed, io, started.value.prep, started.value.lease, null)).code;
}

// The checks before a run and its lease: the Connection, the preset, the base URL, the model, then the gate. A refusal names its word
// and, for a gate refusal, the exit 75 (what a key pool reads to try the next member).
function startRun(home: Opened, parsed: Parsed, name: string): Started {
  const loaded = home.store.load().directory;
  const connection = findConnection(loaded, name);
  if (!connection || connection.custody !== "morndo") return failed("missing");
  if (loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return failed(LOGIN_KEY_REFUSAL);
  const preset = presetOf(home.catalog, connection.vendor);
  if (!preset) return failed("missing");
  const baseUrl = preset.runtimes.find(item => item.runtime === connection.runtime)?.baseUrl ?? "";
  const party = firstPartyHost(home.catalog.presets());
  if (connection.kind === "api-key" && connection.runtime === "claude") {
    const problem = baseUrlProblem(baseUrl);
    if (problem) return failed(problem);
  }
  const choice = launchChoice(preset.defaultPicks, parsed.get("role") ?? "run");
  const model = choice.model;
  const listed = preset.models.source === "static" ? preset.models.ids : preset.prices.map(row => row.model);
  const small = smallModel(listed, model) ?? "";
  const reserve = Number(parsed.get("reserve") ?? "5");
  const granted = ask(home, name, parsed, false, reserve, choice.model || "default");
  if (!granted.ok) return failed(granted.problem, granted.exit);
  const row = findConnection(home.store.load().directory, name);
  const lease = row && row.custody === "morndo" ? row.leases.find(item => item.id === granted.id) : undefined;
  if (!lease) return failed("missing");
  return { ok: true, value: { prep: { name, connection, preset, baseUrl, party, choice, model, small }, lease } };
}

// The run on a lease already granted, to its end. The key is released to the child, so `home` is closed once the child starts and the
// lease is closed in a home of its own.
async function runLeased(home: Opened, parsed: Parsed, io: Io, prep: RunPrep, lease: Lease, grant: { pool: string; id: string } | null): Promise<RunEnd> {
  const { name, connection, preset, baseUrl, party, choice, model, small } = prep;
  const keys = keysProgram(home.env.HOME ?? "", home.env.MORNDO_KEYS, existsSync, {
    command: process.execPath,
    args: ["--experimental-strip-types", join(import.meta.dirname, "main.ts")],
  });
  // A pooled claude run is bound to the grant, so a later helper call can move the session. Every other run stays on its lease.
  const helperLine = (grant === null
    ? [keys.command, ...keys.args, "helper", "--lease", lease.id]
    : [keys.command, ...keys.args, "helper", "--pool", grant.pool, "--grant", grant.id]).join(" ");
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
  let output = "";
  let failure = "";
  let attributed: string | null = null;
  let childSession: string | null = null;
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
      onStart: (pid: number) => {
        stopper.started(pid);
        const id = home.processes.identity(pid);
        if (id) childSession = sessionKey(id);
      },
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
    output = child.stdout;
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
      // The cost is an estimate and goes to the lease the grant names now (the last member). The first lease is the fallback
      // when the grant is gone. A failed run is attributed before the grant closes, so the wrapper can report that member (KP18).
      const tracked = grant === null ? null : again.keypools.grantOf(grant.pool, grant.id);
      again.leases.close(tracked?.member ?? name, tracked?.lease ?? lease.id, outcome, cost);
      if (grant !== null) {
        if (status !== 0) {
          // The child's session is the run the grant served. attribute answers that session's member, and the window
          // when the grant has not seen it (KP18), before the grant closes.
          const found = again.keypools.attribute(grant.pool, grant.id, childSession);
          if (found.ok) attributed = found.value;
        }
        again.keypools.closeGrant(grant.pool, grant.id);
      }
      const seen = modelFromOutput(stdout);
      if (seen && model !== "" && !sameModel(model, seen, preset.idPatterns ?? {})) again.engines.mark(name, `model ${seen} missing`, again.now() + 3_600_000);
    } finally { if (released) again.close(); stopper.done(); }
  }
  if (refusal !== null) return { code: refusal, output, attributed };
  if (hungUp) return { code: 129, output, attributed };       // the terminal went away (SIGHUP): 128 + 1
  // 70, 75 and 78 are this launcher's own words (§8.4: one meaning per exit code) — its file refusal, its deferral,
  // its refusal of a store from a newer helper — so a child that exits one of them comes out as a plain failure.
  // The old wrapper's fallback on 70 then still means only what the launcher itself decided.
  return { code: status === 70 || status === 75 || status === 78 ? 1 : status, output, attributed };
}

// `morndo-keys run --pool <name>` (ADR-0037): the pool picks the member (the last pick is saved, the member's gate runs, one MemberPicked is
// written), the run goes on it, and a run that failed is read for a refusal of the key. Only the agent CLI's own structured result is read
// (readRunFailure), never the free text the model and its tools printed: a credit or spend-limit refusal marks the member exhausted, a
// refused key or account marks it failing (which blocks the pool), anything else, or output that is not that record, changes nothing. A
// headless turn (-p) that ended on an exhausted key, before it did any work (no cost, no model use, one turn), goes once more, on another
// member; one that had done work is reported and stopped, so it never pays or edits twice. What the child printed is dropped.
async function launchPooled(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const pool = need(parsed.get("pool"));
  if (parsed.get("connection") !== undefined) return fail(io, "usage");
  const headless = parsed.rest.includes("-p") || parsed.rest.includes("--print");
  // The launcher asks the agent CLI for its JSON result. A caller who sets another output format (text, say) gets output a model can
  // write any line of: such a run is never read for a refusal.
  const structured = !parsed.rest.some(arg => arg === "--output-format" || arg.startsWith("--output-format="));
  let current = home;
  let skip: readonly string[] = [];
  let first: number | null = null;
  try {
    for (;;) {
      const began = current.now();
      const claude = current.keypools.state(pool)?.runtime === "claude";
      const workspace = parsed.get("workspace") ?? current.env.PWD ?? process.cwd();
      const picked = await current.keypools.pick(pool, async member => startRun(current, parsed, member), claude ? {
        skip,
        // The grant remembers the request the first lease was gated with, so a hand-off runs that gate again (CN8).
        grant: (_member, value) => ({
          lease: value.lease.id, holder: value.lease.holder, startedAt: value.lease.start,
          request: {
            role: parsed.get("role") ?? "run", entry: value.prep.choice.model || "default", workspacePath: workspace,
            limit: LEASES, reserve: Number(parsed.get("reserve") ?? "5"), margin: 0,
          },
        }),
      } : { skip });
      if (!picked.ok) {
        // A retry that finds no other member leaves the first run's result as the answer, with the word beside it.
        if (first === null) return fail(io, picked.error.problem, picked.error.exit);
        io.stderr(`${picked.error.problem}\n`);
        return first;
      }
      const { member, value } = picked.value;
      const grant = picked.value.grant === undefined ? null : { pool, id: picked.value.grant };
      const end = await runLeased(current, parsed, io, value.prep, value.lease, grant);
      // runLeased closed its home when the key went to the child: the report is made in a home of its own.
      const after = openHome(home.env);
      let retry = false;
      try {
        const failure = end.code !== 0 && structured ? readRunFailure(end.output) : null;
        if (failure) {
          // A claude run reports the member its grant attributed (KP18); every other runtime reports the member it was picked on.
          const who = grant === null ? member : end.attributed;
          if (who !== null) {
            const reported = after.keypools.reportSignal(pool, who, failure.signal, began);
            retry = reported.ok && reported.value.kind === "exhausted" && failure.beforeWork && headless && first === null;
          }
        }
      } finally { after.close(); }
      if (!retry) return end.code;
      first = end.code;
      skip = [...skip, member];
      current.close();
      current = openHome(home.env);
    }
  } finally { if (current !== home) current.close(); }
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
  const pool = parsed.get("pool");
  if (pool !== undefined) {
    // A caller names a pool, never a key: --connection and --member are refused (ADR-0037).
    if (parsed.get("connection") !== undefined || parsed.get("member") !== undefined) return fail(io, "usage");
    const picked = await home.keypools.pick(pool, member => prepareLease(home, parsed, member));
    if (!picked.ok) return fail(io, picked.error.problem, picked.error.exit);
    return serveLeased(home, io, picked.value.value);
  }
  const prepared = await prepareLease(home, parsed, need(parsed.get("connection")));
  if (!prepared.ok) return fail(io, prepared.error.problem, prepared.error.exit);
  return serveLeased(home, io, prepared.value);
}

type Prepared = { name: string; ref: string; holder: { lane: string | null }; workspace: string; seen: "none" | "rules" | "os"; proof: "verified" | "claimed"; id: string };

// Everything up to the lease: the Connection, the caller's proof, the gate. A refusal that is not a gate word carries no exit.
async function prepareLease(home: Opened, parsed: Parsed, name: string): Promise<{ ok: true; value: Prepared } | Failed> {
  const connection = findConnection(home.store.load().directory, name);
  if (!connection) return failed("missing");
  if (connection.status === "revoked") return failed("revoked");
  if (connection.custody !== "morndo" || connection.kind !== "api-key" || connection.runtime !== "claude" || loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return failed("not_leasable");
  const preset = presetOf(home.catalog, connection.vendor);
  if (!preset) return failed("missing");
  const holder = selfHolder(parsed.get("lane") ?? null);
  if (!holder) return failed("holder");
  const vouched = isolationOf(parsed.get("isolation") ?? "none");
  let seen = vouched;
  let proof: "verified" | "claimed" = "claimed";
  if (effectiveIsolation(connection, floorOf(preset)) === "os") {
    const pinFile = join(home.dir, PIN_FILE);
    const checked = await verifyClaudeParent({
      ppid: () => process.ppid, connection: name, pin: parsePin(procReader.file(pinFile)?.body ?? null),
      release: parseReleasePin(procReader.file(join(home.dir, RELEASE_PIN_FILE))?.body ?? null),
      verifyRelease: (version, sha256) => releaseAdmits(home.dir, version, sha256), shaCache: fileShaCache(home.dir),
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
  if (!granted.ok) return failed(granted.error.problem, granted.error.exit);
  return { ok: true, value: { name, ref: connection.ref, holder, workspace, seen, proof, id: granted.value.id } };
}

// The key goes to stdout once; the audit line lands before it is printed; the lease closes after.
async function serveLeased(home: Opened, io: Io, p: Prepared): Promise<number> {
  let outcome = "failed";
  try {
    const secret = await home.open(p.ref);
    const served = home.leases.serve(p.name, p.id, { pid: process.pid, ppid: process.ppid, lane: p.holder.lane, workspace: p.workspace, isolation: p.seen, proof: p.proof });
    if (!served.ok) return fail(io, served.error.problem);
    io.stdout(`${secret}\n`);
    outcome = "done";
    return 0;
  } catch {
    io.stderr("failed\n");
    return 1;
  } finally { home.leases.close(p.name, p.id, outcome, null); }
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
  if (parsed.get("signed") === "true") return pinReleases(home, parsed, io, baseUrls);
  const pin = pinFor(parsed.get("path") ?? "claude", home.env.PATH, baseUrls);
  if (pin === null) return fail(io, "missing");
  writeFileSync(join(home.dir, PIN_FILE), `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  io.stdout(`${JSON.stringify(pin)}\n`);
  return 0;
}

// `morndo-keys pin-claude --signed [--versions-dir D] [--floor V]` (T-346): instead of one binary, the owner pins Anthropic's
// release key (the fingerprint compiled into this build, shown here), the directory the installer keeps versions in (default
// ~/.local/share/claude/versions) and the lowest version to accept (default: the version `claude` on this shell's PATH is). A
// lease then admits any version in that directory, at or above the floor, whose sha256 a signed manifest lists: an update needs no
// new pin. The manifests are fetched by `claude-releases sync`, never by a lease.
function pinReleases(home: Opened, parsed: Parsed, io: Io, baseUrls: Record<string, string>): number {
  let versionsDir: string;
  try {
    versionsDir = realpathSync(parsed.get("versions-dir") ?? join(home.env.HOME ?? "", ".local/share/claude/versions"));
    if (!statSync(versionsDir).isDirectory()) return fail(io, "missing");
  } catch { return fail(io, "missing"); }
  let floor = parsed.get("floor");
  if (floor === undefined) {
    // the version the claude on this shell's PATH is, when it lives in that directory
    const found = pinFor("claude", home.env.PATH, {})?.resolved;
    if (found !== undefined && dirname(found) === versionsDir && isVersion(basename(found))) floor = basename(found);
  }
  if (floor === undefined || !isVersion(floor) || compareVersions(floor, CLAUDE_RELEASE_FIRST_SIGNED) < 0) return fail(io, "floor");
  const pin = { fingerprint: CLAUDE_RELEASE_FINGERPRINT, versionsDir, floor, baseUrls };
  writeFileSync(join(home.dir, RELEASE_PIN_FILE), `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  io.stdout(`${JSON.stringify(pin)}\n`);
  return 0;
}

// `morndo-keys claude-releases sync [--only V]...` (T-346): the node job that keeps the release cache filled. It fetches the
// manifest and its signature for each installed version at or above the pinned floor (and each --only), verifies them against the
// compiled-in key, and caches them only then. No secret is involved, and a lease never calls it. A failure leaves the old cache and
// exits 1, after the other versions are done; one JSON line per version says what happened.
async function claudeReleases(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  if (parsed.positionals[0] !== "sync") return fail(io, "usage");
  const pin = parseReleasePin(procReader.file(join(home.dir, RELEASE_PIN_FILE))?.body ?? null);
  if (pin === null) return fail(io, "no_release_pin");
  const versions = [...new Set([...installedVersions(pin.versionsDir, pin.floor), ...parsed.all("only").filter(isVersion).filter(version => compareVersions(version, pin.floor) >= 0)])];
  const results = await syncReleases({ home: home.dir, versions, ...(io.fetch === undefined ? {} : { fetch: io.fetch }) });
  for (const result of results) io.stdout(`${JSON.stringify(result)}\n`);
  return results.some(result => result.status === "failed") ? 1 : 0;
}

async function helper(env: NodeJS.ProcessEnv, parsed: Parsed, io: Io): Promise<number> {
  if (parsed.get("pool") !== undefined) return helperPool(env, parsed, io);
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

// `helper --pool P --grant G`: the pooled run's apiKeyHelper. One call asks the grant whether its member can still serve and, when it
// cannot, moves the run. A refusal prints its word on stderr and exits 1 — never 75, because an apiKeyHelper treats every non-zero the same.
async function helperPool(env: NodeJS.ProcessEnv, parsed: Parsed, io: Io): Promise<number> {
  const pool = parsed.get("pool");
  const grant = parsed.get("grant");
  if (pool === undefined || grant === undefined || parsed.get("lease") !== undefined) {
    io.stderr("usage\n");
    return 1;
  }
  const home = openHome(env);
  try {
    const caller = selfId();
    if (!caller) {
      io.stderr("holder\n");
      return 1;
    }
    // The gate of the member's lease is the one `run` used.
    home.runtime.current = gateRuntime(home, "claude");
    const served = await home.keypools.handOff(pool, grant, { id: caller, ppid: process.ppid });
    if (!served.ok) {
      io.stderr(`${served.error.problem}\n`);
      return 1;
    }
    const connection = findConnection(home.store.load().directory, served.value.connection);
    if (!connection || connection.custody !== "morndo" || connection.kind !== "api-key") {
      io.stderr("missing\n");
      return 1;
    }
    io.stdout(`${await home.open(connection.ref)}\n`);
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
    home.catalog, home.models, home.engines, home.keypools.routingPools(),
  );
}

function publish(home: Opened): void {
  publishOwned(home.store.load().directory, home.catalog, home.models, home.engines, home.keypools.routingPools());
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
    if (token === "--subscription" || token === "--all" || token === "--risk" || token === "--json" || token === "--report" || token === "--notify" || token === "--yes" || token === "--keep" || token === "--signed" || token === "--confirm-own-account") {
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
