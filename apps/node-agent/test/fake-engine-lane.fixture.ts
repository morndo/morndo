// A stand-in for the engine layer's `engine-lane` (its lane.py, commit 683a7c9), run as a pane's program by the agent's tests
// (never the real lane, which would start an engine). It keeps the contracts the node relies on:
// - bracketed paste is on; Enter submits; a message typed while a turn runs is queued;
// - the input line "❯ " is always the last line on screen, with no rule above it and no footer; `say` prints above it;
// - the lane records itself in <sessions dir>/<pid>.json (the lane's id as sessionId until a turn names an engine session,
//   the process's start ticks and the boot id) and writes a transcript with one `user` line per message it takes, timestamped
//   in whole seconds ("%Y-%m-%dT%H:%M:%SZ"), and an end_turn `assistant` line per turn.
// Usage: node fake-engine-lane.fixture.ts <home> <state dir> [--busy <ms per turn>]; the sessions dir is $ENGINES_SESSIONS or
// <home>/.local/share/engines/sessions. Writes <state dir>/submitted.jsonl (one JSON string per submit) and raw.bin.
// "/exit" submitted ends it as lane.py does: the registry file is dropped and the process exits 0.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const [home = ".", stateDir = "."] = process.argv.slice(2);
const busyMs = Number(process.argv[process.argv.indexOf("--busy") + 1] ?? 0) || 0;
const regDir = process.env.ENGINES_SESSIONS || join(home, ".local", "share", "engines", "sessions");
const trDir = join(home, ".local", "share", "engines", "transcripts");
mkdirSync(regDir, { recursive: true });
mkdirSync(trDir, { recursive: true });

const laneId = randomUUID();
let session = "";
let status: "idle" | "busy" = "idle";
let lastPrompt = "";
let turns = 0;
const queue: string[] = [];
const startedAt = Date.now();
const window = (() => {
  try { return execFileSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE ?? "", "#{window_name}"], { encoding: "utf8" }).trim(); }
  catch { return ""; }
})();
const transcript = join(trDir, `${window || "lane"}-${laneId}.jsonl`);
const stat = readFileSync("/proc/self/stat", "utf8");
const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

function save() {
  const tmp = join(regDir, `.${process.pid}.json.tmp`);
  writeFileSync(tmp, JSON.stringify({
    pid: process.pid, sessionId: session || laneId, name: window || "engine-codex", status, cwd: process.cwd(), startedAt,
    pidStartTicks: ticks, bootId, pidStartedAt: startedAt, updatedAt: Date.now(), engine: "codex", model: "gpt-demo", transcript,
    lastPrompt: lastPrompt.slice(0, 200), title: "codex:gpt-demo",
  }));
  renameSync(tmp, join(regDir, `${process.pid}.json`));
}
const log = (rec: Record<string, unknown>) =>
  appendFileSync(transcript, `${JSON.stringify({ ...rec, timestamp: `${new Date().toISOString().slice(0, 19)}Z` })}\n`);

let buf = "";
const prompt = () => {
  const lines = buf.split("\n");
  return `❯ ${lines[0]}${lines.length > 1 ? ` [+${lines.length - 1} lines]` : ""}`;
};
function say(text: string) {
  process.stdout.write(`\r\u001b[2K${text}\n${prompt()}`);
}
function startTurn(text: string) {
  lastPrompt = text.split("\n")[0] ?? "";
  status = "busy";
  save();
  setTimeout(() => {
    session = `engine-session-${++turns}`;                 // the engine names its session at its first event
    log({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "STATUS: DONE" }] } });
    status = "idle";
    save();
    say("· turn done · STATUS: DONE");
    const next = queue.shift();
    if (next !== undefined) startTurn(next);
  }, busyMs);
}
function submit(text: string) {
  buf = "";
  appendFileSync(join(stateDir, "submitted.jsonl"), `${JSON.stringify(text)}\n`);
  if (!text.trim()) { process.stdout.write(`\r\u001b[2K${prompt()}`); return; }
  log({ type: "user", message: { role: "user", content: text } });
  say(`you: ${text.split("\n")[0]}`);
  if (text.trim() === "/exit") {
    rmSync(join(regDir, `${process.pid}.json`), { force: true });
    process.stdout.write("\u001b[?2004l\r\n");
    process.exit(0);
  }
  if (status === "busy") { queue.push(text); say(`· queued (${queue.length} waiting)`); }
  else startTurn(text);
}

process.stdin.setRawMode(true);
process.stdout.write("\u001b[?2004h");
save();
say(`engine-lane codex ready in ${process.cwd()}`);
const decoder = new StringDecoder("utf8");
let pending = "";
let paste = false;
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(stateDir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\u001b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\u001b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\u001b") {                          // Escape and stray sequences are ignored
      const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) buf += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") submit(buf.replace(/^\n+|\n+$/g, ""));
    else if (ch === "\u007f") buf = buf.slice(0, -1);
    else if (ch >= " ") buf += ch;
  }
  process.stdout.write(`\r\u001b[2K${prompt()}`);
});
