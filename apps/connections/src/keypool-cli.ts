// `morndo-keys keypool …` (ADR-0037). Exit 0 when done; 1 when refused, with the reason word on stderr. A pick that is refused (the pool
// is empty or blocked, a gate says no) exits 75, as `lease` and `run` do. `create`, `add`, `move` and `revive` are the principal's
// (KP10): the command id is "cli", as every other command of this bin.
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { findConnection, isKey, isSinkPath, type Actor, type Outcome } from "@morndo/domain";
import type { ProbeResult, RefusalTarget, ReportBy } from "./application/key-pool-service.ts";
import type { Opened } from "./compose.ts";
import { fail, gateRuntime, need, pooledProbe, prepareLease, serveLeased, type Io, type Parsed } from "./cli.ts";
import { ENV_NAME, envPathProblem, writeEnvFile } from "./adapters/env-file.ts";
import { lineScanner, redactingWriter, type Verdict } from "./adapters/log-watch.ts";
import { signalFromHook } from "./adapters/outcome-anthropic.ts";
import { selfHolder, selfId } from "./adapters/processes.ts";

const ACTOR: Actor = { kind: "principal", command: "cli" };
const HOUR = 3_600_000;
const DAY = 86_400_000;
// A hook's payload is read, classified and dropped; more than this is not one.
const HOOK_STDIN_LIMIT = 65_536;

type Done = { ok: true } | { ok: false; error: { problem: string; exit?: number } };

function done(result: Done, io: Io): number {
  return result.ok ? 0 : fail(io, result.error.problem, result.error.exit);
}

// "24h", "6h", "2d": a number of hours or days.
export function durationOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = /^(\d+)(h|d)$/.exec(text);
  if (!match) throw new Error("recheck: give hours or days, like 24h or 2d");
  return Number(match[1]) * (match[2] === "h" ? HOUR : DAY);
}

function modeOf(text: string | undefined): "round-robin" | "drain" | undefined {
  if (text === undefined) return undefined;
  if (text === "round-robin" || text === "drain") return text;
  throw new Error("mode: round-robin or drain");
}

const EXHAUSTED_REASONS = ["credit", "spend-limit"] as const;
const FAILING_REASONS = ["rejected", "denied", "held", "cap"] as const;

// What the owner or a server says happened to a member's key. `ok` stands for a real Messages request that was answered.
function outcomeOf(kind: string | undefined, reason: string | undefined): Outcome | null {
  if (kind === "exhausted") {
    const why = EXHAUSTED_REASONS.find(item => item === (reason ?? "credit"));
    return why ? { kind: "exhausted", reason: why, resumeAt: null } : null;
  }
  if (kind === "failing") {
    const why = FAILING_REASONS.find(item => item === (reason ?? "rejected"));
    return why ? { kind: "failing", reason: why } : null;
  }
  if (kind === "limited") return reason === undefined ? { kind: "limited", retryAfterMs: null } : null;
  if (kind === "ok") return reason === undefined ? { kind: "ok", evidence: "messages" } : null;
  return null;
}

export async function keyPoolCommand(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const sub = parsed.positionals[0] ?? "";
  const pool = parsed.positionals[1];
  const member = parsed.positionals[2];
  const confirmOwn = parsed.get("confirm-own-account") === "true";
  switch (sub) {
    case "create": return create(home, need(pool), parsed.positionals.slice(2), parsed, io);
    case "add": return done(home.keypools.join(need(pool), need(member), { confirmOwn }, ACTOR), io);
    case "remove": return done(home.keypools.leave(need(pool), need(member), ACTOR), io);
    case "move": return done(home.keypools.move(need(pool), need(member), Number(need(parsed.get("to"))), ACTOR), io);
    case "policy": {
      const mode = modeOf(parsed.get("mode"));
      const recheckEveryMs = durationOf(parsed.get("recheck"));
      return done(home.keypools.setPolicy(need(pool), { ...(mode === undefined ? {} : { mode }), ...(recheckEveryMs === undefined ? {} : { recheckEveryMs }) }, ACTOR), io);
    }
    case "list":
      for (const view of home.keypools.list()) io.stdout(`${JSON.stringify(view)}\n`);
      return 0;
    case "report": {
      if (parsed.get("from-hook") === "true") return reportFromHook(home, need(pool), parsed, io);
      const outcome = outcomeOf(parsed.get("outcome"), parsed.get("reason"));
      if (outcome === null) return fail(io, "outcome");
      const grant = parsed.get("grant");
      if (grant !== undefined) {
        // The grant names the member. A lane may not also name a member or a lease.
        if (parsed.get("member") !== undefined || parsed.get("lease") !== undefined) return fail(io, "usage");
        const caller = selfId();
        if (caller === null) return fail(io, "holder");
        const reported = home.keypools.reportByGrant(need(pool), grant, outcome, home.now(), { kind: "holder", caller });
        if (reported.ok) await probeSuspect(home, need(pool), reported.value.suspect);
        return done(reported, io);
      }
      // With --lease the caller is a lane, and may report only for the member of that open lease, as the process that holds it or one of its
      // children; without it the caller is the principal at the machine (the same trust as every other command of this bin).
      const lease = parsed.get("lease");
      const caller = lease === undefined ? null : selfId();
      if (lease !== undefined && caller === null) return fail(io, "holder");
      const by: ReportBy = lease === undefined || caller === null ? ACTOR : { kind: "lane", lease, caller: { pid: caller.pid, startedAt: caller.startedAt, bootId: caller.bootId } };
      return done(home.keypools.report(need(pool), need(parsed.get("member")), outcome, home.now(), by), io);
    }
    case "sink": return sink(home, parsed, io);
    case "write-env": return writeEnv(home, need(pool), parsed, io);
    case "watch": return watch(home, need(pool), parsed, io);
    case "sync": return done(home.keypools.sync(), io);
    case "recheck": return recheck(home, parsed, io);
    case "revive": return done(home.keypools.revive(need(pool), need(member), ACTOR), io);
    case "delete": return done(home.keypools.delete(need(pool), ACTOR), io);
    default: return fail(io, "usage");
  }
}

// `keypool sink add|remove|list <pool> [path]` (KP20): the files `write-env` writes a pool's key to. A registered path is denied to the lanes' tools
// (the launcher reads every pool's sinks), so it may not lie in the connections home, where the vault is, and must not be a directory.
function sink(home: Opened, parsed: Parsed, io: Io): number {
  const action = parsed.positionals[1];
  const pool = parsed.positionals[2];
  const path = parsed.positionals[3];
  if (pool === undefined || (action !== "add" && action !== "remove" && action !== "list")) return fail(io, "usage");
  if (action === "list") {
    const paths = home.keypools.sinksOf(pool);
    if (paths === null) return fail(io, "missing");
    for (const row of paths) io.stdout(`${JSON.stringify({ pool, path: row })}\n`);
    return 0;
  }
  if (path === undefined) return fail(io, "usage");
  if (action === "remove") return done(home.keypools.removeSink(pool, path, ACTOR), io);
  if (!isSinkPath(path)) return fail(io, "bad_path");
  if (insideHome(home.dir, path)) return fail(io, "sink_protected");
  if (isDirectory(path)) return fail(io, "sink_directory");
  return done(home.keypools.addSink(pool, path, ACTOR), io);
}

function insideHome(dir: string, path: string): boolean {
  const roots = new Set([dir]);
  try { roots.add(realpathSync(dir)); } catch { /* a home that is gone protects nothing */ }
  return [...roots].some(root => path === root || path.startsWith(`${root}/`));
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

// `keypool write-env <pool> --file <sink> --var NAME [--if-due [--rotate-every D]]` (plan 3.6): the picked member's key goes to a registered sink under one
// gated lease, KeyServed written before the file, the lease closed after. The place is checked before any lease is taken. Words only on stdout and stderr.
async function writeEnv(home: Opened, pool: string, parsed: Parsed, io: Io): Promise<number> {
  const file = parsed.get("file");
  const name = parsed.get("var");
  const ifDue = parsed.get("if-due") === "true";
  const rotate = parsed.get("rotate-every");
  if (file === undefined || name === undefined || (rotate !== undefined && !ifDue)) return fail(io, "usage");
  const state = home.keypools.state(pool);
  if (state === null) return fail(io, "missing");
  if (!ENV_NAME.test(name)) return fail(io, "bad_name");
  let rotateMs: number | undefined;
  try { rotateMs = durationOf(rotate); } catch { return fail(io, "usage"); }
  if (rotateMs !== undefined && state.mode === "drain") return fail(io, "usage");
  if (!(home.keypools.sinksOf(pool) ?? []).includes(file)) return fail(io, "not_a_sink");
  const protectedDirs = [home.dir];
  const problem = envPathProblem(file, protectedDirs);
  if (problem !== null) return fail(io, problem);
  if (ifDue && !due(state.members, file, rotateMs)) {
    io.stdout(`${JSON.stringify({ pool, written: false, why: "not_due" })}\n`);
    return 0;
  }
  const picked = await home.keypools.pick(pool, member => prepareLease(home, parsed, member), pooledProbe(home, pool, parsed.get("lane") ?? null));
  if (!picked.ok) return fail(io, picked.error.problem, picked.error.exit);
  const { member, value } = picked.value;
  const code = await serveLeased(home, io, value, secret => {
    const written = writeEnvFile({ path: file, name, value: secret, member, protectedDirs });
    return written.ok ? null : written.problem;
  });
  if (code === 0) io.stdout(`${JSON.stringify({ pool, written: true, member })}\n`);
  return code;
}

// Is a rewrite due: the file or its sidecar is missing, the sidecar is older than the file (a write cut short), the member it names can no
// longer serve or has left the pool, or `rotate` has passed since the file was written.
function due(members: readonly { credential: string; state: string }[], file: string, rotate: number | undefined): boolean {
  const sidecar = `${file}.member`;
  if (!existsSync(file) || !existsSync(sidecar)) return true;
  const written = statSync(file).mtimeMs;
  if (statSync(sidecar).mtimeMs < written) return true;
  const named = readFileSync(sidecar, "utf8").trim();
  if (members.find(row => row.credential === named)?.state !== "active") return true;
  return rotate !== undefined && Date.now() - written >= rotate;
}

const WATCH_POLL_MS = 250;
const WATCH_ONCE_MS = 10_000;
const READ_CHUNK = 65_536;
// What a verdict is told to the pool as: a canned phrase, never a part of the log line.
const WATCH_SIGNAL: Readonly<Record<Exclude<Verdict, "none">, string>> = {
  "exhausted-credit": "credit balance is too low",
  "exhausted-spend": "you have reached your specified API usage limits",
};

// `keypool watch <pool> --log <file> (--member M | --sink <sink>) [--once]` (plan 3.6). The matched line is never printed or kept: a verdict is a word,
// the report names the member, a member is reported at most once in ten seconds, and what is printed passes the exact-value filter of the pool's keys.
async function watch(home: Opened, pool: string, parsed: Parsed, io: Io): Promise<number> {
  const log = parsed.get("log");
  const named = parsed.get("member");
  const sinkPath = parsed.get("sink");
  const once = parsed.get("once") === "true";
  if (log === undefined || (named === undefined) === (sinkPath === undefined)) return fail(io, "usage");
  const state = home.keypools.state(pool);
  if (state === null) return fail(io, "missing");
  if (named !== undefined && !state.members.some(row => row.credential === named)) return fail(io, "missing");
  if (sinkPath !== undefined && !(home.keypools.sinksOf(pool) ?? []).includes(sinkPath)) return fail(io, "not_a_sink");
  if (once && !existsSync(log)) return fail(io, "no_log");
  const secrets: string[] = [];
  for (const row of state.members) {
    const connection = findConnection(home.store.load().directory, row.credential);
    if (!connection || !isKey(connection) || connection.custody !== "morndo") continue;
    try { secrets.push(await home.open(connection.ref)); } catch { /* not readable: nothing to filter */ }
  }
  const print = redactingWriter(text => { io.stdout(text); }, secrets);
  const reportedAt = new Map<string, number>();
  const memberNow = (): string | null => {
    if (named !== undefined) return named;
    try { return readFileSync(`${sinkPath ?? ""}.member`, "utf8").trim() || null; } catch { return null; }
  };
  const act = (verdicts: readonly Verdict[]): void => {
    for (const verdict of verdicts) {
      if (verdict === "none") continue;
      const member = memberNow();
      if (member === null) continue;
      const last = reportedAt.get(member);
      if (last !== undefined && Date.now() - last < WATCH_ONCE_MS) continue;
      const signal = { status: null, kind: null, text: WATCH_SIGNAL[verdict], retryAfterSeconds: null, code: null, resumeDate: null };
      const reported = home.keypools.reportRefusal(pool, { kind: "member", member }, signal, home.now());
      if (!reported.ok || reported.value.outcome !== "exhausted") continue;
      reportedAt.set(member, Date.now());
      print(`${JSON.stringify({ pool, member, outcome: "exhausted" })}\n`);
    }
  };
  // Where the log is read from: its end when it is there at the start; the start of a file that appears later, is truncated or is replaced.
  let offset = 0;
  let inode: number | null = null;
  let scanner = lineScanner();
  let decoder = new StringDecoder("utf8");
  let first = true;
  for (;;) {
    let size = -1;
    let ino = -1;
    try { const found = statSync(log); size = found.size; ino = found.ino; } catch { /* not there (yet) */ }
    if (size >= 0) {
      let renewed = false;
      if (first && !once) offset = size;
      else if ((inode !== null && ino !== inode) || size < offset) { offset = 0; renewed = true; }
      if (renewed) { scanner = lineScanner(); decoder = new StringDecoder("utf8"); }
      inode = ino;
      first = false;
      const fd = openSync(log, "r");
      try {
        const buffer = Buffer.alloc(READ_CHUNK);
        while (offset < size) {
          const got = readSync(fd, buffer, 0, Math.min(READ_CHUNK, size - offset), offset);
          if (got <= 0) break;
          offset += got;
          act(scanner.push(decoder.write(buffer.subarray(0, got))));
        }
      } finally { closeSync(fd); }
    } else if (first) {
      first = false;
    } else {
      inode = null;
      offset = 0;
    }
    if (once || io.gone?.aborted) return 0;
    await new Promise<void>(resolve => { setTimeout(resolve, WATCH_POLL_MS); });
  }
}

// A KP18 report that fell back to the hand-off window names the current member to suspect: one claimed probe of it decides.
async function probeSuspect(home: Opened, pool: string, suspect: string | null): Promise<void> {
  if (suspect === null) return;
  const runtime = home.keypools.state(pool)?.runtime;
  if (runtime === undefined) return;
  home.runtime.current = gateRuntime(home, runtime);
  const holder = selfHolder(null);
  if (holder) await home.keypools.probeMember(pool, suspect, { why: "suspect", holder });
}

// `keypool report <pool> (--member M | --grant G | --served) --from-hook`: the agent CLI's StopFailure payload on stdin, read, classified and dropped. Only a
// refusal of the key is applied (exhausted, failing); the line printed is the pool and a word, never the payload. The hook's own exit code is
// ignored by the CLI, so a payload that is no refusal exits 0 as `ignored`.
async function reportFromHook(home: Opened, pool: string, parsed: Parsed, io: Io): Promise<number> {
  const member = parsed.get("member");
  const grant = parsed.get("grant");
  const served = parsed.get("served") === "true";
  if ([member !== undefined, grant !== undefined, served].filter(Boolean).length !== 1) return fail(io, "usage");
  for (const refused of ["lease", "outcome", "reason"]) if (parsed.get(refused) !== undefined) return fail(io, "usage");
  const text = io.stdin ?? "";
  if (Buffer.byteLength(text) > HOOK_STDIN_LIMIT) return fail(io, "too_big");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return fail(io, "payload"); }
  const signal = signalFromHook(payload);
  if (signal === null) {
    if (home.keypools.state(pool) === null) return fail(io, "missing");
    io.stdout(`${JSON.stringify({ pool, outcome: "ignored" })}\n`);
    return 0;
  }
  // By grant and by session the caller is this process: the grant's holder or one of its children, the session the key was served to.
  const caller = grant !== undefined || served ? selfId() : null;
  if ((grant !== undefined || served) && caller === null) return fail(io, "holder");
  const target: RefusalTarget = grant !== undefined && caller !== null ? { kind: "grant", grant, by: { kind: "holder", caller } }
    : served && caller !== null ? { kind: "served", caller }
      : { kind: "member", member: member ?? "" };
  const reported = home.keypools.reportRefusal(pool, target, signal, home.now());
  if (!reported.ok) return fail(io, reported.error.problem);
  await probeSuspect(home, pool, reported.value.suspect);
  io.stdout(`${JSON.stringify({ pool, outcome: reported.value.outcome })}\n`);
  return 0;
}

// One JSON line per probe: the pool, then the service's result, words only. Exit 0 once the command has run.
// `--member` probes that member now and needs the pool; with no pool, every live pool's due members are probed.
async function recheck(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const pool = parsed.positionals[1];
  const member = parsed.get("member");
  if (member !== undefined && pool === undefined) return fail(io, "usage");
  if (pool !== undefined && home.keypools.state(pool) === null) return fail(io, "missing");
  const holder = selfHolder(null);
  if (!holder) return fail(io, "holder");
  const names = pool === undefined ? home.keypools.list().map(view => view.name) : [pool];
  for (const name of names) {
    // The probe lease takes the gate `run` uses for that pool's runtime.
    home.runtime.current = gateRuntime(home, home.keypools.state(name)?.runtime ?? "claude");
    const results = await home.keypools.recheckBy(ACTOR, { holder, pool: name, ...(member === undefined ? {} : { member }) });
    if (!results.ok) return fail(io, results.error.problem);
    for (const result of results.value) io.stdout(probeLine(name, result));
  }
  return 0;
}

function probeLine(pool: string, result: ProbeResult): string {
  const line = { pool, member: result.member, outcome: result.outcome, ...(result.word === undefined ? {} : { word: result.word }) };
  return `${JSON.stringify(line)}\n`;
}

// The terms line is shown when it is asked for and not yet acknowledged: `--by` says who read it.
function create(home: Opened, name: string, members: readonly string[], parsed: Parsed, io: Io): number {
  const vendor = need(parsed.get("vendor"));
  // "true" is what a bare flag stores, never somebody's name.
  const given = parsed.get("by") ?? "";
  const by = given === "true" ? "" : given;
  if (by.trim() === "") {
    const line = home.catalog.keyPool(vendor)?.termsLine;
    if (line) io.stderr(`${line}\n`);
  }
  const mode = modeOf(parsed.get("mode"));
  const recheckEveryMs = durationOf(parsed.get("recheck"));
  return done(home.keypools.create({
    name, vendor, runtime: need(parsed.get("runtime")), members, by, confirmOwn: parsed.get("confirm-own-account") === "true",
    ...(mode === undefined ? {} : { mode }), ...(recheckEveryMs === undefined ? {} : { recheckEveryMs }),
  }, ACTOR), io);
}
