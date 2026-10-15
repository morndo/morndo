// Stands in for `codex app-server` on stdio: JSON-RPC, one object per line, no "jsonrpc" field
// (https://learn.chatgpt.com/docs/app-server, read 2026-10-15). It answers initialize, takes the initialized notification,
// sends one account/rateLimits/updated notification, then answers account/rateLimits/read from limits.json beside it.
// The file `mode` beside it: ok (default), error, silent, garbage, request (sends the client two requests of its own, with the
// ids 0 and 1 (the client's own ids), and answers the read only after the client has answered both), deaf (silent, and ignores SIGTERM and a closed stdin). What it saw goes to seen.json beside it: its
// arguments, the names of its environment, CODEX_HOME, its pid and the initialize params.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const mode = existsSync(join(here, "mode")) ? readFileSync(join(here, "mode"), "utf8").trim() : "ok";
const seen = { argv: process.argv.slice(2), names: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME ?? null, pid: process.pid, init: null, replies: [] };
const record = () => writeFileSync(join(here, "seen.json"), JSON.stringify(seen));
record();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
const lines = createInterface({ input: process.stdin });
if (mode === "deaf") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
else lines.on("close", () => process.exit(0));
let owed = null;
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined && (message.id === 0 || message.id === 1)) {
    seen.replies.push({ id: message.id, error: message.error ?? null });
    record();
    if (seen.replies.length === 2 && owed !== null) send({ id: owed, result: JSON.parse(readFileSync(join(here, "limits.json"), "utf8")) });
    return;
  }
  if (message.method === "initialize") {
    seen.init = message.params;
    record();
    send({ id: message.id, result: { userAgent: "fake/0.0.0" } });
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method !== "account/rateLimits/read") return;
  if (!initialized) { send({ id: message.id, error: { code: -32600, message: "not initialized" } }); return; }
  send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: null, secondary: null } } });
  if (mode === "silent" || mode === "deaf") return;
  if (mode === "request") {
    owed = message.id;
    send({ id: 0, method: "attestation/generate", params: {} });
    send({ id: 1, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized" } });
    return;
  }
  if (mode === "error") { send({ id: message.id, error: { code: -32000, message: "not signed in with ChatGPT" } }); return; }
  if (mode === "garbage") {
    process.stdout.write("not json\n");
    send({ id: message.id, result: { rateLimits: { primary: { usedPercent: "high" } } } });
    return;
  }
  send({ id: message.id, result: JSON.parse(readFileSync(join(here, "limits.json"), "utf8")) });
});
