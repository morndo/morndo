// The node's configuration (spec §5.1, §8; plan Contracts: AgentConfig, Policy). config.json says who this node is in
// the fleet and which fleet it trusts (written by `morndo-node join`); policy.json says what the fleet may do here
// (the owner's to edit; written with the defaults at join). Both are JSON under ~/.config/morndo-node/. A value that
// doesn't fit is an error naming the file and the field, never a silent default: a typo in the policy must not widen
// what the fleet may do.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JOB_CLASS } from "@morndo/domain";
import { NODE_NAME, OP_NAMES, fleetUrlOk, type OpName } from "@morndo/protocol";
import { MAX_TIMER_MS } from "./ops/job-limits.ts";
import { agentPaths } from "./paths.ts";

export type JobClassPolicy = { limit: number; timeoutSec?: number };
export type JobGuardPolicy = { load1?: number; memAvailableMiB?: number };
export type JobsPolicy = { enabled: boolean; classes: Record<string, JobClassPolicy>; guard?: JobGuardPolicy };
export type Policy = {
  ops: OpName[];
  session: string;
  repoRoots: string[];
  fileRoots?: string[];
  lockedPanes: Record<string, string>;
  tmuxSocket: string | null;
  jobs: JobsPolicy;
  jobsWarning?: string;
};
export type AgentConfig = {
  node: string; fleetUrl: string; fleetKey: string; keyPath: string; dbPath: string; relayPort: number; home: string; policy: Policy;
  hub?: string;
};

// Every op the protocol names: an op added there is on by default here, and a policy.json may list it.
export const ALL_OPS: readonly OpName[] = OP_NAMES;
export const isOpName = (s: unknown): s is OpName => typeof s === "string" && (ALL_OPS as readonly string[]).includes(s);

export const RELAY_PORT = 8787;
// Every op on (pane.keys too: the hub's terminal view needs it; spec §8 lists turning it off as the owner's mitigation),
// the tmux session "main", no repositories for worktrees until the owner names them, files under today's rules.
// Shipped jobs: one class, limit 2, and no guard. A policy file that omits `jobs` keeps this. A file that sets
// `jobs` without `guard` still reads nothing (design §5).
export const DEFAULT_JOBS: JobsPolicy = { enabled: true, classes: { default: { limit: 2 } } };
export const DEFAULT_POLICY: Policy = { ops: [...ALL_OPS], session: "main", repoRoots: [], lockedPanes: {}, tmuxSocket: null, jobs: DEFAULT_JOBS };

const CLASS_LIMIT_MAX = 1000;
const TIMEOUT_SEC_MAX = Math.floor(MAX_TIMER_MS / 1000);

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

type Obj = Record<string, unknown>;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function readJson(path: string): Obj {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${path} must hold a JSON object`);
  return value as Obj;
}

const absolutePaths = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => typeof p === "string" && isAbsolute(p));

function copyJobs(jobs: JobsPolicy): JobsPolicy {
  const classes: JobsPolicy["classes"] = {};
  for (const [name, cls] of Object.entries(jobs.classes)) {
    classes[name] = cls.timeoutSec !== undefined ? { limit: cls.limit, timeoutSec: cls.timeoutSec } : { limit: cls.limit };
  }
  const copy: JobsPolicy = { enabled: jobs.enabled, classes };
  if (jobs.guard) {
    const guard: JobGuardPolicy = {};
    if (jobs.guard.load1 !== undefined) guard.load1 = jobs.guard.load1;
    if (jobs.guard.memAvailableMiB !== undefined) guard.memAvailableMiB = jobs.guard.memAvailableMiB;
    copy.guard = guard;
  }
  return copy;
}

const atLeastZero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function parseClasses(value: unknown, where: string): Record<string, JobClassPolicy> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${where}: jobs.classes must name each class and its limit`);
  }
  const classes: Record<string, JobClassPolicy> = {};
  for (const [name, raw] of Object.entries(value as Obj)) {
    if (!JOB_CLASS.test(name)) throw new ConfigError(`${where}: jobs.classes: ${name} is not a class name`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${where}: jobs.classes.${name} must be an object`);
    const body = raw as Obj;
    const unknown = Object.keys(body).filter(k => k !== "limit" && k !== "timeoutSec");
    if (unknown.length) throw new ConfigError(`${where}: jobs.classes.${name}: unknown field ${unknown.join(", ")}`);
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > CLASS_LIMIT_MAX) {
      throw new ConfigError(`${where}: jobs.classes.${name}: limit must be a whole number from 1 to ${CLASS_LIMIT_MAX}`);
    }
    const cls: JobClassPolicy = { limit: body.limit };
    if (body.timeoutSec !== undefined) {
      if (typeof body.timeoutSec !== "number" || !Number.isInteger(body.timeoutSec) || body.timeoutSec < 1 || body.timeoutSec > TIMEOUT_SEC_MAX) {
        throw new ConfigError(`${where}: jobs.classes.${name}: timeoutSec must be whole seconds from 1 to ${TIMEOUT_SEC_MAX}`);
      }
      cls.timeoutSec = body.timeoutSec;
    }
    classes[name] = cls;
  }
  return classes;
}

function parseGuard(value: unknown, where: string): JobGuardPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${where}: jobs.guard must be an object`);
  const body = value as Obj;
  const unknown = Object.keys(body).filter(k => k !== "load1" && k !== "memAvailableMiB");
  if (unknown.length) throw new ConfigError(`${where}: jobs.guard: unknown field ${unknown.join(", ")}`);
  const guard: JobGuardPolicy = {};
  if (body.load1 !== undefined) {
    if (!atLeastZero(body.load1)) throw new ConfigError(`${where}: jobs.guard: load1 must be a number of 0 or more`);
    guard.load1 = body.load1;
  }
  if (body.memAvailableMiB !== undefined) {
    if (!atLeastZero(body.memAvailableMiB)) throw new ConfigError(`${where}: jobs.guard: memAvailableMiB must be a number of 0 or more`);
    guard.memAvailableMiB = body.memAvailableMiB;
  }
  return guard;
}

function parseJobs(value: unknown, where: string): JobsPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${where}: jobs must be an object`);
  const body = value as Obj;
  const known = ["enabled", "classes", "guard"];
  const unknown = Object.keys(body).filter(k => !known.includes(k));
  if (unknown.length) throw new ConfigError(`${where}: jobs: unknown field ${unknown.join(", ")}`);
  if (typeof body.enabled !== "undefined" && typeof body.enabled !== "boolean") throw new ConfigError(`${where}: jobs.enabled must be true or false`);
  if (body.classes === undefined) {
    if (body.enabled === false) return guardOn({ enabled: false, classes: {} }, body.guard, where);
    throw new ConfigError(`${where}: jobs.classes must name each class and its limit`);
  }
  const jobs: JobsPolicy = { enabled: body.enabled !== false, classes: parseClasses(body.classes, where) };
  return guardOn(jobs, body.guard, where);
}

function guardOn(jobs: JobsPolicy, guard: unknown, where: string): JobsPolicy {
  if (guard === undefined) return jobs;
  const parsed = parseGuard(guard, where);
  // Neither line means no guard. This is the only place that rule lives.
  if (parsed.load1 === undefined && parsed.memAvailableMiB === undefined) return jobs;
  return { ...jobs, guard: parsed };
}

export function jobLimits(jobs: JobsPolicy): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const [name, cls] of Object.entries(jobs.classes)) limits[name] = cls.limit;
  return limits;
}

// Seconds, only for classes that set one. A start that omits --timeout uses these; 0 on the start means no limit.
// What status and health say when the jobs block did not fit. The agent stays up; jobs stay off.
export function jobsConfigProblem(reason: string): string {
  return `disabled by config error: ${reason}`;
}

export function jobTimeouts(jobs: JobsPolicy): Record<string, number> {
  const timeouts: Record<string, number> = {};
  for (const [name, cls] of Object.entries(jobs.classes)) {
    if (cls.timeoutSec !== undefined) timeouts[name] = cls.timeoutSec;
  }
  return timeouts;
}

export function parsePolicy(value: Obj, where: string): Policy {
  const known = ["ops", "session", "repoRoots", "fileRoots", "lockedPanes", "tmuxSocket", "jobs"];
  const unknown = Object.keys(value).filter(k => !known.includes(k));
  if (unknown.length) throw new ConfigError(`${where}: unknown field ${unknown.join(", ")} (known: ${known.join(", ")})`);
  const policy: Policy = { ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {}, jobs: copyJobs(DEFAULT_JOBS) };
  if (value.ops !== undefined) {
    if (!Array.isArray(value.ops) || !value.ops.every(isOpName)) throw new ConfigError(`${where}: ops must be a list of op names (${ALL_OPS.join(", ")})`);
    policy.ops = [...new Set(value.ops)];
  }
  if (value.session !== undefined) {
    if (typeof value.session !== "string" || !SESSION_NAME.test(value.session)) throw new ConfigError(`${where}: session must be a tmux session name of letters, digits, "_" or "-"`);
    policy.session = value.session;
  }
  if (value.repoRoots !== undefined) {
    if (!absolutePaths(value.repoRoots)) throw new ConfigError(`${where}: repoRoots must be a list of absolute paths`);
    policy.repoRoots = value.repoRoots;
  }
  if (value.fileRoots !== undefined) {
    if (!absolutePaths(value.fileRoots)) throw new ConfigError(`${where}: fileRoots must be a list of absolute paths`);
    policy.fileRoots = value.fileRoots;
  }
  if (value.lockedPanes !== undefined) {
    const lp = value.lockedPanes;
    if (lp === null || typeof lp !== "object" || Array.isArray(lp) || !Object.values(lp).every(p => typeof p === "string" && isAbsolute(p))) {
      throw new ConfigError(`${where}: lockedPanes must map window names to absolute lock file paths`);
    }
    policy.lockedPanes = lp as Record<string, string>;
  }
  if (value.tmuxSocket !== undefined) {
    if (value.tmuxSocket !== null && (typeof value.tmuxSocket !== "string" || !SOCKET_NAME.test(value.tmuxSocket))) {
      throw new ConfigError(`${where}: tmuxSocket must be null (the default server) or a tmux -L socket name`);
    }
    policy.tmuxSocket = value.tmuxSocket;
  }
  if (value.jobs !== undefined) {
    try { policy.jobs = parseJobs(value.jobs, where); }
    catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      policy.jobs = { enabled: false, classes: {} };
      policy.jobsWarning = e.message;
    }
  }
  return policy;
}

export function loadPolicy(path: string): Policy {
  return existsSync(path) ? parsePolicy(readJson(path), path) : { ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {}, jobs: copyJobs(DEFAULT_JOBS) };
}

// The fields of config.json, as `join` writes them.
export type StoredConfig = Omit<AgentConfig, "home" | "policy">;

export function loadConfig(home: string): AgentConfig {
  const paths = agentPaths(home);
  if (!existsSync(paths.configFile)) {
    throw new ConfigError(`This machine has not joined a fleet (no ${paths.configFile}). Run: morndo-node join '<join string>'`);
  }
  const c = readJson(paths.configFile);
  const where = paths.configFile;
  if (typeof c.node !== "string" || !NODE_NAME.test(c.node)) throw new ConfigError(`${where}: node must match ${NODE_NAME}`);
  // TLS on the network: Tailscale Serve terminates it in front of the fleet, so a plain ws:// URL is only ever this
  // machine's own fleet (plan Contracts, fleetUrlOk; spec §8 "Exposure").
  if (typeof c.fleetUrl !== "string" || !fleetUrlOk(c.fleetUrl)) {
    throw new ConfigError(`${where}: fleetUrl must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1])`);
  }
  if (typeof c.fleetKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.fleetKey)) throw new ConfigError(`${where}: fleetKey must be the fleet's public key (base64)`);
  if (typeof c.keyPath !== "string" || !isAbsolute(c.keyPath)) throw new ConfigError(`${where}: keyPath must be an absolute path`);
  if (typeof c.dbPath !== "string" || !isAbsolute(c.dbPath)) throw new ConfigError(`${where}: dbPath must be an absolute path`);
  if (typeof c.relayPort !== "number" || !Number.isInteger(c.relayPort) || c.relayPort < 0 || c.relayPort > 65535) {
    throw new ConfigError(`${where}: relayPort must be a port number`);
  }
  // The hub this node asks before a job starts. Absent is allowed: the agent still runs, and a start is refused.
  let hub: string | undefined;
  if (c.hub !== undefined) {
    if (typeof c.hub !== "string" || !hubUrlOk(c.hub)) throw new ConfigError(`${where}: hub must be an http or https URL`);
    hub = c.hub;
  }
  return {
    node: c.node, fleetUrl: c.fleetUrl, fleetKey: c.fleetKey, keyPath: c.keyPath, dbPath: c.dbPath, relayPort: c.relayPort,
    home, policy: loadPolicy(paths.policyFile),
    ...(hub ? { hub } : {}),
  };
}

function hubUrlOk(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch { return false; }
}
