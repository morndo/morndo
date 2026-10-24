// morndo-board, the agents' way onto the board (ADR-0015): a thin client of the hub's /api/agent/board routes. Pure
// of I/O: `run` takes the arguments, the environment, a fetch and a way to learn this lane's name, and writes to the
// given streams, so the tests drive it against an in-process hub and the entry point (main.ts) wires the real ones.
// Exit codes: 0 done, 1 the hub refused (one line on stderr, in words an agent can act on), 2 usage, 3 the hub can't
// be reached or didn't answer in a shape this CLI knows.
import type { MergeRecord, MergedView, Task, TaskEvent, TaskStatus } from "@morndo/domain";
import { promptFor } from "./prompt.ts";
import { lintWhy, proofBlock, whyTokens, type ProofView } from "./proof-text.ts";

export type Io = {
  fetch: typeof fetch;
  lane: () => Promise<string | null>;        // this lane's name when the environment doesn't say (tmux's window name)
  out: (line: string) => void;
  err: (line: string) => void;
  readFile?: (path: string) => Promise<string>;   // what `brief --json <file>` reads (main.ts wires the disk)
};
export type Env = { MORNDO_HUB?: string | undefined; MORNDO_AGENT_TOKEN?: string | undefined; MORNDO_LANE?: string | undefined };

export const HELP = `morndo-board: the team's board, for the manager and the lanes.

  list [--mine] [--status S] [--json]   the board (In progress, Blocked, In review, To do, Backlog, Done this week)
  show T-12 [--json]                    one task with its history and comments
  new "<title>" [--desc "…"] [--assign <lane>] [--proof "<kind[@owner/repo]: text>"]… [--priority high|normal|low] [--status todo|backlog|doing]
  assign T-12 <lane>|none [--proof "<kind[@owner/repo]: text>"]…   (manager only)
  proof T-12 [--add "<spec>"]… [--drop "<spec>"|<N>]…   the proof list the work must answer (manager sets it; the lane may add)
  start T-12                            in progress (one per lane at a time)
  block T-12 --why "…"                  blocked, with the reason
  resume T-12                           back in progress
  review T-12 [--note "…"]              you say it is done; the manager checks and marks it done
  brief T-12 --summary "…" --left-out "…" --limit "…" [--decision "…"] [--pr owner/repo#42@sha]… [--ci owner/repo@sha:ci,lint]… [--test "…"]… [--manual|--ui|--data|--infra "…"]… [--no-code "…"] | --json brief.json
  brief T-12 --show [--json] [--from-last]   the brief the hub holds and how each reference checked out
  merged T-12 <sha> [--repo owner/name]   record the commit its PR merged as (default repo morndo/morndo; manager, or the task's lane)
  unmerged T-12 <sha> [--repo …]   clear a wrong merge record (manager only); to replace one, unmerged then merged
  done T-12 --why "…" [--not-live "…"] [--proof-override "<reason>"]  accept it, naming what you checked; refused while its morndo/morndo merge is not live on every node (manager only)
  todo T-12                             put it back
  move T-12 <status> [--why "…"]        any move the rules allow
  comment T-12 "…"                      a line on the task's record
  edit T-12 [--title "…"] [--desc "…"] [--priority P]   (manager only)
  whoami                                who the hub takes this call for
  prompt --role manager|worker          the instructions block for a lane's prompt

Environment: MORNDO_HUB (the hub's address), MORNDO_AGENT_TOKEN (from \`morndo agent-token new\`), MORNDO_LANE (this
lane's name; without it, the tmux window's name).`;

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
    case "lane_needed": return "which lane? set MORNDO_LANE, or run inside the lane's tmux window";
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
    case "too_many": return `a task holds at most 5 merge records; clear a wrong one first: unmerged T-12 <sha>${detail ? ` (${detail})` : ""}`;
    case "no_commit": return "the hub's checkout doesn't have that commit yet; ask the manager to record it, or update the checkout";
    case "no_merge": return "that merge isn't recorded on this task (see show)";
    case "bad_item": return `an item is <kind>[@owner/repo]: <text>, kind one of pr, ci, tests, manual, ui, data, infra${detail ? detail.startsWith("an item is") ? ` (${detail})` : `: ${detail}` : ""}`;
    case "no_item": return `that item is not on the list (${detail ?? ""})`;
    default: return error;
  }
}

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
// The board's own moves (ADR-0032) name their rule and the lane whose run they followed.
const who = (a: TaskEvent["actor"]) =>
  a.kind === "principal" ? "principal" : a.kind === "console" ? "console" : a.kind === "board" ? `board (${a.rule}, ${a.lane})` : a.name;
function changeText(e: TaskEvent): string {
  const c = e.change;
  switch (c.kind) {
    case "created": return `filed it in ${c.status}${c.assignee ? `, for ${c.assignee}` : ""}`;
    // The proof the board saw on a done (B16): its own line, with an override or the principal's acceptance inside it.
    case "moved": return `${c.from} → ${c.to}${c.reason ? `: ${c.reason}` : ""}${c.notLive !== undefined ? ` (done while not live: ${c.notLive})` : ""}${c.proofSeen !== undefined ? ` (${c.proofSeen})` : ""}`;
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

// Flags: --name value, --name=value, or a bare --flag; the rest are positional, in order.
export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
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
class Refused extends Error { constructor(message: string) { super(message); this.name = "Refused"; } }
class Unreachable extends Error { constructor(message: string) { super(message); this.name = "Unreachable"; } }

export async function run(argv: readonly string[], env: Env, io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "help", ...rest] = positional;
  const text = (f: string) => (typeof flags[f] === "string" ? (flags[f] as string) : undefined);
  try {
    if (cmd === "help" || flags.help === true) { io.out(HELP); return 0; }
    if (cmd === "prompt") {
      const role = text("role");
      if (role !== "manager" && role !== "worker") throw new Usage("usage: morndo-board prompt --role manager|worker");
      io.out(promptFor(role).trimEnd());
      return 0;
    }
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
      if (!res.ok) throw new Refused(explain(typeof d.error === "string" ? d.error : `http_${res.status}`, typeof d.other === "string" ? d.other : undefined, typeof d.from === "string" ? d.from : undefined, typeof d.detail === "string" ? d.detail : undefined));
      return d;
    };
    const key = (s: string | undefined) => {
      if (!s || !/^T-\d{1,9}$/.test(s)) throw new Usage(`which task? give its key, like T-12${s ? ` (got ${JSON.stringify(s)})` : ""}`);
      return s;
    };
    const showTask = (d: Record<string, unknown>) => {
      if (flags.json === true) { io.out(JSON.stringify(d, null, 2)); return; }
      const t = d.task as Task;
      io.out(`${t.key}  ${t.title}`);
      io.out(`  ${STATUS_WORDS[t.status]}${t.blockedReason ? ` (${t.blockedReason})` : ""} · ${t.assignee ? `assigned to ${t.assignee}` : "nobody assigned"} · priority ${t.priority} · rev ${t.rev}`);
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
    const printProofList = (proof: ProofView | undefined) => {
      if (proof === undefined) { io.out("no proof list"); return; }
      const coverage = proof.coverage ?? [];
      if (coverage.length === 0) { io.out("no proof list"); return; }
      for (const l of proofBlock(proof).filter(l => l.startsWith("  Proof list") || l.startsWith("    ["))) io.out(l);
    };

    switch (cmd) {
      case "whoami": {
        const d = await call("GET", "/api/agent/whoami");
        if (flags.json === true) { io.out(JSON.stringify(d)); return 0; }
        const a = d.actor as { kind: string; name?: string };
        io.out(a.kind === "manager" ? `the manager (${a.name})` : `the lane ${a.name}`);
        return 0;
      }
      case "list": {
        const d = await call("GET", "/api/agent/board");
        let tasks = d.tasks as Task[];
        const orphans = new Set((d.orphans as string[] | undefined) ?? []);
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
        if (flags.json === true) { io.out(JSON.stringify(tasks.map(t => ({ ...t, ...(orphans.has(t.key) ? { orphan: true } : {}), ...(proofLines !== undefined && t.key in proofLines ? { proof: proofLines[t.key] } : {}) })))); return 0; }
        if (!tasks.length) { io.out(flags.mine === true ? `nothing assigned to ${me ?? "you"}` : "the board is empty"); return 0; }
        const lanes = new Set(d.lanes as string[]);
        // B11: each task's merges by key, so a row can say where its merge stands (the hub's label, its own brackets).
        const mergedBy = new Map((Array.isArray(d.merged) ? d.merged as MergedView[] : []).map(m => [m.key, m]));
        for (const s of LIST_ORDER) {
          const rows = tasks.filter(t => t.status === s);
          if (!rows.length) continue;
          io.out(`${STATUS_WORDS[s]} (${rows.length})`);
          // An orphan's lane is gone for good, not merely not running: the marker says which is which.
          for (const t of rows) {
            const m = mergedBy.get(t.key);
            const merge = m !== undefined && m.merges.length > 0 ? m : undefined;   // a view with no merge says nothing
            const override = merge?.merges.find(x => x.override)?.override ?? null;
            io.out(`  ${line(t)}${orphans.has(t.key) ? "  [orphan: its lane is gone; reassign it]" : t.assignee && lanes.size && !lanes.has(t.assignee) ? "  [lane not running]" : ""}${merge ? `  [${merge.label}]` : ""}${override ? `  (done not live: ${override})` : ""}`);
            // ADR-0035: the proof line under a task in review, "proof: no brief" included — a review nobody briefed is
            // the thing the manager looks for (B15).
            const proof = proofLines?.[t.key];
            if (proof !== undefined) io.out(`      ${proof}`);
          }
        }
        return 0;
      }
      case "show": showTask(await call("GET", `/api/agent/board/tasks/${key(rest[0])}`)); return 0;
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
        if (proofSpecs.length > 0) {
          await call("POST", `/api/agent/board/tasks/${k}`, { action: "proof_list", add: proofSpecs });   // a refusal here leaves the task as filed
          showTask(await call("GET", `/api/agent/board/tasks/${k}`));
        } else showTask(created);
        return 0;
      }
      case "assign": {
        const k = key(rest[0]);
        const to = rest[1];
        if (!to) throw new Usage("usage: morndo-board assign T-12 <lane>|none");
        const proofSpecs = valuesOf(argv, "proof");
        await act(k, { action: "assign", to: to === "none" ? null : to });
        if (proofSpecs.length > 0) {
          await call("POST", `/api/agent/board/tasks/${k}`, { action: "proof_list", add: proofSpecs });   // a refusal here leaves the task as filed
          showTask(await call("GET", `/api/agent/board/tasks/${k}`));
        }
        return 0;
      }
      case "proof": {
        const k = key(rest[0]);
        const adds = valuesOf(argv, "add");
        const dropsRaw = valuesOf(argv, "drop");
        if (adds.length === 0 && dropsRaw.length === 0) {
          const d = await call("GET", `/api/agent/board/tasks/${k}`);
          if (flags.json === true) { io.out(JSON.stringify((d.proof as ProofView | undefined)?.coverage ?? [])); return 0; }
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
        io.out(`${k} proof list updated`);
        const d = await call("GET", `/api/agent/board/tasks/${k}`);
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
        if (!why) throw new Usage('usage: morndo-board block T-12 --why "…"');
        await act(k, { action: "move", to: "blocked", reason: why });
        return 0;
      }
      case "review": {
        const k = key(rest[0]);
        await act(k, { action: "move", to: "review" });
        const note = text("note");
        if (note) await act(k, { action: "comment", text: note });
        return 0;
      }
      // B13 (ADR-0035): the brief, the lane's word on what it did, with the references the board checks itself.
      case "brief": {
        const k = key(rest[0]);
        // --show: what the hub holds and how each reference checked out; --from-last, the brief of the last round even
        // once it is stale (a new round starts from it); nothing ever filed, one plain line.
        if (flags.show === true) {
          const d = await call("GET", `/api/agent/board/tasks/${k}`);
          const events = (d.events as TaskEvent[] | undefined) ?? [];
          let lastBrief: ProofView["brief"] = null;
          for (const e of events) if (e.change.kind === "briefed") lastBrief = e.change.brief;
          if (lastBrief === null) { io.out("no brief filed"); return 0; }
          if (flags["from-last"] === true) { io.out(JSON.stringify(lastBrief, null, 2)); return 0; }
          if (flags.json !== undefined) { io.out(JSON.stringify(d.proof ?? null, null, 2)); return 0; }
          const shown = d.proof as ProofView | undefined;
          if (shown !== undefined) for (const l of proofBlock(shown)) io.out(l);
          return 0;
        }
        // Filing: the required words from the flags, the references and the attested checks in the order the command
        // line gave them (a flag may repeat), or the whole wire shape from a file.
        let brief: Record<string, unknown>;
        const jsonPath = text("json");
        if (jsonPath !== undefined) {
          if (io.readFile === undefined) throw new Usage("usage: morndo-board brief T-12 --json <file>   # the wire shape, from a file this CLI can read");
          let raw: string;
          try { raw = await io.readFile(jsonPath); } catch { throw new Usage(`usage: morndo-board brief T-12 --json <file>   # cannot read ${jsonPath}`); }
          try { brief = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Usage(`usage: morndo-board brief T-12 --json <file>   # ${jsonPath} is not JSON`); }
        } else {
          if (flags.json === true) throw new Usage('usage: morndo-board brief T-12 --json <file>   # or the flags: --summary "…" --left-out "…" --limit "…"');
          const summary = text("summary"), leftOut = text("left-out"), limits = text("limit");
          const missing = [["--summary", summary], ["--left-out", leftOut], ["--limit", limits]].filter(([, v]) => v === undefined).map(([f]) => f);
          if (missing.length > 0) throw new Usage(`usage: morndo-board brief T-12 --summary "…" --left-out "…" --limit "…" [--decision "…"] [--pr owner/repo#42@sha]… [--ci owner/repo@sha:ci,lint]… [--test "…"]… [--no-code "…"] | --json brief.json   # missing ${missing.join(", ")}`);
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
        io.out(`${k} brief filed (rev ${(r.event as TaskEvent).rev})`);
        // What the hub holds right after: the proof block of the brief just filed, its references on their way.
        const d = await call("GET", `/api/agent/board/tasks/${k}`);
        const proof = d.proof as ProofView | undefined;
        if (proof !== undefined) for (const l of proofBlock(proof)) io.out(l);
        return 0;
      }
      case "merged": {
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
