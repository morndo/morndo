// A stand-in for Claude Code's input box in a tmux pane, for the fleet's tests (test/fleet), its two-node e2e and its QA
// runbook. It is never the real CLI, so none of the real one's hooks fire, and it runs nothing: it only records, and
// writes the files Claude Code writes.
// It draws like Claude Code (as apps/hub/test/tmux-fake-claude.fixture.ts does): optional prose, a ─ rule, "❯ " and the
// input, a ─ rule, a footer. A busy turn adds "✻ Working…" above the box; a menu replaces the box; a shell command running
// under the session (status shell) adds "· 1 shell" to the footer, as 2.1.293 does, and the box stays. It turns bracketed
// paste on (ESC[?2004h). Inside a paste every byte is text; outside it, Enter submits, Ctrl-U clears the draft, Escape
// answers a menu or interrupts a busy turn, Ctrl-C interrupts or clears.
// What it writes is Claude Code 2.1.293's (fleet clients, Task 16): the lines Task 2 recorded on the owner's PC, in
// test/fixtures/claude-code/2.1.293 (synthetic values in the recorded keys and shapes), made this box's own: their
// "[fixture] …" text is the line's text, and their session, folder, ids and times are this box's. Never a shape written
// here, so the drills and the receipt's own unit tests read the same lines:
// - the session file <claude>/sessions/<pid>.json, with its `status`: busy, idle, waiting (a menu) or shell (a shell
//   command running; the session is alive: RECONCILIATION.md ruling 11);
// - the transcript: a submit while idle (or shell) is a typed `user` prompt; a submit while busy is a `queue-operation`
//   `enqueue` with its text, held in the box's queue until the test says what Claude Code does with it next: a `dequeue`
//   (no text) and then the queued prompt (the queued lines merged), a `remove` `absorbed_mid_turn` with the
//   `queued_command` attachment, a `remove` with another reason, or an interrupt (a `remove` `cleared_on_cancel` for each).
// Usage: node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id|auto> --tmux-session=<name>] [--offset=<ms>]
//          [--start-delay=<ms>]
//   <state dir>/prose.txt        read at start: the prose drawn above the box
//   <state dir>/raw.bin          every byte received
//   <state dir>/submitted.jsonl  one JSON string per submit
//   <state dir>/control.jsonl    the test's commands (Control below), one JSON object per line, applied in order every
//                                25 ms; how many were applied so far is written to <state dir>/applied
//   --claude: the session file <dir>/sessions/<pid>.json naming this pane (from TMUX_PANE) and the transcript
//     <dir>/projects/-qa/<session>.jsonl, timed on this machine's clock plus --offset (the node's clock, the one the real
//     CLI writes with). --session=auto makes up a session id (a lane that lane.start opened, whose id no one chose).
//   --start-delay: for that long the pane shows Claude Code starting, with no box and no session file.
//   A state dir holding a file named `untrusted` shows Claude Code's folder-trust dialog first (the screen recorded on
//   2.1.287, packages/node-ops/test/fixtures/claude-code-2.1.287/trust-dialog.ansi): Down then Enter trusts the folder;
//   Enter alone, or Escape, exits, as there.
// Submitted while not busy: "/exit" ends the process, as Claude Code's /exit does: its session file stays, its process
// is gone, so the session is no longer live; "/clear" or "/new" starts a new session (ruling 17): a new session id in the
// same session file, and a new transcript.
// Options take the --name=value form: util.parseArgs takes a value starting with "-" (a negative offset) only that way
// (https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-06).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

export type Status = "busy" | "idle" | "waiting" | "shell";
export type TranscriptKind = "userTyped" | "userQueued" | "enqueue" | "dequeue" | "removeAbsorbed" | "removeDeliveredToAgent"
  | "removeCleared" | "queuedCommand";
// A test's command (test/fleet-harness.ts, Lane.control). The fields act in the order they are listed here.
export type Control = {
  silent?: boolean;                 // from now on a submit reaches no transcript (a prompt Claude Code never records)
  swallowEnters?: number;           // the next n Enters leave the line in the box…
  replaceWith?: string;             // …and the first of them puts this text there instead (the owner typing over it)
  question?: string;                // the menu's question from now on (default "Do you want to proceed?")
  clear?: true;                     // the draft is cleared
  write?: TranscriptKind;           // one transcript line of this kind…
  text?: string;                    // …with this text
  dequeue?: true;                   // a dequeue line (no text): Claude Code takes its queue as the next prompt…
  prompt?: true;                    // …and the queued prompt: the queued lines merged, one per line
  absorb?: true;                    // each queued line taken into the running turn: remove absorbed_mid_turn + queued_command
  remove?: string;                  // each queued line removed with this reason
  interrupt?: { restore?: boolean; queueNext?: boolean };   // Escape on a busy turn: each queued line cleared_on_cancel,
                                                            // status idle; restore: the lines back in the box; queueNext: below
  status?: Status;                  // the session's status and the screen that goes with it; shell: a shell command
                                    // running under the live session, the box stays and takes lines as when idle
  queueNext?: true;                 // the next submit is queued, and the status turns busy (a turn starting as it lands)
  exit?: true;                      // the process exits, as on /exit: the session is no longer live
};
type Line = Record<string, unknown>;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    claude: { type: "string" }, session: { type: "string" }, "tmux-session": { type: "string" }, offset: { type: "string" },
    "start-delay": { type: "string" },
  },
});
const dir = resolve(positionals[0] ?? ".");
const offset = Number(values.offset ?? 0);
const clock = () => Date.now() + offset;
const startDelay = Number(values["start-delay"] ?? 0);
const tmuxSession = values["tmux-session"] ?? "qa";
const prose = existsSync(join(dir, "prose.txt")) ? readFileSync(join(dir, "prose.txt"), "utf8").replace(/\n+$/, "") : "";

// Task 2's recorded lines (test/fixtures/claude-code/2.1.293), one per kind the box writes.
const RECORDED = join(import.meta.dirname, "claude-code", "2.1.293");
function recorded(file: string, line: number): Line {
  const l = readFileSync(join(RECORDED, file), "utf8").split("\n").filter(Boolean)[line];
  if (!l) throw new Error(`${file} has no line ${line + 1}: the box needs Task 2's recorded lines`);
  return JSON.parse(l) as Line;
}
const T: Record<TranscriptKind, Line> = {
  userTyped: recorded("typed-prompt.jsonl", 0),
  enqueue: recorded("queued-then-prompt.jsonl", 0),
  dequeue: recorded("queued-then-prompt.jsonl", 1),
  userQueued: recorded("queued-then-prompt.jsonl", 2),
  removeAbsorbed: recorded("absorbed-mid-turn.jsonl", 1),
  queuedCommand: recorded("absorbed-mid-turn.jsonl", 2),
  removeDeliveredToAgent: recorded("delivered-to-agent.jsonl", 1),
  removeCleared: recorded("cleared-on-cancel.jsonl", 1),
};
const SESSION = JSON.parse(readFileSync(join(RECORDED, "session-file.json"), "utf8")) as Line;
const RECORDED_SESSION = String(SESSION.sessionId);
const RECORDED_CWD = String(SESSION.cwd);
const RECORDED_ID = /^0f1c[0-9a-f]{4}-2d3e-4f5a-8b6c-[0-9a-f]{12}$/;     // the recorded lines' synthetic uuids
const TRUST = join(import.meta.dirname, "..", "..", "packages", "node-ops", "test", "fixtures", "claude-code-2.1.287", "trust-dialog.ansi");

const claude = values.claude ?? null;
let sessionId = values.session === "auto" ? randomUUID() : (values.session ?? null);
const transcriptOf = (id: string | null) => (claude && id ? join(claude, "projects", "-qa", `${id}.jsonl`) : null);
let transcript = transcriptOf(sessionId);
const sessionFile = claude && sessionId ? join(claude, "sessions", `${process.pid}.json`) : null;
const startedAt = clock();

let phase: "starting" | "trust" | "running" = "starting";
let trustDown = false;
let status: Status = "idle";
let input = "";
let paste = false;
let pending = "";
let queue: string[] = [];
let queueNext = false;
let silent = false;
let swallow = 0;
let replaceWith: string | null = null;
let question = "Do you want to proceed?";
let lastUuid: string | null = null;

// A recorded line made this box's: its "[fixture] …" text is `text`; its session, folder, ids and times are this box's.
function own(v: unknown, text: string, key = ""): unknown {
  if (typeof v === "string") {
    if (key === "timestamp") return new Date(clock()).toISOString();
    if (v.startsWith("[fixture] ")) return text;
    if (v === RECORDED_SESSION) return sessionId;
    if (v === RECORDED_CWD) return process.cwd();
    if (RECORDED_ID.test(v)) return key === "parentUuid" ? lastUuid : randomUUID();
    return v;
  }
  if (Array.isArray(v)) return v.map(x => own(x, text));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, own(x, text, k)]));
  return v;
}

function writeSession() {
  if (!claude || !sessionFile || !sessionId || phase !== "running") return;
  mkdirSync(join(claude, "sessions"), { recursive: true });
  const now = clock();
  const tmp = `${sessionFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    ...SESSION, pid: process.pid, sessionId, cwd: process.cwd(), startedAt, tmux: `${tmuxSession}:@0.${process.env.TMUX_PANE ?? ""}`,
    status, updatedAt: now, statusUpdatedAt: now,
  }));
  renameSync(tmp, sessionFile);   // rename(2): a reader sees the old file or the new one, never half of one
}

// `reason`: the recorded cleared_on_cancel line with another reason, one Claude Code may add that no rule names.
function write(kind: TranscriptKind, text = "", reason?: string) {
  if (!transcript) return;
  const line = own(T[kind], text) as Line;
  if (reason !== undefined && "reason" in line) line.reason = reason;
  if (typeof line.uuid === "string") lastUuid = line.uuid;
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}

const RULE = "─".repeat(40);
function screen(): string {
  if (phase === "starting") return "Starting Claude Code…";
  if (phase === "trust") return readFileSync(TRUST, "utf8").replace(/\r?\n/g, "\r\n");
  if (status === "waiting") {
    return [" Bash command", "   npm run docs", "", ` ${question}`, " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\r\n");
  }
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  return `${prose ? `${prose.replace(/\n/g, "\r\n")}\r\n\r\n` : ""}${status === "busy" ? "✻ Working… (esc to interrupt)\r\n" : ""}`
    + `${RULE}\r\n\x1b[38;5;246m❯ \x1b[39m${line}\r\n${RULE}\r\n  ? for shortcuts${status === "shell" ? " · 1 shell" : ""}`;
}
const draw = () => { process.stdout.write(`\x1b[H\x1b[2J${screen()}`); };

function setStatus(s: Status) { status = s; writeSession(); }
function exit() { draw(); setTimeout(() => process.exit(0), 100); }

// The transcript's opening lines (the shapes the fleet core's tests read, among them the uuid "seed-2" that
// integration.test.ts locates).
function seed(file: string) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const t0 = clock() - 60_000;
  writeFileSync(file, [
    { type: "ai-title", aiTitle: "Fleet fixture" },
    { type: "user", uuid: "seed-1", timestamp: new Date(t0).toISOString(), origin: { kind: "human" }, message: { role: "user", content: "seeded prompt" } },
    { type: "assistant", uuid: "seed-2", timestamp: new Date(t0 + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "seeded reply" }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
}
// /clear or /new (ruling 17): a new session in the same process, so the same session file names a new id.
function newSession() {
  sessionId = randomUUID();
  transcript = transcriptOf(sessionId);
  lastUuid = null;
  queue = [];
  if (transcript) seed(transcript);
  setStatus("idle");
}

// submitted.jsonl is written last: a test that waits for the text there then finds its transcript line written too.
function submit() {
  const text = input;
  input = "";
  const submitted = () => appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(text)}\n`);
  if (text === "/exit" && status !== "busy") { submitted(); exit(); return; }
  if ((text === "/clear" || text === "/new") && status !== "busy") { newSession(); submitted(); return; }
  if (silent) { submitted(); return; }
  if (status === "busy" || queueNext) {
    if (queueNext) { queueNext = false; setStatus("busy"); }
    queue.push(text); write("enqueue", text);
  } else write("userTyped", text);
  submitted();
}
function interrupt(o: { restore?: boolean; queueNext?: boolean }) {
  const dropped = queue;
  queue = [];
  for (const t of dropped) write("removeCleared", t);
  if (o.restore && dropped.length) input = dropped.join("\n");
  if (o.queueNext) queueNext = true;
  setStatus("idle");
}
function removeAll(reason: string) {
  for (const t of queue) {
    if (reason === "absorbed_mid_turn") write("removeAbsorbed", t);
    else if (reason === "delivered_to_agent") write("removeDeliveredToAgent", t);
    else if (reason === "cleared_on_cancel") write("removeCleared", t);
    else write("removeCleared", t, reason);
  }
  queue = [];
}
function apply(c: Control) {
  if (c.silent !== undefined) silent = c.silent;
  if (c.swallowEnters !== undefined) { swallow = c.swallowEnters; replaceWith = c.replaceWith ?? null; }
  if (c.question !== undefined) question = c.question;
  if (c.clear) input = "";
  if (c.write) write(c.write, c.text ?? "");
  if (c.dequeue) write("dequeue");
  if (c.prompt && queue.length) { write("userQueued", queue.join("\n")); queue = []; }
  if (c.absorb) { for (const t of queue) { write("removeAbsorbed", t); write("queuedCommand", t); } queue = []; }
  if (c.remove !== undefined) removeAll(c.remove);
  if (c.interrupt) interrupt(c.interrupt);
  if (c.status) setStatus(c.status);
  if (c.queueNext) queueNext = true;
  if (c.exit) exit();
}

// Claude Code has started: the seeded transcript, the session file, the box.
function open() {
  if (transcript) seed(transcript);
  writeSession();
  draw();
}

// A key as the running Claude Code takes it.
function key(k: string) {
  if (phase === "starting") return;                                   // nothing reads the keyboard yet
  if (phase === "trust") {
    if (k === "Down") trustDown = true;
    else if (k === "Enter" && trustDown) { phase = "running"; open(); }
    else if (k === "Enter" || k === "Escape") process.exit(1);
    return;
  }
  if (status === "waiting") { if (["Enter", "Escape", "1", "2"].includes(k)) setStatus("idle"); return; }
  if (k === "Escape" || k === "C-c") { if (status === "busy") interrupt({}); else if (k === "C-c") input = ""; return; }
  if (k === "Enter") {
    if (swallow > 0) { swallow--; if (replaceWith !== null) { input = replaceWith; replaceWith = null; } return; }
    submit();
    return;
  }
  if (k.length === 1) input += k;
}

const controls = join(dir, "control.jsonl");
let readTo = 0;
let applied = 0;
setInterval(() => {
  if (!existsSync(controls)) return;
  const all = readFileSync(controls, "utf8");
  const end = all.lastIndexOf("\n") + 1;
  if (end <= readTo) return;
  for (const l of all.slice(readTo, end).split("\n").filter(Boolean)) { apply(JSON.parse(l) as Control); applied++; }
  readTo = end;
  writeFileSync(join(dir, "applied"), String(applied));
  draw();
}, 25);

const decoder = new StringDecoder("utf8");
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending === "\x1b") { pending = ""; key("Escape"); continue; }   // a lone ESC is the Escape key: tmux writes a key in one go
    if (pending[0] === "\x1b") {
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;                             // the rest of the sequence is still on its way
      if (csi?.[0] === "\x1b[B") key("Down");                           // other keys are ignored
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) { if (phase === "running" && status !== "waiting") input += ch === "\r" ? "\n" : ch; }
    else if (ch === "\r") key("Enter");
    else if (ch === "\x15") { if (phase === "running") input = ""; }      // Ctrl-U: the draft is cleared
    else if (ch === "\x03") key("C-c");
    else if (ch >= " " && ch !== "\x7f") key(ch);
  }
  draw();
});

draw();
const begin = () => {
  phase = existsSync(join(dir, "untrusted")) ? "trust" : "running";
  if (phase === "running") open(); else draw();
};
if (startDelay > 0) setTimeout(begin, startDelay); else begin();
