// Stands in for the runtime binary of a key-pool run. It takes the key from the apiKeyHelper the launcher gave it (as the real
// CLI does), appends that key to the job's record file, and answers as the job says for that key: what it prints, on which
// stream, and how it exits. A key the job does not name answers with a normal result. The keys are synthetic.
// The helper line is `helper --lease <id>` (a single Connection) or `helper --pool <name> --grant <id>` (a pooled run). `report`:
// what a lane's tool would do, as a child of this run: the pool report command with the lease or the grant the helper line names.
// `rehelp: n`: as Claude Code does when its cached key has expired, ask the helper n more times; every call is recorded, and the
// key of the last one decides how the run ends. `killParent: true`: SIGKILL the launcher after the first helper call.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const jobAt = argv.indexOf("--job");
const job = JSON.parse(readFileSync(argv[jobAt + 1], "utf8"));
const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
const parts = String(settings.apiKeyHelper).split(" ");
const grantForm = parts.at(-2) === "--grant";

function helper() {
  // What the helper said on stderr is recorded whether it succeeded or not, never shown: a test reads it for a leaked key.
  const out = spawnSync(parts[0], parts.slice(1), { encoding: "utf8", timeout: 10_000, input: "" });
  return { key: out.status === 0 ? String(out.stdout ?? "").trim() : "", code: out.status ?? 1, stderr: String(out.stderr ?? "") };
}
function record(result, again) {
  appendFileSync(job.record, `${JSON.stringify({ key: result.key, code: result.code, stderr: result.stderr, argv, again: again === true })}\n`);
}
function reports(answer) {
  if (!answer.report) return;
  const tail = grantForm
    ? [...parts.slice(1, -5), "keypool", "report", ...answer.report, "--grant", parts.at(-1)]
    : [...parts.slice(1, -3), "keypool", "report", ...answer.report, "--lease", parts.at(-1)];
  try { execFileSync(parts[0], tail, { encoding: "utf8", timeout: 20_000, input: "", stdio: ["pipe", "pipe", "pipe"] }); appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: 0, stderr: "" })}\n`); }
  catch (error) { appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: error.status ?? 1, stderr: String(error.stderr ?? "") })}\n`); }
}

let result = helper();
record(result, false);
const first = job.keys?.[result.key] ?? { exit: 0 };
reports(first);
// `killParent`: the run is killed before it can close its lease or its grant (what a SIGKILL of the launcher leaves behind).
if (first.killParent) process.kill(process.ppid, "SIGKILL");
let answer = first;
for (let i = 0; i < (first.rehelp ?? 0); i++) {
  result = helper();
  record(result, true);
  answer = job.keys?.[result.key] ?? { exit: 0 };
}
if (answer !== first) reports(answer);
if (answer.json) process.stdout.write(`${JSON.stringify(answer.json)}\n`);
else if (answer.say) process.stdout.write(`${answer.say}\n`);
if (answer.sayErr) process.stderr.write(`${answer.sayErr}\n`);
if (answer.exit === 0 && !answer.say && !answer.json) process.stdout.write(`${JSON.stringify({ type: "result", model: "sonnet-5.5", total_cost_usd: 0.01 })}\n`);
process.exit(answer.exit);
