// `morndo-keys pool …` (ADR-0029). Exit 0 when done; 1 when refused or failed, with the reason on stderr; 75 on a gate refusal,
// as `run`. `pool exec` is one turn of the pool (design §6.8): it places the turn on a member, claims it, runs the CLI in a run
// home of its own, passes the stream through, and, when the turn ended on a usage limit in rotate mode, goes on as the same
// session on the next member.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findConnection, type Reading } from "@morndo/domain";
import { productVersion } from "@morndo/service-kit";
import type { Opened } from "./compose.ts";
import { ask, fail, need, type Io, type Parsed } from "./cli.ts";
import { readCodexAccount } from "./adapters/codex-account.ts";
import { poolStore } from "./adapters/codex-pool-home.ts";
import { spendResetCredit } from "./adapters/codex-reset.ts";
import { classifyFailure, continuationArgs, continuePrompt, handoffArgs, handoffPrompt, promptOf, resumesLast, retryAt, sessionOf } from "./adapters/codex-turn.ts";
import { selfHolder } from "./adapters/processes.ts";
import { childEnv, keysProgram, loginEnv } from "./adapters/runtime-claude.ts";
import { CodexRuntime, helperParts } from "./adapters/runtime-codex.ts";
import { usageReport, type CodexLimits } from "./adapters/usage-codex.ts";
import { type PoolRefusal, type TurnBegun, type TurnEnd } from "./application/pool-service.ts";
import { reaper } from "./reader-gone.ts";

const DEFAULT_RUNTIME = "codex";
const DEFAULT_WAIT_MS = 1_800_000;
const WAIT_FIRST_MS = 200;
const WAIT_CAP_MS = 5_000;
const DEFAULT_NIGHT = "22-7";
const TERMS_LINE = "Rotation moves a lane to another account when one reaches its limit. OpenAI's terms forbid \"circumventing any rate limits or restrictions\" (EU Terms of Use, \"What you cannot do\"); whether rotation across your own paid accounts is allowed is for you to judge. Turn it on only if you accept that.";

const runtimeOf = (parsed: Parsed): string => parsed.get("runtime") ?? DEFAULT_RUNTIME;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// How long a turn waits for a busy account: 200 ms, doubling to 5 s. A wait that is not a number of milliseconds is the default.
export function waitDelay(attempt: number): number {
  return Math.min(WAIT_FIRST_MS * 2 ** attempt, WAIT_CAP_MS);
}

export function waitLimit(text: string | undefined): number {
  const n = Number(text);
  return text !== undefined && text.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

type Seated<T> = { ok: true; value: T } | { ok: false; error: PoolRefusal };

// Tries until it is not told that the member is busy, or the wait is up. The clock and the sleep are the caller's.
export async function awaitSeat<T>(o: {
  attempt(): Seated<T>; waitMs: number; now(): number; sleep(ms: number): Promise<void>; onWait(member: string): void; stopped?(): boolean;
}): Promise<Seated<T>> {
  const deadline = o.now() + o.waitMs;
  let said = false;
  for (let n = 0; ; n++) {
    const got = o.attempt();
    if (got.ok || got.error.kind !== "busy" || o.now() >= deadline || o.stopped?.() === true) return got;
    if (!said) { o.onWait(got.error.member); said = true; }
    await o.sleep(Math.min(waitDelay(n), deadline - o.now()));
  }
}

// Whether `at` falls in the night hours "from-to" (local, wrapping past midnight) of a time zone: when a kept member's reserve holds.
export function isNight(at: number, zone: string, hours: string): boolean {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(hours);
  if (!m) return false;
  const from = Number(m[1]);
  const to = Number(m[2]);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "numeric" }).format(new Date(at)));
  return from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;
}
const when = (at: number | null | undefined): string => (at == null ? "unknown time" : new Date(at).toISOString());

export async function poolCommand(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const sub = parsed.positionals[0] ?? "";
  const target = parsed.positionals[1];
  const runtime = runtimeOf(parsed);
  switch (sub) {
    case "add": return add(home, need(target), parsed, io);
    case "remove": return done(home.pool.remove(runtimeFor(home, target, runtime), need(target)), io);
    case "retire": return done(home.pool.retire(runtimeFor(home, target, runtime), need(target), parsed.get("why") ?? "retired by hand"), io);
    case "activate": return done(home.pool.activate(runtimeFor(home, target, runtime), need(target)), io);
    case "set": return set(home, runtime, parsed, io);
    case "mode": return mode(home, runtime, parsed, io);
    case "list": return list(home, runtime, parsed, io);
    case "read": return read(home, runtime, parsed, io);
    case "exec": return exec(home, runtime, parsed, io);
    case "move": return done(home.pool.move(runtime, need(parsed.get("session")), need(parsed.get("to")), parsed.get("by") ?? ""), io);
    case "check": return check(home, runtime, io);
    case "advice": return advice(home, runtime, parsed, io);
    case "reset": return reset(home, runtime, parsed, io);
    default: return fail(io, "unknown pool command");
  }
}

// A member's runtime is its Connection's; the flag names it for the commands that have no Connection.
function runtimeFor(home: Opened, name: string | undefined, fallback: string): string {
  const row = name === undefined ? null : findConnection(home.store.load().directory, name);
  return row?.runtime ?? fallback;
}

function done(result: { ok: true } | { ok: false; error: PoolRefusal }, io: Io): number {
  return result.ok ? 0 : fail(io, result.error.problem, result.error.exit);
}

function add(home: Opened, name: string, parsed: Parsed, io: Io): number {
  const row = findConnection(home.store.load().directory, name);
  const expires = parsed.get("expires");
  const at = expires === undefined ? null : /^\d{4}-\d{2}-\d{2}$/.test(expires) ? Date.parse(`${expires}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(at)) return fail(io, "expires: give a date as YYYY-MM-DD");
  return done(home.pool.add(row?.runtime ?? runtimeOf(parsed), name, { keep: parsed.get("keep") === "true", expires: at, onlyFor: parsed.all("only-for") }), io);
}

const NUMBERS = new Set(["shortMinLeft", "longMinLeft", "pickMarginShort", "pickMarginLong", "nightReserveLong", "turnsPerMember", "activeMinutes", "defaultMarkMinutes", "maxMarkHours", "resetAdviceWaitHours", "creditAdviceHours"]);

function set(home: Opened, runtime: string, parsed: Parsed, io: Io): number {
  const key = need(parsed.positionals[1]);
  const text = need(parsed.positionals[2]);
  const by = parsed.get("by") ?? null;
  if (NUMBERS.has(key)) return done(home.pool.setSettings(runtime, { [key]: Number(text) }, by), io);
  if (key === "defaultMember") return done(home.pool.setSettings(runtime, { defaultMember: text === "none" ? null : text }, by), io);
  if (key === "order" && (text === "weighted" || text === "soonest-reset")) return done(home.pool.setSettings(runtime, { order: text }, by), io);
  if (key === "moveBy" && (text === "resume" || text === "handoff")) return done(home.pool.setSettings(runtime, { moveBy: text }, by), io);
  return fail(io, `unknown setting or value: ${key} ${text}`);
}

function mode(home: Opened, runtime: string, parsed: Parsed, io: Io): number {
  const wanted = parsed.positionals[1];
  if (wanted !== "pinned" && wanted !== "rotate") return fail(io, "mode: pinned or rotate");
  if (wanted === "rotate") io.stdout(`${TERMS_LINE}\n`);
  return done(home.pool.setMode(runtime, wanted, parsed.get("by") ?? null), io);
}

function list(home: Opened, runtime: string, parsed: Parsed, io: Io): number {
  const out = home.pool.list(runtime);
  if (parsed.get("json") === "true") { io.stdout(`${JSON.stringify(out)}\n`); return 0; }
  io.stdout(`mode ${out.settings.mode}, default ${out.settings.defaultMember ?? "none"}, moveBy ${out.settings.moveBy}\n`);
  const pct = (n: number | null): string => (n === null ? "?" : `${n}%`);
  for (const s of out.seats) {
    io.stdout(`${s.member}\t${s.state}${s.sameAs ? ` (same account as ${s.sameAs})` : ""}\tshort ${pct(s.shortLeft)} left\tlong ${pct(s.longLeft)} left\t${s.backAt === null ? "" : `back ${when(s.backAt)}`}\n`);
  }
  return 0;
}

// The reading's windows as the limits the status-line report takes (M2).
function limitsOf(reading: Omit<Reading, "member" | "at">): CodexLimits {
  const [first, second] = [...reading.windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  const win = (w: typeof first) => (w ? { usedPercent: w.usedPercent, windowDurationMins: w.minutes, resetsAt: w.resetsAt === null ? null : Math.floor(w.resetsAt / 1000) } : null);
  return { primary: win(first), secondary: win(second), planType: reading.plan, others: [] };
}

function codexEnv(home: Opened, configDir: string | null): NodeJS.ProcessEnv {
  return childEnv(home.env, loginEnv("codex", configDir));
}

function codexBin(home: Opened): string {
  return home.env.MORNDO_CODEX_BIN ?? "codex";
}

async function readOne(home: Opened, runtime: string, member: string, report: boolean, io: Io): Promise<number> {
  const row = findConnection(home.store.load().directory, member);
  if (!row || row.custody !== "morndo" || row.kind !== "subscription") return fail(io, `no such pool member: ${member}`);
  const holder = selfHolder(null);
  if (!holder) return fail(io, "holder");
  const id = randomUUID();
  const held = home.pool.hold(runtime, member, id, holder);
  if (!held.ok) {
    if (held.error.problem.endsWith("is busy")) { io.stderr(`${member}: busy, read skipped\n`); return 0; }
    return fail(io, held.error.problem, held.error.exit);
  }
  try {
    const read = await readCodexAccount({ bin: codexBin(home), env: codexEnv(home, row.configDir), version: productVersion() });
    if (!read.ok) return fail(io, `${member}: ${read.problem}`);
    home.pool.record(runtime, { member, at: home.now(), ...read.reading });
    if (report) {
      if (!read.reading.signedIn || read.reading.windows.length === 0) return fail(io, `${member}: no usage window`);
      io.stdout(`${JSON.stringify(usageReport(limitsOf(read.reading), `${member}-limits`))}\n`);
    }
    return 0;
  } finally { home.pool.release(runtime, id); }
}

async function read(home: Opened, runtime: string, parsed: Parsed, io: Io): Promise<number> {
  const report = parsed.get("report") === "true";
  if (parsed.get("all") === "true") {
    let code = 0;
    for (const seat of home.pool.list(runtime).seats) code = Math.max(code, await readOne(home, runtime, seat.member, false, io));
    return code;
  }
  return readOne(home, runtime, need(parsed.get("member")), report, io);
}

function check(home: Opened, runtime: string, io: Io): number {
  const usable = home.pool.usable(runtime);
  if (usable.length === 0) return fail(io, "no pool member is on, acknowledged and signed in");
  io.stdout(`${usable.join(" ")}\n`);
  return 0;
}

async function advice(home: Opened, runtime: string, parsed: Parsed, io: Io): Promise<number> {
  const notify = parsed.get("notify") === "true";
  const advised = notify ? home.pool.adviceOnce(runtime) : home.pool.advice(runtime);
  if (!advised) return 0;
  const first = advised.reason === "all-blocked"
    ? `Reset credit: ${advised.member} is blocked until ${when(advised.backAt)} and work waits.`
    : `Reset credit: one on ${advised.member} lapses ${when(advised.creditExpiresAt)}.`;
  const text = `${first}\nUse one now? Default: wait. To use it: morndo-keys pool reset --runtime ${runtime} --member ${advised.member} --by <you> --yes`;
  io.stdout(`${text}\n`);
  const url = home.env.MORNDO_POOL_NOTIFY_URL;
  if (notify && url) {
    try { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) }); }
    catch { io.stderr("notice not delivered\n"); }
  }
  return 0;
}

async function reset(home: Opened, runtime: string, parsed: Parsed, io: Io): Promise<number> {
  const by = parsed.get("by") ?? "";
  const member = need(parsed.get("member"));
  if (by.trim() === "" || parsed.get("yes") !== "true") return fail(io, "spending a reset credit needs --by: who decided it, and --yes");
  const row = findConnection(home.store.load().directory, member);
  if (!row || row.custody !== "morndo" || row.kind !== "subscription") return fail(io, `no such pool member: ${member}`);
  const holder = selfHolder(null);
  if (!holder) return fail(io, "holder");
  const id = randomUUID();
  const held = home.pool.hold(runtime, member, id, holder);
  if (!held.ok) return fail(io, held.error.problem, held.error.exit);
  try {
    const spent = await spendResetCredit({ bin: codexBin(home), env: codexEnv(home, row.configDir), version: productVersion(), key: randomUUID() });
    if (!spent.ok) return fail(io, `${member}: ${spent.problem}`);
    home.pool.spent(runtime, member, by, spent.outcome);
    io.stdout(`${spent.outcome}\n`);
    return 0;
  } finally { home.pool.release(runtime, id); }
}

// ---- one turn

const line = (io: Io, event: object): void => { io.stdout(`${JSON.stringify(event)}\n`); };
const failedEvent = (io: Io, message: string): void => line(io, { type: "turn.failed", error: { message } });
const noteEvent = (io: Io, message: string): void => line(io, { type: "error", message });

function modelOf(args: readonly string[]): string | null {
  const at = args.findIndex(a => a === "-m" || a === "--model");
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

// What a refused start says, by the kind of refusal. A usage limit is told as the CLI would tell it, so the engine layer
// classifies it as one; a busy member is only busy, and says so on stderr.
function refusedStart(home: Opened, runtime: string, error: PoolRefusal, session: string | null, io: Io): number {
  const names = (): string[] => home.pool.list(runtime).seats.filter(s => s.state === "out" || s.state === "low").map(s => s.member);
  switch (error.kind) {
    case "session-busy": return fail(io, `session ${session ?? ""} is being written by pid ${error.holder.pid}`, error.exit);
    case "no-seat":
      failedEvent(io, `You’ve hit your usage limit on every pool account (${names().join(", ")}). The first is back at ${when(error.backAt)}.`);
      return 1;
    case "unavailable":
      if (error.state === "logged-out") failedEvent(io, `${error.member} is not signed in: sign it in again`);
      else if (error.state === "retired") failedEvent(io, `${error.member} is retired from the pool`);
      else failedEvent(io, `You’ve hit your usage limit on ${error.member}. It is back at ${when(error.backAt)}.`);
      return 1;
    case "busy": case "no-default": case "gate": case "input": return fail(io, error.problem, error.exit);
  }
}

type Turn = { status: number; held: string | null; messages: string[]; thread: string | null };

async function exec(home: Opened, runtime: string, parsed: Parsed, io: Io): Promise<number> {
  const args = parsed.rest;
  const prompt = promptOf(args);
  if (args[0] !== "exec" || prompt === null) return fail(io, "pool exec runs `exec … <prompt>`; the prompt must be the last argument, and - (stdin) is not accepted");
  if (resumesLast(args)) return fail(io, "pool exec can't place `exec resume --last`: it continues whichever session is newest, on no account in particular. Give the session id.");
  const session = sessionOf(args);
  const lane = parsed.get("lane") ?? null;
  const holder = selfHolder(lane);
  if (!holder) return fail(io, "holder");
  const dir = parsed.get("workspace") ?? home.env.PWD ?? process.cwd();
  const waitMs = waitLimit(home.env.MORNDO_POOL_WAIT_MS);
  const model = modelOf(args);
  const zone = home.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const night = (): boolean => isNight(home.now(), zone, home.env.MORNDO_POOL_NIGHT ?? DEFAULT_NIGHT);
  const store = poolStore(home.env.MORNDO_POOL_DATA ?? join(home.env.HOME ?? homedir(), ".local/share/morndo/pool"), runtime);
  const keys = keysProgram(home.env.HOME ?? "", home.env.MORNDO_KEYS, existsSync, { command: process.execPath, args: ["--experimental-strip-types", join(import.meta.dirname, "main.ts")] });

  let stopped: number | null = null;
  let childPid: number | null = null;
  // The stop goes to the turn's group: SIGTERM, then SIGKILL after the grace for what ignores it, and the kill is kept until the
  // group is gone, not until the output pipes close (reader-gone.ts). `cutShort`: the turn was really stopped (a live group got the
  // signal, or nothing was spawned), so the exit code is the signal's; a signal after a clean finish changes neither it nor the lease.
  const reap = reaper();
  let cutShort = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    stopped = signal === "SIGINT" ? 130 : 143;
    if (childPid !== null && reap.stop([-childPid])) cutShort = true;
  };
  const term = (): void => onSignal("SIGTERM");
  const int = (): void => onSignal("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  // A reader that is gone (reader-gone.ts) stops the turn as a SIGTERM would: no account's budget is spent on unread output.
  io.gone?.addEventListener("abort", term, { once: true });
  if (io.gone?.aborted) term();

  const claimId = randomUUID();
  // Starts a turn on a session, waiting while the member is busy (backing off), saying so once.
  const begin = (on: string | null): Promise<Seated<TurnBegun>> => awaitSeat({
    attempt: () => home.pool.begin({ runtime, claimId, session: on, pin: parsed.get("account") ?? null, dir, night: night(), model, holder }),
    waitMs, now: () => Date.now(), sleep, stopped: () => stopped !== null,
    onWait: member => { noteEvent(io, `[pool] waiting: a turn runs on ${member}`); },
  });

  const runOnce = async (current: TurnBegun, argv: readonly string[]): Promise<Turn> => {
    const row = findConnection(home.store.load().directory, current.member);
    const entry = modelOf(argv) ?? "default";
    const granted = ask(home, current.member, parsed, false, Number(parsed.get("reserve") ?? "5"), entry);
    if (!granted.ok) {
      home.pool.release(runtime, current.claimId);
      throw Object.assign(new Error(granted.problem), { exit: granted.exit });
    }
    const lease = row?.custody === "morndo" ? findConnection(home.store.load().directory, current.member) : null;
    const leaseRow = lease && lease.custody === "morndo" ? lease.leases.find(l => l.id === granted.id) : undefined;
    const plan = {
      lease: granted.id, connection: current.member, ref: null, configDir: current.configDir, model: entry === "default" ? "" : entry, effort: "",
      workspace: dir, deny: [home.vaultDir, home.db, home.identity, ...(row?.repo?.deny ?? [])], reservation: leaseRow?.reservation ?? 0, probe: false, subscription: true,
    };
    home.pool.started(runtime, current.claimId);
    const turn: Turn = { status: 1, held: null, messages: [], thread: session };
    let buffer = "";
    const take = (text: string): void => {
      buffer += text;
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const one = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        handle(one);
      }
    };
    const handle = (one: string): void => {
      type Event = { type?: string; thread_id?: string; message?: string; error?: { message?: string } };
      let event: Event | null = null;
      try { event = JSON.parse(one) as Event; } catch { event = null; }
      if (event?.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id !== turn.thread) {
        turn.thread = event.thread_id;
        const bound = home.pool.bind(runtime, current.claimId, event.thread_id);
        if (!bound.ok) io.stderr(`${bound.error.problem}\n`);
      }
      const message = event?.type === "turn.failed" ? event.error?.message : event?.type === "error" ? event.message : undefined;
      if (typeof message === "string") turn.messages.push(message);
      if (event?.type === "turn.failed") { turn.held = one; return; }
      io.stdout(`${one}\n`);
    };
    const codexHelper = helperParts(keys.command, granted.id);
    const runtimeCodex = new CodexRuntime({
      bin: codexBin(home), profilePath: home.env.MORNDO_CODEX_CONFIG ?? join(home.dir, "codex-profile.toml"), configDir: current.configDir,
      command: codexHelper.command, args: [...keys.args, ...codexHelper.args], baseUrl: "", parent: home.env,
    });
    let outcome = "failed";
    try {
      const result = await runtimeCodex.execute(plan, argv, {
        onStdout: take, onStderr: text => { io.stderr(text); }, onStart: pid => { childPid = pid; }, proceed: () => { if (stopped !== null) cutShort = true; return stopped === null; },
      }, store);
      if (buffer !== "") { handle(buffer); buffer = ""; }
      turn.status = cutShort && result.status === 0 ? 1 : result.status;   // a launcher may exit 0 on the signal
      outcome = turn.status === 0 ? "done" : "failed";
    } catch (error) {
      outcome = error instanceof Error ? error.message : "run failed";
      home.leases.close(current.member, granted.id, outcome, null);
      home.pool.release(runtime, current.claimId);
      throw error;
    } finally {
      childPid = null;
      await reap.settle();
    }
    home.leases.close(current.member, granted.id, outcome, null);
    return turn;
  };

  const endOf = (turn: Turn): TurnEnd => {
    const failure = classifyFailure(turn.messages);
    if (failure.kind === "usage-limit") {
      const named = turn.messages.map(m => retryAt(m, home.now(), zone)).find((t): t is number => t !== null) ?? null;
      return { kind: "usage-limit", resetAt: named, model: failure.model ? model : null };
    }
    return { kind: failure.kind };
  };

  try {
    const first = await begin(session);
    if (!first.ok) return refusedStart(home, runtime, first.error, session, io);
    let current = first.value;
    const tried = new Set<string>();
    let argv: readonly string[] = args;
    if (current.moved) {
      const handoff = current.continueBy === "handoff" && session !== null;
      noteEvent(io, `[pool] ${current.moved.from} can't take this turn (${current.moved.why}); it goes on ${handoff ? "as a new session" : "as the same session"} on ${current.member}`);
      if (handoff && session !== null) argv = handoffArgs(args, handoffPrompt(session, prompt));
    }
    for (;;) {
      tried.add(current.member);
      let turn: Turn;
      try { turn = await runOnce(current, argv); }
      catch (error) {
        const exit = (error as { exit?: number }).exit;
        io.stderr(`${error instanceof Error ? error.message : "run failed"}\n`);
        return exit ?? 1;
      }
      if (stopped !== null && cutShort) { home.pool.end(runtime, current.claimId, { kind: "other" }); return stopped; }
      if (turn.status === 0) { home.pool.end(runtime, current.claimId, { kind: "done" }); return 0; }
      const ended = endOf(turn);
      const out = home.pool.end(runtime, current.claimId, ended, { dir, night: night(), tried: [...tried] });
      const known = turn.thread ?? session;
      let next = out.next;
      let refusal = out.refusal;
      if (next === null && ended.kind === "usage-limit" && refusal?.kind === "busy") {
        // The failed member is out, and every free one is busy: wait for one, as a start of the same session.
        const again = await begin(known);
        if (again.ok) { next = again.value; refusal = null; } else refusal = again.error;
      }
      if (next) {
        if (ended.kind === "usage-limit") noteEvent(io, `[pool] ${current.member} reached its usage limit; this turn goes on as the same session on ${next.member}`);
        argv = next.continueBy === "handoff" || ended.kind === "unreadable"
          ? handoffArgs(args, handoffPrompt(known ?? "unknown", prompt))
          : known === null ? args : continuationArgs(args, known, continuePrompt(prompt));
        current = next;
        continue;
      }
      if (ended.kind === "usage-limit" && refusal?.kind === "no-seat") {
        const names = home.pool.list(runtime).seats.filter(s => s.state === "out" || s.state === "low").map(s => s.member);
        failedEvent(io, `You’ve hit your usage limit on every pool account (${names.join(", ")}). The first is back at ${when(refusal.backAt)}.`);
      } else if (ended.kind === "usage-limit" && refusal?.kind === "busy") {
        return fail(io, refusal.problem, refusal.exit);
      } else if (turn.held !== null) io.stdout(`${turn.held}\n`);
      return turn.status === 0 ? 1 : turn.status;
    }
  } finally {
    process.off("SIGTERM", term);
    process.off("SIGINT", int);
    io.gone?.removeEventListener("abort", term);
  }
}
