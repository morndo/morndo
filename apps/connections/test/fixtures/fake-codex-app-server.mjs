// Stands in for `codex app-server` on stdio: JSON-RPC, one object per line, no "jsonrpc" field
// (https://learn.chatgpt.com/docs/app-server, read 2026-10-15). It answers initialize, takes the initialized notification,
// sends one account/rateLimits/updated notification, then answers account/rateLimits/read from limits.json beside it.
// It also answers account/read from account.json beside it, and account/rateLimitResetCredit/consume with { outcome: "reset" }.
// The file `mode` beside it: ok (default), error, silent, garbage. What it saw goes to seen.json beside it: its
// arguments, the names of its environment, CODEX_HOME, its pid, the initialize params and every request in order (calls).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const mode = existsSync(join(here, "mode")) ? readFileSync(join(here, "mode"), "utf8").trim() : "ok";
const seen = { argv: process.argv.slice(2), names: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME ?? null, pid: process.pid, init: null, calls: [] };
const record = () => writeFileSync(join(here, "seen.json"), JSON.stringify(seen));
record();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method) { seen.calls.push({ method: message.method, params: message.params ?? null }); record(); }
  if (message.method === "initialize") {
    seen.init = message.params;
    record();
    send({ id: message.id, result: { userAgent: "fake/0.0.0" } });
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (!["account/rateLimits/read", "account/read", "account/rateLimitResetCredit/consume"].includes(message.method)) return;
  if (!initialized) { send({ id: message.id, error: { code: -32600, message: "not initialized" } }); return; }
  if (message.method === "account/read") {
    const file = join(here, "account.json");
    send({ id: message.id, result: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { account: null, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === "account/rateLimitResetCredit/consume") { send({ id: message.id, result: { outcome: "reset" } }); return; }
  send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: null, secondary: null } } });
  if (mode === "silent") return;
  if (mode === "error") { send({ id: message.id, error: { code: -32000, message: "not signed in with ChatGPT" } }); return; }
  if (mode === "garbage") {
    process.stdout.write("not json\n");
    send({ id: message.id, result: { rateLimits: { primary: { usedPercent: "high" } } } });
    return;
  }
  send({ id: message.id, result: JSON.parse(readFileSync(join(here, "limits.json"), "utf8")) });
});
