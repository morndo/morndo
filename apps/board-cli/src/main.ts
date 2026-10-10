#!/usr/bin/env node
// morndo-board: the agents' command onto the team's board (ADR-0015). Everything is in cli.ts; this wires the real
// fetch, the environment and, inside tmux, the window's name as this lane's name (`tmux display-message -p '#W'`,
// the name the hub lists the lane under).
import { execFile } from "node:child_process";
import { run } from "./cli.ts";

const laneFromTmux = () => new Promise<string | null>(resolve => {
  if (!process.env.TMUX) return resolve(null);
  execFile("tmux", ["display-message", "-p", "#W"], { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
});

const code = await run(process.argv.slice(2), process.env, {
  fetch, lane: laneFromTmux,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
process.exit(code);
