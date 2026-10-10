// A stand-in for Claude Code's input box, run as a pane's program by the agent's tmux tests (never the real CLI), like
// apps/hub/test/tmux-fake-claude.fixture.ts. It turns bracketed paste on and draws a ─ rule, "❯ " and the input, a ─
// rule and a footer. Inside a paste every byte is text; outside it Enter submits and DEL deletes. It runs nothing: it
// records what reaches it. Usage: node fake-claude.fixture.ts <state dir>; writes <dir>/submitted.jsonl.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.argv[2] ?? ".";
const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";

function draw() {
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\u001b[H\u001b[2J${"─".repeat(40)}\r\n\u001b[38;5;246m❯ \u001b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}

process.stdin.setRawMode(true);
process.stdout.write("\u001b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\u001b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\u001b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\u001b") {
      const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") { appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`); input = ""; }
    else if (ch === "\u007f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
  }
  draw();
});
