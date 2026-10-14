// "Has Claude Code taken this text?", read from the transcript of the session it was typed into (docs/design/fleet-clients/
// README.md §4.3, §1). The rules are the manager inbox's (the chat bot's inbox transcript rules, checked there on 2.1.288), ported
// with their tests, and extended to what Claude Code 2.1.293 writes. The transcript is Claude Code's own and undocumented
// ("The entry format is internal to Claude Code and changes between versions", https://code.claude.com/docs/en/sessions,
// read 2026-10-08); every shape read here is pinned by a recorded example in test/fixtures/claude-code/2.1.293 (synthetic
// texts, the recorded keys), so a change in Claude Code shows as a failing test.
// What each entry says of a text typed before it:
// - {"type":"user","message":{"content":…},"promptSource":…}: a prompt the session took, whatever its source: delivered.
//   Not a prompt: a subagent's entry (isSidechain), a tool result, a meta entry (isMeta: a reminder, a command's caveat)
//   and a compaction's summary (isCompactSummary, which quotes earlier prompts).
// - A slash command ("/compact", Review Focus 1) comes back as its command, not as the text:
//   "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>".
// - {"type":"queue-operation","operation":"enqueue","content":…}: typed while it was busy; Claude Code holds it: held.
// - "dequeue" carries no text: no verdict. The prompt written after it decides.
// - "remove" with reason "absorbed_mid_turn" or "delivered_to_agent": taken into the turn: delivered. "cleared_on_cancel":
//   an interrupt dropped it: dropped. Any other reason, or none: no verdict. (The inbox counted a remove without a reason
//   as delivered; 2.1.293 wrote a reason on every one of 2,736 in two days, and the attachment that follows a real
//   delivery still confirms it, so no verdict is the safe side.)
// - {"type":"attachment","attachment":{"type":"queued_command","prompt":…}}: handed to the model: delivered.
// Anything else, a line that isn't JSON, and an entry without a time give no verdict.
// A command that starts a new session (/clear and its aliases) is written only into the new session's transcript, so its
// receipt is the pane's session changing (newSessionReceipt, below), never an entry of the session it was typed into.

export type ReceiptVerdict = "delivered" | "held" | "dropped" | "none";
export type PendingText = { id: string; text: string; typedAt: number };

type Said = { verdict: Exclude<ReceiptVerdict, "none">; text: string; at: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const DELIVERED_REASONS = new Set(["absorbed_mid_turn", "delivered_to_agent"]);

// One JSONL line: what it says of a text, or null.
function said(line: string): Said | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }                // a half-written line, or not JSON
  if (!isRecord(o) || o.isSidechain === true) return null;
  const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : Number.NaN;
  if (!Number.isFinite(at)) return null;                              // without a time, "after it was typed" can't be told
  if (o.type === "user") {
    if (o.isMeta === true || o.isCompactSummary === true || !isRecord(o.message)) return null;
    const c = o.message.content;
    if (typeof c === "string") return { verdict: "delivered", text: c, at };
    if (!Array.isArray(c) || c.some(b => isRecord(b) && b.type === "tool_result")) return null;
    const text = c.filter((b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
    return text ? { verdict: "delivered", text, at } : null;
  }
  if (o.type === "queue-operation" && typeof o.content === "string") {
    if (o.operation === "enqueue") return { verdict: "held", text: o.content, at };
    if (o.operation !== "remove") return null;                        // "dequeue": no verdict, even should it carry a text
    if (typeof o.reason === "string" && DELIVERED_REASONS.has(o.reason)) return { verdict: "delivered", text: o.content, at };
    if (o.reason === "cleared_on_cancel") return { verdict: "dropped", text: o.content, at };
    return null;
  }
  if (o.type === "attachment" && isRecord(o.attachment) && o.attachment.type === "queued_command" && typeof o.attachment.prompt === "string") {
    return { verdict: "delivered", text: o.attachment.prompt, at };
  }
  return null;
}

// Each entry decides at most one pending text: the earliest typed (then the first listed) that it fits, at or after its
// typedAt and not yet decided in this read. An enqueue holds one not yet held in this read, so two typings of one text
// held in turn are two pending texts held. Two deliveries of one text need two receipts.
export function readReceipts(lines: string[], pending: PendingText[]): { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[] {
  const order = pending.map((p, i) => ({ p, i })).sort((a, b) => a.p.typedAt - b.p.typedAt || a.i - b.i).map(x => x.p);
  const held = new Set<string>();
  const decided = new Set<string>();
  const out: { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[] = [];
  for (const line of lines) {
    const e = said(line);
    if (!e) continue;
    const p = order.find(q => !decided.has(q.id) && !(e.verdict === "held" && held.has(q.id)) && e.at >= q.typedAt && promptMatches(q.text, e.text));
    if (!p) continue;
    if (e.verdict === "held") held.add(p.id); else decided.add(p.id);
    out.push({ id: p.id, verdict: e.verdict, at: e.at });
  }
  return out;
}

// ---- matching (the inbox's `matches`, without its visible id: Morndo types no marker into the text)

const PASTE_TAG = /<\/?pasted_content id="[^"]*">/g;
const PLACEHOLDER = /\[Pasted text #\d+ \+(\d+) lines\]/;
// The text as tmux.send pastes it (tmux.ts drops every C0 control but newline and tab, and DEL), so as the transcript can
// have it. A function, not a regular expression with control characters (the lint rule).
function typed(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || (c >= 0x20 && c !== 0x7f)) out += s.charAt(i);
  }
  return out;
}
const normalize = (s: string) => s.replace(/\r\n?/g, "\n").replace(PASTE_TAG, "").split("\n").map(l => l.trimEnd()).join("\n").trim();
// A text Claude Code runs as a slash command: "/", a command name (a plugin's has a ":"), then its arguments.
const SLASH = /^\/([A-Za-z0-9][\w:.-]*)(?:[ \t]+([\s\S]*))?$/;
const tag = (s: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1];
// Whether Claude Code escapes markup in the arguments is not known (none seen with any): both forms are taken.
const unescaped = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

// Is `prompt`, as the transcript has it, the text that was typed?
export function promptMatches(text: string, prompt: string): boolean {
  const want = normalize(typed(text)), got = normalize(prompt);
  if (!got || !want) return false;
  if (got === want) return true;
  // Several queued lines reaching the model as one prompt (the inbox's rule, 2.1.288; 2.1.293 wrote each queued line as
  // its own prompt in two days of transcripts): ours inside it as whole lines, long enough to be ours.
  if (want.length >= 12 && (got.startsWith(`${want}\n`) || got.endsWith(`\n${want}`) || got.includes(`\n${want}\n`))) return true;
  // The input box's short form for a long paste: the rest must agree, and the line count must fit.
  const p = PLACEHOLDER.exec(got);
  if (p && want.includes("\n")) {
    const [before = "", after = ""] = got.split(p[0]);
    const lines = want.split("\n").length, k = Number(p[1]);
    if ((k === lines || k === lines - 1) && want.startsWith(before.trim()) && want.endsWith(after.trim())) return true;
  }
  // A slash command (Review Focus 1): the command entry with its name and the same arguments.
  const slash = SLASH.exec(want);
  const name = tag(got, "command-name");
  if (!slash || name === undefined || name.trim() !== `/${slash[1]}`) return false;
  const args = tag(got, "command-args") ?? "";
  const wantArgs = normalize(slash[2] ?? "");
  return normalize(args) === wantArgs || normalize(unescaped(args)) === wantArgs;
}

// ---- a command that starts a new session (README §4.3)

// `/clear [name]` and its aliases `/reset` and `/new` (https://code.claude.com/docs/en/commands, read 2026-10-08), as one
// line typed at the start of the box. Claude Code records the command only in the new session's transcript (2.1.293: its
// 7th line, test/fixtures/claude-code/2.1.293/clear-new-session.jsonl).
const NEW_SESSION = /^\/(?:clear|reset|new)(?:[ \t][^\n]*)?$/;
export function startsNewSession(text: string): boolean {
  return NEW_SESSION.test(typed(text).replace(/\s+$/, ""));
}
// Its receipt: the pane's session now (null while there is none) is another than the one it was typed into.
export function newSessionReceipt(text: string, typedInto: string, sessionNow: string | null): boolean {
  return startsNewSession(text) && sessionNow !== null && sessionNow !== typedInto;
}
