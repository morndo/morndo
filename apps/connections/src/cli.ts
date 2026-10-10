// morndo-keys. The design names this morndo-connections; this build uses the name the manager asked for.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineText, findConnection, spentOf, type Actor, type Connection, type Directory, type Mode } from "@morndo/domain";
import { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand } from "@morndo/protocol";
import { findPreset as presetOf } from "./application/catalog.ts";
import { loginKeyRefused } from "./application/login-key.ts";
import { LOGIN_KEY_REFUSAL } from "./login-refusal.ts";
import { openHome, type Opened } from "./compose.ts";
import { fetchModelIds, modelMissing, sameModel, wantedModel } from "./adapters/models.ts";
import { selfHolder, selfId } from "./adapters/processes.ts";
import { ClaudeRuntime, helperCommand, isStatusRefusal } from "./adapters/runtime-claude.ts";
import { CodexRuntime, helperParts } from "./adapters/runtime-codex.ts";
import { CursorRuntime } from "./adapters/runtime-cursor.ts";
import { HELPER_LIMIT, HELPER_TTL_MS } from "./adapters/runtime-limits.ts";
import { streamRedactor } from "./adapters/redact.ts";
import { costFromOutput, modelFromOutput } from "./adapters/spend.ts";
import { resetEngines } from "./adapters/engines-file.ts";
import { commandShape } from "./adapters/engines-bin.ts";
import { adoptLayer, gateBin, gateCommand, publishOwned } from "./application/engines-sync.ts";
import { FileRefused } from "./adapters/file-mode.ts";
import { DatabaseFromFuture } from "./adapters/store-migrations.ts";

const ACTOR: Actor = { kind: "principal", command: "cli" };
const GATE = new Set(["off", "terms", "expired", "repo", "isolation", "dialect", "leases", "budget"]);
const LEASES = 8;

export type Io = { stdout: (text: string) => void; stderr: (text: string) => void; stdin?: string };

type Parsed = { cmd: string; positionals: string[]; rest: string[]; get(name: string): string | undefined; all(name: string): string[] };

export async function run(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const parsed = parse(argv);
  try {
    if (parsed.cmd === "helper") return await helper(env, parsed, io);
    return await command(env, parsed, io);
  } catch (error) {
    if (parsed.cmd === "helper") return error instanceof FileRefused || error instanceof DatabaseFromFuture ? 70 : 1;
    io.stderr(error instanceof Error ? error.message : "failed");
    return error instanceof FileRefused || error instanceof DatabaseFromFuture ? 70 : 1;
  }
}

async function command(env: NodeJS.ProcessEnv, parsed: Parsed, io: Io): Promise<number> {
  const home = openHome(env);
  try {
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
    case "spend": return spend(home, need(name), io);
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
  const model = wantedModel(preset.defaultPicks["*"]) ?? "default";
  const reserve = Number(parsed.get("reserve") ?? "5");
  const granted = ask(home, name, parsed, false, reserve);
  if (!granted.ok) return fail(io, granted.problem, granted.exit);
  const row = findConnection(home.store.load().directory, name);
  const lease = row && row.custody === "morndo" ? row.leases.find(item => item.id === granted.id) : undefined;
  if (!lease) return fail(io, "missing");
  const main = join(import.meta.dirname, "main.ts");
  const subscription = connection.kind === "subscription";
  const configDir = connection.kind === "subscription" ? connection.configDir : join(home.dir, "runtime", name);
  const plan = {
    lease: lease.id, connection: name, ref: connection.kind === "api-key" ? connection.ref : null,
    configDir, model, effort: "high", workspace: parsed.get("workspace") ?? home.env.PWD ?? process.cwd(),
    deny: [home.vaultDir, home.db, home.identity, ...(connection.repo?.deny ?? [])],
    reservation: lease.reservation, probe: false, subscription,
  };
  const bin = connection.runtime === "codex" ? home.env.MORNDO_CODEX_BIN ?? "codex" : home.env.MORNDO_CLAUDE_BIN ?? "claude";
  const baseUrl = preset.runtimes.find(item => item.runtime === connection.runtime)?.baseUrl ?? "";
  const saved = home.env;
  let released = false;
  let refusal: number | null = null;
  let status = 1;
  let stdout = "";
  let failure = "";
  let outRedactor = streamRedactor([""]);
  let errRedactor = streamRedactor([""]);
  try {
    const secret = connection.kind === "api-key" ? await home.open(connection.ref) : "";
    outRedactor = streamRedactor([secret]);
    errRedactor = streamRedactor([secret]);
    home.close();
    released = true;
    const hooks = {
      onStdout: (chunk: string) => { io.stdout(outRedactor.push(chunk)); },
      onStderr: (chunk: string) => { io.stderr(errRedactor.push(chunk)); },
    };
    const child = connection.runtime === "codex"
      ? await new CodexRuntime({
        bin, profilePath: saved.MORNDO_CODEX_CONFIG ?? join(home.dir, "codex-profile.toml"), configDir,
        ...helperParts(process.execPath, main, lease.id), baseUrl, parent: saved,
      }).execute(plan, parsed.rest, hooks)
      : connection.runtime === "cursor"
        ? await new CursorRuntime(saved.MORNDO_CURSOR_BIN ?? "agent", saved).execute(plan, parsed.rest, hooks)
        : await new ClaudeRuntime(bin, helperCommand(process.execPath, main, lease.id), saved).execute(plan, parsed.rest, hooks);
    status = child.status;
    stdout = child.stdout;
  } catch (error) {
    failure = error instanceof Error ? error.message : "run failed";
    if (isStatusRefusal(error)) refusal = 75;
    io.stderr(errRedactor.push(failure));
    status = 1;
  } finally {
    io.stdout(outRedactor.flush());
    io.stderr(errRedactor.flush());
    const again = released ? openHome(saved) : home;
    try {
      const outcome = failure !== "" ? failure : status === 0 ? "done" : "failed";
      again.leases.close(name, lease.id, outcome, costFromOutput(stdout));
      const seen = modelFromOutput(stdout);
      if (seen && !sameModel(model, seen, preset.idPatterns ?? {})) again.engines.mark(name, `model ${seen} missing`, again.now() + 3_600_000);
    } finally { if (released) again.close(); }
  }
  if (refusal !== null) return refusal;
  return status === 70 || status === 75 ? 1 : status;
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
  home.vault.remove(current.ref);
  io.stdout(`${JSON.stringify({ fingerprint: await home.vault.fingerprint(ref) })}\n`);
  return 0;
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

function ask(home: Opened, name: string, parsed: Parsed, probeLease: boolean, reserve: number): { ok: true; id: string } | { ok: false; problem: string; exit?: number } {
  const connection = findConnection(home.store.load().directory, name);
  if (!connection) return { ok: false, problem: "missing" };
  if (loginKeyRefused(home.catalog.presets(), connection.runtime, connection.kind, connection.custody)) return { ok: false, problem: LOGIN_KEY_REFUSAL };
  const holder = selfHolder(parsed.get("lane") ?? null);
  if (!holder) return { ok: false, problem: "holder" };
  home.runtime.current = gateRuntime(home, connection.runtime);
  const workspace = parsed.get("workspace") ?? home.env.PWD ?? process.cwd();
  const granted = home.leases.lease(name, {
    role: parsed.get("role") ?? "run", entry: wantedModel(presetOf(home.catalog, connection.vendor)?.defaultPicks["*"]) ?? "default",
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

function done(result: { ok: true } | { ok: false; error: { problem: string; role?: string; exit?: number } }, io: Io): number {
  if (result.ok) return 0;
  return fail(io, result.error.problem, result.error.exit, result.error.role);
}

function fail(io: Io, problem: string, exit?: number, role?: string): number {
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

function need(value: string | undefined): string {
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
    if (token === "--subscription" || token === "--all" || token === "--risk") {
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
