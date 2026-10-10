// One redactor for every service's log lines (ADR-0008 A4; spec section 8: "logs go through the redacting logger"). The
// hub, the fleet service and the node agent each write their own logger around it, so a rule added here reaches all
// three: before, each kept a copy of the rules and they had drifted (an agent line kept "user@github", the hub's kept an
// escaped quote's tail). Pure: no node:*, so the home directory comes in as an argument.
export type Level = "debug" | "info" | "warn" | "error";
export const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const levelFrom = (v: string | undefined): Level => (v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info");

const MAX_CAUSES = 5;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// JSON fields whose value is a secret or the principal's text, by name; the value may hold escaped quotes.
const SECRET_FIELDS = "secret|cookieSecret|token|code|sig|fleetSig|nonce|clientNonce|key|publicKey|fleetKey|text|data|bytes|body";

// API-key material (ADR-0018 §6.2). Prefixes checked 2026-10-10: Anthropic keys start with `sk-ant-`
// (https://platform.claude.com/docs/en/get-api-key, example `sk-ant-api03-…`); OpenRouter keys start with `sk-or-v1-`
// (https://openrouter.ai/docs/guides/features/guardrails/secret-formats). OpenAI and DeepSeek keys start with `sk-`
// (DeepSeek: a bearer token, https://api-docs.deepseek.com/; the prefix is the design's generic shape). OpenAI's
// authentication page (https://developers.openai.com/api/docs/api-reference/authentication, fetched 2026-10-10) says to
// send the key as a bearer and does not publish the prefix; `sk-` / `sk-proj-` is the shape the design names. An age
// identity starts with `AGE-SECRET-KEY-1` (https://github.com/FiloSottile/age). `_TOKEN=` and `_KEY=` assignments keep
// the name and blank the value. The patterns are compiled once. String.prototype.replace sets a global regexp's
// lastIndex to 0 before it matches (ECMA-262), so sharing them does not skip a later string.
// A hard wrap puts the rest of a token on the next line, indented. Join that tail only when the previous line ends
// inside an unfinished key (a bounded prefix plus key characters running to the end, still shorter than the shape's
// minimum). A finished key, or a line that merely contains "sk-", stays as it is, so the next line's words survive.
const KEY_SHAPES: readonly { prefix: string; min: number; body: RegExp }[] = [
  { prefix: "github_pat_", min: 20, body: /[A-Za-z0-9_]/ },
  { prefix: "AGE-SECRET-KEY-1", min: 8, body: /[A-Za-z0-9]/ },
  { prefix: "sk-or-v1-", min: 8, body: /[A-Za-z0-9_-]/ },
  { prefix: "sk-ant-", min: 8, body: /[A-Za-z0-9_-]/ },
  { prefix: "ghp_", min: 36, body: /[A-Za-z0-9]/ },
  { prefix: "AIza", min: 35, body: /[0-9A-Za-z_-]/ },
  { prefix: "sk-", min: 20, body: /[A-Za-z0-9_-]/ },
];

function unfinishedAtEnd(line: string): { body: RegExp } | null {
  // The longest prefix that runs to the end of the line wins, so `sk-ant-` is not also read as a short `sk-`.
  let best: { at: number; prefixLen: number; short: boolean; body: RegExp } | null = null;
  for (const shape of KEY_SHAPES) {
    let from = 0;
    while (from < line.length) {
      const at = line.indexOf(shape.prefix, from);
      if (at < 0) break;
      const boundary = at === 0 || !/[A-Za-z0-9]/.test(line[at - 1] ?? "");
      if (boundary) {
        let i = at + shape.prefix.length;
        while (i < line.length && shape.body.test(line[i] ?? "")) i++;
        const longer = i === line.length && (best === null || at < best.at || (at === best.at && shape.prefix.length > best.prefixLen));
        if (longer) best = { at, prefixLen: shape.prefix.length, short: i - (at + shape.prefix.length) < shape.min, body: shape.body };
      }
      from = at + shape.prefix.length;
    }
  }
  return best?.short ? { body: best.body } : null;
}

function unwrapKeyLines(text: string): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out.at(-1);
    const open = prev !== undefined ? unfinishedAtEnd(prev) : null;
    const indented = open ? /^[ \t]+(.*)$/.exec(line) : null;
    const rest = indented?.[1];
    if (open && prev !== undefined && rest) {
      let n = 0;
      while (n < rest.length && open.body.test(rest[n] ?? "")) n++;
      if (n > 0) {
        out[out.length - 1] = prev + rest.slice(0, n);
        if (n < rest.length) out.push(rest.slice(n));
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

const KEY_MATERIAL: readonly (readonly [RegExp, string])[] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-or-v1-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bAGE-SECRET-KEY-1[A-Za-z0-9]{8,}/g, "[redacted]"],
  // GitHub token prefixes (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github, fetched 2026-10-10): classic `ghp_`, fine-grained `github_pat_`.
  [/\bghp_[A-Za-z0-9]{36,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  // Google API keys start with `AIza` and 35 more characters (https://cloud.google.com/docs/authentication/api-keys, example fetched 2026-10-10).
  [/\bAIza[0-9A-Za-z_-]{35,}/g, "[redacted]"],
];

// An uppercase env name (`DB_PASSWORD`, `FOO_KEY`, `MY_SECRET`) or, in any case, a name whose segments include one of
// api/access/auth/secret/private/client/password/credential and one of key/token/secret (`api_token`, not `primary_key`
// or `page_token`). The value runs to whitespace, or to the closing quote when it is quoted.
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|KEY|SECRET|PASSWORD)$/;
const NAME_A = new Set(["api", "access", "auth", "secret", "private", "client", "password", "credential"]);
const NAME_B = new Set(["key", "token", "secret"]);
const ASSIGNMENT = /(?<![A-Za-z0-9])("?)([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)\1\s*[:=]\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\S+)/g;

function secretAssignment(name: string): boolean {
  if (ENV_NAME.test(name)) return true;
  const segs = name.toLowerCase().split(/[_-]/);
  return segs.some(s => NAME_A.has(s)) && segs.some(s => NAME_B.has(s));
}

function redactAssignments(text: string): string {
  return text.replace(ASSIGNMENT, (match, quote: string, name: string) => {
    if (!secretAssignment(name)) return match;
    return quote === '"' ? `"${name}":"[redacted]"` : `${name}=[redacted]`;
  });
}

// Key shapes only. Transcript and screen views use this: the log redactor also blanks emails and home paths, which the
// principal is reading on purpose in those views.
export function redactKeyMaterial(text: string): string {
  let out = unwrapKeyLines(text);
  for (const [pattern, replacement] of KEY_MATERIAL) out = out.replace(pattern, replacement);
  return redactAssignments(out);
}

export const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/(__Host-morndo=)[^;\s"',]*/g, "$1[redacted]"],                                       // the session cookie's value
  [/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]"],                                         // bearer tokens
  [/([#?&]t=)[^&#\s"']+/g, "$1[redacted]"],                                              // pairing secrets: /pair#t=..., ?t=...
  [/((?:%23|%3F|%26)t%3D)(?:(?!%26)[^&\s"'])+/gi, "$1[redacted]"],                        // the same, URL-encoded
  [/(morndo-join:\d+:)[A-Za-z0-9_-]+/g, "$1[redacted]"],                                  // a join string carries a code
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[pem redacted]"],             // a key file's contents
  [new RegExp(`("(?:${SECRET_FIELDS})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, "g"), "$1[redacted]$2"],
  [/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g, "[email]"],                            // emails and logins like user@github
  [/\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi, "[tailnet-host]"],                                // MagicDNS names
  [/(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\d)/g, "[tailnet-ip]"],   // 100.64.0.0/10
  [/\bfd7a:115c:a1e0(?::[0-9a-f]{0,4})*/gi, "[tailnet-ip]"],                              // fd7a:115c:a1e0::/48
];

// Every redaction, then the home directory written as "~" (never when the home is "/", which would eat every path).
export function redactText(text: string, home: string): string {
  let out = redactKeyMaterial(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  if (home && home !== "/") out = out.replace(new RegExp(`${escape(home.replace(/\/+$/, ""))}(?=$|[^\\w-])`, "g"), "~");
  return out;
}

// An error for the log: its stack (name, message, frames), then each cause in turn, up to a cap and never twice; never
// any other field, so a response body an error carries stays out. Anything else is named by its shape, never its values.
export function toLogFormat(value: unknown): string {
  const one = (x: unknown): string => {
    if (x instanceof Error) return x.stack ?? `${x.name}: ${x.message}`;
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return `[array of ${x.length}]`;
    if (x !== null && typeof x === "object") return `[object with keys: ${Object.keys(x).join(", ")}]`;
    return String(x);
  };
  const seen = new Set<unknown>([value]);
  let out = one(value);
  let cause = value instanceof Error ? value.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_CAUSES && !seen.has(cause); depth++) {
    out += `\nCaused by: ${one(cause)}`;
    seen.add(cause);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return out;
}
