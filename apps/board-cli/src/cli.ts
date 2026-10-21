// morndo-board, the agents' way onto the board (ADR-0015): a thin client of the hub's /api/agent/board routes. Pure
// of I/O: `run` takes the arguments, the environment, a fetch and a way to learn this lane's name, and writes to the
// given streams, so the tests drive it against an in-process hub and the entry point (main.ts) wires the real ones.
// Exit codes: 0 done, 1 the hub refused (one line on stderr, in words an agent can act on), 2 usage, 3 the hub can't
// be reached or didn't answer in a shape this CLI knows.
import type { MergedView, Task, TaskEvent, TaskStatus } from "@morndo/domain";
import { promptFor } from "./prompt.ts";

export type Io = {
  fetch: typeof fetch;
  lane: () => Promise<string | null>;        // this lane's name when the environment doesn't say (tmux's window name)
  out: (line: string) => void;
  err: (line: string) => void;
};
export type Env = { MORNDO_HUB?: string | undefined; MORNDO_AGENT_TOKEN?: string | undefined; MORNDO_LANE?: string | undefined };

export const HELP = `morndo-board: the team's board, for the manager and the lanes.

  list [--mine] [--status S] [--json]   the board (In progress, Blocked, In review, To do, Backlog, Done this week)
  show T-12 [--json]                    one task with its history and comments
  new "<title>" [--desc "…"] [--assign <lane>] [--priority high|normal|low] [--status todo|backlog|doing]
  assign T-12 <lane>|none               (manager only)
  start T-12                            in progress (one per lane at a time)
  block T-12 --why "…"                  blocked, with the reason
  resume T-12                           back in progress
  review T-12 [--note "…"]              you say it is done; the manager checks and marks it done
  merged T-12 <sha> [--repo owner/name]   record the commit its PR merged as (default repo morndo/morndo; manager, or the task's lane)
  unmerged T-12 <sha> [--repo …]   clear a wrong merge record (manager only); to replace one, unmerged then merged
  done T-12 --why "…" [--not-live "<reason>"]  accept it, naming what you checked; refused while its morndo/morndo merge is not live on every node (manager only)
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
    case "empty": return "the text is empty";
    case "too_long": return "the text is too long";
    case "bad_name": return "that isn't a lane name (letters, digits, . _ -)";
    case "bad_text": return "the text holds a control character";
    case "unknown": return "no such task";
    case "no_token": case "unknown_token": return "the hub doesn't know this token (MORNDO_AGENT_TOKEN)";
    case "revoked": return "this token was revoked";
    case "lane_needed": return "which lane? set MORNDO_LANE, or run inside the lane's tmux window";
    case "rate_limited": return "too many calls; wait a moment";
    case "board_off": return "the hub has no board";
    case "not_live": return `its merge is not live${detail ? `: ${detail}` : ""}; if you accept it anyway: done T-12 --why "…" --not-live "<reason>"`;
    case "bad_sha": return "that isn't a commit hash (7 to 40 hex characters)";
    case "bad_repo": return "that isn't a repo name (owner/name)";
    case "no_merge": return "that merge isn't recorded on this task (see show)";
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
    case "moved": return `${c.from} → ${c.to}${c.reason ? `: ${c.reason}` : ""}${c.notLive !== undefined ? ` (done while not live: ${c.notLive})` : ""}`;
    case "assigned": return c.to ? `assigned it to ${c.to}` : `took it from ${c.from ?? "nobody"}`;
    case "edited": return `edited ${Object.keys(c).filter(k => k !== "kind").join(", ")}`;
    case "commented": return c.text.includes("\n") ? `commented:\n      ${c.text.replace(/\n/g, "\n      ")}` : `commented: ${c.text}`;
    case "merged": return `recorded its merge: ${c.repo} ${c.sha.slice(0, 7)}`;
    case "unmerged": return `cleared its merge record: ${c.repo} ${c.sha.slice(0, 7)}`;
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
      if (t.description) io.out(`  ${t.description.replace(/\n/g, "\n  ")}`);
      const events = (d.events as TaskEvent[] | undefined) ?? [];
      if (events.length) io.out("  History:");
      for (const e of events) io.out(`    ${when(e.at)}  ${who(e.actor).padEnd(12)} ${changeText(e)}`);
      // After a change the hub answers with that one event: say what just happened.
      const event = d.event as TaskEvent | undefined;
      if (event && !events.length) io.out(`  ${who(event.actor)} ${changeText(event)}`);
    };
    const act = async (k: string, action: Record<string, unknown>) => showTask(await call("POST", `/api/agent/board/tasks/${k}`, action));

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
        if (flags.json === true) { io.out(JSON.stringify(tasks)); return 0; }
        if (!tasks.length) { io.out(flags.mine === true ? `nothing assigned to ${me ?? "you"}` : "the board is empty"); return 0; }
        const lanes = new Set(d.lanes as string[]);
        // B11: each task's merges by key, so a row can say where its merge stands (the hub's label, its own brackets).
        const mergedBy = new Map((Array.isArray(d.merged) ? d.merged as MergedView[] : []).map(m => [m.key, m]));
        for (const s of LIST_ORDER) {
          const rows = tasks.filter(t => t.status === s);
          if (!rows.length) continue;
          io.out(`${STATUS_WORDS[s]} (${rows.length})`);
          for (const t of rows) {
            const m = mergedBy.get(t.key);
            const merge = m !== undefined && m.merges.length > 0 ? m : undefined;   // a view with no merge says nothing
            const override = merge?.merges.find(x => x.override)?.override ?? null;
            io.out(`  ${line(t)}${t.assignee && lanes.size && !lanes.has(t.assignee) ? "  [lane not running]" : ""}${merge ? `  [${merge.label}]` : ""}${override ? `  (done not live: ${override})` : ""}`);
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
        const body = { title, ...(text("desc") !== undefined ? { description: text("desc") } : {}), ...(text("assign") !== undefined ? { assignee: text("assign") } : {}), ...(priority ? { priority } : {}), ...(status ? { status } : {}) };
        showTask(await call("POST", "/api/agent/board/tasks", body));
        return 0;
      }
      case "assign": {
        const k = key(rest[0]);
        const to = rest[1];
        if (!to) throw new Usage("usage: morndo-board assign T-12 <lane>|none");
        await act(k, { action: "assign", to: to === "none" ? null : to });
        return 0;
      }
      case "start": await act(key(rest[0]), { action: "move", to: "doing" }); return 0;
      case "resume": await act(key(rest[0]), { action: "move", to: "doing" }); return 0;
      case "todo": await act(key(rest[0]), { action: "move", to: "todo" }); return 0;
      case "done": {
        const k = key(rest[0]);
        if (flags["not-live"] === true) throw new Usage("--not-live takes the reason it is accepted before it is live");
        const notLive = text("not-live");
        await act(k, { action: "move", to: "done", ...(text("why") !== undefined ? { reason: text("why") } : {}), ...(notLive !== undefined ? { notLive } : {}) });
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
