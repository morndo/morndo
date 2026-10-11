#!/usr/bin/env node
// The morndo-secrets bin. The value comes only from stdin, as bytes; a typed confirmation is read from the terminal
// itself (/dev/tty), so it works while stdin carries the value, and nothing answers it when there is no terminal.
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { runSecrets } from "./secrets-cli.ts";

async function stdinBytes(): Promise<Uint8Array | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
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

const code = await runSecrets(process.argv.slice(2), process.env, {
  stdin: await stdinBytes(),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  confirm,
});
process.exit(code);
