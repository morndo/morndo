#!/usr/bin/env node
// morndo-memory: the lanes' command for Memory (ADR-0031). Everything is in cli.ts; this wires the real fetch, the
// environment — the settings files under ~/.config/morndo behind it, service-kit agent-settings.ts — standard input
// (`--body -`), the host's name, inside tmux the window's name as this lane's name (service-kit's laneFromTmux asks
// tmux about the command's own pane, `display-message -p -t "$TMUX_PANE" '#W'`, never the session's active window),
// and where the working directory sits in git:
// `git rev-parse --path-format=absolute --show-toplevel --git-common-dir`, "one line per flag" (in the order given,
// checked with git 2.50.1). `--path-format=absolute` makes both paths "absolute and canonical"; without it the common
// directory of a main checkout's subdirectory comes back relative, such as `../.git` (git-scm.com/docs/git-rev-parse,
// read 2026-10-20). Any git failure means no repository: outside one, and in a bare repository ("If there is no working
// tree, report an error").
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { argvWantsVersion, exitAfterOutput, buildLabel, quietBrokenPipe, agentSettingsIo, withAgentSettings } from "@morndo/service-kit";
import { run, runsOffline, type GitPlace } from "./cli.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${buildLabel()}\n`);
  process.exit(0);
}

// help prints text and needs no settings.
const settings = agentSettingsIo(process.env);
const env = runsOffline(process.argv.slice(2)) ? process.env : await withAgentSettings(process.env, settings);

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

const code = await run(process.argv.slice(2), env, {
  fetch, lane: settings.lane, git: gitPlace, host: hostname, stdin,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
