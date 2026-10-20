#!/usr/bin/env node
// morndo job: start, list, show, logs and cancel on this node (ADR-0017). The node asks the hub. The command
// stays on the local socket.
import { homedir } from "node:os";
import { argvWantsVersion, productVersion } from "@morndo/service-kit";
import { callNode, runJob, type NodeRequest, type NodeResult } from "./job-cli.ts";
import { agentPaths } from "./paths.ts";

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
// Set, not forced: output to a pipe, which Node writes asynchronously on POSIX, drains first
// (nodejs.org/docs/latest-v24.x/api/process.html, "A note on process I/O", read 2026-10-20).
process.exitCode = code;
