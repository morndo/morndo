#!/usr/bin/env node
// A protocol-1 plugin with fixed answers (design §5, §13). The hub will spawn this with an argument vector and
// never a shell. The input's basename picks the answer; the file is not read, and nothing is fetched.
// A hang input starts one child in this process group and does not reap it: a signal to this process alone leaves
// the child, and a signal to the group takes both.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { SENTENCE } from "./answers.mjs";

let hanger;
const CHOICE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{1,8})*)$/;
const POSITIVE = /^[1-9]\d*$/;
const ALLOWED = new Set(["--json", "--input", "--language", "--threads", "--max-seconds"]);

function fail(code) {
  process.exit(code);
}

// A large write is still buffered when exit runs, and the pipe keeps only what already flushed. Wait for the write.
function finish(body) {
  process.stdout.write(body, () => process.exit(0));
}

// rest is the argv after the command. A flag that is not part of protocol 1, or a missing value, is usage.
function flags(rest) {
  const out = { json: false };
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    if (!name.startsWith("--") || !ALLOWED.has(name)) return null;
    if (name === "--json") {
      out.json = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return null;
    out[name] = value;
    i += 1;
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "probe") {
  if (rest.length !== 1 || rest[0] !== "--json") fail(2);
  finish(JSON.stringify({
    protocol: 1, ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
    languages: "multi", maxSeconds: 600, missing: [],
  }));
} else if (cmd !== "run") {
  fail(2);
} else {
  const got = flags(rest);
  if (!got?.json || got["--input"] === undefined || got["--language"] === undefined
    || got["--threads"] === undefined || got["--max-seconds"] === undefined) fail(2);

  const input = got["--input"];
  const language = got["--language"];
  if (!input.startsWith("/") || !CHOICE.test(language)) fail(2);
  if (!POSITIVE.test(got["--threads"]) || !POSITIVE.test(got["--max-seconds"])) fail(2);

  const base = basename(input);
  if (base.startsWith("unreadable")) fail(3);
  if (base.startsWith("too-long")) fail(4);
  if (base.startsWith("not-ready")) fail(5);
  if (base.startsWith("bad-json")) finish("{");
  else if (base.startsWith("protocol-2")) {
    finish(JSON.stringify({ protocol: 2, language: "de", durationMs: 1, segments: [] }));
  } else if (base.startsWith("huge")) {
    const text = "x".repeat(2 * 1024 * 1024);
    finish(JSON.stringify({
      protocol: 1, language: "de", durationMs: 1, segments: [{ startMs: 0, endMs: 1, text }],
    }));
  } else if (base.startsWith("hang")) {
    hanger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    hanger.ref();
    setInterval(() => {}, 1e9);
  } else {
    const heard = language === "auto" ? "de" : language;
    const body = JSON.stringify({
      protocol: 1, language: heard, durationMs: 5200,
      segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }],
    });
    if (base.startsWith("stderr-token")) process.stderr.write("fixture-token-9f3a\n", () => finish(body));
    else finish(body);
  }
}
