// Anti-corruption adapter over Claude Code's transcripts (ADR-0006). Read-only: ~/.claude/projects/<dir>/<sessionId>.jsonl
// holds a session's messages. Which session runs in which pane, and where its transcript is, is the session registry
// (@morndo/node-ops, sessions.ts). The format is internal ("The entry format is internal to Claude Code and changes
// between versions", https://code.claude.com/docs/en/sessions, 2026-10-01). Checked against Claude Code 2.1.286, and the
// prompts it takes into a running turn against 2.1.284 to 2.1.288; the contract tests use synthetic fixtures of those
// shapes. The supported replacement is HTTP hooks.
import type { Attachment, Author, ConversationEntry, Message, QuestionPart } from "@morndo/domain";
import type { TranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { describeFile } from "./file-kinds.ts";
import { OWNER_FILE } from "./attachment-note.ts";

// A field of a vendor file that should be text: itself, else the default (an object never becomes "[object Object]").
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);

// ---- transcript → conversation entries

type Line = Record<string, unknown> & { type?: string; message?: { content?: unknown }; timestamp?: string; uuid?: string };

const ts = (l: Line) => Date.parse(String(l.timestamp ?? "")) || 0;
// How far the conversation had come by this line: the time of a turn, a reply or a queue record. The agent's other
// bookkeeping lines carry times of their own that say nothing about it.
const reached = (l: Line) => (l.type === "user" || l.type === "assistant" || l.type === "queue-operation" ? ts(l) : 0);
const lineId = (l: Line) => String(l.uuid ?? `${l.type}-${ts(l)}`);  // a message's id is this, then ":" and its block
const between = (text: string, tag: string) => new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();

// Files a message carries, by absolute path: the application keeps a copy of each and fills in the attachments' ids.
export type FileRef = { messageId: string; paths: string[] };
export type Parsed = { entries: ConversationEntry[]; title: string | null; files: FileRef[] };

// ---- files sent and received
// An agent sends a file with the box's `lanes sendfile <path> [caption...]` (it prints "sent <absolute path>" per file),
// and the chat bot types the principal's files into a lane as "[The owner attached a file: <path>]".
const SENDFILE = /\blanes\s+sendfile\b/;
const SENT_LINE = /^sent (\/.+)$/gm;
export { OWNER_FILE } from "./attachment-note.ts";

// The captions of each `lanes sendfile` call in a shell command, in order; null where the caption isn't plain text
// (a variable or a substitution), so it is never guessed.
export function sendfileCaptions(command: string): (string | null)[] {
  const words: { w: string; plain: boolean }[] = [];
  let cur = "", plain = true, started = false;
  const push = () => { if (started) words.push({ w: cur, plain }); cur = ""; plain = true; started = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (c === "'") { const j = command.indexOf("'", i + 1); cur += command.slice(i + 1, j === -1 ? undefined : j); i = j === -1 ? command.length : j; started = true; continue; }
    if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\") { cur += command[++j] ?? ""; continue; }
        if (command[j] === "$" || command[j] === "`") plain = false;
        cur += command[j];
      }
      i = j; started = true; continue;
    }
    if (c === "\\") { cur += command[++i] ?? ""; started = true; continue; }
    if (c === "$" || c === "`") plain = false;
    if (/[;&|\n()]/.test(c)) { push(); words.push({ w: c, plain: false }); continue; }
    if (/\s/.test(c)) { push(); continue; }
    cur += c; started = true;
  }
  push();
  const out: (string | null)[] = [];
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i]?.w !== "lanes" || words[i + 1]?.w !== "sendfile") continue;
    const rest: { w: string; plain: boolean }[] = [];
    for (let j = i + 3; j < words.length && !/^[;&|\n()]$/.test(words[j]?.w ?? ""); j++) rest.push(words[j] as { w: string; plain: boolean });
    out.push(rest.length && rest.every(r => r.plain) ? rest.map(r => r.w).join(" ") : null);
  }
  return out;
}

const attachment = (path: string, caption: string | null): Attachment => ({ id: null, size: null, caption, ...describeFile(path) });

// AskUserQuestion's input: up to a few questions, each with a header, options (label, description) and multiSelect.
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function questionParts(input: unknown): QuestionPart[] {
  const qs = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.slice(0, 6).flatMap(q => {
    const o = (q ?? {}) as Record<string, unknown>;
    const question = clip(o.question, 1000);
    if (!question) return [];
    const options = (Array.isArray(o.options) ? o.options : []).slice(0, 8).flatMap(x => {
      const label = clip((x as Record<string, unknown>)?.label, 120);
      return label ? [{ label, description: clip((x as Record<string, unknown>)?.description, 400) || null }] : [];
    });
    return [{ question, header: clip(o.header, 40) || null, options, multiSelect: o.multiSelect === true }];
  });
}

// A long paste, as the agent CLI writes it: `<pasted_content id="x">`, the text, `</pasted_content id="x">`. The hub's own
// typing is a bracketed paste (tmux.ts), so a long message from the app arrives like this.
const PASTED = /^<pasted_content id="([^"\n]+)">\n([\s\S]*)\n<\/pasted_content id="\1">$/;
// The prompt without its wrapper, when one wrapper with matching ids is the whole prompt; anything else as written.
const unwrapped = (text: string) => PASTED.exec(text)?.[2]?.trim() ?? text;
// The manager's inbox (ADR-0010) types a line that carries no id of its own with a short visible one at the end of its
// first line (" ⟨m:7f3a9c⟩"), so it can tell its line in the transcript from a look-alike. The conversation shows the
// line as it was written, so its echo matches the Command that sent it (S8).
const INBOX_MARK = / ⟨m:[0-9a-f]{6}⟩(?=\n|$)/;
const unmarked = (text: string) => text.replace(INBOX_MARK, "");

// One transcript line → entries. `agent` names the worker (its channel), `pendingQuestions` tracks AskUserQuestion IDs,
// `sends` the `lanes sendfile` calls still waiting for their output (their captions), `notBefore` the latest time among
// the lines read before this one (for a prompt taken into a running turn, below).
export function parseLine(line: Line, agent: string, pendingQuestions: Set<string>, sends: Map<string, (string | null)[]> = new Map(), notBefore = 0): Parsed {
  const out: ConversationEntry[] = [];
  const files: FileRef[] = [];
  let title: string | null = null;
  const at = ts(line);
  const id = lineId(line);
  const content = line.message?.content;

  // A prompt, whoever sent it: a turn of its own (a user line) or one taken into a running turn (below). Its author
  // comes from the source's own fields, then from the prefixes this box's typists use.
  const prompt = (raw: string, source: unknown, isMeta: boolean, isCompactSummary: boolean, when = at) => {
    const origin = (source ?? {}) as { kind?: string };
    const text = unmarked(unwrapped(raw.trim()));
    const say = (author: Author, body: string, kind: "text" | "event" = "text") => out.push({ id, at: when, author, kind, text: body });
    if (isCompactSummary) say({ kind: "system", name: "Morndo" }, "The conversation was compacted.", "event");
    else if (origin.kind === "peer") {
      const from = /from-name="([^"]+)"/.exec(text)?.[1] ?? "another session";
      say({ kind: "peer", name: from }, between(text, "cross-session-message") ?? text);
    } else if (isMeta) { /* system reminders and similar: not part of the conversation */ }
    else if (origin.kind === "task-notification") say({ kind: "system", name: "Background task" }, between(text, "summary") ?? "A background task changed state.", "event");
    else if (text.startsWith("[lane-event]")) say({ kind: "system", name: "kira" }, "Lane events arrived.", "event");
    else if (text.startsWith("<command-name>")) say({ kind: "principal", name: "You" }, between(text, "command-name") ?? text, "event");
    else if (text.startsWith("<local-command") || text.startsWith("<bash-")) { /* local command output */ }
    else if (/^Manager:\s/.test(text)) say({ kind: "peer", name: "Manager" }, text.replace(/^Manager:\s*/, ""));
    else if (origin.kind === "channel") say({ kind: "principal", name: "You" }, between(text, "channel") ?? text);
    else if (text) {
      say({ kind: "principal", name: "You" }, text);
      const owned = [...text.matchAll(OWNER_FILE)].map(m => (m[1] ?? "").trim()).filter(Boolean);
      const last = out.at(-1);
      if (owned.length && last && last.kind !== "answer") { last.attachments = owned.map(p => attachment(p, null)); files.push({ messageId: id, paths: owned }); }
    }
  };

  if (line.type === "ai-title" && typeof line.aiTitle === "string") title = line.aiTitle;

  else if (line.type === "user" && typeof content === "string") prompt(content, line.origin, Boolean(line.isMeta), Boolean(line.isCompactSummary));

  // A prompt that arrives while the agent works: Claude Code takes it into the running turn ("absorbed_mid_turn" in
  // its queue-operation records) and writes it as a queued_command attachment, never as a user line (seen in 2.1.284
  // to 2.1.288).
  // - Its timestamp is when it was sent, but the line is written when the agent takes it in, after later-stamped
  //   lines. It is placed there (`notBefore`), so the order by time is the file's order: what a reader of the live
  //   conversation sees is what a reload and an older page give.
  // - Only the sources seen and known speak: a person at the terminal or on a channel, a peer, a background task.
  //   Any other origin or command mode is no message: nothing unknown may come out as the principal, whose `[tap …]`
  //   line answers an Ask.
  else if (line.type === "attachment" && !line.isSidechain) {
    const a = (line.attachment ?? {}) as { type?: unknown; prompt?: unknown; origin?: unknown; isMeta?: unknown; commandMode?: unknown };
    // 2.1.283 and older wrote a task notification without an origin: there its command mode says what it is.
    const origin = a.origin === undefined && a.commandMode === "task-notification" ? { kind: "task-notification" } : a.origin;
    const kind = (origin as { kind?: unknown } | null | undefined)?.kind;
    const speaks = kind === "human" || kind === "channel" || kind === "peer" || kind === "task-notification";
    const asPrompt = a.commandMode === undefined || a.commandMode === "prompt" || a.commandMode === "task-notification";
    if (a.type === "queued_command" && typeof a.prompt === "string" && speaks && asPrompt) prompt(a.prompt, origin, Boolean(a.isMeta), false, Math.max(at, notBefore));
  }

  else if (line.type === "user" && Array.isArray(content)) {
    for (const [i, b] of (content as Record<string, unknown>[]).entries()) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string" && pendingQuestions.has(b.tool_use_id)) {
        pendingQuestions.delete(b.tool_use_id);
        out.push({ kind: "answer", id: `${id}:${i}`, at, questionId: b.tool_use_id });
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string" && sends.has(b.tool_use_id)) {
        const captions = sends.get(b.tool_use_id) ?? [];
        sends.delete(b.tool_use_id);
        const body = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? (b.content as { type?: string; text?: string }[]).map(x => (x.type === "text" ? x.text ?? "" : "")).join("\n") : "";
        const paths = [...body.matchAll(SENT_LINE)].map(m => (m[1] ?? "").trim());
        if (paths.length) {
          // Captions pair with files only when each call sent one file; a loop's captions can't be told apart.
          const caption = (n: number) => (captions.length === paths.length ? captions[n] ?? null : null);
          const mid = `${b.tool_use_id}:files`;
          out.push({ id: mid, at, author: { kind: "agent", name: agent }, kind: "file", text: "", attachments: paths.map((p, n) => attachment(p, caption(n))) });
          files.push({ messageId: mid, paths });
        }
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !line.isMeta) {
        out.push({ id: `${id}:${i}`, at, author: { kind: "principal", name: "You" }, kind: "text", text: b.text.trim() });
      }
    }
  }

  else if (line.type === "assistant" && Array.isArray(content) && !line.isSidechain) {
    const me: Author = { kind: "agent", name: agent };
    for (const [i, b] of (content as Record<string, unknown>[]).entries()) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        out.push({ id: `${id}:${i}`, at, author: me, kind: "text", text: b.text.trim() });
      } else if (b.type === "tool_use" && typeof b.id === "string") {
        const name = text(b.name, "tool");
        if (name === "AskUserQuestion") {
          pendingQuestions.add(b.id);
          const questions = questionParts(b.input);
          out.push({ id: b.id, at, author: me, kind: "question", text: questions.map(q => q.question).join("\n") || "A question for you.", questionId: b.id, questions });
        } else {
          const command = text((b.input as { command?: unknown } | undefined)?.command);
          if (name === "Bash" && SENDFILE.test(command)) sends.set(b.id, sendfileCaptions(command));
          out.push({ id: b.id, at, author: me, kind: "activity", text: name, tools: [name] });
        }
      }
    }
  }
  return { entries: out, title, files };
}

// ---- reading a transcript: the follow and older pages (design §3.1)
// The bytes come from a TranscriptBytes (@morndo/node-ops): this machine's file, or a node's through the fleet, in
// reads of at most one chunk (LIMITS.chunkBytes). followTranscript and olderPage are plain async functions over it: they
// ask it for the size, a range of bytes or where a line is, and parse what comes back, whichever TranscriptBytes it is.

// A line longer than this is never parsed: it shows as one message too large to show, and reading goes on past it
// (real transcripts have lines up to 3.7 MB).
export const MAX_LINE_BYTES = 8 << 20;
// An older page reads one window of at most this much before the message it ends at, plus that message's own line.
export const OLDER_WINDOW_BYTES = 4 << 20;

// A message that stands for text too large to show, named by the byte offset where it starts: older pages before it
// end there.
const TOO_LARGE = /^too-large-(\d+)$/;
const tooLarge = (start: number, at: number): Message => ({
  id: `too-large-${start}`, at, author: { kind: "system", name: "Morndo" }, kind: "event", text: "A message too large to show.",
});

const utf8 = new TextDecoder();
// One line's bytes (without its newline) → its JSON, or null for an empty, torn or foreign line.
function lineJson(bytes: Uint8Array): Line | null {
  const raw = utf8.decode(bytes);
  if (!raw.trim()) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  return v !== null && typeof v === "object" ? (v as Line) : null;
}
const gone = () => new Error("the transcript is gone");
const merge = (into: Parsed, p: Parsed) => { into.entries.push(...p.entries); into.files.push(...p.files); if (p.title) into.title = p.title; };

// `offset`: the next byte to read. `carry`: what was read of a line whose end hasn't come yet (it ends at `offset`).
// `skip`: inside a line dropped up to its end, from its start `from`: one the first read jumped into, or one over
// MAX_LINE_BYTES (`shown`: it becomes a message too large to show). `latest`: the latest time among the lines read so
// far (parseLine's `notBefore`).
export type TranscriptCursor = {
  offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number;
  carry?: Uint8Array[]; skip?: { from: number; shown: boolean };
};

// Bytes read at the cursor's offset → what they add to the conversation (pure). Complete lines are parsed in file
// order, the first joined to what earlier reads carried; what follows the last newline is carried to the next read. A
// line over `maxLine` is dropped as it arrives and shows as one message too large to show once its end is read.
export function feedTranscript(cursor: TranscriptCursor, bytes: Uint8Array, agent: string, maxLine = MAX_LINE_BYTES): Parsed {
  const out: Parsed = { entries: [], title: null, files: [] };
  const at = cursor.offset;                                          // where `bytes` start in the file
  cursor.offset += bytes.length;
  cursor.sends ??= new Map();
  let from = 0;
  for (let nl = bytes.indexOf(0x0a); nl !== -1; from = nl + 1, nl = bytes.indexOf(0x0a, from)) {
    const carried = cursor.carry ?? [];
    delete cursor.carry;
    const before = carried.reduce((n, c) => n + c.length, 0);
    if (cursor.skip) {
      if (cursor.skip.shown) out.entries.push(tooLarge(cursor.skip.from, cursor.latest ?? 0));
      delete cursor.skip;
    } else if (before + nl - from > maxLine) {
      out.entries.push(tooLarge(at + from - before, cursor.latest ?? 0));
    } else {
      const line = lineJson(carried.length ? Buffer.concat([...carried, bytes.subarray(from, nl)]) : bytes.subarray(from, nl));
      if (!line) continue;
      merge(out, parseLine(line, agent, cursor.pending, cursor.sends, cursor.latest ?? 0));
      cursor.latest = Math.max(cursor.latest ?? 0, reached(line));
    }
  }
  if (from < bytes.length && !cursor.skip) {
    const carried = [...(cursor.carry ?? []), bytes.slice(from)];  // a copy: the source may reuse its buffer
    const length = carried.reduce((n, c) => n + c.length, 0);
    if (length > maxLine) { cursor.skip = { from: cursor.offset - length, shown: true }; delete cursor.carry; }
    else cursor.carry = carried;
  }
  return out;
}

// `tailBytes`: the most the first read takes, from the end; `chunk`: one read; `budget`: the most one call reads (the
// rest comes on the next call, from the cursor); `maxLine`: the longest line parsed.
export type FollowOptions = { tailBytes?: number; chunk?: number; budget?: number; maxLine?: number };

// The follow (O5): what the transcript added since the cursor. The first read takes at most the last `tailBytes`,
// from a line boundary (the line it starts in is skipped). A line arrives over as many reads as it takes, so a follow
// never stalls on a long one.
async function followSteps(src: TranscriptBytes, cursor: TranscriptCursor, agent: string, o: FollowOptions): Promise<Parsed> {
  const tail = o.tailBytes ?? 2 << 20, chunk = o.chunk ?? LIMITS.chunkBytes, budget = o.budget ?? MAX_LINE_BYTES, maxLine = o.maxLine ?? MAX_LINE_BYTES;
  const out: Parsed = { entries: [], title: null, files: [] };
  const size = await src.size();
  if (size === null) throw gone();
  if (size < cursor.offset) { cursor.offset = 0; cursor.latest = 0; delete cursor.carry; delete cursor.skip; }   // truncated or replaced
  if (cursor.offset === 0 && size > tail) { cursor.offset = size - tail; cursor.skip = { from: cursor.offset, shown: false }; }
  for (let got = 0; cursor.offset < size && got < budget;) {
    const r = await src.read(cursor.offset, Math.min(chunk, budget - got));
    if (r === null) throw gone();
    if (!r.bytes.length) break;
    merge(out, feedTranscript(cursor, r.bytes, agent, maxLine));
    got += r.bytes.length;
    if (r.eof) break;
  }
  return out;
}

// A source that throws (a node that can't answer now, the fleet down) leaves the cursor exactly as it was: what this
// call had read and parsed is dropped with the error, and the next follow reads the same bytes again, so no line is
// lost and none is parsed twice.
export async function followTranscript(src: TranscriptBytes, cursor: TranscriptCursor, agent: string, o: FollowOptions = {}): Promise<Parsed> {
  const before: TranscriptCursor = {
    ...cursor, pending: new Set(cursor.pending),
    ...(cursor.sends ? { sends: new Map([...cursor.sends].map(([k, v]) => [k, [...v]])) } : {}),
    ...(cursor.carry ? { carry: [...cursor.carry] } : {}),
    ...(cursor.skip ? { skip: { ...cursor.skip } } : {}),
  };
  try {
    return await followSteps(src, cursor, agent, o);
  } catch (e) {
    delete cursor.sends; delete cursor.latest; delete cursor.carry; delete cursor.skip;
    Object.assign(cursor, before);
    throw e;
  }
}

// An older page (ADR-0008 phase D, O9): up to `limit` messages from before the message `beforeId`, oldest first. Its
// line is found with `locate` (its uuid), then one window of at most `window` bytes before that line is read, with the
// line itself (a page that ends inside a line keeps that line's earlier blocks). The window is parsed in file order with
// fresh question and file state, so a `sendfile` result whose call lies just outside it shows without its files.
// `done`: nothing older is left. `missing`: the message isn't in the transcript: not the beginning (review L1).
// `resume`: where the next page, before this page's first message, ends: the start of that message's line (a hint that
// saves the search). A window that holds no message at all (a line longer than the window lies there) gives one
// message too large to show, so a reader moves on past it instead of asking for the same page again.
export type OlderPage = { messages: Message[]; done: boolean; files: FileRef[]; missing?: true; resume?: { id: string; end: number } };
export type OlderOptions = { limit?: number; from?: number | undefined; window?: number; chunk?: number; maxLine?: number };
// Where a message's line is. A text's id is `<line uuid>:<block>` and a prompt's is the line's uuid; an activity's or a
// question's is the tool call's id (the assistant line holding that tool_use); a file's is `<call id>:files` (the line
// holding that call's result). `needles` are searched in turn; `holds` says whether a line is the one.
const FILES_ID = /^(.+):files$/;
const blocksOf = (l: Line): Record<string, unknown>[] => (Array.isArray(l.message?.content) ? (l.message.content as Record<string, unknown>[]) : []);
type Anchor = { needles: string[]; holds: (l: Line) => boolean };
function anchorOf(beforeId: string): Anchor {
  const call = FILES_ID.exec(beforeId)?.[1];
  if (call) return { needles: [`"tool_use_id":${JSON.stringify(call)}`], holds: l => blocksOf(l).some(b => b.type === "tool_result" && b.tool_use_id === call) };
  const cut = beforeId.lastIndexOf(":");
  const uuid = cut === -1 ? beforeId : beforeId.slice(0, cut);
  return {
    needles: [`"uuid":${JSON.stringify(uuid)}`, ...(cut === -1 ? [`"id":${JSON.stringify(beforeId)}`] : [])],
    holds: l => lineId(l) === uuid || (cut === -1 && l.type === "assistant" && !l.isSidechain && blocksOf(l).some(b => b.type === "tool_use" && b.id === beforeId)),
  };
}
const missing = (): OlderPage => ({ messages: [], done: false, files: [], missing: true });

async function readRange(src: TranscriptBytes, from: number, to: number, chunk: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let at = from; at < to;) {
    const r = await src.read(at, Math.min(chunk, to - at));
    if (r === null) throw gone();
    if (!r.bytes.length) break;
    parts.push(r.bytes);
    at += r.bytes.length;
  }
  return Buffer.concat(parts);
}

// The line that starts at `start`, with its newline; null when it is longer than `maxLine` or hasn't ended. Reads
// grow from 4 KiB to a chunk, so a short line costs a short read.
async function readLine(src: TranscriptBytes, start: number, chunk: number, maxLine: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  for (let at = start, ask = Math.min(4096, chunk); at - start <= maxLine; ask = Math.min(ask * 2, chunk)) {
    const r = await src.read(at, ask);
    if (r === null) throw gone();
    const nl = r.bytes.indexOf(0x0a);
    if (nl !== -1) return Buffer.concat([...parts, r.bytes.subarray(0, nl + 1)]);
    if (!r.bytes.length || r.eof) return null;
    parts.push(r.bytes);
    at += r.bytes.length;
  }
  return null;
}

// A page from one window (pure): `bytes` were read at byte `at`. A line the window's start cuts into is dropped (the
// next page's window holds it), and so is a last line without its newline. `anchored`: the page ends before
// `beforeId`, whose line is the window's last; else it ends at the window's end (a message too large to show asked
// for it). null: that line isn't there, or the message isn't in it.
function pageOf(bytes: Uint8Array, at: number, agent: string, beforeId: string, limit: number, anchored: boolean): OlderPage | null {
  const lines: { line: Line; start: number; end: number }[] = [];
  let from = 0;
  if (at > 0) { const nl = bytes.indexOf(0x0a); from = nl === -1 ? bytes.length : nl + 1; }
  const firstWhole = at + from;
  for (let nl = bytes.indexOf(0x0a, from); nl !== -1; from = nl + 1, nl = bytes.indexOf(0x0a, from)) {
    const line = lineJson(bytes.subarray(from, nl));
    if (line) lines.push({ line, start: at + from, end: at + nl + 1 });
  }
  const target = anchored ? lines.length - 1 : lines.length;
  if (anchored && !anchorOf(beforeId).holds(lines[target]?.line ?? {})) return null;
  const messages: Message[] = [];
  const files: FileRef[] = [];
  const lineOf = new Map<string, number>();
  const pending = new Set<string>();
  const sends = new Map<string, (string | null)[]>();
  let latest = 0;                                                     // as the live read keeps it, from this window's start
  for (let i = 0; i <= target && i < lines.length; i++) {
    const p = parseLine(lines[i]?.line ?? {}, agent, pending, sends, latest);
    latest = Math.max(latest, reached(lines[i]?.line ?? {}));
    for (const e of p.entries) if (e.kind !== "answer") { messages.push(e); lineOf.set(e.id, i); }
    files.push(...p.files);
  }
  // A file message is only made when its call lies in the window; its line is the anchor either way.
  const found = messages.findIndex(m => m.id === beforeId);
  const index = !anchored ? messages.length : found !== -1 ? found : FILES_ID.test(beforeId) ? messages.filter(m => (lineOf.get(m.id) ?? 0) < target).length : -1;
  if (index === -1) return null;
  const page = messages.slice(Math.max(0, index - limit), index);
  const ends = anchored ? (lines[target]?.start ?? at + bytes.length) : at + bytes.length;
  if (!page.length && at > 0) {
    // Nothing to show in the whole window: the next page ends where its first whole line starts, or, when one line
    // fills the window, where the window starts.
    const next = firstWhole < ends ? firstWhole : at;
    return { messages: [tooLarge(next, latest || (anchored ? ts(lines[target]?.line ?? {}) : 0))], done: false, files: [] };
  }
  const ids = new Set(page.map(m => m.id));
  const first = page[0];
  const resume = first ? { id: first.id, end: lines[lineOf.get(first.id) ?? 0]?.start ?? at } : undefined;
  return { messages: page, done: at === 0 && index <= limit, files: files.filter(f => ids.has(f.messageId)), ...(resume ? { resume } : {}) };
}

async function olderSteps(src: TranscriptBytes, agent: string, beforeId: string, o: OlderOptions): Promise<OlderPage> {
  const limit = o.limit ?? 100, window = o.window ?? OLDER_WINDOW_BYTES, chunk = o.chunk ?? LIMITS.chunkBytes, maxLine = o.maxLine ?? MAX_LINE_BYTES;
  const size = await src.size();
  if (size === null) throw gone();
  const big = TOO_LARGE.exec(beforeId);
  if (big) {                                                          // the page ends where the text too large to show starts
    const end = Number(big[1]);
    if (end > size) return missing();
    const start = Math.max(0, end - window);
    return pageOf(await readRange(src, start, end, chunk), start, agent, beforeId, limit, false) ?? missing();
  }
  const anchor = anchorOf(beforeId);
  const isWanted = (l: Uint8Array | null) => l !== null && anchor.holds(lineJson(l.subarray(0, l.length - 1)) ?? {});
  // A hint from the last page (where this message's line starts) saves the search, while it still holds.
  let start: number | null = o.from !== undefined && o.from >= 0 && o.from < size ? o.from : null;
  let line = start === null ? null : await readLine(src, start, chunk, maxLine);
  if (start === null || !isWanted(line)) {
    start = null; line = null;
    for (const needle of anchor.needles) {
      const found = await src.locate(needle);
      if (found === null) continue;
      const l = await readLine(src, found, chunk, maxLine);
      if (isWanted(l)) { start = found; line = l; break; }
    }
    if (start === null) return missing();
  }
  const from = Math.max(0, start - window);
  const before = await readRange(src, from, start, chunk);
  return pageOf(Buffer.concat([before, line ?? new Uint8Array(0)]), from, agent, beforeId, limit, true) ?? missing();
}

export function olderPage(src: TranscriptBytes, agent: string, beforeId: string, o: OlderOptions = {}): Promise<OlderPage> {
  return olderSteps(src, agent, beforeId, o);
}
