#!/usr/bin/env node
import { argvWantsVersion, productVersion } from "@morndo/service-kit";
import { run } from "./cli.ts";

if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${productVersion()}\n`);
  process.exit(0);
}

const readStdin = process.stdin.isTTY || process.argv.includes("helper") || process.argv.includes("run") || process.argv.includes("usage") || process.argv.includes("pool");
const stdin = readStdin ? Promise.resolve("") : new Promise<string>(resolve => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", chunk => chunks.push(chunk as Buffer));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

const code = await run(process.argv.slice(2), process.env, {
  stdin: await stdin,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
process.exit(code);
