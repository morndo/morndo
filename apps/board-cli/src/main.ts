#!/usr/bin/env node
// morndo-board: the agents' command onto the team's board (ADR-0015). Everything is in cli.ts; this wires the real
// fetch, the environment — the settings files under ~/.config/morndo behind it, service-kit agent-settings.ts — and,
// inside tmux, the window's name as this lane's name: service-kit's laneFromTmux asks tmux about the command's own
// pane (`display-message -p -t "$TMUX_PANE" '#W'`, never the session's active window), the name the hub lists the
// lane under.
import { readFile } from "node:fs/promises";
import { argvWantsVersion, exitAfterOutput, buildLabel, quietBrokenPipe, agentSettingsIo, laneFromTmux, withAgentSettings } from "@morndo/service-kit";
import { run } from "./cli.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${buildLabel()}\n`);
  process.exit(0);
}

const env = await withAgentSettings(process.env, agentSettingsIo(process.env));

const code = await run(process.argv.slice(2), env, {
  fetch, lane: () => laneFromTmux(process.env), readFile: p => readFile(p, "utf8"),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
