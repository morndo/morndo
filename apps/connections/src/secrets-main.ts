#!/usr/bin/env node
// The morndo-secrets bin. The value comes only from stdin, as bytes, and only `put` reads it, so no other command waits
// on an open pipe (review 7). A typed confirmation is read from the terminal itself (/dev/tty), so it works while stdin
// carries the value, and nothing answers it when there is no terminal. It leaves once its output is out, so output to a
// pipe, which Node writes asynchronously on POSIX, drains first, and a reader that closes the pipe is not an error (review
// 11; service-kit's exit-after-output.ts; nodejs.org/docs/latest-v24.x/api/process.html, "A note on process I/O" and
// process.exit(), read 2026-10-12).
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { exitAfterOutput, quietBrokenPipe } from "@morndo/service-kit";
import { runSecrets, stdinValue } from "./secrets-cli.ts";

quietBrokenPipe();

async function stdinBytes(): Promise<Uint8Array | null> {
  if (process.stdin.isTTY) return null;
  return stdinValue(process.stdin);
}

function confirm(prompt: string): Promise<string | null> {
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch { return Promise.resolve(null); }
  try {
    writeSync(fd, prompt);
    const bytes: number[] = [];
    const one = new Uint8Array(1);
    while (readSync(fd, one, 0, 1, null) === 1 && one[0] !== 0x0a) bytes.push(one[0] ?? 0);
    return Promise.resolve(new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r$/, ""));
  } finally {
    closeSync(fd);
  }
}

await exitAfterOutput(await runSecrets(process.argv.slice(2), process.env, {
  stdin: process.argv[2] === "put" ? await stdinBytes() : null,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  confirm,
}));
