// morndo-board, the agents' way onto the board (ADR-0015): a thin client of the hub's /api/agent/board routes. Pure
// of I/O: `run` takes the arguments, the environment, a fetch and a way to learn this lane's name, and writes to the
// given streams, so the tests drive it against an in-process hub and the entry point (main.ts) wires the real ones.
// Exit codes: 0 done, 1 the hub refused (one line on stderr, in words an agent can act on), 2 usage, 3 the hub can't
// be reached or didn't answer in a shape this CLI knows.
import { inboxItems, isDecisionAnswered, isIdleForStale, staleMessage, staleTasks, watchedKeys, type JudgedWait, type MergeRecord, type MergedView, type Task, type TaskEvent, type TaskKey, type TaskStatus, type Wait } from "@morndo/domain";
import { mapLimit } from "@morndo/service-kit";
import { promptFor } from "./prompt.ts";
import { lintWhy, proofBlock, whyTokens, type ProofView } from "./proof-text.ts";

export type Io = {
  fetch: typeof fetch;
  lane: () => Promise<string | null>;        // this lane's name when the environment doesn't say (tmux's window name)
  out: (line: string) => void;
  err: (line: string) => void;
  readFile?: (path: string) => Promise<string>;   // what `brief --file <file>` reads (main.ts wires the disk)
};
export type Env = { MORNDO_HUB?: string | undefined; MORNDO_AGENT_TOKEN?: string | undefined; MORNDO_LANE?: string | undefined };

export const HELP = `morndo-board: the team's board, for the manager and the lanes.

  list [--mine] [--status S] [--json]   the board (In progress, Blocked, In review, To do, Backlog, Done this week)
  show T-12 [--json]                    one task with its history and comments
  inbox                                 the decisions that wait for the manager, and how long they have waited
  stale                                 the tasks idle 48 h or more with no wait the board watches
  merged                                the open tasks whose pull request merged without a merge record
  new "<title>" [--desc "…"] [--assign <lane>] [--proof "<kind[@owner/repo]: text>"]… [--priority high|normal|low] [--status todo|backlog|doing]
  assign T-12 <lane>|none [--proof "<kind[@owner/repo]: text>"]…   (manager only)
  proof T-12 [--add "<spec>"]… [--drop "<spec>"|<N>]…   the proof list the work must answer (manager sets it; the lane may add)
  start T-12                            in progress (one per lane at a time)
  block T-12 --why "…" [--on <wait>]… [--decision]
                                        blocked, with the reason; each --on is one thing the board watches for you and,
                                        once all are over, moves the task back to do: T-11 (done), owner/repo#93 or '#93'
                                        (merged or closed; quote a bare #), ny-530 (the owner's card closed),
                                        until:2026-10-28T09:00+01:00 (a time wait is at most 31 days ahead; a block
                                        without one, or --decision, is refused). --decision marks a block that asks the
                                        manager which way to go: it is due an answer in 24 h and inbox lists it
  resume T-12                           back in progress
  review T-12 [--note "…"]              you say it is done; the manager checks and marks it done
  brief T-12 --summary "…" --left-out "…" --limit "…" [--decision "…"] [--pr owner/repo#42@sha]… [--ci owner/repo@sha:ci,lint]… [--test "…"]… [--manual|--ui|--data|--infra "…"]… [--no-code "…"] | --file brief.json   [--out-json]
  brief T-12 --show [--out-json] [--from-last]   the brief the hub holds and how each reference checked out
  merged T-12 <sha> [--repo owner/name]   record the commit its PR merged as (default repo morndo/morndo; manager, or the task's lane)
  unmerged T-12 <sha> [--repo …]   clear a wrong merge record (manager only); to replace one, unmerged then merged
  done T-12 --why "…" [--not-live "…"] [--proof-override "<reason>"]  accept it, naming what you checked; refused while its morndo/morndo merge is not live on every node (manager only)
  todo T-12                             put it back
  move T-12 <status> [--why "…"]        any move the rules allow
  comment T-12 "…"                      a line on the task's record
  edit T-12 [--title "…"] [--desc "…"] [--priority P]   (manager only)
  whoami                                who the hub takes this call for
  prompt --role manager|worker          the instructions block for a lane's prompt

--json, on any command that prints data, makes stdout exactly one JSON document and moves every other line to stderr;
it takes no value. A command of several calls that is refused part-way prints what happened so far, then exits non-zero:
check the exit code before you trust the document. On brief, --json is not the output flag: the machine output is
--out-json, and the file form is --file <file> (the old --json <file> still works, with a deprecation line on stderr).
help and prompt have no JSON form.

Environment: MORNDO_HUB (the hub's address), MORNDO_AGENT_TOKEN (from \`morndo agent-token new\`), MORNDO_LANE (this
lane's name; without it, the tmux window's name). With none of them in the environment, the settings are read from
~/.config/morndo: agent-hub (the hub's address), agent-node (this machine's name), agent-lanes.token (the token the
lanes share) and agent-manager.token (used only for the window named manager); an environment setting always wins.`;

const STATUS_WORDS: Record<TaskStatus, string> = { doing: "In progress", blocked: "Blocked", review: "In review", todo: "To do", backlog: "Backlog", done: "Done this week" };
const LIST_ORDER: TaskStatus[] = ["doing", "blocked", "review", "todo", "backlog", "done"];
const STATUSES = new Set<string>(LIST_ORDER);
const PRIORITIES = new Set(["high", "normal", "low"]);

// Why the hub refused, in words an agent can act on. `detail`: what the board sees (B11, not_live).
function explain(error: string, other: string | undefined, from: string | undefined, detail: string | undefined): string {
  switch (error) {
    case "not_allowed": return "only the manager (or the principal) may do that";
    case "not_yours": return "that task is assigned to someone else";
    case "bad_transition": return `a task can't move from ${from ?? "where it is"} like that; a lane moves its own tasks to doing, blocked, review or todo, and only the manager marks done`;
    case "needs_assignee": return "nobody is assigned to it; the manager assigns first";
    case "reason_needed": return "say why: --why \"…\" (for done: what you checked, e.g. the tests you ran, CI at a commit, a review)";
    case "one_doing": return `${other ?? "another task"} is already in progress for this lane; finish, block or put it back first`;
    case "changed": return "the task changed since you looked; show it again";
    case "same": return "it already is";
    case "empty": return `the text is empty${detail ? ` (${detail})` : ""}`;
    case "too_long": return `the text is too long${detail ? ` (${detail})` : ""}`;
    case "bad_name": return "that isn't a lane name (letters, digits, . _ -)";
    case "bad_text": return `the text holds a control character${detail ? ` (${detail})` : ""}`;
    case "unknown": return "no such task";
    case "no_token": case "unknown_token": return "the hub doesn't know this token (MORNDO_AGENT_TOKEN)";
    case "revoked": return "this token was revoked";
    case "lane_needed": return "which lane? set MORNDO_LANE, or run in the lane's tmux window with TMUX_PANE set";
    case "rate_limited": return "too many calls; wait a moment";
    case "board_off": return "the hub has no board";
    case "not_live": return `its merge is not live${detail ? `: ${detail}` : ""}; if you accept it anyway: done T-12 --why "…" --not-live "<reason>"`;
    // B14 to B16 (ADR-0035): the brief's own refusals. `detail` names what was wrong — the field for a text rule, the
    // offending reference for a grammar or allowlist one, the proof's own line for a held done.
    case "bad_ref": return `a reference must be whole${detail ? `: ${detail}` : ""}`;
    case "ref_unrelated": return `a ci reference must hang off a pull request of the same brief or a merge record of the task${detail ? `: ${detail}` : ""}`;
    case "ref_repo": return `the board does not check ${detail ? `the repository ${detail}` : "that repository"}; its settings list the ones it reads`;
    case "proof_not_green": return `done is held${detail ? `: ${detail}` : ""}; to accept it anyway: done T-12 --why "…" --proof-override "<what you looked at instead>"`;
    case "bad_sha": return "that isn't a commit hash (7 to 40 hex characters)";
    case "bad_repo": return "that isn't a repo name (owner/name)";
    case "too_many": return detail?.includes("waits") ? `a block names ${detail}; the rest belongs in --why` : `a task holds at most 5 merge records; clear a wrong one first: unmerged T-12 <sha>${detail ? ` (${detail})` : ""}`;
    case "bad_wait": return `the board can't watch that wait${detail ? `: ${detail}` : ""}`;
    // B21 (ADR-0041): a block that named nothing the board watches and asked no decision.
    case "no_wait": return "a block names what it waits on: --on T-12, #93, owner/repo#93, ny-530 or until:<time> (at most 31 days ahead); or --decision to ask the manager";
    case "no_commit": return "the hub's checkout doesn't have that commit yet; ask the manager to record it, or update the checkout";
    case "no_merge": return "that merge isn't recorded on this task (see show)";
    case "bad_item": return `an item is <kind>[@owner/repo]: <text>, kind one of pr, ci, tests, manual, ui, data, infra${detail && !detail.startsWith("an item is") ? `: ${detail}` : ""}`;
    case "no_item": return `that item is not on the list (${detail ?? ""})`;
    default: return error;
  }
}

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
// B21 (ADR-0041): the instant an unset MORNDO_BLOCK_GATE refuses from — the same date the hub's own setting reads
// (apps/hub/src/config.ts BLOCK_GATE_FROM) — named in the notice after a warned block.
const BLOCK_GATE_FROM = Date.parse("2026-11-12T00:00:00Z");
// The board's own moves (ADR-0032) name their rule and the lane whose run they followed.
// B18: a wait as the CLI writes it, the same spelling --on takes.
const waitText = (w: Wait) => w.kind === "task" ? w.key : w.kind === "card" ? w.id : w.kind === "time" ? `until:${new Date(w.at).toISOString()}`
  : w.repo.toLowerCase() === "morndo/morndo" ? `#${w.n}` : `${w.repo}#${w.n}`;
const readingsText = (rs: readonly JudgedWait[]) => rs.map(r => r.label).join(" · ");
const DAY_MS = 24 * 3_600_000;
const who = (a: TaskEvent["actor"]) =>
  a.kind === "principal" ? "principal" : a.kind === "console" ? "console" : a.kind === "board" ? `board (${a.rule}, ${a.lane})` : a.name;
function changeText(e: TaskEvent): string {
  const c = e.change;
  switch (c.kind) {
    case "created": return `filed it in ${c.status}${c.assignee ? `, for ${c.assignee}` : ""}`;
    // The proof the board saw on a done (B16): its own line, with an override or the principal's acceptance inside it.
    case "moved": return `${c.from} → ${c.to}${c.reason ? `: ${c.reason}` : ""}${c.waits?.length ? ` [waits on ${c.waits.map(waitText).join(", ")}]` : ""}${c.notLive !== undefined ? ` (done while not live: ${c.notLive})` : ""}${c.proofSeen !== undefined ? ` (${c.proofSeen})` : ""}`;
    case "assigned": return c.to ? `assigned it to ${c.to}` : `took it from ${c.from ?? "nobody"}`;
    case "edited": return `edited ${Object.keys(c).filter(k => k !== "kind").join(", ")}`;
    case "commented": return c.text.includes("\n") ? `commented:\n      ${c.text.replace(/\n/g, "\n      ")}` : `commented: ${c.text}`;
    case "briefed": return `filed a brief: ${c.brief.summary.slice(0, 80)}`;
    case "merged": return `recorded its merge: ${c.repo} ${c.sha.slice(0, 7)}`;
    case "unmerged": return `cleared its merge record: ${c.repo} ${c.sha.slice(0, 7)}`;
    case "proof_listed": {
      const parts = [...c.add.map(s => `+ ${s}`), ...c.drop.map(s => `- ${s}`)];
      return parts.length ? `updated the proof list:\n      ${parts.join("\n      ")}` : "updated the proof list";
    }
  }
}
const line = (t: Task) =>
  `${t.key.padEnd(6)} ${(t.assignee ?? "-").padEnd(14)} ${t.title}${t.priority !== "normal" ? `  (${t.priority})` : ""}${t.status === "blocked" && t.blockedReason ? `  [blocked: ${t.blockedReason}]` : ""}${t.comments ? `  ${t.comments} comment${t.comments === 1 ? "" : "s"}` : ""}`;

// B19, B20: the hours a decision has waited or a task has sat idle, as the inbox and the stale list show them.
const inHours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;
// How many decision-event reads may be in flight at once. More than this crowds the hub; fewer leaves the list waiting.
const EVENT_READS = 8;

// B19: one GET per decision the inbox might list, at most EVENT_READS at once, as the predicate both views apply
// (isDecisionAnswered). `legacySince` stays 0: the hub's start is not on the wire. `idleOnly`: stale reads a decision
// only once it isIdleForStale; inbox reads them all, and a younger one counts as unanswered and draws no warning. A
// task that is gone (404) is left out of both lists, and one warning names every such key. Any other failure is the
// command's. `gone` is that set, beside the predicate.
async function answeredFor(
  call: (method: "GET" | "POST", path: string, body?: unknown) => Promise<Record<string, unknown>>,
  tasks: readonly Task[],
  now: number,
  err: (line: string) => void,
  o: { idleOnly?: boolean } = {},
): Promise<{ answered: (key: TaskKey, since: number) => boolean; gone: ReadonlySet<TaskKey> }> {
  const byKey = new Map(tasks.map(t => [t.key, t]));
  const candidates = inboxItems(tasks, now, { legacySince: 0 }).filter(item => {
    if (o.idleOnly !== true) return true;
    const task = byKey.get(item.key);
    return task !== undefined && isIdleForStale(task, now);
  });
  const reads = await mapLimit(candidates, EVENT_READS, async (item): Promise<{ key: TaskKey; events: readonly TaskEvent[]; failed: boolean }> => {
    try {
      const events = ((await call("GET", `/api/agent/board/tasks/${item.key}`)).events as TaskEvent[] | undefined) ?? [];
      return { key: item.key, events, failed: false };
    } catch (e) {
      if (e instanceof Refused && e.status === 404) return { key: item.key, events: [], failed: true };
      throw e;
    }
  });
  const eventsByKey = new Map(reads.map(read => [read.key, read.events]));
  const gone = new Set(reads.flatMap(read => read.failed ? [read.key] : []));
  if (gone.size > 0) err(`warning: ${[...gone].join(", ")} ${gone.size === 1 ? "is" : "are"} gone; left out`);
  return {
    gone,
    answered: (key, since) => {
      const task = byKey.get(key);
      return task !== undefined && isDecisionAnswered(task, eventsByKey.get(key) ?? [], since);
    },
  };
}

// Flags: --name value, --name=value, or a bare --flag; the rest are positional, in order. `booleans` names the flags
// that take no value, so the word after one stays positional (a task key, a title); with none named every flag takes
// the next word, as morndo-decide, which shares this parser, has it. `--name=value` is a value for any flag.
export function parseArgs(argv: readonly string[], booleans: readonly string[] = []): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    if (booleans.includes(a.slice(2))) { flags[a.slice(2)] = true; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[a.slice(2)] = next; i++; }
    else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}

// A flag that may repeat: every `--name value` and `--name=value`, in the order the command line gave them, several
// names at once for the flags that share a list (the brief's references, its attested checks). parseArgs keeps only the
// last of a repeated flag and its shape stays as it is, so the brief reads the line itself.
function flagValues(argv: readonly string[], names: readonly string[]): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    for (const name of names) {
      if (a === `--${name}`) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { out.push({ name, value: next }); i++; }
        break;
      }
      if (a.startsWith(`--${name}=`)) { out.push({ name, value: a.slice(name.length + 3) }); break; }
    }
  }
  return out;
}
export const valuesOf = (argv: readonly string[], name: string): string[] => flagValues(argv, [name]).map(v => v.value);

// The attested checks' flag names into their kinds (B13): `--test` is the kind `tests`, the rest are their own name.
const ATTESTED_FLAG_KIND: Record<string, string> = { test: "tests", manual: "manual", ui: "ui", data: "data", infra: "infra" };

class Usage extends Error {}
class Refused extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "Refused"; this.status = status; }
}
class Unreachable extends Error { constructor(message: string) { super(message); this.name = "Unreachable"; } }

// Whether this call needs no settings: it prints text without asking the hub (help, the prompt blocks). Read from the same
// parse and the same command word the dispatch below uses, so a flag's value or a word of some other command is never taken
// for one.
export function runsOffline(argv: readonly string[]): boolean {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "help"] = positional;
  return cmd === "help" || flags.help === true || cmd === "prompt";
}

export async function run(argv: readonly string[], env: Env, io: Io): Promise<number> {
  // --json takes no value on every command but brief, where `--json <file>` is the old file form and the machine
  // output is --out-json (T-873). The command is the first word that is not a flag (no flag of this CLI that may come
  // before it takes a value), so the set is picked before the line is parsed.
  const word = argv.find(a => !a.startsWith("--"));
  const { positional, flags } = parseArgs(argv, word === "brief" ? ["out-json"] : ["json", "out-json"]);
  const [cmd = "help", ...rest] = positional;
  const text = (f: string) => (typeof flags[f] === "string" ? (flags[f] as string) : undefined);
  // Under --json, stdout is exactly one JSON document (jq reads it), so every sentence that is not that document goes
  // to stderr instead — the notice helper is the one way each of them is written. brief's old `--show --json` still
  // prints JSON.
  const asJson = cmd === "brief" ? flags["out-json"] === true || (flags.show === true && flags.json === true) : flags.json === true;
  const notice = (l: string) => (asJson ? io.err : io.out)(l);
  try {
    if (cmd === "help" || flags.help === true) { io.out(HELP); return 0; }
    if (cmd === "prompt") {
      const role = text("role");
      if (role !== "manager" && role !== "worker") throw new Usage("usage: morndo-board prompt --role manager|worker");
      io.out(promptFor(role).trimEnd());
      return 0;
    }
    if (cmd !== "brief" && typeof flags.json === "string") throw new Usage(`--json takes no value (${JSON.stringify(flags.json)}); it asks for JSON output`);
    if (cmd !== "brief" && flags["out-json"] !== undefined) throw new Usage("--out-json is brief's; on any other command the flag is --json");
    if (cmd === "brief" && flags.show === true && typeof flags.json === "string") throw new Usage("brief --show prints JSON with --out-json; --json <file> is the file form of filing a brief");
    const hub = (env.MORNDO_HUB ?? "").replace(/\/+$/, "");
    const token = env.MORNDO_AGENT_TOKEN ?? "";
    if (!hub || !token) throw new Usage("set MORNDO_HUB (the hub's address) and MORNDO_AGENT_TOKEN (from `morndo agent-token new`)");
    const lane = env.MORNDO_LANE?.trim() || (await io.lane());
    const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> => {
      let res: Response;
      try {
        res = await io.fetch(`${hub}${path}`, {
          method, headers: { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) { throw new Unreachable(`can't reach the hub at ${hub}: ${(e as Error).message}`); }
      let data: unknown;
      try { data = await res.json(); } catch { throw new Unreachable(`the hub at ${hub} answered ${res.status} without JSON`); }
      if (typeof data !== "object" || data === null) throw new Unreachable(`the hub answered ${res.status} in a shape this CLI doesn't know`);
      const d = data as Record<string, unknown>;
      if (!res.ok) throw new Refused(explain(typeof d.error === "string" ? d.error : `http_${res.status}`, typeof d.other === "string" ? d.other : undefined, typeof d.from === "string" ? d.from : undefined, typeof d.detail === "string" ? d.detail : undefined), res.status);
      return d;
    };
    const key = (s: string | undefined) => {
      if (!s || !/^T-\d{1,9}$/.test(s)) throw new Usage(`which task? give its key, like T-12${s ? ` (got ${JSON.stringify(s)})` : ""}`);
      return s;
    };
    const showTask = (d: Record<string, unknown>) => {
      if (asJson) { io.out(JSON.stringify(d, null, 2)); return; }
      const t = d.task as Task;
      io.out(`${t.key}  ${t.title}`);
      io.out(`  ${STATUS_WORDS[t.status]}${t.blockedReason ? ` (${t.blockedReason})` : ""} · ${t.assignee ? `assigned to ${t.assignee}` : "nobody assigned"} · priority ${t.priority} · rev ${t.rev}`);
      // B18: what the block waits on, as the hub last read it (or as named, before its first reading).
      const read = d.waitsRead as JudgedWait[] | undefined;
      if (t.status === "blocked" && (t.waits ?? []).length > 0) io.out(`  Waits on: ${read ? readingsText(read) : `${(t.waits ?? []).map(waitText).join(" · ")} (not read yet)`}`);
      // B11: the task's merges as the hub sees them, its label saying where they stand.
      const merged = d.merged as MergedView | null | undefined;
      if (merged && merged.merges.length > 0) {
        for (const m of merged.merges) {
          io.out(`  Merged: ${m.repo} ${m.sha.slice(0, 7)} (by ${m.by}, ${when(m.at)})`);
          if (m.override) io.out(`  Accepted as done while not live: ${m.override}`);
        }
        if (merged.label) io.out(`  ${merged.label}`);
      }
      // ADR-0035: the proof the hub holds, when it says something — a brief was filed, or the task waits on one in
      // review or done. A task at work with no brief yet keeps its silence.
      const proof = d.proof as ProofView | undefined;
      if (proof !== undefined && (proof.brief !== null || t.status === "review" || t.status === "done"))
        for (const l of proofBlock(proof)) io.out(l);
      else if (proof !== undefined && (proof.coverage?.length ?? 0) > 0)
        for (const l of proofBlock(proof).filter(l => l.startsWith("  Proof list") || l.startsWith("    ["))) io.out(l);
      if (t.description) io.out(`  ${t.description.replace(/\n/g, "\n  ")}`);
      const events = (d.events as TaskEvent[] | undefined) ?? [];
      if (events.length) io.out("  History:");
      for (const e of events) io.out(`    ${when(e.at)}  ${who(e.actor).padEnd(12)} ${changeText(e)}`);
      // After a change the hub answers with that one event: say what just happened.
      const event = d.event as TaskEvent | undefined;
      if (event && !events.length) io.out(`  ${who(event.actor)} ${changeText(event)}`);
    };
    const act = async (k: string, action: Record<string, unknown>) => showTask(await call("POST", `/api/agent/board/tasks/${k}`, action));
    // A command of several calls. Plain, each answer that has `plain` is shown as it comes, and when a later call is
    // refused the last answer not yet shown is shown before the refusal goes out (a task that was filed has its key
    // told). Under --json stdout is one document, the last answer with `keep` that came, printed even when a later call
    // is refused: the refusal goes to stderr and the exit code is the refusal's, so a script checks the exit code
    // before it trusts the document (docs/agents/board.md).
    const chain = async (steps: { call: () => Promise<Record<string, unknown>>; plain?: boolean; keep?: boolean }[]) => {
      let kept: Record<string, unknown> | undefined;
      let keptShown = true;
      let finished = false;
      try {
        for (const step of steps) {
          const d = await step.call();
          const shownNow = !asJson && step.plain !== false;
          if (shownNow) showTask(d);
          if (step.keep !== false) { kept = d; keptShown = shownNow; }
        }
        finished = true;
      } finally {
        if (kept !== undefined && (asJson || (!finished && !keptShown))) showTask(kept);
      }
    };
    const post = (k: string, action: Record<string, unknown>) => () => call("POST", `/api/agent/board/tasks/${k}`, action);
    const read = (k: string) => () => call("GET", `/api/agent/board/tasks/${k}`);
    const printProofList = (proof: ProofView | undefined) => {
      if (proof === undefined) { io.out("no proof list"); return; }
      const coverage = proof.coverage ?? [];
      if (coverage.length === 0) { io.out("no proof list"); return; }
      for (const l of proofBlock(proof).filter(l => l.startsWith("  Proof list") || l.startsWith("    ["))) io.out(l);
    };

    switch (cmd) {
      case "whoami": {
        const d = await call("GET", "/api/agent/whoami");
        if (asJson) { io.out(JSON.stringify(d)); return 0; }
        const a = d.actor as { kind: string; name?: string };
        io.out(a.kind === "manager" ? `the manager (${a.name})` : `the lane ${a.name}`);
        return 0;
      }
      case "list": {
        const d = await call("GET", "/api/agent/board");
        let tasks = d.tasks as Task[];
        const orphans = new Set((d.orphans as string[] | undefined) ?? []);
        // B18: each block's readings by key, and the blocks of words only that sat too long.
        const readsOf = new Map(((d.waits as { key: string; readings: JudgedWait[] }[] | undefined) ?? []).map(w => [w.key, w.readings]));
        const stale = new Set((d.staleBlocks as string[] | undefined) ?? []);
        const proofLines = d.proof as Record<string, string> | undefined;   // each task in review's one line (ADR-0035)
        const me = lane;
        if (flags.mine === true) {
          const w = await call("GET", "/api/agent/whoami");
          const name = (w.actor as { name: string }).name;
          tasks = tasks.filter(t => t.assignee === name);
        }
        const status = text("status");
        if (status !== undefined) {
          if (!STATUSES.has(status)) throw new Usage(`--status takes one of ${LIST_ORDER.join(", ")}`);
          tasks = tasks.filter(t => t.status === status);
        }
        if (asJson) { if (d.standIn === true) notice("(proof references are read from a stand-in forge, not GitHub)"); io.out(JSON.stringify(tasks.map(t => ({ ...t, ...(orphans.has(t.key) ? { orphan: true } : {}), ...(proofLines !== undefined && t.key in proofLines ? { proof: proofLines[t.key] } : {}), ...(readsOf.has(t.key) ? { waitsRead: readsOf.get(t.key) } : {}), ...(stale.has(t.key) ? { staleBlock: true } : {}) })))); return 0; }
        if (!tasks.length) { io.out(flags.mine === true ? `nothing assigned to ${me ?? "you"}` : "the board is empty"); return 0; }
        const lanes = new Set(d.lanes as string[]);
        // B11: each task's merges by key, so a row can say where its merge stands (the hub's label, its own brackets).
        const mergedBy = new Map((Array.isArray(d.merged) ? d.merged as MergedView[] : []).map(m => [m.key, m]));
        // B23: the pull requests that merged without a merge record, by key, as the hub flags them now (live).
        const prMerged = new Map(((d.mergedPrs as { key: string; prs: string[] }[] | undefined) ?? []).map(f => [f.key, f.prs.join(" · ")]));
        if (d.standIn === true) io.out("(proof references are read from a stand-in forge, not GitHub)");
        for (const s of LIST_ORDER) {
          const rows = tasks.filter(t => t.status === s);
          if (!rows.length) continue;
          io.out(`${STATUS_WORDS[s]} (${rows.length})`);
          // An orphan's lane is gone for good, not merely not running: the marker says which is which.
          for (const t of rows) {
            const m = mergedBy.get(t.key);
            const merge = m !== undefined && m.merges.length > 0 ? m : undefined;   // a view with no merge says nothing
            const override = merge?.merges.find(x => x.override)?.override ?? null;
            const staleFor = stale.has(t.key) ? `  [blocked ${Math.floor((((d.at as number | undefined) ?? Date.now()) - t.stateChangedAt) / DAY_MS)} d on words only: check it, or name its waits with --on]` : "";
            const prFor = prMerged.has(t.key) ? `  [PR merged: ${prMerged.get(t.key)}]` : "";
            io.out(`  ${line(t)}${orphans.has(t.key) ? "  [orphan: its lane is gone; reassign it]" : t.assignee && lanes.size && !lanes.has(t.assignee) ? "  [lane not running]" : ""}${merge ? `  [${merge.label}]` : ""}${override ? `  (done not live: ${override})` : ""}${staleFor}${prFor}`);
            // B18: under a block that names waits, what the hub last read of them.
            if (t.status === "blocked" && (t.waits ?? []).length > 0) {
              const r = readsOf.get(t.key);
              io.out(`      waits on: ${r ? readingsText(r) : `${(t.waits ?? []).map(waitText).join(" · ")} (not read yet)`}`);
            }
            // ADR-0035: the proof line under a task in review, "proof: no brief" included — a review nobody briefed is
            // the thing the manager looks for (B15).
            const proof = proofLines?.[t.key];
            if (proof !== undefined) io.out(`      ${proof}`);
          }
        }
        return 0;
      }
      case "show": showTask(await call("GET", `/api/agent/board/tasks/${key(rest[0])}`)); return 0;
      // B19: the decisions that wait for the manager, with how long. An answer after the ask closes one, a decision
      // from before the rule included — the same rule the hub's sweep uses (isDecisionAnswered).
      case "inbox": {
        const d = await call("GET", "/api/agent/board");
        const now = (d.at as number | undefined) ?? Date.now();
        const tasks = d.tasks as Task[];
        const read = await answeredFor(call, tasks, now, io.err);
        const open = inboxItems(tasks, now, { legacySince: 0, answered: read.answered }).filter(i => !read.gone.has(i.key));
        if (asJson) { io.out(JSON.stringify(open)); return 0; }   // T-873: one array, [] when none, not the sentence
        if (open.length === 0) { io.out("no decisions wait"); return 0; }
        for (const i of open)
          io.out(`${i.key}  ${(i.assignee ?? "-").padEnd(14)} ${i.legacy ? "asked before the rule" : i.overdue ? `asked ${inHours(now - i.openedAt)} ago, OVERDUE ${inHours(now - i.dueAt)}` : `asked ${inHours(now - i.openedAt)} ago, due in ${inHours(i.dueAt - now)}`}: ${i.line}`);
        return 0;
      }
      // B20: the tasks nobody changed for 48 h that the board watches nothing on, as the hub's sweep lists them.
      case "stale": {
        const d = await call("GET", "/api/agent/board");
        const now = (d.at as number | undefined) ?? Date.now();
        const tasks = d.tasks as Task[];
        const read = await answeredFor(call, tasks, now, io.err, { idleOnly: true });
        const waits = d.waits as { key: string; readings: JudgedWait[] }[] | undefined;
        const watched = watchedKeys({ tasks, ...(waits !== undefined ? { waits } : {}), merged: Array.isArray(d.merged) ? d.merged as MergedView[] : [] }, now, 0, read.answered);
        for (const key of read.gone) watched.delete(key);
        const items = staleTasks(tasks, now, { watched, answered: read.answered }).filter(i => !read.gone.has(i.key));
        if (asJson) { io.out(JSON.stringify(items)); return 0; }   // T-873: one array, [] when none, not the sentence
        if (items.length === 0) { io.out("nothing stale"); return 0; }
        io.out(staleMessage(items));
        return 0;
      }
      case "new": {
        const title = rest[0];
        if (!title) throw new Usage('usage: morndo-board new "<title>" [--desc "…"] [--assign <lane>] [--priority high|normal|low] [--status todo|backlog|doing]');
        const priority = text("priority");
        if (priority !== undefined && !PRIORITIES.has(priority)) throw new Usage("--priority takes high, normal or low");
        const status = text("status");
        if (status !== undefined && !STATUSES.has(status)) throw new Usage(`--status takes one of ${LIST_ORDER.join(", ")}`);
        const proofSpecs = valuesOf(argv, "proof");
        const body = { title, ...(text("desc") !== undefined ? { description: text("desc") } : {}), ...(text("assign") !== undefined ? { assignee: text("assign") } : {}), ...(priority ? { priority } : {}), ...(status ? { status } : {}) };
        const created = await call("POST", "/api/agent/board/tasks", body);
        const k = (created.task as Task).key;
        // a refusal of the proof list leaves the task as filed: under --json that is the document
        await chain([{ call: async () => created, plain: proofSpecs.length === 0 },
          ...(proofSpecs.length > 0 ? [{ call: post(k, { action: "proof_list", add: proofSpecs }), plain: false, keep: false }, { call: read(k) }] : [])]);
        return 0;
      }
      case "assign": {
        const k = key(rest[0]);
        const to = rest[1];
        if (!to) throw new Usage("usage: morndo-board assign T-12 <lane>|none");
        const proofSpecs = valuesOf(argv, "proof");
        // a refusal of the proof list leaves the task as assigned: under --json that is the document
        await chain([{ call: post(k, { action: "assign", to: to === "none" ? null : to }) },
          ...(proofSpecs.length > 0 ? [{ call: post(k, { action: "proof_list", add: proofSpecs }), plain: false, keep: false }, { call: read(k) }] : [])]);
        return 0;
      }
      case "proof": {
        const k = key(rest[0]);
        const adds = valuesOf(argv, "add");
        const dropsRaw = valuesOf(argv, "drop");
        if (adds.length === 0 && dropsRaw.length === 0) {
          const d = await call("GET", `/api/agent/board/tasks/${k}`);
          if (asJson) { io.out(JSON.stringify((d.proof as ProofView | undefined)?.coverage ?? [])); return 0; }
          printProofList(d.proof as ProofView | undefined);
          return 0;
        }
        const drops: string[] = [];
        for (const raw of dropsRaw) {
          if (/^\d+$/.test(raw)) {
            const d = await call("GET", `/api/agent/board/tasks/${k}`);
            const coverage = (d.proof as ProofView | undefined)?.coverage ?? [];
            const n = Number(raw);
            const item = coverage[n - 1];
            if (item === undefined) throw new Usage(`--drop ${raw}: no such item on the proof list`);
            drops.push(item.spec);
          } else drops.push(raw);
        }
        await call("POST", `/api/agent/board/tasks/${k}`, { action: "proof_list", ...(adds.length > 0 ? { add: adds } : {}), ...(drops.length > 0 ? { drop: drops } : {}) });
        notice(`${k} proof list updated`);
        const d = await call("GET", `/api/agent/board/tasks/${k}`);
        // T-873: under --json the one document is the proof list, the same shape the read form prints.
        if (asJson) { io.out(JSON.stringify((d.proof as ProofView | undefined)?.coverage ?? [])); return 0; }
        printProofList(d.proof as ProofView | undefined);
        return 0;
      }
      case "start": await act(key(rest[0]), { action: "move", to: "doing" }); return 0;
      case "resume": await act(key(rest[0]), { action: "move", to: "doing" }); return 0;
      case "todo": await act(key(rest[0]), { action: "move", to: "todo" }); return 0;
      case "done": {
        const k = key(rest[0]);
        if (flags["not-live"] === true) throw new Usage("--not-live takes the reason it is accepted before it is live");
        if (flags["proof-override"] === true) throw new Usage("--proof-override takes the reason you accepted a proof that is not green");
        const notLive = text("not-live");
        const proofOverride = text("proof-override");
        const why = text("why");
        // The --why lint (plan 3.5): the reason is prose, never parsed, but each commit or `#n` it names is checked
        // against what the board verified itself, and what it did not earns one warning line. A reason that names none
        // is not looked at, a look that fails or a hub with no proof to read holds nothing and says nothing; the done
        // is sent whatever the warnings said.
        if (why !== undefined && whyTokens(why).length > 0) {
          try {
            const d = await call("GET", `/api/agent/board/tasks/${k}`);
            const proof = d.proof as ProofView | undefined;
            if (proof !== undefined) {
              const merges: readonly MergeRecord[] = (d.merged as MergedView | null | undefined)?.merges ?? [];
              for (const w of lintWhy(why, proof, merges)) io.err(w);
            }
          } catch { /* the look never holds the done: it goes out all the same */ }
        }
        await act(k, { action: "move", to: "done", ...(why !== undefined ? { reason: why } : {}), ...(notLive !== undefined ? { notLive } : {}), ...(proofOverride !== undefined ? { proofOverride } : {}) });
        return 0;
      }
      case "block": {
        const k = key(rest[0]);
        const why = text("why");
        if (!why) throw new Usage('usage: morndo-board block T-12 --why "…" [--on <wait>]… [--decision]');
        const on = valuesOf(argv, "on");
        // An --on that came without its wait is refused, never dropped: a shell takes an unquoted `#93` for a comment and
        // hands over a bare --on, and a block on fewer waits than named would end too early (review of #161).
        const named = argv.filter(a => a === "--on" || a.startsWith("--on=")).length;
        if (named !== on.length || on.some(v => v.trim() === ""))
          throw new Usage("--on needs a wait after it: T-12, '#93' (quote it: a shell takes an unquoted # for a comment), owner/repo#93, ny-530 or until:<time>");
        const d = await call("POST", `/api/agent/board/tasks/${k}`, { action: "move", to: "blocked", reason: why, ...(on.length > 0 ? { waits: on } : {}), ...(flags.decision === true ? { decision: true } : {}) });
        showTask(d);
        // B21 (ADR-0041): a block the hub took while warning says so, with what is coming: from when a block without
        // a wait is refused, and the waits it could name instead — the hub's own setting may say another date or mode.
        const change = (d.event as TaskEvent | undefined)?.change;
        if (change !== undefined && change.kind === "moved" && change.unwatched === true) {
          notice(`no watched wait: from ${new Date(BLOCK_GATE_FROM).toISOString().slice(0, 10)} a block without --on or --decision is refused; name one (--on T-12, #93, owner/repo#93, ny-530 or until:<time>, at most 31 days ahead) (unless the hub's MORNDO_BLOCK_GATE says otherwise)`);
        }
        return 0;
      }
      case "review": {
        const k = key(rest[0]);
        const note = text("note");
        await chain([{ call: post(k, { action: "move", to: "review" }) }, ...(note ? [{ call: post(k, { action: "comment", text: note }) }] : [])]);
        return 0;
      }
      // B13 (ADR-0035): the brief, the lane's word on what it did, with the references the board checks itself.
      case "brief": {
        const k = key(rest[0]);
        // A word after the key that no flag took is refused for what it is, most often a flag value that was not quoted.
        if (rest[1] !== undefined) throw new Usage(`unexpected word ${JSON.stringify(rest[1])} after the task key; quote a flag value that has spaces, like --summary "…"`);
        // --show: what the hub holds and how each reference checked out; --from-last, the brief of the last round even
        // once it is stale (a new round starts from it); nothing ever filed, one plain line.
        if (flags.show === true) {
          const d = await call("GET", `/api/agent/board/tasks/${k}`);
          const events = (d.events as TaskEvent[] | undefined) ?? [];
          let lastBrief: ProofView["brief"] = null;
          for (const e of events) if (e.change.kind === "briefed") lastBrief = e.change.brief;
          // --from-last asks for the brief itself (null when none was ever filed); the one JSON shape of the family is
          // the proof view, which filing prints too
          if (flags["from-last"] === true && (lastBrief !== null || asJson)) { io.out(JSON.stringify(lastBrief, null, 2)); return 0; }
          if (asJson) { io.out(JSON.stringify(d.proof ?? null, null, 2)); return 0; }
          if (lastBrief === null) { io.out("no brief filed"); return 0; }
          const shown = d.proof as ProofView | undefined;
          if (shown !== undefined) for (const l of proofBlock(shown)) io.out(l);
          return 0;
        }
        // Filing: the required words from the flags, the references and the attested checks in the order the command
        // line gave them (a flag may repeat), or the whole wire shape from a file.
        let brief: Record<string, unknown>;
        const jsonFile = text("json"), file = text("file");
        if (jsonFile !== undefined && file !== undefined) throw new Usage("usage: morndo-board brief T-12 --file <file>   # --file and --json <file> name the same thing; give one (--json <file> is the old spelling)");
        const filePath = file ?? jsonFile;
        if (filePath !== undefined) {
          if (io.readFile === undefined) throw new Usage("usage: morndo-board brief T-12 --file <file>   # the wire shape, from a file this CLI can read");
          let raw: string;
          try { raw = await io.readFile(filePath); } catch { throw new Usage(`usage: morndo-board brief T-12 --file <file>   # cannot read ${filePath}`); }
          if (jsonFile !== undefined) io.err("--json <file> is deprecated for brief: use --file <file>");
          try { brief = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Usage(`usage: morndo-board brief T-12 --file <file>   # ${filePath} is not JSON`); }
        } else {
          if (flags.json === true) throw new Usage('usage: morndo-board brief T-12 --file <file>   # or the flags: --summary "…" --left-out "…" --limit "…"; --out-json asks for JSON output');
          const summary = text("summary"), leftOut = text("left-out"), limits = text("limit");
          const missing = [["--summary", summary], ["--left-out", leftOut], ["--limit", limits]].filter(([, v]) => v === undefined).map(([f]) => f);
          if (missing.length > 0) throw new Usage(`usage: morndo-board brief T-12 --summary "…" --left-out "…" --limit "…" [--decision "…"] [--pr owner/repo#42@sha]… [--ci owner/repo@sha:ci,lint]… [--test "…"]… [--no-code "…"] | --file brief.json   # missing ${missing.join(", ")}`);
          const refs = flagValues(argv, ["pr", "ci"]).map(v => v.value);
          const attested = flagValues(argv, ["test", "manual", "ui", "data", "infra"]).map(v => ({ kind: ATTESTED_FLAG_KIND[v.name]!, how: v.value }));
          brief = {
            summary, leftOut, limits,
            ...(text("decision") !== undefined ? { decisions: text("decision") } : {}),
            ...(refs.length > 0 ? { refs } : {}),
            ...(attested.length > 0 ? { attested } : {}),
            ...(text("no-code") !== undefined ? { noCode: text("no-code") } : {}),
          };
        }
        const r = await call("POST", `/api/agent/board/tasks/${k}`, { action: "brief", brief });
        notice(`${k} brief filed (rev ${(r.event as TaskEvent).rev})`);
        // What the hub holds right after: the proof block of the brief just filed, its references on their way; under
        // --json that read is stdout's one document (T-873).
        const d = await call("GET", `/api/agent/board/tasks/${k}`);
        if (asJson) { io.out(JSON.stringify(d.proof ?? null, null, 2)); return 0; }
        const proof = d.proof as ProofView | undefined;
        if (proof !== undefined) for (const l of proofBlock(proof)) io.out(l);
        return 0;
      }
      case "merged": {
        // B23 (ADR-0042): with no task named, the open tasks whose pull request merged without a merge record, as the
        // hub flags them now (live). The board moves nothing and records nothing there; it lists. Any flag but --json
        // is a usage error: a recording call that lost its key must not quietly list and exit 0.
        if (rest.length === 0) {
          const stray = Object.keys(flags).filter(f => f !== "json");
          if (stray.length > 0) throw new Usage("usage: morndo-board merged T-12 <sha> [--repo owner/name]");
          const d = await call("GET", "/api/agent/board");
          const flagged = (d.mergedPrs as { key: string; prs: string[] }[] | undefined) ?? [];
          if (asJson) { io.out(JSON.stringify(flagged)); return 0; }   // [] when nothing is flagged; the sentence is the plain form's
          if (flagged.length === 0) { io.out("no merged pull requests without a merge record"); return 0; }
          const statusOf = new Map((d.tasks as Task[]).map(t => [t.key as string, t.status]));
          for (const f of flagged) {
            const status = statusOf.get(f.key);
            if (status !== undefined) io.out(`${f.key} (${status}): ${f.prs.join(" · ")}`);
          }
          return 0;
        }
        const k = key(rest[0]);
        const sha = rest[1];
        const repo = flags.repo;                        // --repo with no value parses as true: it must name one
        if (!sha || repo === true) throw new Usage("usage: morndo-board merged T-12 <sha> [--repo owner/name]");
        await act(k, { action: "merged", sha, ...(repo !== undefined ? { repo } : {}) });
        return 0;
      }
      case "unmerged": {
        const k = key(rest[0]);
        const sha = rest[1];
        const repo = flags.repo;                        // --repo with no value parses as true: it must name one
        if (!sha || repo === true) throw new Usage("usage: morndo-board unmerged T-12 <sha> [--repo owner/name]");
        await act(k, { action: "unmerged", sha, ...(repo !== undefined ? { repo } : {}) });
        return 0;
      }
      case "move": {
        const k = key(rest[0]);
        const to = rest[1];
        if (!to || !STATUSES.has(to)) throw new Usage(`usage: morndo-board move T-12 <${LIST_ORDER.join("|")}> [--why "…"]`);
        await act(k, { action: "move", to, ...(text("why") !== undefined ? { reason: text("why") } : {}) });
        return 0;
      }
      case "comment": {
        const k = key(rest[0]);
        const body = rest.slice(1).join(" ");
        if (!body.trim()) throw new Usage('usage: morndo-board comment T-12 "…"');
        await act(k, { action: "comment", text: body });
        return 0;
      }
      case "edit": {
        const k = key(rest[0]);
        const priority = text("priority");
        if (priority !== undefined && !PRIORITIES.has(priority)) throw new Usage("--priority takes high, normal or low");
        const body = { action: "edit", ...(text("title") !== undefined ? { title: text("title") } : {}), ...(text("desc") !== undefined ? { description: text("desc") } : {}), ...(priority ? { priority } : {}) };
        if (Object.keys(body).length === 1) throw new Usage('usage: morndo-board edit T-12 [--title "…"] [--desc "…"] [--priority P]');
        await act(k, body);
        return 0;
      }
      default:
        throw new Usage(`unknown command ${JSON.stringify(cmd)}; try morndo-board help`);
    }
  } catch (e) {
    if (e instanceof Usage) { io.err(e.message); return 2; }
    if (e instanceof Refused) { io.err(`refused: ${e.message}`); return 1; }
    if (e instanceof Unreachable) { io.err(e.message); return 3; }
    throw e;
  }
}
