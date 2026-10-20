// Stands in for `codex` in the pool tests (ADR-0029): `login status`, `app-server` (the fake app server, with its files in the
// member's sign-in home), and `exec` / `exec resume <id>` as a stream of events in codex-cli 0.161.0's `--json` shapes.
// The member is found by following $CODEX_HOME/auth.json to its real path: that file's directory is the member's sign-in home.
// `mode` there: ok (default), limit, slow, stream (a line every 100 ms for 5 s, its pid in `pid`, then `finished`), encrypted (a
// resume only), auth. Each run appends a record to runs.jsonl in that
// home: its arguments, the member, where its sessions and writer locks really are, and the names of its environment.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? "";
const out = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (argv[0] === "login" && argv[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (argv[0] === "app-server") {
  globalThis.__FAKE_CODEX = { dir: realpathSync(codexHome), modeFile: "read-mode" };
  await import("./fake-codex-app-server.mjs");
} else if (argv[0] === "exec") {
  const memberHome = dirname(realpathSync(join(codexHome, "auth.json")));
  const mode = existsSync(join(memberHome, "mode")) ? readFileSync(join(memberHome, "mode"), "utf8").trim() : "ok";
  // `exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: the id is the first word that is not an option or an option's value.
  const VALUE_OPTIONS = new Set(["-c", "--config", "-m", "--model", "-i", "--image", "--enable", "--disable", "--thread-source", "--cyber-access-program", "-o", "--output-last-message", "--output-schema"]);
  let resumed = null;
  if (argv[1] === "resume") {
    for (let i = 2; i < argv.length; i++) {
      if (argv[i].startsWith("-")) { if (VALUE_OPTIONS.has(argv[i])) i++; continue; }
      resumed = argv[i];
      break;
    }
  }
  appendFileSync(join(memberHome, "runs.jsonl"), `${JSON.stringify({
    argv, member: basename(memberHome), sessionsDir: realpathSync(join(codexHome, "sessions")),
    locksDir: realpathSync(join(codexHome, "thread-writer-locks")), names: Object.keys(process.env),
  })}\n`);
  const thread = resumed ?? `t-${process.pid}`;
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  appendFileSync(join(codexHome, "sessions", `${thread}.jsonl`), `${JSON.stringify({ by: basename(memberHome), argv })}\n`);
  out({ type: "thread.started", thread_id: thread });
  out({ type: "turn.started" });
  if (mode === "slow") await pause(1500);
  if (mode === "stream") {
    writeFileSync(join(memberHome, "pid"), String(process.pid));
    for (let i = 0; i < 50; i++) { out({ type: "item.completed", item: { type: "agent_message", text: `line ${i}` } }); await pause(100); }
    writeFileSync(join(memberHome, "finished"), "yes");
  }
  const fail = message => { out({ type: "error", message }); out({ type: "turn.failed", error: { message } }); process.exit(1); };
  if (mode === "limit") fail("You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Jan 1st, 2099 9:00 AM.");
  if (mode === "auth") fail("Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.");
  if (mode === "encrypted" && resumed) fail("invalid_encrypted_content: The encrypted content could not be verified.");
  out({ type: "item.completed", item: { type: "agent_message", text: `STATUS: DONE ran on ${basename(memberHome)}` } });
  out({ type: "turn.completed" });
  process.exit(0);
} else {
  process.stderr.write("fake codex: unknown command\n");
  process.exit(2);
}
