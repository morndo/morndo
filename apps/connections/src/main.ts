#!/usr/bin/env node
import { argvWantsVersion, exitAfterOutput, isReaderGone, buildLabel, quietBrokenPipe } from "@morndo/service-kit";
import { run } from "./cli.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${buildLabel()}\n`);
  process.exit(0);
}

// Commands that take no input on stdin, by the command word (argv[2]) only: `add usage …` is an add, and reads its key.
const NO_STDIN = new Set(["helper", "run", "lease", "pin-claude", "usage", "pool"]);
const readStdin = process.stdin.isTTY || NO_STDIN.has(process.argv[2] ?? "");
const stdin = readStdin ? Promise.resolve("") : new Promise<string>(resolve => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", chunk => chunks.push(chunk as Buffer));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

// A reader that closes the pipe is told to the run, which stops its turn rather than let it spend on, unread (reader-gone.ts).
const readerGone = new AbortController();
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => { if (isReaderGone(error, stream)) readerGone.abort(); });
}

const code = await run(process.argv.slice(2), process.env, {
  stdin: await stdin,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  gone: readerGone.signal,
  tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
