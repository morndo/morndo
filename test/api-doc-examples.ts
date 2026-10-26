// Reads docs/fleet-api.md's examples and matches real answers to them (fleet clients, Task 15). The format is the doc's own
// section 4, "How to read the examples":
// - a fenced block whose info string is `example <name> [poll|events|subscriber]`;
// - a request ("METHOD target", header lines, a blank line, the body), a line "---", then its answer (the status, header
//   lines, a blank line, the body); with `poll` the request is repeated until the answer matches;
// - `events`: JSON messages, one per line, seen in that order on a /v1/events subscription;
// - `subscriber`: a request the fleet made to a hook subscriber.
// Placeholders ({{kind}}, {{kind?}}, {{kind:name}}, {{uri:name}}, ["{{unordered}}", …]) are JSON strings in the doc and
// match values of their kind; a name binds once and holds every later use, in answers and in requests. Everything else
// matches only itself, and an answer may hold no field its example doesn't name.
// It imports no vitest: the doc test (test/fleet/api-doc.test.ts) and the matcher's own (test/fleet/api-doc-matcher.test.ts)
// both use it.
import { WORKER_ID } from "../packages/protocol/src/worker-id.ts";

export type Http = { method: string; target: string; headers: Record<string, string>; body: string };
export type Answer = { status: number; headers: Record<string, string>; body: string };
export type Example =
  | { name: string; kind: "http"; poll: boolean; request: Http; answer: Answer }
  | { name: string; kind: "ws"; request: Http; messages: string[] }
  | { name: string; kind: "events"; messages: string[] }
  | { name: string; kind: "subscriber"; request: Http };
export type Vars = Map<string, unknown>;
export type Verdict = { ok: true; vars: Vars } | { ok: false; why: string };
// What a hook subscriber received (test/fleet-harness.ts, subscriber()): its path, its headers and the event, parsed.
export type Received = { path: string; headers: Record<string, string>; event: unknown };

const FENCE = /^```example ([a-z0-9-]+)((?: [a-z]+)*)\n([\s\S]*?)\n```$/gm;
const MODIFIERS = new Set(["poll", "events", "subscriber"]);
const KINDS = new Set(["any", "string", "number", "time", "uuid", "workerId", "unordered", "uri"]);
const TOKEN = /\{\{([A-Za-z]+)(\?)?(?::([A-Za-z0-9_-]+))?\}\}/g;
const WHOLE = /^\{\{([A-Za-z]+)(\?)?(?::([A-Za-z0-9_-]+))?\}\}$/;
const HEADER = /^([A-Za-z0-9-]+): (.*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TWO_DAYS = 2 * 86_400_000;
const show = (v: unknown) => (v === undefined ? "nothing" : (JSON.stringify(v) ?? typeof v).slice(0, 200));   // undefined only for a function or a symbol

// ---- parsing

function head(text: string): { first: string; headers: Record<string, string>; body: string } {
  const lines = text.split("\n");
  const first = (lines.shift() ?? "").trim();
  const headers: Record<string, string> = {};
  for (let h = HEADER.exec(lines[0] ?? ""); h; h = HEADER.exec(lines[0] ?? "")) {
    headers[(h[1] ?? "").toLowerCase()] = h[2] ?? "";
    lines.shift();
  }
  return { first, headers, body: lines.join("\n").trim() };
}
function request(text: string, where: string): Http {
  const h = head(text);
  const r = /^(GET|POST|WS) (\S+)$/.exec(h.first);
  if (!r) throw new Error(`${where}: "${h.first}" is not "METHOD target"`);
  return { method: r[1] ?? "", target: r[2] ?? "", headers: h.headers, body: h.body };
}
function answer(text: string, where: string): Answer {
  const h = head(text);
  if (!/^\d{3}$/.test(h.first)) throw new Error(`${where}: "${h.first}" is not a status`);
  return { status: Number(h.first), headers: h.headers, body: h.body };
}
const messages = (text: string) => text.split("\n").map(l => l.trim()).filter(Boolean);

export function parseExamples(markdown: string): Example[] {
  const out: Example[] = [];
  const names = new Set<string>();
  for (const f of markdown.matchAll(FENCE)) {
    const name = f[1] ?? "";
    const where = `example ${name}`;
    const flags = (f[2] ?? "").trim().split(" ").filter(Boolean);
    const content = f[3] ?? "";
    if (names.has(name)) throw new Error(`${where}: the name is used twice`);
    names.add(name);
    for (const flag of flags) if (!MODIFIERS.has(flag)) throw new Error(`${where}: unknown modifier ${flag}`);
    for (const t of content.matchAll(TOKEN)) if (!KINDS.has(t[1] ?? "")) throw new Error(`${where}: unknown placeholder ${t[0]}`);
    if (flags.includes("events")) { out.push({ name, kind: "events", messages: messages(content) }); continue; }
    if (flags.includes("subscriber")) { out.push({ name, kind: "subscriber", request: request(content, where) }); continue; }
    const at = content.indexOf("\n---\n");
    if (at === -1) throw new Error(`${where}: no "---" between the request and the answer`);
    const req = request(content.slice(0, at), where);
    const rest = content.slice(at + 5);
    if (req.method === "WS") out.push({ name, kind: "ws", request: req, messages: messages(rest) });
    else out.push({ name, kind: "http", poll: flags.includes("poll"), request: req, answer: answer(rest, where) });
  }
  return out;
}

// ---- requests

// A request with each {{kind:name}} replaced by the value bound to `name`: a whole JSON string "{{kind:name}}" by the value
// as JSON (a number stays a number), anything else by its text, and {{uri:name}} by its text URL-encoded as one segment.
export function substitute(text: string, vars: Vars): string {
  const value = (token: string, name: string) => {
    if (!vars.has(name)) throw new Error(`${token}: nothing bound to ${name} yet`);
    return vars.get(name);
  };
  const out = text
    .replace(/"\{\{([A-Za-z]+):([A-Za-z0-9_-]+)\}\}"/g, (t, kind: string, name: string) =>
      JSON.stringify(kind === "uri" ? encodeURIComponent(String(value(t, name))) : value(t, name)))
    .replace(/\{\{([A-Za-z]+):([A-Za-z0-9_-]+)\}\}/g, (t, kind: string, name: string) =>
      (kind === "uri" ? encodeURIComponent(String(value(t, name))) : String(value(t, name))));
  const open = /\{\{[^}]*\}\}/.exec(out);
  if (open) throw new Error(`${open[0]}: a request can't hold an open placeholder; bind a name in an earlier answer`);
  return out;
}

// ---- matching

const CHECK: Record<string, (v: unknown) => boolean> = {
  any: () => true,
  string: v => typeof v === "string",
  number: v => typeof v === "number" && Number.isFinite(v),
  time: v => typeof v === "number" && Number.isInteger(v) && Math.abs(v - Date.now()) < TWO_DAYS,
  uuid: v => typeof v === "string" && UUID.test(v),
  workerId: v => typeof v === "string" && WORKER_ID.test(v),
};
// Inside a longer string, as a regular expression (groups made non-capturing, so each placeholder is one group).
const inner = (re: RegExp) => re.source.slice(1, -1).replace(/\((?!\?)/g, "(?:");
const PART: Record<string, string> = {
  any: "[\\s\\S]*?", string: "[\\s\\S]+?", number: "-?\\d+(?:\\.\\d+)?", time: "\\d{12,14}", uuid: inner(UUID), workerId: inner(WORKER_ID),
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function bind(name: string | undefined, v: unknown, vars: Vars, at: string): string | null {
  if (name === undefined) return null;
  if (!vars.has(name)) { vars.set(name, v); return null; }
  return JSON.stringify(vars.get(name)) === JSON.stringify(v) ? null : `${at}: expected ${name} = ${show(vars.get(name))}, got ${show(v)}`;
}

function embedded(exp: string, act: unknown, vars: Vars, at: string): string | null {
  if (typeof act !== "string") return `${at}: expected a string like ${show(exp)}, got ${show(act)}`;
  const names: (string | undefined)[] = [];
  let source = "";
  let last = 0;
  for (const t of exp.matchAll(TOKEN)) {
    source += `${escape(exp.slice(last, t.index))}(${PART[t[1] ?? ""] ?? "(?!)"})`;
    names.push(t[3]);
    last = (t.index ?? 0) + t[0].length;
  }
  const found = new RegExp(`^${source}${escape(exp.slice(last))}$`).exec(act);
  if (!found) return `${at}: expected ${show(exp)}, got ${show(act)}`;
  for (const [i, name] of names.entries()) {
    const why = bind(name, found[i + 1], vars, at);
    if (why) return why;
  }
  return null;
}

function unordered(exp: unknown[], act: unknown[], vars: Vars, at: string): string | null {
  if (exp.length !== act.length) return `${at}: expected ${exp.length} items in any order, got ${act.length}`;
  const used = new Set<number>();
  for (const [i, e] of exp.entries()) {
    let why = "";
    const hit = act.findIndex((a, j) => {
      if (used.has(j)) return false;
      const trial = new Map(vars);
      const r = match(e, a, trial, `${at}[${j}]`);
      if (r !== null) { why ||= r; return false; }
      for (const [k, v] of trial) vars.set(k, v);
      return true;
    });
    if (hit === -1) return `${at}: nothing matches item ${i} (${why})`;
    used.add(hit);
  }
  return null;
}

// Null when `act` matches `exp`; else where and how it differs. Names bound on the way go into `vars`.
export function match(exp: unknown, act: unknown, vars: Vars, at = "$"): string | null {
  if (typeof exp === "string") {
    const w = WHOLE.exec(exp);
    if (w) {
      const [, kind = "", , name] = w;
      const ok = CHECK[kind];
      if (!ok) return `${at}: ${exp} can't stand for a value`;
      if (!ok(act)) return `${at}: expected ${kind}, got ${show(act)}`;
      return bind(name, act, vars, at);
    }
    if (exp.includes("{{")) return embedded(exp, act, vars, at);
    return exp === act ? null : `${at}: expected ${show(exp)}, got ${show(act)}`;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(act)) return `${at}: expected a list, got ${show(act)}`;
    if (exp[0] === "{{unordered}}") return unordered(exp.slice(1), act, vars, at);
    if (exp.length !== act.length) return `${at}: expected ${exp.length} items, got ${act.length}`;
    for (const [i, e] of exp.entries()) {
      const why = match(e, act[i], vars, `${at}[${i}]`);
      if (why) return why;
    }
    return null;
  }
  if (exp !== null && typeof exp === "object") {
    if (act === null || typeof act !== "object" || Array.isArray(act)) return `${at}: expected an object, got ${show(act)}`;
    const e = exp as Record<string, unknown>;
    const a = act as Record<string, unknown>;
    for (const k of Object.keys(a)) if (!Object.hasOwn(e, k)) return `${at}.${k}: not in the example (${show(a[k])})`;
    for (const [k, v] of Object.entries(e)) {
      if (!Object.hasOwn(a, k)) {
        if (typeof v === "string" && WHOLE.exec(v)?.[2] === "?") continue;
        return `${at}.${k}: missing`;
      }
      const why = match(v, a[k], vars, `${at}.${k}`);
      if (why) return why;
    }
    return null;
  }
  return Object.is(exp, act) ? null : `${at}: expected ${show(exp)}, got ${show(act)}`;
}

function body(exp: string, got: string, vars: Vars): string | null {
  if (exp === "") return got.trim() === "" ? null : `body: expected none, got ${show(got)}`;
  let e: unknown;
  try { e = JSON.parse(exp); } catch { return got.replace(/\n$/, "") === exp ? null : `body: expected ${show(exp)}, got ${show(got)}`; }
  let a: unknown;
  try { a = JSON.parse(got); } catch { return `body: expected JSON, got ${show(got)}`; }
  return match(e, a, vars, "body");
}

function headersMatch(exp: Record<string, string>, got: Record<string, string>, vars: Vars): string | null {
  for (const [name, value] of Object.entries(exp)) {
    const why = match(value, got[name], vars, `header ${name}`);
    if (why) return why;
  }
  return null;
}

export function matchAnswer(exp: Answer, got: Answer, vars: Vars): Verdict {
  if (exp.status !== got.status) return { ok: false, why: `status: expected ${exp.status}, got ${got.status}` };
  const trial = new Map(vars);
  const why = headersMatch(exp.headers, got.headers, trial) ?? body(exp.body, got.body, trial);
  return why ? { ok: false, why } : { ok: true, vars: trial };
}

// Each expected message, in order, among the ones received (others may come between them).
export function matchEvents(exp: string[], got: readonly unknown[], vars: Vars): Verdict {
  const trial = new Map(vars);
  let from = 0;
  for (const [i, line] of exp.entries()) {
    const e = JSON.parse(line) as unknown;
    let why = "none received after the one before it";
    let hit = -1;
    for (let j = from; j < got.length && hit === -1; j++) {
      const t = new Map(trial);
      const r = match(e, got[j], t, `message ${i}`);
      if (r === null) { hit = j; for (const [k, v] of t) trial.set(k, v); } else why = r;
    }
    if (hit === -1) return { ok: false, why: `message ${i} not seen (${got.length} received; the last that differed: ${why})` };
    from = hit + 1;
  }
  return { ok: true, vars: trial };
}

// Any one request the subscriber received that matches.
export function matchReceived(exp: Http, got: readonly Received[], vars: Vars): Verdict {
  const e = JSON.parse(exp.body) as unknown;
  let why = `none of the ${got.length} requests received`;
  for (const g of got) {
    const trial = new Map(vars);
    const r = exp.method !== "POST" ? `method: expected ${exp.method}, got POST`
      : match(exp.target, g.path, trial, "path") ?? headersMatch(exp.headers, g.headers, trial) ?? match(e, g.event, trial, "body");
    if (r === null) return { ok: true, vars: trial };
    why = r;
  }
  return { ok: false, why };
}
