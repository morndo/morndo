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
import { argvWantsVersion, productVersion } from "@morndo/service-kit";
import { run, type GitPlace } from "./cli.ts";

if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${productVersion()}\n`);
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
// Set, not forced: output to a pipe, which Node writes asynchronously on POSIX, drains first
// (nodejs.org/docs/latest-v24.x/api/process.html, "A note on process I/O", read 2026-10-20).
process.exitCode = code;
