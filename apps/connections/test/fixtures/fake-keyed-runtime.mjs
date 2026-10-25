// Stands in for the runtime binary of a key-pool run. It takes the key from the apiKeyHelper the launcher gave it (as the real
// CLI does), appends that key to the job's record file, and answers as the job says for that key: what it prints, on which
// stream, and how it exits. A key the job does not name answers with a normal result. The keys are synthetic.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const jobAt = argv.indexOf("--job");
const job = JSON.parse(readFileSync(argv[jobAt + 1], "utf8"));
const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
const parts = String(settings.apiKeyHelper).split(" ");
let key = "";
try { key = execFileSync(parts[0], parts.slice(1), { encoding: "utf8", timeout: 10_000, input: "" }).trim(); } catch { /* a refused helper prints nothing */ }
appendFileSync(job.record, `${JSON.stringify({ key, argv })}\n`);
const answer = job.keys?.[key] ?? { exit: 0 };
// `report`: what a lane's tool would do, as a child of this run: the pool report command with the lease the helper line names.
if (answer.report) {
  const lease = parts.at(-1);
  const tail = [...parts.slice(1, -3), "keypool", "report", ...answer.report, "--lease", lease];
  try { execFileSync(parts[0], tail, { encoding: "utf8", timeout: 20_000, input: "", stdio: ["pipe", "pipe", "pipe"] }); appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: 0, stderr: "" })}\n`); }
  catch (error) { appendFileSync(`${job.record}.report`, `${JSON.stringify({ code: error.status ?? 1, stderr: String(error.stderr ?? "") })}\n`); }
}
if (answer.json) process.stdout.write(`${JSON.stringify(answer.json)}\n`);
else if (answer.say) process.stdout.write(`${answer.say}\n`);
if (answer.sayErr) process.stderr.write(`${answer.sayErr}\n`);
if (answer.exit === 0 && !answer.say && !answer.json) process.stdout.write(`${JSON.stringify({ type: "result", model: "sonnet-5.5", total_cost_usd: 0.01 })}\n`);
process.exit(answer.exit);
