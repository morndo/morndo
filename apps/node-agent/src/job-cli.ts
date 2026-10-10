// morndo job (ADR-0017, design §2, §6). The command stays on this machine. The hub sees the lane and a directory
// hash, never the command. Exit codes: 0 accepted or printed, 1 refused, 2 usage, 3 the node is unreachable, 4 the hub.
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { basename } from "node:path";
import { LANE_NAME, parseTaskKey, type NotifyTarget } from "@morndo/domain";

export type JobEnv = {
  MORNDO_HUB?: string | undefined;
  MORNDO_AGENT_TOKEN?: string | undefined;
  MORNDO_LANE?: string | undefined;
  HOME?: string | undefined;
};

export type NodeResult =
  | { ok: true; job: { id: string; state: string; text?: string } }
  | { ok: true; jobs: { id: string; state: string }[] }
  | { ok: true; text: string }
  | { ok: false; error: string };
export type NodeRequest =
  | {
    op: "start";
    id: string;
    lane: string;
    name: string;
    jobClass: string;
    notify: NotifyTarget;
    command: string[];
    cwd: string;
    timeoutMs?: number | null;
    token: string;
  }
  | { op: "list"; lane: string; token: string; state?: string; json?: boolean }
  | { op: "show" | "logs" | "cancel"; id: string; lane: string; token: string; lines?: number; json?: boolean };

export type JobIo = {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  node: (msg: NodeRequest) => Promise<NodeResult>;
};

const REFUSAL = new Set(["id_conflict", "denied", "disk", "not_yours", "disabled", "bad_class", "refused", "bad_command"]);

const USAGE = "usage: morndo job start --notify <lane:name|task:T-n|fleet> [--name <name>] [--timeout <seconds>] [--class <name>] [--id <id>] -- <command...>";

export async function runJob(argv: string[], env: JobEnv, io: JobIo): Promise<number> {
  const command = argv[0];
  if (command === "list" || command === "show" || command === "logs" || command === "cancel") return runRead(command, argv.slice(1), env, io);
  if (command !== "start") { io.err(USAGE); return 2; }
  const parsed = parseStart(argv.slice(1));
  if (!parsed.ok) { io.err(parsed.error); return 2; }
  const lane = env.MORNDO_LANE?.trim() ?? "";
  if (!LANE_NAME.test(lane)) { io.err("which lane? set MORNDO_LANE"); return 2; }
  if (!env.MORNDO_AGENT_TOKEN) { io.err("the hub has no token for this call (MORNDO_AGENT_TOKEN)"); return 4; }
  const id = parsed.id ?? `job:${randomBytes(8).toString("hex")}`;
  const name = (parsed.name ?? basename(parsed.command[0] ?? "").slice(0, 64)) || "job";
  let answered: NodeResult;
  try {
    answered = await io.node({
      op: "start", id, lane, name, jobClass: parsed.jobClass, notify: parsed.notify,
      command: parsed.command, cwd: io.cwd, ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
      token: env.MORNDO_AGENT_TOKEN,
    });
  } catch {
    io.err("the node agent could not be reached; nothing was started");
    return 3;
  }
  if (!answered.ok) return refuse(io, answered.error);
  if (!("job" in answered)) { io.err("the node agent could not be reached; nothing was started"); return 3; }
  io.out(`${answered.job.id} ${answered.job.state}`);
  return 0;
}

// The node answers one JSON line. A close with no line, or silence past the timeout, rejects so the CLI can exit.
export function callNode(sock: string, msg: NodeRequest, timeoutMs = 10_000): Promise<NodeResult> {
  return new Promise((resolve, reject) => {
    const socket = connect(sock);
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      socket.destroy();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs);
    socket.on("error", () => finish(() => reject(new Error("closed"))));
    socket.on("end", () => { if (!buf.includes("\n")) finish(() => reject(new Error("closed"))); });
    socket.on("close", () => finish(() => reject(new Error("closed"))));
    socket.on("data", chunk => {
      buf += String(chunk);
      const at = buf.indexOf("\n");
      if (at < 0) return;
      let parsed: NodeResult;
      try { parsed = JSON.parse(buf.slice(0, at)) as NodeResult; }
      catch (e) { finish(() => reject(e)); return; }
      finish(() => resolve(parsed));
    });
    socket.write(`${JSON.stringify(msg)}\n`);
  });
}

export function tokenHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function runRead(command: "list" | "show" | "logs" | "cancel", argv: string[], env: JobEnv, io: JobIo): Promise<number> {
  const lane = env.MORNDO_LANE?.trim() ?? "";
  if (!LANE_NAME.test(lane)) { io.err("which lane? set MORNDO_LANE"); return 2; }
  if (!env.MORNDO_AGENT_TOKEN) { io.err("the hub has no token for this call (MORNDO_AGENT_TOKEN)"); return 4; }
  const token = env.MORNDO_AGENT_TOKEN;
  const json = argv.includes("--json");
  const flags = argv.filter(part => part !== "--json");
  let answered: NodeResult;
  try {
    if (command === "list") {
      const stateAt = flags.indexOf("--state");
      const state = stateAt >= 0 ? flags[stateAt + 1] : undefined;
      if (stateAt >= 0 && !state) { io.err(USAGE); return 2; }
      answered = await io.node({ op: "list", lane, token, ...(state ? { state } : {}), json });
    } else {
      const id = positionals(flags)[0];
      if (!id) { io.err(`usage: morndo job ${command} <id>`); return 2; }
      const linesAt = flags.indexOf("--lines");
      const lines = linesAt >= 0 ? Number(flags[linesAt + 1]) : undefined;
      if (linesAt >= 0 && !Number.isInteger(lines)) { io.err("usage: --lines is a number"); return 2; }
      answered = await io.node({ op: command, id, lane, token, ...(lines !== undefined ? { lines } : {}), json });
    }
  } catch {
    io.err("the node agent could not be reached; nothing was started");
    return 3;
  }
  if (!answered.ok) return refuse(io, answered.error);
  if ("jobs" in answered) {
    io.out(json ? JSON.stringify(answered.jobs) : answered.jobs.map(job => `${job.id} ${job.state}`).join("\n"));
    return 0;
  }
  if ("text" in answered) { io.out(answered.text); return 0; }
  io.out(answered.job.text ?? `${answered.job.id} ${answered.job.state}`);
  return 0;
}

function positionals(argv: string[]): string[] {
  const valued = new Set(["--lines", "--state"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i] ?? "";
    if (valued.has(part)) { i++; continue; }
    if (part.startsWith("--")) continue;
    out.push(part);
  }
  return out;
}

function refuse(io: JobIo, error: string): number {
  if (error === "no_hub") { io.err("this node has no hub address in its config; nothing was started"); return 4; }
  if (error === "no_cache" || error === "hub") { io.err(hubLine(error === "no_cache" ? "unreachable" : "refused")); return 4; }
  io.err(nodeLine(error));
  return REFUSAL.has(error) ? 1 : 1;
}

function hubLine(error: string): string {
  if (error === "revoked") return "this token was revoked; nothing was started";
  if (error === "unreachable") return "the hub could not be reached, and this lane has no token from the last 24 hours";
  if (error === "not_yours") return "the hub refused this token for that lane; nothing was started";
  return "the hub refused the token; nothing was started";
}

function nodeLine(error: string): string {
  if (error === "id_conflict") return "id_conflict: this id already belongs to a different job; nothing was started";
  if (error === "denied") return "that directory is not allowed; nothing was started";
  if (error === "disk") return "the log disk cap is full; nothing was started";
  if (error === "not_yours") return "that is not this lane's job; nothing was started";
  if (error === "disabled") return "jobs are off on this node; nothing was started";
  if (error === "bad_class") return "unknown class; nothing was started";
  return `${error}; nothing was started`;
}

type StartFlags = { notify: NotifyTarget; name?: string; timeoutMs?: number | null; jobClass: string; id?: string; command: string[] };

function parseStart(argv: string[]): { ok: true } & StartFlags | { ok: false; error: string } {
  let notify: NotifyTarget | null = null;
  let name: string | undefined;
  let timeoutMs: number | null | undefined;
  let jobClass = "default";
  let id: string | undefined;
  const dash = argv.indexOf("--");
  if (dash < 0) return { ok: false, error: USAGE };
  const command = argv.slice(dash + 1);
  if (command.length === 0 || command.some(part => part.length === 0)) return { ok: false, error: USAGE };
  const flags = argv.slice(0, dash);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (flag === "--notify" && value) { notify = notifyOf(value); if (!notify) return { ok: false, error: "usage: --notify is lane:<name>, task:T-<n>, or fleet" }; i++; continue; }
    if (flag === "--name" && value) { name = value; i++; continue; }
    if (flag === "--class" && value) { jobClass = value; i++; continue; }
    if (flag === "--id" && value) { id = value; i++; continue; }
    if (flag === "--timeout" && value) {
      if (!/^\d+$/.test(value)) return { ok: false, error: "usage: --timeout is seconds" };
      const seconds = Number(value);
      timeoutMs = seconds === 0 ? null : seconds * 1000;
      i++;
      continue;
    }
    return { ok: false, error: USAGE };
  }
  if (!notify) return { ok: false, error: "usage: --notify is required" };
  return { ok: true, notify, ...(name !== undefined ? { name } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), jobClass, ...(id !== undefined ? { id } : {}), command };
}

function notifyOf(value: string): NotifyTarget | null {
  if (value === "fleet") return { kind: "fleet" };
  if (value.startsWith("lane:")) {
    const name = value.slice("lane:".length);
    return LANE_NAME.test(name) ? { kind: "lane", name } : null;
  }
  if (value.startsWith("task:")) {
    const key = parseTaskKey(value.slice("task:".length));
    return key ? { kind: "task", key } : null;
  }
  return null;
}
