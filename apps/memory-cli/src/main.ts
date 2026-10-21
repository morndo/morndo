#!/usr/bin/env node
// morndo-memory: the lanes' command for Memory (ADR-0031). Everything is in cli.ts; this wires the real fetch, the
// environment, standard input (`--body -`), the host's name, inside tmux the window's name as this lane's name (`tmux
// display-message -p '#W'`, the name the hub lists the lane under), and where the working directory sits in git:
// `git rev-parse --path-format=absolute --show-toplevel --git-common-dir`, "one line per flag" (in the order given,
// checked with git 2.50.1). `--path-format=absolute` makes both paths "absolute and canonical"; without it the common
// directory of a main checkout's subdirectory comes back relative, such as `../.git` (git-scm.com/docs/git-rev-parse,
// read 2026-10-20). Any git failure means no repository: outside one, and in a bare repository ("If there is no working
// tree, report an error").
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { argvWantsVersion, exitAfterOutput, buildLabel, quietBrokenPipe } from "@morndo/service-kit";
import { run, type GitPlace } from "./cli.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${buildLabel()}\n`);
  process.exit(0);
}

const laneFromTmux = () => new Promise<string | null>(resolve => {
  if (!process.env.TMUX) return resolve(null);
  execFile("tmux", ["display-message", "-p", "#W"], { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
});

const gitPlace = () => new Promise<GitPlace | null>(resolve => {
  execFile("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
    const [top, common] = stdout.split("\n");
    resolve(error || !top || !common ? null : { top, common });
  });
});

const stdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const code = await run(process.argv.slice(2), process.env, {
  fetch, lane: laneFromTmux, git: gitPlace, host: hostname, stdin,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
