// The hub calls the connections program, as it calls the engines CLI (secret-store README §4; ADR-0018 §4).
// A role save is `apply role`, which that program runs through RoutingService. This file never opens the app.
// The call is asynchronous, the same way runEngines uses execFile, so a page request does not block the process.
import { execFile } from "node:child_process";
import { ConnectionsPage, type NarrowCommand, type PriorityCommand, type RevokeCommand, type RoleCommand } from "@morndo/protocol";
import type { ConnectionCommands } from "../application/connections-page.ts";

const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export function connectionsEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, MORNDO_CONNECTIONS_HOME: home, MORNDO_VAULT: "file" };
  delete env.MORNDO_ENGINES_BIN;
  return env;
}

type Run = { status: number; stdout: string; stderr: string };

function call(program: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(program, args, { env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: 0, stdout, stderr });
      const failed = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (typeof failed.code === "number" && !failed.killed) return resolve({ status: failed.code, stdout, stderr });
      reject(error);
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ENOENT") return;
    });
    child.stdin?.end(input);
  });
}

export function connectionsCli(program: string, env: NodeJS.ProcessEnv): ConnectionCommands {
  const page = async () => {
    const run = await call(program, ["page"], "", env);
    if (run.status !== 0) throw new Error(run.stderr.trim() || "the connections program didn't answer");
    return ConnectionsPage.parse(JSON.parse(run.stdout));
  };
  const send = async (kind: string, body: unknown, command: string) => {
    const run = await call(program, ["apply", kind, command], JSON.stringify(body), env);
    if (run.status === 0) return { ok: true as const };
    return { ok: false as const, problem: run.stderr.trim() || "failed" };
  };
  return {
    page,
    priority: (body: PriorityCommand, command: string) => send("priority", body, command),
    role: (body: RoleCommand, command: string) => send("role", body, command),
    revoke: (body: RevokeCommand, command: string) => send("revoke", body, command),
    narrow: (body: NarrowCommand, command: string) => send("narrow", body, command),
  };
}
