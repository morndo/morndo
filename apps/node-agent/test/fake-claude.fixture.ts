// A stand-in for Claude Code's input box, run as a pane's program by the agent's tmux tests (never the real CLI), like
// apps/hub/test/tmux-fake-claude.fixture.ts. It turns bracketed paste on and draws a ─ rule, "❯ " and the input, a ─
// rule and a footer. Inside a paste every byte is text; outside it Enter submits and DEL deletes. It runs nothing: it
// records what reaches it.
// Usage: node fake-claude.fixture.ts <state dir> [--tasks] [--stay]; writes <dir>/submitted.jsonl (one JSON string per
// submit) and <dir>/raw.bin (every byte received).
// "/exit" submitted ends it as Claude Code's does: it clears its frame, so no stale box is left on the screen (Claude Code
// 2.1.287, packages/node-ops/test/fixtures/claude-code-2.1.287/exited-to-shell.ansi), and exits 0.
// - With --tasks it first asks, as Claude Code does while background tasks run, in a menu whose first choice is "Exit
//   and stop tasks" (the words claude-pool answers with 1; their real screen is still to be recorded, RECONCILIATION.md
//   ruling 19), and ends on "1".
// - With --stay it records "/exit" and goes on: a lane that never closes.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.argv[2] ?? ".";
const tasks = process.argv.includes("--tasks");
const stay = process.argv.includes("--stay");
const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";
let menu = false;

function draw() {
  if (menu) {
    process.stdout.write("\u001b[H\u001b[2JBackground tasks are still running.\r\n\r\n❯ 1. Exit and stop tasks\r\n  2. Keep working\r\n\r\nEnter to confirm · Esc to cancel");
    return;
  }
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\u001b[H\u001b[2J${"─".repeat(40)}\r\n\u001b[38;5;246m❯ \u001b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}

function end(): never {
  process.stdout.write("\u001b[?2004l\u001b[H\u001b[2J");
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdout.write("\u001b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
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
    if (menu) { if (ch === "1") end(); continue; }
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") {
      appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`);
      const exit = input === "/exit";
      input = "";
      if (exit && tasks) menu = true;
      else if (exit && !stay) end();
    }
    else if (ch === "\u007f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
  }
  draw();
});
