// `morndo-keys keypool …` (ADR-0037). Exit 0 when done; 1 when refused, with the reason word on stderr. A pick that is refused (the pool
// is empty or blocked, a gate says no) exits 75, as `lease` and `run` do. `create`, `add`, `move` and `revive` are the principal's
// (KP10): the command id is "cli", as every other command of this bin.
import { realpathSync, statSync } from "node:fs";
import { isSinkPath, type Actor, type Outcome } from "@morndo/domain";
import type { ProbeResult, ReportBy } from "./application/key-pool-service.ts";
import type { Opened } from "./compose.ts";
import { fail, gateRuntime, need, type Io, type Parsed } from "./cli.ts";
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

// A KP18 report that fell back to the hand-off window names the current member to suspect: one claimed probe of it decides.
async function probeSuspect(home: Opened, pool: string, suspect: string | null): Promise<void> {
  if (suspect === null) return;
  const runtime = home.keypools.state(pool)?.runtime;
  if (runtime === undefined) return;
  home.runtime.current = gateRuntime(home, runtime);
  const holder = selfHolder(null);
  if (holder) await home.keypools.probeMember(pool, suspect, { why: "suspect", holder });
}

// `keypool report <pool> (--member M | --grant G) --from-hook`: the agent CLI's StopFailure payload on stdin, read, classified and dropped. Only a
// refusal of the key is applied (exhausted, failing); the line printed is the pool and a word, never the payload. The hook's own exit code is
// ignored by the CLI, so a payload that is no refusal exits 0 as `ignored`.
async function reportFromHook(home: Opened, pool: string, parsed: Parsed, io: Io): Promise<number> {
  const member = parsed.get("member");
  const grant = parsed.get("grant");
  if ((member === undefined) === (grant === undefined)) return fail(io, "usage");
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
  let caller: ReturnType<typeof selfId> = null;
  if (grant !== undefined) {
    caller = selfId();
    if (caller === null) return fail(io, "holder");
  }
  const target = grant !== undefined && caller !== null
    ? { kind: "grant", grant, by: { kind: "holder", caller } } as const
    : { kind: "member", member: member ?? "" } as const;
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
