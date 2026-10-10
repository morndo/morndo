// A stand-in for an agent CLI's input box in a tmux pane, for the fleet tests (test/fleet), the fleet's two-node e2e and
// its QA runbook. It is never the real CLI, so none of the real one's hooks fire. It draws like Claude Code 2.1.286, as
// apps/hub/test/tmux-fake-claude.fixture.ts does: optional prose, a ─ rule, "❯ " and the input, a ─ rule, a footer. It
// turns bracketed paste on (ESC[?2004h). Inside a paste every byte is text; outside it, Enter submits and Ctrl-U clears
// the draft. It runs nothing: it only records.
// Usage: node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id> --tmux-session=<name>] [--offset=<ms>]
//   <state dir>/prose.txt        read at start: the prose drawn above the box
//   <state dir>/raw.bin          every byte received
//   <state dir>/submitted.jsonl  one JSON string per submit
//   --claude: a session file <dir>/sessions/<pid>.json naming this pane (from TMUX_PANE), and a transcript
//     <dir>/projects/-qa/<session>.jsonl. Each submit adds one user line to the transcript, timed on this machine's clock
//     plus --offset (the node's clock, the one the real CLI writes with). Shapes as in
//     apps/hub/src/adapters/claude-sessions.ts.
// Options take the --name=value form: util.parseArgs takes a value starting with "-" (a negative offset) only that way
// (https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-06).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { claude: { type: "string" }, session: { type: "string" }, "tmux-session": { type: "string" }, offset: { type: "string" } },
});
const dir = positionals[0] ?? ".";
const offset = Number(values.offset ?? 0);
const clock = () => Date.now() + offset;
const prose = existsSync(join(dir, "prose.txt")) ? readFileSync(join(dir, "prose.txt"), "utf8").replace(/\n+$/, "") : "";

let transcript: string | null = null;
if (values.claude && values.session) {
  const sessions = join(values.claude, "sessions");
  const project = join(values.claude, "projects", "-qa");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(project, { recursive: true });
  transcript = join(project, `${values.session}.jsonl`);
  if (!existsSync(transcript)) {
    const t0 = clock() - 60_000;
    writeFileSync(transcript, [
      { type: "ai-title", aiTitle: "Fleet fixture" },
      { type: "user", uuid: "seed-1", timestamp: new Date(t0).toISOString(), origin: { kind: "human" }, message: { role: "user", content: "seeded prompt" } },
      { type: "assistant", uuid: "seed-2", timestamp: new Date(t0 + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "seeded reply" }] } },
    ].map(l => JSON.stringify(l)).join("\n") + "\n");
  }
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: values.session, tmux: `${values["tmux-session"] ?? "qa"}:@0.${process.env.TMUX_PANE ?? ""}`,
    name: null, cwd: process.cwd(), version: "2.1.286", updatedAt: clock(),
  }));
}

const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";

function draw() {
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\x1b[H\x1b[2J${prose ? `${prose.replace(/\n/g, "\r\n")}\r\n\r\n` : ""}${"─".repeat(40)}\r\n`
    + `\x1b[38;5;246m❯ \x1b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}
function submit() {
  appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`);
  if (transcript) {
    appendFileSync(transcript, `${JSON.stringify({ type: "user", uuid: randomUUID(), timestamp: new Date(clock()).toISOString(), origin: { kind: "human" }, message: { role: "user", content: input } })}\n`);
  }
  input = "";
}

process.stdin.setRawMode(true);
process.stdout.write("\x1b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\x1b") {
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;               // the rest of the sequence is still on its way
      pending = pending.slice(csi ? csi[0].length : 1);     // other keys are ignored
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") submit();
    else if (ch === "\x15") input = "";                     // Ctrl-U: the draft is cleared
    else if (ch >= " " && ch !== "\x7f") input += ch;
  }
  draw();
});
