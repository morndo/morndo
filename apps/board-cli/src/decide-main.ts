#!/usr/bin/env node
// morndo-decide: the agents' command for a decision brief (ADR-0023). Everything is in decide.ts; this wires the real
// fetch, the environment — the settings files under ~/.config/morndo behind it, service-kit agent-settings.ts — the
// file it reads ("-" is stdin) and, inside tmux, the window's name as this lane's name.
import { readFileSync } from "node:fs";
import { exitAfterOutput, quietBrokenPipe, agentSettingsIo, runsOffline, withAgentSettings } from "@morndo/service-kit";
import { run } from "./decide.ts";

quietBrokenPipe();

// help, template, prompt and the local lint of a draft print text and need no settings.
const settings = agentSettingsIo(process.env);
const env = runsOffline(process.argv.slice(2), ["help", "template", "prompt", "lint"]) ? process.env : await withAgentSettings(process.env, settings, { skip: ["node"] });

const read = async (path: string) => {
  if (path === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFileSync(path, "utf8");
};

const code = await run(process.argv.slice(2), env, {
  fetch, lane: settings.lane, read,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
