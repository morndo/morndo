// A stand-in for Claude Code's input box, run as a pane's program by the tmux-*.test.ts files (never the real CLI).
// It turns bracketed paste on (ESC[?2004h) and draws, like Claude Code 2.1.286: optional prose above, a ─ border,
// "❯ " and the input, a ─ border, a footer. Inside a paste every byte is text; outside it Enter submits.
// It runs nothing: it only records what reaches it.
// Usage: node tmux-fake-claude.fixture.ts <state dir>. Reads <dir>/prose.txt; writes <dir>/raw.bin (every byte
// received) and <dir>/submitted.jsonl (one JSON string per submit).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.argv[2] ?? ".";
const prose = existsSync(join(dir, "prose.txt")) ? readFileSync(join(dir, "prose.txt"), "utf8").replace(/\n+$/, "") : "";
const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";

function draw() {
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\x1b[H\x1b[2J${prose ? `${prose.replace(/\n/g, "\r\n")}\r\n\r\n` : ""}${"─".repeat(40)}\r\n`
    + `\x1b[38;5;246m❯ \x1b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
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
    else if (ch === "\r") { appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`); input = ""; }
    else if (ch >= " ") input += ch;
  }
  draw();
});
