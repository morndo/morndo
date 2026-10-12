// morndo-secrets: the machine commands for the node's Secrets (ADR-0022; design §5.2, §6, §14). The value comes only from
// stdin, as bytes, with one trailing newline stripped unless --raw (D3). Every command that widens, and every one that
// destroys, asks for a confirmation typed at the terminal and has no --yes; disable and ungrant narrow, so anyone may run
// them (SC7). No command prints a value: they print References, versions, metadata and events.
import { createHash } from "node:crypto";
import { KEEP_SHAPE, USE_MODES, parseReference, type Actor, type GrantEnd, type GrantSubject, type UseMode } from "@morndo/domain";
import { LeftBehind } from "./application/secrets-service.ts";
import { openSecrets, type SecretsHome } from "./compose.ts";
import { FileRefused } from "./adapters/file-mode.ts";
import { NodeKeyRefused } from "./adapters/node-keys.ts";
import { DatabaseFromFuture } from "./adapters/store-migrations.ts";
import { IndexFileRefused } from "@morndo/node-ops";

export type SecretsIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // The value's bytes when stdin is piped; null when it is a terminal.
  stdin: Uint8Array | null;
  // A line typed at the terminal after `prompt`, or null with no terminal to ask at.
  confirm: (prompt: string) => Promise<string | null>;
};

const USAGE = 64;
const REFUSED = 1;
// Done, with something left to clean that the command names on stderr (review 4).
const PARTIAL = 3;
// A file to restore or fix: a node key, the database, the index file or a vault file.
const FILES = 70;
const BOOLEANS = new Set(["raw", "node"]);
const VALUES = new Set(["lane", "workspace", "mode", "until", "expiry"]);

class Usage extends Error {}
// `left`: what a refused command left to clean (round 2, point 11).
class Refused extends Error {
  readonly left: readonly string[];
  constructor(message: string, left: readonly string[] = []) {
    super(message);
    this.left = left;
  }
}

type Parsed = { cmd: string; positionals: string[]; flags: Set<string>; values: Map<string, string[]> };

function parse(argv: readonly string[]): Parsed {
  const cmd = argv[0] ?? "";
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const name = token.slice(2);
    if (name === "yes") throw new Usage("there is no --yes: type the confirmation at the terminal");
    if (name === "value") throw new Usage("put reads the value from stdin only");
    if (BOOLEANS.has(name)) { flags.add(name); continue; }
    const value = argv[i + 1];
    if (!VALUES.has(name) || value === undefined || value.startsWith("--")) throw new Usage(`unknown or incomplete option --${name}`);
    values.set(name, [...(values.get(name) ?? []), value]);
    i += 1;
  }
  return { cmd, positionals, flags, values };
}

const one = (p: Parsed, n: number, what: string): string[] => {
  if (p.positionals.length !== n) throw new Usage(`${p.cmd} takes ${what}`);
  return p.positionals;
};
const reference = (text: string | undefined): string => {
  if (text === undefined || parseReference(text) === null) throw new Usage("not a Reference: secret://<scope>/<name>");
  return text;
};

// stdin's bytes, read to the end, copied into an array of their own, and each chunk the stream handed over zeroed once
// copied. Not Buffer.concat: it cuts a result under half of Buffer.poolSize (32 KiB since Node 24.18) from Node's shared
// pool, where the value would outlive the zeroing (round 2, point 3; https://nodejs.org/docs/latest-v24.x/api/buffer.html,
// Buffer.poolSize and Buffer.allocUnsafe, read 2026-10-12).
// The chunks are zeroed in a finally, so a stream that fails midway leaves none of them behind (round 3, point 4).
export async function stdinValue(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function runSecrets(argv: readonly string[], env: NodeJS.ProcessEnv, io: SecretsIo): Promise<number> {
  let home: SecretsHome | null = null;
  try {
    const parsed = parse(argv);
    home = openSecrets(env);
    // The sweep never stops a command: an emergency disable or revoke must run with the index unreadable (review 3).
    try { home.service.sweep(); } catch (error) { io.stderr(`warning: the startup sweep failed: ${error instanceof Error ? error.message : "failed"}\n`); }
    return await dispatch(home, parsed, io);
  } catch (error) {
    // A store whose cleanup failed too is reported by its own error, then what it left (round 2, point 11).
    const cause = error instanceof LeftBehind ? error.cause : error;
    io.stderr(`${cause instanceof Error ? cause.message : "failed"}\n`);
    if (error instanceof LeftBehind || error instanceof Refused) leftOver(error.left, io);
    if (cause instanceof Usage) return USAGE;
    const file = [FileRefused, DatabaseFromFuture, IndexFileRefused, NodeKeyRefused].some(kind => cause instanceof kind);
    return file ? FILES : REFUSED;
  } finally {
    // The value's bytes are zeroed whatever happened, a usage error or a home that won't open included (round 2, point 7).
    io.stdin?.fill(0);
    home?.close();
  }
}

async function dispatch(home: SecretsHome, p: Parsed, io: SecretsIo): Promise<number> {
  switch (p.cmd) {
    case "put": return put(home, p, io);
    case "workspace": return workspace(home, p, io);
    case "list": {
      one(p, 0, "no arguments");
      for (const view of home.service.list()) io.stdout(`${JSON.stringify(view)}\n`);
      return 0;
    }
    case "log": {
      if (p.positionals.length > 1) throw new Usage("log takes at most a Reference");
      const ref = p.positionals[0] === undefined ? null : reference(p.positionals[0]);
      for (const event of home.service.log(ref)) io.stdout(`${JSON.stringify(event)}\n`);
      return 0;
    }
    case "grant": {
      const [ref] = one(p, 1, "a Reference");
      const subject = subjectOf(p);
      const modes = (p.values.get("mode") ?? []) as UseMode[];
      if (modes.length === 0 || !modes.every(m => (USE_MODES as readonly string[]).includes(m))) throw new Usage(`--mode: ${USE_MODES.join(", ")}`);
      const until = untilOf(p.values.get("until")?.at(-1));
      const actor = await confirmed(home, io, reference(ref), `Grant ${ref}? Type the Reference to confirm: `);
      return answer(home.service.grant(reference(ref), { subject, modes, until }, actor), io, `granted ${ref}`);
    }
    case "ungrant": {
      const [ref] = one(p, 1, "a Reference");
      return answer(home.service.ungrant(reference(ref), subjectOf(p), { kind: "operator" }), io, `ungranted ${ref}`);
    }
    case "disable": {
      const [ref] = one(p, 1, "a Reference");
      return answer(home.service.disable(reference(ref), { kind: "operator" }), io, `disabled ${ref}`);
    }
    case "enable": case "revoke": case "delete": {
      const [ref] = one(p, 1, "a Reference");
      const verb = p.cmd;
      const actor = await confirmed(home, io, reference(ref), `${verb[0]?.toUpperCase()}${verb.slice(1)} ${ref}? Type the Reference to confirm: `);
      const r = verb === "enable" ? home.service.enable(reference(ref), actor)
        : verb === "revoke" ? home.service.revoke(reference(ref), actor) : home.service.delete(reference(ref), actor);
      return answer(r, io, `${verb}d ${ref}`);
    }
    case "recipient": {
      one(p, 0, "no arguments");
      const recipient = await home.recipient();
      if (recipient === null) throw new Refused("refused: plaintext_vault: this node's vault has no recipient; migrate to the age vault first");
      io.stdout(`${recipient} ${createHash("sha256").update(recipient).digest("hex").slice(0, 12)}\n`);
      return 0;
    }
    default:
      throw new Usage("usage: morndo-secrets put|workspace add|list|log|grant|ungrant|disable|enable|revoke|delete|recipient");
  }
}

// The value's copy is zeroed once sealed, and runSecrets zeroes the stdin buffer whatever happens (review 12; round 2,
// point 7). What can't be zeroed is in design §6 (zeroing).
async function put(home: SecretsHome, p: Parsed, io: SecretsIo): Promise<number> {
  if (p.positionals.length !== 1) throw new Usage("put takes a Reference and reads the value from stdin only");
  const ref = reference(p.positionals[0]);
  const expiry = expiryOf(p.values.get("expiry")?.at(-1));
  if (io.stdin === null) throw new Usage("put reads the value from stdin: pipe it in");
  const piped = io.stdin;
  const strip = !p.flags.has("raw") && piped.length > 0 && piped[piped.length - 1] === 0x0a ? 1 : 0;
  if (piped.length - strip === 0) throw new Usage("put read no value from stdin");
  const actor = await confirmed(home, io, ref, `Store a new value under ${ref}? Type the Reference to confirm: `);
  const value = piped.slice(0, piped.length - strip);
  let sealed: Uint8Array | null;
  try { sealed = await home.sealForNode(value); } finally { value.fill(0); }
  if (sealed === null) throw new Refused("refused: plaintext_vault: this node's vault would keep the value as plaintext; migrate to the age vault first");
  const r = await home.service.store({ reference: ref, sealed, shape: KEEP_SHAPE, grants: [], expiry, destinations: [], renew: false }, actor);
  if (!r.ok) throw new Refused(`refused: ${r.error.problem}`, r.error.left);
  io.stdout(`stored ${ref} version ${r.value.version}\n`);
  if (r.value.sameAs.length > 0) io.stdout(`same value as ${r.value.sameAs.join(", ")}\n`);
  if (!r.value.indexed) io.stderr("warning: the value is under 8 bytes, so it is not indexed: output filtering can't find it\n");
  return leftOver(r.value.left, io);
}

async function workspace(home: SecretsHome, p: Parsed, io: SecretsIo): Promise<number> {
  if (p.positionals[0] !== "add" || p.positionals.length !== 2) throw new Usage("workspace add PATH");
  const path = p.positionals[1] ?? "";
  const actor = await confirmed(home, io, path, `Register the repository at ${path} as a workspace? Type the path to confirm: `);
  const r = home.service.addWorkspace(path, actor);
  if (!r.ok) throw new Refused(`refused: ${r.error.problem}`);
  io.stdout(`workspace ${r.value.name} ${r.value.root}\n`);
  return 0;
}

// The principal at the machine: the expected text typed at the terminal, then a fresh Command id.
async function confirmed(home: SecretsHome, io: SecretsIo, expected: string, prompt: string): Promise<Actor> {
  const typed = await io.confirm(prompt);
  if (typed === null) throw new Refused("not confirmed: this needs a confirmation typed at the terminal, and there is none");
  if (typed.trim() !== expected) throw new Refused("not confirmed: the typed text didn't match");
  return { kind: "principal", command: home.commandId() };
}

function answer(
  r: { ok: true; value: { left: readonly string[] } } | { ok: false; error: { problem: string; left?: readonly string[] } }, io: SecretsIo, done: string,
): number {
  if (!r.ok) throw new Refused(`refused: ${r.error.problem}`, r.error.left);
  io.stdout(`${done}\n`);
  return leftOver(r.value.left, io);
}

function leftOver(left: readonly string[], io: SecretsIo): number {
  for (const item of left) io.stderr(`left to clean: ${item}\n`);
  return left.length > 0 ? PARTIAL : 0;
}

function subjectOf(p: Parsed): GrantSubject {
  const lane = p.values.get("lane")?.at(-1);
  const ws = p.values.get("workspace")?.at(-1);
  const node = p.flags.has("node");
  if ([lane !== undefined, ws !== undefined, node].filter(Boolean).length !== 1) throw new Usage("name one of --node, --lane LANE or --workspace NAME");
  if (lane !== undefined) return { kind: "lane", lane };
  if (ws !== undefined) return { kind: "workspace", workspace: ws };
  return { kind: "node" };
}

function untilOf(text: string | undefined): GrantEnd {
  if (text === undefined) return { kind: "open" };
  if (text === "lane-end") return { kind: "lane-end" };
  const at = Number(text);
  if (!Number.isSafeInteger(at) || at <= 0) throw new Usage("--until: lane-end or a time in ms");
  return { kind: "at", at };
}

function expiryOf(text: string | undefined): number | null {
  if (text === undefined || text === "none") return null;
  const at = Number(text);
  if (!Number.isSafeInteger(at) || at <= 0) throw new Usage("--expiry: none or a time in ms");
  return at;
}
