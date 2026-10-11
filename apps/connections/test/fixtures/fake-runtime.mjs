// Stands in for the runtime binary. Records argv and the environment, and sends the helper's
// stdout only as request headers. A denied cat exits before the file is read.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || process.env.CURSOR_CONFIG_DIR || "";
}

if ((argv[0] === "auth" && argv[1] === "status") || (argv[0] === "login" && argv[1] === "status") || argv[0] === "status") {
  let auth;
  try { auth = JSON.parse(readFileSync(`${configDir()}/auth.json`, "utf8")); }
  catch { process.exit(1); }
  if (!auth.signedIn) process.exit(1);
  process.stdout.write(JSON.stringify({ authMethod: auth.authMethod, configDirectory: configDir() }));
  process.exit(0);
}

if (argv[0] === "--call-helper") {
  try { process.stdout.write(execFileSync(argv[1], argv.slice(2), { encoding: "utf8", timeout: 10_000, input: "" })); }
  catch { /* a refused helper prints nothing */ }
  process.exit(0);
}

const jobAt = argv.indexOf("--job");
const job = JSON.parse(readFileSync(argv[jobAt + 1], "utf8"));

if (job.subscription) {
  const leaked = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.CURSOR_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (job.api) {
    const headers = leaked ? { authorization: `Bearer ${leaked}`, "x-api-key": leaked } : {};
    await post(job.api, headers, "{}");
  }
  record();
  let method = "claude.ai";
  try { method = JSON.parse(readFileSync(`${configDir()}/auth.json`, "utf8")).authMethod ?? method; }
  catch { /* the launcher already accepted the method */ }
  process.stdout.write(`${JSON.stringify({ type: "result", authMethod: method, model: job.model ?? "sonnet-5.5" })}\n`);
  process.exit(0);
}

function denied(path, prefixes) {
  return prefixes.some(prefix => {
    const root = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return path === root || path.startsWith(`${root}/`);
  });
}

function invocation() {
  const settingsAt = argv.indexOf("--settings");
  if (settingsAt >= 0) {
    const settings = JSON.parse(argv[settingsAt + 1]);
    const parts = String(settings.apiKeyHelper).split(" ");
    const sandbox = settings.sandbox ?? {};
    const on = sandbox.enabled === true && sandbox.failIfUnavailable === true && sandbox.allowUnsandboxedCommands === false;
    return { cmd: parts[0], args: parts.slice(1), deny: on ? sandbox.filesystem?.denyRead ?? [] : [], rules: settings.permissions?.deny ?? [] };
  }
  const text = readFileSync(`${process.env.CODEX_HOME}/config.toml`, "utf8");
  const command = /^\s*command = "([^"]+)"/m.exec(text)?.[1];
  const args = [...(/^\s*args = \[(.*)\]/m.exec(text)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(match => match[1]);
  return { cmd: command, args, deny: [], rules: [] };
}

function call(spec) {
  try { return execFileSync(spec.cmd, spec.args, { encoding: "utf8", timeout: 10_000, input: "" }); }
  catch (error) { return typeof error.stdout === "string" ? error.stdout : ""; }
}

function subagent(spec) {
  try {
    return execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--call-helper", spec.cmd, ...spec.args], { encoding: "utf8", timeout: 10_000, input: "" });
  } catch (error) { return typeof error.stdout === "string" ? error.stdout : ""; }
}

function record() {
  const bashEnv = execFileSync("env", [], { encoding: "utf8" });
  writeFileSync(job.record, JSON.stringify({ argv, env: process.env, bashEnv }));
}

function wait(path) {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > 15_000) process.exit(2);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  }
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, "content-type": "application/json" } }, res => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const spec = invocation();
if (job.speak) {
  if (job.hold) {
    writeFileSync(job.hold.ready, "ready");
    wait(job.hold.release);
  }
  process.stdout.write(String(job.speak));
  process.stderr.write(String(job.speak));
  record();
  process.exit(0);
}
function ruleDenied(path, rules) {
  return rules.some(rule => {
    const spec = /^Read\((.*)\)$/.exec(rule)?.[1];
    if (!spec) return false;
    const absolute = spec.startsWith("//") ? spec.slice(1) : spec;
    if (absolute.endsWith("/**")) {
      const root = absolute.slice(0, -3);
      return path.startsWith(`${root}/`);
    }
    return path === absolute;
  });
}

if (job.read) {
  if (ruleDenied(job.read, spec.rules)) process.exit(1);
  process.stdout.write(readFileSync(job.read));
  process.exit(0);
}
if (job.cat) {
  if (denied(job.cat, spec.deny)) process.exit(1);
  process.stdout.write(readFileSync(job.cat));
  process.exit(0);
}
if (job.exit !== undefined) {
  record();
  process.exit(job.exit);
}
if (job.hold) {
  const first = call(spec);
  writeFileSync(job.hold.ready, "ready");
  wait(job.hold.release);
  const second = call(spec);
  writeFileSync(job.helperOut, JSON.stringify([first, second]));
  record();
  process.exit(0);
}
if (job.calls) {
  const outs = [];
  for (let i = 0; i < job.calls; i++) outs.push(i === job.subagentAt ? subagent(spec) : call(spec));
  writeFileSync(job.helperOut, JSON.stringify(outs));
  record();
  process.exit(0);
}
const key = call(spec).trim();
if (job.api || job.base) {
  const url = job.base ? `${process.env.ANTHROPIC_BASE_URL}/v1/messages` : job.api;
  await post(url, { authorization: `Bearer ${key}`, "x-api-key": key }, JSON.stringify({ model: job.model ?? "sonnet-5.5" }));
}
record();
const result = { type: "result", model: job.model ?? "sonnet-5.5" };
if (!job.omitCost) result.total_cost_usd = job.cost ?? 0.25;
process.stdout.write(`${JSON.stringify(result)}\n`);
