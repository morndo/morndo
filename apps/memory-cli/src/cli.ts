// morndo-memory, the lanes' command for Memory (ADR-0031): a thin client of the hub's /api/agent/memory routes. Pure of
// I/O, as morndo-board: `run` takes the arguments, the environment, a fetch, and ways to learn this lane's name, where the
// working directory sits in git, the host's name and standard input, and writes to the given streams; the entry point
// (main.ts) wires the real ones. Answers are read with the protocol's schemas: a Note this build can't read is dropped
// from a list and counted, never guessed. Exit codes, as morndo-board: 0 done, 1 refused (one line on stderr, in words an
// agent can act on), 2 usage, 3 the hub can't be reached or didn't answer in a shape this CLI knows.
import { MEMORY_LIMITS, NOTE_KINDS, TIER_LABELS, isDeliverable, isStale, parseNoteId, parseScope, type Note, type NoteId, type Scope } from "@morndo/domain";
import { MEMORY_SEARCH, MemoryListAnswer, parseBody, parseNote, type MemoryRememberBody } from "@morndo/protocol";

// Where the working directory sits in git: its top level and the common git directory every worktree of it shares.
export type GitPlace = { top: string; common: string };
export type Io = {
  fetch: typeof fetch;
  lane: () => Promise<string | null>;        // this lane's name when the environment doesn't say (tmux's window name)
  git: () => Promise<GitPlace | null>;       // null outside a repository
  host: () => string;                        // this machine's host name, when MORNDO_NODE doesn't say
  stdin: () => Promise<string>;              // all of standard input, for `--body -`
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
};
export type Env = {
  MORNDO_HUB?: string | undefined; MORNDO_AGENT_TOKEN?: string | undefined; MORNDO_LANE?: string | undefined; MORNDO_NODE?: string | undefined;
};

export const HELP = `morndo-memory: what the lanes learned, kept for every lane on every machine.

  search <words> [--scope S] [--kind fact|procedure] [--limit N] [--json]
                                  live notes that match, best first (no words: the scope's index)
  show N-12 [--json]              one note in full
  remember --kind fact|procedure --title "…" (--body "…" | --body -) [--summary "…"] [--scope S]
           [--untrusted] [--ref R] [--supersedes N-12] [--json]
                                  record what you learned; a procedure waits for the owner's approval
  invalidate N-12 --reason "…"    it no longer holds (a lane invalidates only its own notes)

A scope is repo:<name>, project:<name>, user or org. Without --scope it is repo: and the folder name of the git
repository you are in (its main checkout's, so every worktree of it shares the scope); outside one, search looks in
every scope. --body - reads the body from stdin. --untrusted: it came from outside content (a mail, a web page, a
comment); no lane gets it until the owner approves it. --ref: the work it came from (a task, a report, a PR).
--supersedes: this note replaces that one, with the same kind and scope.

Environment: MORNDO_HUB (the hub's address), MORNDO_AGENT_TOKEN (from \`morndo agent-token new\`), MORNDO_LANE (this
lane's name; without it, the tmux window's name), MORNDO_NODE (this machine's name; without it, the host name).`;

const TIMEOUT_MS = 20_000;
const NODE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // the domain's node name (M3)
const KINDS = new Set<string>(NOTE_KINDS);
const BOOLEAN = new Set(["json", "untrusted", "help"]);
const FLAGS: Record<string, readonly string[]> = {
  search: ["scope", "kind", "limit", "json"],
  show: ["json"],
  remember: ["kind", "title", "body", "summary", "scope", "untrusted", "ref", "supersedes", "json"],
  invalidate: ["reason"],
};
const REMEMBER_USAGE = 'usage: morndo-memory remember --kind fact|procedure --title "…" (--body "…" | --body -) [--summary "…"] [--scope S] [--untrusted] [--ref R] [--supersedes N-12] [--json]';

// Why the hub refused, in words an agent can act on.
function explain(error: string): string {
  switch (error) {
    case "not_yours": return "That note was written by another lane; only it, the manager or the owner can invalidate it.";
    case "not_principal": return "Only the owner can do that.";
    case "not_found": return "No such note for this lane: a lane sees the notes that are live (a procedure once the owner approved it) and the ones it wrote.";
    case "invalidated": return "That note was already invalidated or replaced; search for the one that holds now.";
    case "mismatch": return "A successor keeps the kind and the scope of the note it replaces; pass the same --kind and --scope.";
    case "already_approved": return "The owner already approved that note.";
    case "already_confirmed": return "That note is already confirmed.";
    case "untrusted": return "An untrusted note rises only by the owner's approval.";
    case "no_evidence": return "A confirmation names the evidence it rests on.";
    case "bad_kind": return "A note's kind is fact or procedure.";
    case "bad_scope": return "That isn't a scope: give repo:<name>, project:<name>, user or org.";
    case "bad_text": return "The title, summary, reference or reason holds a control character; only the body may have line breaks.";
    case "empty": return "A note needs a title and a body.";
    case "title_size": return `The title is too long: ${MEMORY_LIMITS.title} characters at most.`;
    case "summary_size": return `The summary is too long: ${MEMORY_LIMITS.summary} characters at most.`;
    case "body_size": return `The body is too long: ${MEMORY_LIMITS.body} characters at most; split it into notes.`;
    case "ref_size": return `The reference is too long: ${MEMORY_LIMITS.ref} characters at most.`;
    case "reason_size": return `The reason is too long: ${MEMORY_LIMITS.reason} characters at most.`;
    case "bad_node": return "That isn't a node name: lowercase letters, digits and hyphens, 64 at most (MORNDO_NODE).";
    case "no_provenance": return "The hub can't tell who wrote this: the token or the lane has no name.";
    case "bad_request": return "The hub couldn't read the request: a field is missing, too long or of the wrong kind.";
    case "no such route": return "This hub has no memory yet; it needs an update.";
    case "no_token": case "unknown_token": return "The hub doesn't know this token (MORNDO_AGENT_TOKEN).";
    case "revoked": return "This token was revoked.";
    case "lane_needed": return "Which lane? Set MORNDO_LANE, or run inside the lane's tmux window.";
    case "bad_name": return "That isn't a lane name: letters, digits, . _ - (MORNDO_LANE).";
    case "rate_limited": return "Too many calls; wait a moment.";
    case "board_off": return "This hub has no agent door.";
    default: return `The hub refused: ${error}.`;
  }
}

// The default scope (ADR-0031): `repo:` and the repository's folder name. That is the folder of its main checkout, the
// parent of the common git directory, so a lane in a linked worktree (`.worktrees/<branch>`) keeps the same notes as one
// in the main checkout. A bare repository's worktree takes the bare folder's name without `.git`; anything else (a
// submodule, a GIT_DIR elsewhere) the top level's own name. Null when that name is no scope.
export function repoScope(place: GitPlace): Scope | null {
  const parts = (p: string) => p.replace(/\/+$/, "").split("/");
  const common = parts(place.common);
  const last = common.at(-1) ?? "";
  const name = last === ".git" ? (common.at(-2) ?? "") : last.endsWith(".git") ? last.slice(0, -".git".length) : (parts(place.top).at(-1) ?? "");
  return parseScope(`repo:${name}`);
}

// This machine's name in a Note's provenance (M3): MORNDO_NODE as given, else the host name lowercased, every run of
// other characters one hyphen, at most 64 characters. Null when nothing is left; a MORNDO_NODE that is no node name is
// a usage error, never a guess.
export function nodeName(env: Env, host: () => string): string | null {
  const given = env.MORNDO_NODE?.trim();
  if (given) {
    if (!NODE_RE.test(given)) throw new Usage(`MORNDO_NODE must be lowercase letters, digits and hyphens, 64 at most (got ${JSON.stringify(given)})`);
    return given;
  }
  const slug = host().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 64).replace(/-+$/, "");
  return slug || null;
}

// Flags: --name value, --name=value, or a bare --json, --untrusted, --help (never followed by a value); the rest are
// positional, in order.
export function parseArgs(argv: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN.has(name) && next !== undefined && !next.startsWith("--")) { flags[name] = next; i++; }
    else flags[name] = true;
  }
  return { positional, flags };
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cells = (n: Note) => [n.id, n.kind, n.scope, TIER_LABELS[n.tier]];
// One note per line: id, kind, scope, trust and title, the columns as wide as the widest in the list. A stale note says
// so (M7).
function rows(notes: readonly Note[], now: number): string[] {
  const widths = [0, 1, 2, 3].map(i => Math.max(...notes.map(n => cells(n)[i]?.length ?? 0)));
  return notes.map(n => `${cells(n).map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ")}  ${n.title}${isStale(n, now) ? "  [stale]" : ""}`);
}
const line = (n: Note, now: number) => rows([n], now).join("");

// What a lane must know before relying on a note that is not simply live (M2, M4, M5, M7).
function standing(n: Note, now: number): string[] {
  const lines: string[] = [];
  if (n.invalidatedAt !== null) lines.push(n.supersededBy ? `replaced by ${n.supersededBy}` : `invalidated: ${n.invalidReason ?? "no reason given"}`);
  else if (n.tier === 4) lines.push("untrusted: no lane gets it until the owner approves it");
  else if (!isDeliverable(n)) lines.push("waits for the owner's approval: no lane gets it until then");
  if (n.recheckAt !== null && isStale(n, now)) lines.push(`stale since ${day(n.recheckAt)}: check it before relying on it`);
  return lines;
}

class Usage extends Error {}
class Refused extends Error { constructor(message: string) { super(message); this.name = "Refused"; } }
class Unreachable extends Error { constructor(message: string) { super(message); this.name = "Unreachable"; } }

export async function run(argv: readonly string[], env: Env, io: Io): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd = "help", ...rest] = positional;
  const now = (io.now ?? Date.now)();
  const json = flags.json === true;
  // A flag's value; a value flag given bare is a usage error, not an empty value.
  const value = (f: string): string | undefined => {
    const v = flags[f];
    if (v === true) throw new Usage(`--${f} needs a value`);
    return v;
  };
  try {
    if (cmd === "help" || flags.help === true) { io.out(HELP); return 0; }
    const allowed = FLAGS[cmd];
    if (!allowed) throw new Usage(`unknown command ${JSON.stringify(cmd)}; try morndo-memory help`);
    // An unknown flag is refused rather than ignored: a mistyped --supersedes would file a second note instead of a successor.
    for (const f of Object.keys(flags)) if (!allowed.includes(f)) throw new Usage(`${cmd} takes no --${f}; try morndo-memory help`);
    for (const f of BOOLEAN) if (typeof flags[f] === "string") throw new Usage(`--${f} takes no value`);

    const hub = (env.MORNDO_HUB ?? "").replace(/\/+$/, "");
    const token = env.MORNDO_AGENT_TOKEN ?? "";
    if (!hub || !token) throw new Usage("set MORNDO_HUB (the hub's address) and MORNDO_AGENT_TOKEN (from `morndo agent-token new`)");
    const lane = env.MORNDO_LANE?.trim() || (await io.lane());
    const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> => {
      let res: Response;
      try {
        res = await io.fetch(`${hub}${path}`, {
          method, signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (e) { throw new Unreachable(`can't reach the hub at ${hub}: ${(e as Error).message}`); }
      let data: unknown;
      try { data = await res.json(); } catch { throw new Unreachable(`the hub at ${hub} answered ${res.status} without JSON`); }
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Unreachable(`the hub answered ${res.status} in a shape this CLI doesn't know`);
      const d = data as Record<string, unknown>;
      const error = typeof d.error === "string" ? d.error : `http_${res.status}`;
      if (res.status >= 500) throw new Unreachable(`the hub at ${hub} failed (${res.status}: ${error}); try again in a moment`);
      if (!res.ok) throw new Refused(explain(error));
      return d;
    };
    const noteOf = (d: Record<string, unknown>): Note => {
      const n = parseNote(d.note);
      if (!n) throw new Unreachable("the hub answered with a note this CLI can't read; update morndo-memory");
      return n;
    };
    const idOf = (s: string | undefined): NoteId => {
      const id = s === undefined ? null : parseNoteId(s);
      if (!id) throw new Usage(`which note? give its id, like N-12${s ? ` (got ${JSON.stringify(s)})` : ""}`);
      return id;
    };
    const kindOf = (): string | undefined => {
      const k = value("kind");
      if (k !== undefined && !KINDS.has(k)) throw new Usage(`--kind takes fact or procedure (got ${JSON.stringify(k)})`);
      return k;
    };
    // --scope as given, else the repository's (see repoScope); null outside a repository.
    const scopeOf = async (): Promise<Scope | null> => {
      const given = value("scope");
      if (given !== undefined) {
        const s = parseScope(given);
        if (!s) throw new Usage(`--scope takes repo:<name>, project:<name>, user or org (got ${JSON.stringify(given)})`);
        return s;
      }
      const place = await io.git();
      if (!place) return null;
      const s = repoScope(place);
      if (!s) throw new Usage("this repository's folder name is not a scope (letters, digits, . _ -); pass --scope repo:<name>");
      return s;
    };

    switch (cmd) {
      case "search": {
        const words = rest.join(" ").trim();
        if (words.length > MEMORY_SEARCH.query) throw new Usage(`the words are too long: ${MEMORY_SEARCH.query} characters at most`);
        const kind = kindOf();
        const limitText = value("limit");
        const limit = limitText === undefined ? undefined : Number(limitText);
        if (limit !== undefined && (!/^\d+$/.test(limitText ?? "") || limit < 1 || limit > MEMORY_SEARCH.limitMax)) throw new Usage(`--limit takes a whole number from 1 to ${MEMORY_SEARCH.limitMax}`);
        const scope = await scopeOf();
        const q = new URLSearchParams({ q: words });
        if (scope) q.set("scope", scope);
        if (kind) q.set("kind", kind);
        if (limit !== undefined) q.set("limit", String(limit));
        const d = await call("GET", `/api/agent/memory/search?${q.toString()}`);
        if (json) { io.out(JSON.stringify(d, null, 2)); return 0; }
        const list = parseBody(MemoryListAnswer, d);
        if (!list) throw new Unreachable("the hub answered a search in a shape this CLI doesn't know");
        const notes = list.notes.map(parseNote).filter((n): n is Note => n !== null);
        const where = scope ?? "any scope";
        if (!notes.length) io.out(words ? `nothing in ${where} matches ${JSON.stringify(words)}` : `nothing in ${where} yet`);
        for (const r of rows(notes, now)) io.out(r);
        const dropped = list.notes.length - notes.length;
        if (dropped) io.err(`${dropped} ${dropped === 1 ? "note" : "notes"} in the answer could not be read by this morndo-memory; update it to see ${dropped === 1 ? "it" : "them"}`);
        return 0;
      }
      case "show": {
        const d = await call("GET", `/api/agent/memory/notes/${idOf(rest[0])}`);
        if (json) { io.out(JSON.stringify(d, null, 2)); return 0; }
        const n = noteOf(d);
        const p = n.provenance;
        io.out(line(n, now));
        io.out(`  by ${p.by}${p.node ? ` on ${p.node}` : ""}${p.ref ? ` · from ${p.ref}` : ""} · written ${day(n.createdAt)} · confirmed ${day(n.lastConfirmedAt)}${n.supersedes ? ` · replaces ${n.supersedes}` : ""}`);
        for (const l of standing(n, now)) io.out(`  ${l}`);
        if (n.summary) io.out(`  ${n.summary}`);
        io.out("");
        io.out(n.body);
        return 0;
      }
      case "remember": {
        if (rest.length) throw new Usage(REMEMBER_USAGE);
        const kind = kindOf();
        const title = value("title");
        const bodyFlag = value("body");
        if (kind === undefined || title === undefined || bodyFlag === undefined) throw new Usage(REMEMBER_USAGE);
        const supersedes = value("supersedes");
        if (supersedes !== undefined && !parseNoteId(supersedes)) throw new Usage(`--supersedes takes the id of the note this one replaces, like N-12 (got ${JSON.stringify(supersedes)})`);
        const summary = value("summary");
        const ref = value("ref");
        const scope = await scopeOf();
        if (!scope) throw new Usage("which scope? run inside the git repository the note is about, or pass --scope repo:<name>|project:<name>|user|org");
        const node = nodeName(env, io.host);
        const body = bodyFlag === "-" ? await io.stdin() : bodyFlag;
        // The hub's limits, checked here so the refusal names the field (the hub's own answer would be bad_request).
        if (!title.trim() || !body.trim()) throw new Refused(explain("empty"));
        if (title.length > MEMORY_LIMITS.title) throw new Refused(explain("title_size"));
        if (summary !== undefined && summary.length > MEMORY_LIMITS.summary) throw new Refused(explain("summary_size"));
        if (body.length > MEMORY_LIMITS.body) throw new Refused(explain("body_size"));
        if (ref !== undefined && ref.length > MEMORY_LIMITS.ref) throw new Refused(explain("ref_size"));
        const request: MemoryRememberBody = {
          kind: kind as MemoryRememberBody["kind"], scope, title, body,
          ...(summary !== undefined ? { summary } : {}), ...(flags.untrusted === true ? { untrusted: true } : {}),
          ...(ref !== undefined ? { ref } : {}), ...(node ? { node } : {}), ...(supersedes !== undefined ? { supersedes } : {}),
        };
        const d = await call("POST", "/api/agent/memory/notes", request);
        if (json) { io.out(JSON.stringify(d, null, 2)); return 0; }
        const n = noteOf(d);
        io.out(line(n, now));
        if (n.supersedes) io.out(`  replaces ${n.supersedes}`);
        const s = standing(n, now);
        for (const l of s.length ? s : ["live: a search finds it now"]) io.out(`  ${l}`);
        return 0;
      }
      case "invalidate": {
        const id = idOf(rest[0]);
        const reason = value("reason");
        if (rest.length > 1 || !reason?.trim()) throw new Usage('usage: morndo-memory invalidate N-12 --reason "…"');
        if (reason.length > MEMORY_LIMITS.reason) throw new Refused(explain("reason_size"));
        const d = await call("POST", `/api/agent/memory/notes/${id}/invalidate`, { reason });
        // Done is the hub's 2xx; the note it answers with, when this CLI can read it, adds the reason as recorded.
        const n = parseNote(d.note);
        io.out(`${id} invalidated: ${n?.invalidReason ?? reason.trim()}`);
        return 0;
      }
      default:
        throw new Usage(`unknown command ${JSON.stringify(cmd)}; try morndo-memory help`);
    }
  } catch (e) {
    if (e instanceof Usage) { io.err(e.message); return 2; }
    if (e instanceof Refused) { io.err(e.message); return 1; }
    if (e instanceof Unreachable) { io.err(e.message); return 3; }
    throw e;
  }
}
