// `morndo lanes` (fleet-clients spec §9.2): every node's lanes over the fleet's client socket, for any user, with no hub
// settings and no hub database (but `start --task`'s, below). It names itself "lanes" (x-morndo-client), and its ids
// and keys are namespaced so ("lanes:…"): the fleet audits each by its client (§8, §11).
// - list: each lane's name, node, worker id, window, session status, pid, folder, title, and its session's topic and
//   last prompt (reconciliation ruling 13; each online node's inventory; a node that isn't online lists the registry's
//   rows, offline);
// - peek: the screen's last lines (pane.capture);
// - send: a delivery (§4), waited for with --wait; --direct types at once (pane.send), for a lane without Claude Code;
// - keys: pane.keys by key name (the protocol's allow-list);
// - start, stop: lane.start (with a first prompt typed once the lane can take it; on a Role's engine with --role, or a
//   named one with --engine and --reason: reliable lanes §3.3), lane.stop (graceful, or --kill; an exit not seen within
//   its 30 s is "uncertain", exit 3, and --kill may follow). `start --task T-12` (ADR-0032, design §4 "The console
//   actor") first assigns T-12 to the new lane as the console, on the hub's own database (main.ts's, opened here as the
//   other console commands open it, whether the hub runs or not); an unknown task or a done one is refused (exit 4)
//   before anything starts;
// - status: one delivery's state; events: lane events as they happen, until interrupted;
// - brief: what an orchestrator must know after a restart or a compaction (brief.ts, reliable lanes §3.5).
// Exit codes (§9.2; reconciliation rulings 29 and 49): 0 accepted (with --wait: delivered; stop: stopped), 3 not
// delivered in time (stop: not seen to stop in time), 4 given up or a definite refusal, 5 in doubt (the fleet was reached
// and never answered, or answered that the delivery may have been stored: run it again with the same --id, which never
// queues it twice; never typed by hand), 69 the fleet couldn't be reached, so nothing was queued (EX_UNAVAILABLE,
// sysexits.h), 2 bad arguments. A refusal's code goes to stderr.
// util.parseArgs, strict, with positionals ("--" ends the options, so a text may start with "-"):
// https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-08.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_POLICY, parseTaskKey, type TaskKey } from "@morndo/domain";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable } from "@morndo/fleet-client";
import { FINAL_DELIVERY_STATES, KEY_NAMES, LIMITS, parseWorkerId, type Delivery, type KeyName, type LaneEvent, type OpError } from "@morndo/protocol";
import { NotLocalDisk } from "@morndo/service-kit";
import { DatabaseFromFuture } from "../adapters/migrations.ts";
import { Store } from "../adapters/store.ts";
import { BoardService } from "../application/board-service.ts";
import { dataDirOf } from "../config.ts";
import { briefLines } from "./brief.ts";

export const EXIT = { ok: 0, usage: 2, late: 3, notDelivered: 4, inDoubt: 5, unavailable: 69 } as const;

// Where the command reads and writes: the process's own (processIo), or a test's. Every write resolves once written,
// so the caller may exit then (writes to a pipe are asynchronous on POSIX:
// https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io, read 2026-10-08).
export type LanesIo = {
  env: NodeJS.ProcessEnv;
  out(text: string): Promise<void>;
  err(text: string): Promise<void>;
  stdin(): Promise<string>;
  interrupted(): Promise<void>;                     // SIGINT or SIGTERM: `events` ends
};

export function processIo(): LanesIo {
  const write = (s: NodeJS.WriteStream) => (text: string) => new Promise<void>(resolve => { s.write(text.endsWith("\n") ? text : `${text}\n`, () => resolve()); });
  return {
    env: process.env,
    out: write(process.stdout),
    err: write(process.stderr),
    async stdin() {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    interrupted: () => new Promise<void>(resolve => { process.once("SIGINT", () => resolve()); process.once("SIGTERM", () => resolve()); }),
  };
}

export const USAGE = `usage: morndo lanes [--json]
       morndo lanes peek <lane | worker id> [--lines N] [--json]
       morndo lanes send <lane | worker id> <text | -> [--id ID] [--wait SECONDS] [--direct] [--json]
       morndo lanes keys <lane | worker id> <key>...
       morndo lanes start <name> --cwd DIR [--node NODE] [--role ROLE | --engine PROVIDER:MODEL[@EFFORT] --reason TEXT]
                          [--account A] [--resume SESSION] [--prompt TEXT] [--task T-12] [--json]
       morndo lanes stop <lane | worker id> [--kill | --keep-window]
       morndo lanes status <delivery id> [--json]
       morndo lanes events [--json]
       morndo lanes brief [--json]
send - reads the text from stdin. Keys are tmux key names: ${KEY_NAMES.join(" ")}.
stop closes the lane's window once its agent has exited; --keep-window leaves it at its shell. The manager is refused.
start --task assigns that task to the new lane first (the hub's board, MORNDO_HOME); its first turn moves it into progress.
Exit codes: 0 accepted (with --wait: delivered; stop: stopped), 3 not delivered in time (stop: not seen to stop),
4 given up, refused or uncertain, 5 in doubt (the fleet was reached and never answered: run it again with the same
--id), 69 the fleet couldn't be reached (nothing queued), 2 bad arguments. The fleet's socket: MORNDO_FLEET_SOCKET
(default ~/.local/state/morndo-fleet/fleet.sock).`;

const OPTIONS = {
  json: { type: "boolean" }, lines: { type: "string" }, id: { type: "string" }, wait: { type: "string" }, direct: { type: "boolean" },
  kill: { type: "boolean" }, "keep-window": { type: "boolean" }, prompt: { type: "string" }, cwd: { type: "string" }, account: { type: "string" }, resume: { type: "string" },
  node: { type: "string" }, role: { type: "string" }, engine: { type: "string" }, reason: { type: "string" }, task: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;
// The options each command takes; any other is a usage error.
const ALLOWED: Record<string, readonly string[]> = {
  list: ["json"], peek: ["lines", "json"], send: ["id", "wait", "direct", "json"], keys: [], status: ["json"], events: ["json"],
  start: ["cwd", "node", "role", "engine", "reason", "account", "resume", "prompt", "task", "json"], stop: ["kill", "keep-window"], brief: ["json"],
};
const DEFAULT_LINES = 40;
const WAIT_STEP_MS = 250;
const KEYS = new Set<string>(KEY_NAMES);

class Usage extends Error {}
class NotDone extends Error {}                         // a refusal, or a delivery given up or uncertain: exit 4
class InDoubt extends Error {}                         // the fleet was reached and never answered: exit 5 (ruling 49)

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };
export type LaneRow = {
  name: string; node: string; workerId: string | null; window: string; status: string | null; pid: number | null;
  cwd: string | null; title: string | null; topic: string | null; lastPrompt: string | null; sessionId: string | null;
  online: boolean; conflict: boolean;
};

export async function runLanes(argv: string[], io: LanesIo): Promise<number> {
  let values: Values;
  let positionals: string[];
  try { ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })); }
  catch (e) { await io.err(`${(e as Error).message}\n${USAGE}`); return EXIT.usage; }
  if (values.help) { await io.out(USAGE); return EXIT.ok; }
  const [first, ...rest] = positionals;
  const command = first ?? "list";
  // Own keys only: a plain object's constructor, toString and valueOf are not commands.
  if (!Object.hasOwn(ALLOWED, command)) { await io.err(`no such lanes command: ${command}\n${USAGE}`); return EXIT.usage; }
  const allowed = ALLOWED[command] ?? [];
  const wrong = Object.keys(values).filter(k => !allowed.includes(k));
  if (wrong.length) { await io.err(`${command} takes no ${wrong.map(k => `--${k}`).join(", ")}\n${USAGE}`); return EXIT.usage; }
  const socket = io.env.MORNDO_FLEET_SOCKET || join(io.env.HOME || homedir(), ".local/state/morndo-fleet/fleet.sock");
  const client = new FleetClient(socket, { client: "lanes" });
  try {
    switch (command) {
      case "list": return await list(client, io, rest, values);
      case "peek": return await peek(client, io, rest, values);
      case "send": return await send(client, io, rest, values);
      case "keys": return await keys(client, io, rest);
      case "start": return await start(client, io, rest, values);
      case "stop": return await stop(client, io, rest, values);
      case "status": return await status(client, io, rest, values);
      case "brief": return await brief(client, io, rest, values);
      default: return await events(client, io, rest, values);
    }
  } catch (e) {
    if (e instanceof Usage) { await io.err(`${e.message}\n${USAGE}`); return EXIT.usage; }
    if (e instanceof NotDone) { await io.err(e.message); return EXIT.notDelivered; }
    if (e instanceof InDoubt) { await io.err(e.message); return EXIT.inDoubt; }
    if (e instanceof FleetOpFailed) { await io.err(refusedLine(e.error)); return EXIT.notDelivered; }
    // Reached, and no answer: in doubt (ruling 49). Not reached, or not the client API: nothing was asked of it.
    if (e instanceof FleetUnavailable && e.reached) { await io.err(`in doubt: the fleet at ${socket} took the request and never answered (${e.message}); run it again`); return EXIT.inDoubt; }
    if (e instanceof FleetUnavailable || e instanceof FleetMismatch) { await io.err(`the fleet couldn't be reached at ${socket}, so nothing was asked of it: ${e.message}`); return EXIT.unavailable; }
    throw e;
  }
}

const refusedLine = (e: OpError) => `refused: ${e.code}${e.executed === "maybe" ? " (it may have happened)" : ""}: ${e.message}`;
const none = (rest: string[], what: string) => { if (rest.length) throw new Usage(`${what} takes no ${rest.length === 1 ? "argument" : "arguments"} here: ${rest.join(" ")}`); };

// Every lane of every node: each online node's inventory, with the registry's conflict flag; a node that isn't online is
// listed from the registry's rows (its last-known lanes), offline.
async function lanesNow(client: FleetClient): Promise<LaneRow[]> {
  const [nodes, registry] = await Promise.all([client.nodes(), client.lanes()]);
  const conflict = new Set(registry.filter(l => l.conflict).map(l => l.name));
  const rows: LaneRow[] = [];
  // Every online node at once: one lane's name costs the slowest node's answer, not the sum of them all (review #10).
  const answers = await Promise.all(nodes.map(n => (n.status === "online" ? client.op({ node: n.name }, "inventory.get", {}, { timeoutMs: 3000 }) : Promise.resolve(null))));
  for (const [i, n] of nodes.entries()) {
    const r = answers[i] ?? null;
    if (!r?.ok) {
      for (const l of registry.filter(x => x.node === n.name)) {
        rows.push({ name: l.name, node: l.node, workerId: l.workerId, window: l.name, status: null, pid: null, cwd: null, title: null, topic: null, lastPrompt: null,
          sessionId: null, online: false, conflict: l.conflict });
      }
      continue;
    }
    for (const p of r.result.panes) {
      rows.push({
        name: p.window, node: n.name, workerId: p.workerId, window: p.window, status: p.status ?? null, pid: p.pid ?? null, cwd: p.cwd,
        title: p.sessionName ?? p.title ?? null, topic: p.topic ?? null, lastPrompt: p.lastPrompt ?? null, sessionId: p.sessionId ?? null,
        online: true, conflict: conflict.has(p.window),
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.node.localeCompare(b.node));
}

// A lane named by its worker ID (node.server.pane, as `morndo lanes` lists it): the way to reach one of two windows that
// share a name, which the fleet never routes by name (lane_conflict).
const isWorkerId = (arg: string) => parseWorkerId(arg) !== null;

// One lane by name or worker ID: exactly one online window, else a refusal (no such lane, or two windows claim the name).
async function laneNamed(client: FleetClient, name: string): Promise<LaneRow & { workerId: string }> {
  if (isWorkerId(name)) {
    const row = (await lanesNow(client)).find(l => l.workerId === name);
    if (!row) throw new NotDone(`refused: no_pane: no lane with worker ID ${name}`);
    if (!row.online) throw new NotDone(`refused: node_offline: ${name} is on a node that isn't online`);
    return { ...row, workerId: name };
  }
  const named = (await lanesNow(client)).filter(l => l.name === name);
  const online = named.filter((l): l is LaneRow & { workerId: string } => l.online && l.workerId !== null);
  if (named.length > 1 || named.some(l => l.conflict)) {
    throw new NotDone(`refused: lane_conflict: two windows are named "${name}"; name one by its worker ID (morndo lanes lists them)`);
  }
  const lane = online[0];
  if (!lane) throw new NotDone(named.length ? `refused: node_offline: "${name}" is on a node that isn't online` : `refused: no_pane: no lane "${name}"`);
  return lane;
}

async function list(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  none(rest, "lanes");
  const rows = await lanesNow(client);
  if (v.json) { await io.out(JSON.stringify(rows)); return EXIT.ok; }
  const cells = [["NAME", "NODE", "WORKER", "STATUS", "PID", "FOLDER", "TITLE"],
    ...rows.map(r => [r.name, r.online ? r.node : `${r.node} (offline)`, r.workerId ?? "-", r.status ?? "-", r.pid === null ? "-" : String(r.pid), r.cwd ?? "-", r.topic ?? r.title ?? ""])];
  const widths = cells[0]?.map((_, i) => Math.max(...cells.map(c => (c[i] ?? "").length))) ?? [];
  await io.out(cells.map(c => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(widths[i] ?? 0))).join("  ").trimEnd()).join("\n"));
  return EXIT.ok;
}

async function peek(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("peek needs a lane");
  none(more, "peek");
  const lines = v.lines === undefined ? DEFAULT_LINES : Number(v.lines);
  if (!Number.isInteger(lines) || lines < 1 || lines > LIMITS.captureMaxLines) throw new Usage(`--lines is a whole number from 1 to ${LIMITS.captureMaxLines}`);
  const lane = await laneNamed(client, name);
  const r = await client.op({ workerId: lane.workerId }, "pane.capture", { workerId: lane.workerId, lines }, { timeoutMs: 5000 });
  if (!r.ok) throw new FleetOpFailed("pane.capture", r.error);
  if (r.result.text === null) throw new NotDone(`refused: no_pane: "${name}" has no pane any more`);
  await io.out(v.json ? JSON.stringify(r.result) : r.result.text);
  return EXIT.ok;
}

// An id as given, namespaced "lanes:" unless it names its client: --id and status take the same form.
const namespaced = (given: string) => /^[a-z]+:/.test(given) ? given : `lanes:${given}`;

// A delivery's id: the one given, or a new one.
function deliveryId(given: string | undefined): string {
  const id = given === undefined ? `lanes:${randomUUID()}` : namespaced(given);
  if (id.length > LIMITS.maxDeliveryId) throw new Usage(`--id is at most ${LIMITS.maxDeliveryId} characters, its client's name included`);
  return id;
}
const describe = (d: Delivery) =>
  `${d.id}: ${d.state}${d.state === "queued" && d.waiting ? ` (waiting: ${d.waiting.reason})` : ""}${d.state === "given_up" && d.why ? ` (${d.why})` : ""}`;
const codeOf = (d: Delivery, waited: boolean) =>
  d.state === "given_up" || d.state === "uncertain" ? EXIT.notDelivered : d.state === "delivered" || !waited ? EXIT.ok : EXIT.late;

async function send(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, arg, ...more] = rest;
  if (!name || arg === undefined) throw new Usage("send needs a lane and a text (or - to read it from stdin)");
  none(more, "send");
  // From stdin, the one newline a shell's echo or a here-string ends it with is not part of the text.
  const text = arg === "-" ? (await io.stdin()).replace(/\r?\n$/, "") : arg;
  if (!text) throw new Usage("the text is empty");
  if (text.length > LIMITS.maxMessageText) throw new Usage(`the text is over ${LIMITS.maxMessageText} characters`);
  const id = deliveryId(v.id);
  if (v.direct) {
    if (v.wait !== undefined) throw new Usage("--wait waits for a delivery; --direct types at once");
    return direct(client, io, name, text, id, v);
  }
  const waitS = v.wait === undefined ? 0 : Number(v.wait);
  if (!Number.isFinite(waitS) || waitS < 0 || waitS > 86_400) throw new Usage("--wait is a number of seconds, at most a day");
  let d: Delivery;
  let queued = false;
  try {
    d = await client.deliver(isWorkerId(name) ? { id, workerId: name, text } : { id, lane: name, text });
    queued = true;
    const end = Date.now() + waitS * 1000;
    while (waitS > 0 && !FINAL_DELIVERY_STATES.has(d.state) && Date.now() < end) {
      await new Promise(r => setTimeout(r, Math.min(WAIT_STEP_MS, Math.max(1, end - Date.now()))));
      d = (await client.delivery(id)) ?? d;
    }
  } catch (e) {
    // The fleet took it and never answered, or it already answered queued and a later poll can't connect (a restart):
    // it may be queued, under this id. Exit 69 is only when nothing was queued. The same id again is safe (§4.1);
    // typing it by hand is not (ruling 49).
    if (e instanceof FleetUnavailable && (e.reached || queued)) throw new InDoubt(inDoubtLine(id, e));
    // Queued already, a poll answered by something that isn't the client API (a proxy's page, a fleet of another
    // version) is no proof either way: in doubt, under this id (review #4).
    if (e instanceof FleetMismatch && queued) throw new InDoubt(inDoubtLine(id, e));
    // An answer that may have stored it (uncertain, or internal with executed maybe) is the same doubt: the id goes
    // out, so the same --id again is safe and a new one is not (ruling 49).
    if (e instanceof FleetOpFailed && e.error.executed === "maybe") throw new InDoubt(inDoubtLine(id, e));
    throw e;
  }
  await io.out(v.json ? JSON.stringify(d) : describe(d));
  return codeOf(d, waitS > 0);
}

const inDoubtLine = (id: string, e: Error) =>
  `in doubt: the fleet took ${id} and never answered (${e.message}); run it again with the same --id (--id ${id}): it is never sent twice`;

// Typed at once, without the queue (spec §9.2 --direct): pane.send under the id as its key, with the window's session.
// In doubt (no answer, or the node's "uncertain"), the same --id again answers its stored outcome and never types twice.
async function direct(client: FleetClient, io: LanesIo, name: string, text: string, id: string, v: Values): Promise<number> {
  const lane = await laneNamed(client, name);
  const server = parseWorkerId(lane.workerId)?.server ?? "";
  const expect = { server, window: lane.window, ...(lane.sessionId !== null ? { sessionId: lane.sessionId } : {}) };
  let r;
  try { r = await client.op({ workerId: lane.workerId }, "pane.send", { workerId: lane.workerId, text, expect }, { key: id, timeoutMs: 10_000 }); }
  catch (e) { if (e instanceof FleetUnavailable && e.reached) throw new InDoubt(inDoubtLine(id, e)); throw e; }
  if (!r.ok && r.error.code === "uncertain") throw new InDoubt(inDoubtLine(id, new Error(refusedLine(r.error))));
  if (!r.ok) throw new FleetOpFailed("pane.send", r.error);
  if (r.result.problem !== null) throw new NotDone(`not typed into ${name}: ${r.result.problem}${r.result.problem === "not_submitted" ? " (the text is in its input box)" : ""}`);
  await io.out(v.json ? JSON.stringify({ id, typedAt: r.result.typedAt }) : `${id}: typed into ${name}`);
  return EXIT.ok;
}

async function keys(client: FleetClient, io: LanesIo, rest: string[]): Promise<number> {
  const [name, ...names] = rest;
  if (!name || !names.length) throw new Usage("keys needs a lane and at least one key name");
  const bad = names.filter(k => !KEYS.has(k));
  if (bad.length) throw new Usage(`not a key name: ${bad.join(" ")}`);
  const lane = await laneNamed(client, name);
  const server = parseWorkerId(lane.workerId)?.server ?? "";
  const r = await client.op({ workerId: lane.workerId }, "pane.keys", { workerId: lane.workerId, names: names as KeyName[], expect: { server, window: lane.window } }, { timeoutMs: 5000 });
  if (!r.ok) throw new FleetOpFailed("pane.keys", r.error);
  if (!r.result.ok) throw new NotDone(`refused: the keys weren't sent to ${name}`);
  await io.out(`${names.join(" ")} sent to ${name}`);
  return EXIT.ok;
}

async function start(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("start needs the new lane's name");
  none(more, "start");
  if (!v.cwd) throw new Usage("start needs --cwd, the folder the lane works in");
  let node = v.node;
  if (node === undefined) {
    const online = (await client.nodes()).filter(n => n.status === "online");
    if (online.length !== 1) throw new Usage(`name the node with --node (${online.length ? `online: ${online.map(n => n.name).join(", ")}` : "none is online"})`);
    node = online[0]?.name ?? "";
  }
  if (v.role !== undefined && v.engine !== undefined) throw new Usage("start takes --role or --engine, not both");
  // Before --task's assignment, so a refused prompt hands out no task (as send's own bound, one line, before the queue).
  if (v.prompt !== undefined && v.prompt.length > LIMITS.maxMessageText) throw new Usage(`the prompt is over ${LIMITS.maxMessageText} characters`);
  const taskKey = v.task === undefined ? null : parseTaskKey(v.task);
  if (v.task !== undefined && taskKey === null) throw new Usage(`--task is a task's key, such as T-12, not ${JSON.stringify(v.task)}`);
  // Assigned before the lane starts: its first turn is then a run that began after the task's last change, which D4
  // moves into progress; assigned after that turn began, D6 would leave it where it is.
  const task = taskKey === null ? null : assignTask(io.env, taskKey, name);
  // A start that fails after the task was assigned says where the task stays.
  const stays = async () => { if (task) await io.err(`${task.key} stays assigned to ${name}: morndo-board assign ${task.key} <lane> hands it on`); };
  const args = { name, cwd: v.cwd, ...(v.account !== undefined ? { account: v.account } : {}), ...(v.resume !== undefined ? { resume: v.resume } : {}),
    ...(v.prompt !== undefined ? { prompt: v.prompt } : {}), ...(v.role !== undefined ? { role: v.role } : {}),
    ...(v.engine !== undefined ? { engine: v.engine } : {}), ...(v.reason !== undefined ? { reason: v.reason } : {}) };
  let r;
  try { r = await client.op({ node }, "lane.start", args, { key: `lanes:start:${randomUUID()}`, timeoutMs: 60_000 }); }
  catch (e) {
    await stays();
    // No --id here: a start run again is a new start. So it says to look first.
    if (e instanceof FleetUnavailable && e.reached) throw new InDoubt(`in doubt: the fleet took the start of ${name} and never answered (${e.message}); it may have started: look with morndo lanes before starting it again`);
    throw e;
  }
  if (!r.ok) { await stays(); throw new FleetOpFailed("lane.start", r.error); }
  if (v.json) { await io.out(JSON.stringify({ node, ...r.result, ...(task ? { task: task.key } : {}) })); return EXIT.ok; }
  const lines = [`started ${name} on ${node}: ${r.result.workerId}`];
  if (task) lines.push(`${task.key} is assigned to it${task.already ? " (it was already)" : ""}: its first turn moves it into progress`);
  const engine = r.result.engine;
  if (engine) lines.push(`it runs ${engine.entry}${engine.role ? ` (role ${engine.role})` : ""}`);
  if (engine?.skipped?.length) lines.push(`passed over first: ${engine.skipped.map(s => `${s.entry} (${s.reason})`).join("; ")}`);
  if (r.result.waiting === "trust") lines.push("it waits at Claude Code's folder-trust dialog: accept it with morndo lanes keys");
  if (r.result.prompt) lines.push(`its first prompt: ${r.result.prompt} (morndo lanes status ${r.result.prompt})`);
  await io.out(lines.join("\n"));
  return EXIT.ok;
}

// --task: `key` assigned to `lane` as the console ({ kind: "console" }, which acts for the principal at the control plane:
// B2), through the board's own service, so the change is judged by the domain (applyAction), written with its event and
// recorded as any other (B6). On the hub's database, opened as main.ts opens it and never made here: a box with no hub has
// no board. Closed again before the lane starts, so a 60-second start holds no lock. Refused in one line (exit 4): no
// such task, a done one (accepted work is not handed out again: file a new task), or the domain's refusal.
function assignTask(env: NodeJS.ProcessEnv, key: TaskKey, lane: string): { key: TaskKey; already: boolean } {
  const dir = dataDirOf(env);
  if (!existsSync(join(dir, "morndo.db"))) throw new NotDone(`refused: no task ${key}: there is no hub database in ${dir} (MORNDO_HOME)`);
  let store: Store;
  try { store = new Store(dir); }
  catch (e) {
    if (e instanceof DatabaseFromFuture) throw new NotDone(`refused: ${dir}/morndo.db was written by a newer Morndo (schema version ${e.found}); run that hub's console`);
    if (e instanceof NotLocalDisk) throw new NotDone(`refused: ${e.message}`);
    throw e;
  }
  try {
    // The console never acts as the principal's endpoint here, so the access policy is never read.
    const board = new BoardService({ store, policy: () => DEFAULT_POLICY });
    const found = board.task(key);
    if (!found) throw new NotDone(`refused: no task ${key}`);
    if (found.task.status === "done") throw new NotDone(`refused: ${key} is done; file a new task for more work`);
    if (found.task.assignee === lane) return { key, already: true };
    const r = board.act(key, { action: "assign", to: lane }, { kind: "console" });
    if (!r.ok) throw new NotDone(`refused: ${key} can't be assigned to ${lane}: ${r.problem}${r.other ? ` (${r.other})` : ""}`);
    return { key, already: false };
  } finally {
    store.close();
  }
}

async function stop(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [name, ...more] = rest;
  if (!name) throw new Usage("stop needs a lane");
  none(more, "stop");
  if (v.kill && v["keep-window"]) throw new Usage("--kill closes the window: it takes no --keep-window");
  const mode = v.kill ? "kill" : "exit";
  // By worker ID: routed to its node, which stops its window of that name.
  const lane = isWorkerId(name) ? await laneNamed(client, name) : null;
  const r = await client.op(lane ? { workerId: lane.workerId } : { lane: name }, "lane.stop", { name: lane?.window ?? name, mode, ...(v["keep-window"] ? { keepWindow: true } : {}) },
    { key: `lanes:stop:${randomUUID()}`, timeoutMs: LIMITS.laneStopWaitMs + 15_000 });
  // Not seen to close or reach its shell within its 30 s: it may still be stopping. --kill may follow (a new key).
  if (!r.ok && r.error.code === "uncertain") {
    await io.err(`${refusedLine(r.error)}\n${name} may still be stopping; morndo lanes stop ${name} --kill closes its window`);
    return EXIT.late;
  }
  if (!r.ok) throw new FleetOpFailed("lane.stop", r.error);
  await io.out(`${mode === "kill" ? "killed" : "stopped"} ${name}`);
  return EXIT.ok;
}

async function status(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  const [id, ...more] = rest;
  if (!id) throw new Usage("status needs a delivery id");
  none(more, "status");
  const d = await client.delivery(namespaced(id));
  if (!d) throw new NotDone(`no delivery ${namespaced(id)}`);
  await io.out(v.json ? JSON.stringify(d) : `${describe(d)}${d.stale ? " (its node isn't answering: as last heard)" : ""}`);
  return codeOf(d, false);
}

async function brief(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  none(rest, "brief");
  const [lanes, watch, deliveries, alerts] = await Promise.all([client.lanes(), client.laneWatch(), client.deliveries(), client.alerts()]);
  const now = Date.now();
  if (v.json) { await io.out(JSON.stringify({ at: now, lanes, watch, deliveries, alerts: alerts.filter(a => now - a.at < 86_400_000) })); return EXIT.ok; }
  await io.out(briefLines({ lanes, watch, deliveries, alerts }, now).join("\n"));
  return EXIT.ok;
}

const eventLine = (e: LaneEvent) => [new Date(e.at).toISOString(), `${e.lane ?? e.window ?? "?"}@${e.node}`, e.event,
  ...(e.status ? [e.status] : []), ...(e.question ? [`"${e.question}"`] : []), ...(e.firstLine ? [e.firstLine] : []), ...(e.error ? [e.error] : []),
  ...(e.event === "stale" ? [`${e.reason ?? ""}${e.stalls ? ` x${e.stalls}` : ""}`] : []), ...(e.waitingOn ? [`on ${e.waitingOn}`] : [])].join(" ");

async function events(client: FleetClient, io: LanesIo, rest: string[], v: Values): Promise<number> {
  none(rest, "events");
  await client.caps();                                   // the fleet answers, or this is 69 at once
  const stop = client.events(e => {
    if (e.t !== "lane") return;
    const body = e.body as LaneEvent;
    void io.out(v.json ? JSON.stringify(body) : eventLine(body));
  });
  await io.interrupted();
  stop();
  return EXIT.ok;
}
