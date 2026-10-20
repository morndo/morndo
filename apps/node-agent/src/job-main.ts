#!/usr/bin/env node
// morndo job: start, list, show, logs and cancel on this node (ADR-0017). The node asks the hub. The command
// stays on the local socket.
import { homedir } from "node:os";
import { argvWantsVersion, exitAfterOutput, productVersion, quietBrokenPipe } from "@morndo/service-kit";
import { callNode, runJob, type NodeRequest, type NodeResult } from "./job-cli.ts";
import { agentPaths } from "./paths.ts";

quietBrokenPipe();
if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${productVersion()}\n`);
  process.exit(0);
}

const home = process.env.HOME || homedir();
const sock = agentPaths(home).jobSock;

function node(msg: NodeRequest): Promise<NodeResult> {
  return callNode(sock, msg);
}

const code = await runJob(process.argv.slice(2), process.env, {
  cwd: process.cwd(),
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  node,
});
// Leave once the output is out (a pipe drains first, none is waited for after it); see service-kit's exit-after-output.ts.
await exitAfterOutput(code);
