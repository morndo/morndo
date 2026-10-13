// morndo-decide, the agents' way to file a decision brief (ADR-0023): a thin client of the hub's /api/agent/decisions
// routes, plus `lint` and `template`, which call the same lintBrief the hub does and need no hub. Pure of I/O: `run`
// takes the arguments, the environment, a fetch, a file reader and a way to learn this lane's name.
// Exit codes, as morndo-board: 0 done, 1 the hub (or the lint) refused, 2 usage, 3 the hub can't be reached.
import { lintBrief, briefMarkdown, type BriefProblem, type DecisionBrief } from "@morndo/domain";
import { BRIEF_TEMPLATE, parseBriefMarkdown } from "@morndo/protocol";
import { parseArgs } from "./cli.ts";
import { decidePromptFor } from "./prompt.ts";

export type Io = {
  fetch: typeof fetch;
  lane: () => Promise<string | null>;
  read: (path: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
  timeZone?: string;
};
export type Env = { MORNDO_HUB?: string | undefined; MORNDO_AGENT_TOKEN?: string | undefined; MORNDO_LANE?: string | undefined };

export const HELP = `morndo-decide: a decision brief for the principal.

  template                                print the blank
  lint <file.md|->                        check a brief; files nothing
  new <file.md|-> [--json]                file it; prints the id and any warnings
  restate <id> <file.md|-> [--json]       the next version; answers to the old one are refused
  show <id> [--json]                      the brief as filed, its status, and the answer once given
  list [--open] [--drafts] [--json]       your requests (the manager: --drafts adds the lanes' drafts)
  forward <id>                            manager: send a lane's draft to the principal
  decline <id> --why "…"                  manager: turn a lane's draft down
  withdraw <id> --why "…"                 the question went away
  settle <id> [--note "…"]                you acted on the answer; it leaves the principal's list
  prompt --role manager|worker            the instruction block for a lane's prompt

Environment: MORNDO_HUB (the hub's address), MORNDO_AGENT_TOKEN (from \`morndo agent-token new\`), MORNDO_LANE (this
lane's name; without it, the tmux window's name). A worker's brief is a draft until the manager forwards it.`;

const ID = /^[A-Za-z0-9_-]{1,32}$/;

function explain(error: string): string {
  switch (error) {
    case "not_allowed": return "only the manager may do that";
    case "unknown": return "no such request";
    case "due_past": return "the due date has passed; restate it before forwarding";
    case "no_ledger": return "this hub has no list, so a ref cannot be answered";
    case "ref_taken": return "that ref is already a request";
    case "too_many_open": return "20 open requests already; settle or withdraw one first";
    case "not_open": return "that request is not open";
    case "reason_needed": return "say why: --why \"…\"";
    case "too_long": return "the text is too long";
    case "bad_text": return "the text holds a control character";
    case "no_token": case "unknown_token": return "the hub doesn't know this token (MORNDO_AGENT_TOKEN)";
    case "revoked": return "this token was revoked";
    case "lane_needed": return "which lane? set MORNDO_LANE, or run inside the lane's tmux window";
    case "rate_limited": return "too many calls; wait a moment";
    case "briefs_off": return "the hub has no decision briefs";
    default: return error;
  }
}

const problemLine = (p: BriefProblem) => `${p.level} ${p.code} (${p.where}): ${p.text}`;
const asText = (v: unknown) => typeof v === "string" || typeof v === "number" ? String(v) : "";

class Usage extends Error {}
class Refused extends Error { constructor(message: string) { super(message); this.name = "Refused"; } }
class Unreachable extends Error { constructor(message: string) { super(message); this.name = "Unreachable"; } }

type Answer = { kind: "option"; key: string; label: string } | { kind: "words" } | null;
type Summary = {
  id: string; version: number; topic: string; headline: string; status: string;
  answer: Answer; draftedBy: string | null; asker: { kind: string; name: string }; resolution: string | null;
};

function isProblem(v: unknown): v is BriefProblem {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (p.level === "error" || p.level === "warning") && typeof p.code === "string" && typeof p.where === "string" && typeof p.text === "string";
}

function answerText(a: Answer): string {
  if (a === null) return "no answer yet";
  if (a.kind === "words") return "in words";
  return `${a.key} · ${a.label}`;
}

export async function run(argv: readonly string[], env: Env, io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "help", ...rest] = positional;
  const text = (f: string) => (typeof flags[f] === "string" ? (flags[f] as string) : undefined);
  try {
    if (cmd === "help" || flags.help === true) { io.out(HELP); return 0; }
    if (cmd === "template") { io.out(BRIEF_TEMPLATE.replace(/\n$/, "")); return 0; }
    if (cmd === "prompt") {
      const role = text("role");
      if (role !== "manager" && role !== "worker") throw new Usage("usage: morndo-decide prompt --role manager|worker");
      io.out(decidePromptFor(role).trimEnd());
      return 0;
    }
    if (cmd === "lint") {
      const path = rest[0];
      if (!path) throw new Usage("usage: morndo-decide lint <file.md|->");
      const raw = await io.read(path);
      const parsed = flags.json === true ? { draft: JSON.parse(raw) as unknown, problems: [] as BriefProblem[] } : parseBriefMarkdown(raw, io.timeZone ?? "UTC");
      const lint = lintBrief(parsed.draft, (io.now ?? Date.now)());
      const errors = [...parsed.problems.filter(p => p.level === "error"), ...lint.problems.filter(p => p.level === "error")];
      const warnings = errors.length ? [] : lint.problems.filter(p => p.level === "warning");
      for (const p of [...errors, ...warnings]) io.err(problemLine(p));
      return errors.length ? 1 : 0;
    }

    const hub = (env.MORNDO_HUB ?? "").replace(/\/+$/, "");
    const token = env.MORNDO_AGENT_TOKEN ?? "";
    if (!hub || !token) throw new Usage("set MORNDO_HUB (the hub's address) and MORNDO_AGENT_TOKEN (from `morndo agent-token new`)");
    const lane = env.MORNDO_LANE?.trim() || (await io.lane());
    const call = async (method: "GET" | "POST" | "PUT", path: string, body?: { json?: unknown; markdown?: string }): Promise<{ status: number; data: Record<string, unknown> }> => {
      let res: Response;
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}) };
      let payload: string | undefined;
      if (body?.markdown !== undefined) { headers["content-type"] = "text/markdown"; payload = body.markdown; }
      else if (body?.json !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
      try { res = await io.fetch(`${hub}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }); }
      catch (e) { throw new Unreachable(`can't reach the hub at ${hub}: ${(e as Error).message}`); }
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("text/markdown")) return { status: res.status, data: { text: await res.text() } };
      let data: unknown;
      try { data = await res.json(); } catch { throw new Unreachable(`the hub at ${hub} answered ${res.status} without JSON`); }
      if (typeof data !== "object" || data === null) throw new Unreachable(`the hub answered ${res.status} in a shape this CLI doesn't know`);
      return { status: res.status, data: data as Record<string, unknown> };
    };
    const problemsOf = (data: Record<string, unknown>) => (Array.isArray(data.problems) ? data.problems.filter(isProblem) : []);
    const refused = (data: Record<string, unknown>) => {
      const problems = problemsOf(data);
      if (problems.length) throw new Refused(problems.map(problemLine).join("\n"));
      throw new Refused(explain(typeof data.error === "string" ? data.error : "refused"));
    };
    const idOf = (s: string | undefined) => {
      if (!s || !ID.test(s)) throw new Usage(`which request? give its id, like d-12${s ? ` (got ${JSON.stringify(s)})` : ""}`);
      return s;
    };
    const load = async (path: string | undefined) => {
      if (!path) throw new Usage("which file? give a path, or - for stdin");
      const raw = await io.read(path);
      if (flags.json === true) {
        try { return { json: JSON.parse(raw) as unknown }; }
        catch { throw new Usage("the file is not JSON"); }
      }
      return { markdown: raw };
    };
    const warn = (data: Record<string, unknown>) => {
      if (!Array.isArray(data.warnings)) return;
      for (const p of data.warnings) if (isProblem(p)) io.err(problemLine(p));
    };
    const showText = (request: Summary & { brief?: DecisionBrief }) => {
      if (flags.json === true) { io.out(JSON.stringify(request, null, 2)); return; }
      const drafted = request.draftedBy ? `  drafted by ${request.draftedBy}` : "";
      io.out(`${request.id}  v${request.version}  ${request.status}${drafted}`);
      io.out(request.topic);
      io.out(request.headline);
      if (request.resolution) io.out(`  ${request.resolution}`);
      if (request.brief) { io.out(""); io.out(briefMarkdown(request.brief)); }
      io.out("");
      io.out(`Answer: ${answerText(request.answer)}`);
    };

    switch (cmd) {
      case "new": {
        const body = await load(rest[0]);
        const { status, data } = await call("POST", "/api/agent/decisions", body);
        if (status === 422 || !status.toString().startsWith("2")) refused(data);
        warn(data);
        io.out(asText(data.id));
        return 0;
      }
      case "restate": {
        const id = idOf(rest[0]);
        const body = await load(rest[1]);
        const { status, data } = await call("PUT", `/api/agent/decisions/${id}`, body);
        if (status === 422 || !status.toString().startsWith("2")) refused(data);
        warn(data);
        io.out(`${asText(data.id)}  v${asText(data.version)}`);
        return 0;
      }
      case "show": {
        const { status, data } = await call("GET", `/api/agent/decisions/${idOf(rest[0])}`);
        if (status !== 200) refused(data);
        showText(data.request as Summary & { brief: DecisionBrief });
        return 0;
      }
      case "list": {
        const q = `${flags.open === true ? "open=1" : ""}${flags.open === true && flags.drafts === true ? "&" : ""}${flags.drafts === true ? "drafts=1" : ""}`;
        const { status, data } = await call("GET", `/api/agent/decisions${q ? `?${q}` : ""}`);
        if (status !== 200) refused(data);
        const requests = data.requests as Summary[];
        if (flags.json === true) { io.out(JSON.stringify(requests, null, 2)); return 0; }
        if (!requests.length) { io.out("no requests"); return 0; }
        for (const r of requests) io.out(`${r.id.padEnd(8)} v${String(r.version).padEnd(3)} ${r.status.padEnd(10)} ${r.topic}${r.draftedBy ? `  drafted by ${r.draftedBy}` : ""}`);
        return 0;
      }
      case "forward": {
        const { status, data } = await call("POST", `/api/agent/decisions/${idOf(rest[0])}/forward`);
        if (status !== 200) refused(data);
        io.out(`${rest[0]} forwarded`);
        return 0;
      }
      case "decline": {
        const why = text("why");
        if (!why) throw new Usage('usage: morndo-decide decline <id> --why "…"');
        const { status, data } = await call("POST", `/api/agent/decisions/${idOf(rest[0])}/decline`, { json: { why } });
        if (status !== 200) refused(data);
        io.out(`${rest[0]} declined`);
        return 0;
      }
      case "withdraw": {
        const why = text("why");
        if (!why) throw new Usage('usage: morndo-decide withdraw <id> --why "…"');
        const { status, data } = await call("POST", `/api/agent/decisions/${idOf(rest[0])}/withdraw`, { json: { why } });
        if (status !== 200) refused(data);
        io.out(`${rest[0]} withdrawn`);
        return 0;
      }
      case "settle": {
        const note = text("note");
        const { status, data } = await call("POST", `/api/agent/decisions/${idOf(rest[0])}/settle`, { json: note === undefined ? {} : { note } });
        if (status !== 200) refused(data);
        io.out(`${rest[0]} settled`);
        return 0;
      }
      default:
        throw new Usage(`unknown command ${JSON.stringify(cmd)}; try morndo-decide help`);
    }
  } catch (e) {
    if (e instanceof Usage) { io.err(e.message); return 2; }
    if (e instanceof Refused) { io.err(e.message.startsWith("error ") || e.message.startsWith("warning ") ? e.message : `refused: ${e.message}`); return 1; }
    if (e instanceof Unreachable) { io.err(e.message); return 3; }
    if (e instanceof SyntaxError) { io.err("the file is not JSON"); return 2; }
    throw e;
  }
}
