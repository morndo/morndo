#!/usr/bin/env node
// morndo job: start, list, show, logs and cancel on this node (ADR-0017). The node asks the hub. The command
// stays on the local socket.
import { homedir } from "node:os";
import { argvWantsVersion, exitAfterOutput, buildLabel, quietBrokenPipe, agentSettingsIo, withAgentSettings } from "@morndo/service-kit";
import { callNode, runJob, runsOffline, type NodeRequest, type NodeResult } from "./job-cli.ts";
import { agentPaths } from "./paths.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${buildLabel()}\n`);
  process.exit(0);
}

// The job program talks to the node, not the hub: it needs the token and the lane (from the window, when the environment has none), not the hub address or the node name.
const env = runsOffline(process.argv.slice(2)) ? process.env : await withAgentSettings(process.env, agentSettingsIo(process.env), { skip: ["hub", "node"], fillLane: true });

const home = process.env.HOME || homedir();
const sock = agentPaths(home).jobSock;

function node(msg: NodeRequest): Promise<NodeResult> {
  return callNode(sock, msg);
}

const code = await runJob(process.argv.slice(2), env, {
  cwd: process.cwd(),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  node,
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
