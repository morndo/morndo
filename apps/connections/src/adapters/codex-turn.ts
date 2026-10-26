// A pool turn's stream (ADR-0029, §6.8): what a failure was, when the account comes back, and the arguments of the turn that
// goes on elsewhere. The messages are codex-cli 0.161.0's (codex-rs/protocol/src/error.rs#L693-814 at rust-v0.161.0,
// https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/error.rs): a usage limit is "You’ve hit your usage
// limit" (U+2019; a plain ' is accepted too), "for <name>" when one model's limit was hit, and "try again at <time>" in
// local time, as `%-I:%M %p` today or `%b %-d<th>, %Y %-I:%M %p` on another day. The arguments follow `codex exec --help` and
// `codex exec resume --help`, codex-cli 0.161.0: resume takes no --sandbox, --add-dir, --profile or --approve-for-me.
export type TurnFailure = { kind: "usage-limit"; model: boolean } | { kind: "auth" } | { kind: "unreadable" } | { kind: "other" };

const LIMIT = /You[’']ve hit your usage limit( for [^.]+)?\./;
const AUTH = /refresh token was already used|sign in again|\b401\b|unauthorized/i;
const UNREADABLE = /invalid_encrypted_content|encrypted content/i;

export function classifyFailure(messages: readonly string[]): TurnFailure {
  const text = messages.join("\n");
  const limit = LIMIT.exec(text);
  if (limit) return { kind: "usage-limit", model: limit[1] !== undefined };
  if (AUTH.test(text)) return { kind: "auth" };
  if (UNREADABLE.test(text)) return { kind: "unreadable" };
  return { kind: "other" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Milliseconds to add to a UTC reading to get the wall clock of `timeZone` at that instant.
function offsetOf(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date(at));
  const n = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

function wallToUtc(y: number, month: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, month, d, h, min);
  const first = guess - offsetOf(guess, timeZone);
  return guess - offsetOf(first, timeZone);
}

function hour24(h: number, ampm: string): number {
  return (h % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0);
}

// The reset a usage-limit message names, in the process's time zone, or null when it names none or one not after `now`.
export function retryAt(message: string, now: number, timeZone: string): number | null {
  const dated = /try again at ([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)/.exec(message);
  let at: number | null = null;
  if (dated) {
    const month = MONTHS.indexOf(dated[1] ?? "");
    if (month < 0) return null;
    at = wallToUtc(Number(dated[3]), month, Number(dated[2]), hour24(Number(dated[4]), dated[6] ?? "AM"), Number(dated[5]), timeZone);
  } else {
    const today = /try again at (\d{1,2}):(\d{2}) (AM|PM)/.exec(message);
    if (!today) return null;
    const wall = new Date(now + offsetOf(now, timeZone));
    at = wallToUtc(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), hour24(Number(today[1]), today[3] ?? "AM"), Number(today[2]), timeZone);
  }
  return at > now ? at : null;
}

// `exec resume [OPTIONS] [SESSION_ID] [PROMPT]` (codex exec resume --help, codex-cli 0.161.0). These options take a value; any
// other word that starts with "-" stands alone, and `--opt=value` is one word. --last and --all take the place of the id.
const RESUME_VALUE_OPTIONS = new Set(["-c", "--config", "-m", "--model", "-i", "--image", "--enable", "--disable", "--thread-source", "--cyber-access-program", "-o", "--output-last-message", "--output-schema"]);

type Resume = { last: boolean; session: string | null; sessionAt: number; positionals: number };

// null when the arguments are not a resume.
function readResume(args: readonly string[]): Resume | null {
  if (args[0] !== "exec" || args[1] !== "resume") return null;
  let last = false;
  const words: number[] = [];
  for (let i = 2; i < args.length; i++) {
    const word = args[i] ?? "";
    if (word === "--last" || word === "--all") { last = true; continue; }
    if (word === "-") { words.push(i); continue; }
    if (word.startsWith("-")) { if (RESUME_VALUE_OPTIONS.has(word)) i++; continue; }
    words.push(i);
  }
  // With --last the first word is the prompt; otherwise the first is the id and a second one is the prompt.
  const sessionAt = last || words.length === 0 ? -1 : (words[0] ?? -1);
  return { last, session: sessionAt < 0 ? null : (args[sessionAt] ?? null), sessionAt, positionals: words.length };
}

// The session a resume names, or null: a first turn, and `--last`, which names none.
export function sessionOf(args: readonly string[]): string | null {
  return readResume(args)?.session ?? null;
}

// `exec resume --last` (or --all) continues whichever session is newest in the store: it can't be placed on an account.
export function resumesLast(args: readonly string[]): boolean {
  return readResume(args)?.last ?? false;
}

// The prompt is the last argument. "-" (stdin) and a flag are not a prompt, and neither is a resume's session id.
export function promptOf(args: readonly string[]): string | null {
  const at = args.length - 1;
  const last = args[at];
  if (last === undefined || last === "-" || last.startsWith("-")) return null;
  const resume = readResume(args);
  return resume !== null && resume.sessionAt === at ? null : last;
}

const RESUME_DROPS = new Set(["--add-dir", "-p", "--profile"]);

// `exec <flags> <prompt>` as `exec resume <session> <flags> <prompt'>`: the sandbox becomes a config value, and flags that
// resume doesn't take are dropped. A resume keeps its flags.
export function continuationArgs(args: readonly string[], session: string, prompt: string): string[] {
  if (args[1] === "resume") return [...args.slice(0, -1), prompt];
  const flags = args.slice(1, -1);
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? "";
    if (flag === "-s" || flag === "--sandbox") { out.push("-c", `sandbox_mode="${flags[i + 1] ?? ""}"`); i++; }
    else if (RESUME_DROPS.has(flag)) i++;
    else if (flag === "--approve-for-me") continue;
    else out.push(flag);
  }
  return ["exec", "resume", session, ...out, prompt];
}

// The same turn as a new session: `resume <session>` dropped, the prompt replaced.
export function handoffArgs(args: readonly string[], prompt: string): string[] {
  const resume = readResume(args);
  if (resume === null) return [...args.slice(0, -1), prompt];
  return ["exec", ...args.slice(2, -1).filter((_, i) => i + 2 !== resume.sessionAt), prompt];
}

export function continuePrompt(request: string): string {
  return `[pool] The turn before this one stopped because its account reached its usage limit. This is the same session on another account. Check the working tree and what you already did, then finish that turn. Its request was:\n${request}`;
}

export function handoffPrompt(oldSession: string, request: string): string {
  return `[pool] This turn carries on work that began in session ${oldSession}, which can't be read on this account. Start from the repository: run \`git status\` and \`git log -5\`, then finish the work. Its request was:\n${request}`;
}
