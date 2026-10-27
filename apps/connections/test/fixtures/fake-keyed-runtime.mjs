// Stands in for the runtime binary of a key-pool run. It takes the key from the apiKeyHelper the launcher gave it (as the real
// CLI does), appends that key to the job's record file, and answers as the job says for that key: what it prints, on which
// stream, and how it exits. A key the job does not name answers with a normal result. The keys are synthetic.
// The helper line is `helper --lease <id>` (a single Connection) or `helper --pool <name> --grant <id>` (a pooled run). `report`:
// what a lane's tool would do, as a child of this run: the pool report command with the lease or the grant the helper line names.
// `rehelp: n`: as Claude Code does when its cached key has expired, ask the helper n more times; every call is recorded, and the
// key of the last one decides how the run ends. `killParent: true`: SIGKILL the launcher after the first helper call.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const argv = process.argv.slice(2);
const jobAt = argv.indexOf("--job");
const job = JSON.parse(readFileSync(argv[jobAt + 1], "utf8"));
const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
const parts = String(settings.apiKeyHelper).split(" ");
// The helper line is `<bin> … helper [--filter <socket>] --lease <id>` or `… helper [--filter <socket>] --pool <name> --grant <id>`.
const helperAt = parts.indexOf("helper");
const grantForm = parts.includes("--grant");
const baseArgs = parts.slice(1, helperAt);

function helper() {
  // What the helper said on stderr is recorded whether it succeeded or not, never shown: a test reads it for a leaked key.
  const out = spawnSync(parts[0], parts.slice(1), { encoding: "utf8", timeout: 10_000, input: "" });
  return { key: out.status === 0 ? String(out.stdout ?? "").trim() : "", code: out.status ?? 1, stderr: String(out.stderr ?? "") };
}
function record(result, again) {
  appendFileSync(job.record, `${JSON.stringify({ key: result.key, code: result.code, stderr: result.stderr, argv, again: again === true })}\n`);
}
// `cmds: [{ args, input? }]`: morndo-keys commands the run's child runs before it asks again (a member joining the pool, a key rotated, a member removed),
// as a person at the machine would; each exit code is recorded.
function commands(answer, list = answer.cmds) {
  const base = baseArgs;
  for (const cmd of list ?? []) {
    const out = spawnSync(parts[0], [...base, ...cmd.args], { encoding: "utf8", timeout: 20_000, input: cmd.input ?? "" });
    appendFileSync(`${job.record}.cmds`, `${JSON.stringify({ args: cmd.args, code: out.status ?? 1, stderr: String(out.stderr ?? "") })}\n`);
  }
}
// `bypass: [{ filter } | { loosen: true } | { junk: n }]`: what a tool of this run could do, as a child of it: call the helper line without its `--filter` (`"drop"`), or
// with another socket (a path). Each answer is recorded in `<record>.bypass` (the key only if the helper printed one), never shown.
// `{ junk: n }`: n keys nobody holds, sent one by one to the run's own socket (what any process of the same user could do); the answers are counted.
function sendKey(path, key) {
  return new Promise(resolve => {
    const socket = connect(path);
    let text = "";
    const timer = setTimeout(() => { socket.destroy(); resolve("timeout"); }, 3000);
    socket.setEncoding("utf8");
    socket.on("data", chunk => { text += chunk; });
    socket.on("close", () => { clearTimeout(timer); resolve(text.trim() || "closed"); });
    socket.on("error", () => { clearTimeout(timer); resolve("error"); });
    socket.on("connect", () => { socket.write(`${JSON.stringify({ key })}\n`); });
  });
}
async function bypasses(answer) {
  for (const item of answer.bypass ?? []) {
    if (item.junk) {
      const path = parts[parts.indexOf("--filter") + 1];
      const answers = {};
      for (let i = 0; i < item.junk; i++) {
        const said = await sendKey(path, `junk-synthetic-filler-${i}`);
        answers[said] = (answers[said] ?? 0) + 1;
      }
      appendFileSync(`${job.record}.bypass`, `${JSON.stringify({ filter: "junk", key: "", code: 0, stderr: "", answers })}\n`);
      continue;
    }
    const args = parts.slice(1);
    const at = args.indexOf("--filter");
    // `loosen`: the run's own socket, with its mode loosened for the one call (a socket that is no longer the one the run made).
    if (item.loosen) chmodSync(args[at + 1], 0o666);
    else if (item.filter === "drop") args.splice(at, 2);
    else args[at + 1] = item.filter;
    const out = spawnSync(parts[0], args, { encoding: "utf8", timeout: 10_000, input: "" });
    if (item.loosen) chmodSync(args[at + 1], 0o600);
    appendFileSync(`${job.record}.bypass`, `${JSON.stringify({ filter: item.loosen ? "loosened" : item.filter, key: out.status === 0 ? String(out.stdout ?? "").trim() : "", code: out.status ?? 1, stderr: String(out.stderr ?? "") })}\n`);
  }
}
function reports(answer) {
  if (!answer.report) return;
  const tail = grantForm
    ? [...baseArgs, "keypool", "report", ...answer.report, "--grant", parts.at(-1)]
    : [...baseArgs, "keypool", "report", ...answer.report, "--lease", parts.at(-1)];
  try { execFileSync(parts[0], tail, { encoding: "utf8", timeout: 20_000, input: "", stdio: ["pipe", "pipe", "pipe"] }); appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: 0, stderr: "" })}\n`); }
  catch (error) { appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: error.status ?? 1, stderr: String(error.stderr ?? "") })}\n`); }
}

// `hook`: what a hook of an interactive session would do, as a child of this run: the pool report command with the grant the helper line names and
// `hook` as the JSON on stdin (a string is sent as it is). Each result is recorded in `<record>.hook`, never shown. (The launcher's own settings carry no
// hook: a headless run ends before a hook can finish.)
function hooks(answer) {
  if (answer.hook === undefined || !grantForm) return;
  const stdin = typeof answer.hook === "string" ? answer.hook : JSON.stringify(answer.hook);
  const pool = parts[parts.indexOf("--pool") + 1];
  const out = spawnSync(parts[0], [...baseArgs, "keypool", "report", pool, "--from-hook", "--grant", parts.at(-1)], { encoding: "utf8", timeout: 20_000, input: stdin });
  appendFileSync(`${job.record}.hook`, `${JSON.stringify({ code: out.status ?? 1, stdout: String(out.stdout ?? ""), stderr: String(out.stderr ?? "") })}\n`);
}

let result = helper();
record(result, false);
const first = job.keys?.[result.key] ?? { exit: 0 };
commands(first);
await bypasses(first);
reports(first);
hooks(first);
// `killParent`: the run is killed before it can close its lease or its grant (what a SIGKILL of the launcher leaves behind).
if (first.killParent) process.kill(process.ppid, "SIGKILL");
let answer = first;
for (let i = 0; i < (first.rehelp ?? 0); i++) {
  result = helper();
  record(result, true);
  answer = job.keys?.[result.key] ?? { exit: 0 };
}
if (answer !== first) { reports(answer); hooks(answer); }
// `cmdsAfter`: commands run after the last helper call, before the child prints (a member removed or rotated once it was handed to).
commands(answer, answer.cmdsAfter);
if (answer.json) process.stdout.write(`${JSON.stringify(answer.json)}\n`);
else if (answer.say) process.stdout.write(`${answer.say}\n`);
if (answer.sayErr) process.stderr.write(`${answer.sayErr}\n`);
if (answer.exit === 0 && !answer.say && !answer.json) process.stdout.write(`${JSON.stringify({ type: "result", model: "sonnet-5.5", total_cost_usd: 0.01 })}\n`);
process.exit(answer.exit);
