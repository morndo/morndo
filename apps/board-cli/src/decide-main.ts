#!/usr/bin/env node
// morndo-decide: the agents' command for a decision brief (ADR-0023). Everything is in decide.ts; this wires the real
// fetch, the environment, the file it reads ("-" is stdin) and, inside tmux, the window's name as this lane's name.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { exitAfterOutput, quietBrokenPipe } from "@morndo/service-kit";
import { run } from "./decide.ts";

quietBrokenPipe();

const laneFromTmux = () => new Promise<string | null>(resolve => {
  if (!process.env.TMUX) return resolve(null);
  execFile("tmux", ["display-message", "-p", "#W"], { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
});

const read = async (path: string) => {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFileSync(path, "utf8");
};

const code = await run(process.argv.slice(2), process.env, {
  fetch, lane: laneFromTmux, read,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
