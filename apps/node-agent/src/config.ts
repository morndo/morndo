// The node's configuration (spec §5.1, §8; plan Contracts: AgentConfig, Policy). config.json says who this node is in
// the fleet and which fleet it trusts (written by `morndo-node join`); policy.json says what the fleet may do here
// (the owner's to edit; written with the defaults at join). Both are JSON under ~/.config/morndo-node/. A value that
// doesn't fit is an error naming the file and the field, never a silent default: a typo in the policy must not widen
// what the fleet may do.
// Fleet clients (spec §5; plan Contracts, Config):
// - `launch` is the command a lane starts with, and how. `{account}` in it stands for the op's account. "shell" types the
//   command into the user's shell once its prompt shows; "direct" runs it as the pane's own program.
// - `protected` lists the lane names lane.stop refuses.
// An op can't add a word to the command (spec §11): only `{account}` and `--resume <session>`, both of fixed formats.
// Reliable lanes (design §3.1, §3.3):
// - `statusContract`: whether the relay asks a lane, once per turn, for the status line its answer lacks; never the lanes in
//   `exempt` (the orchestrator).
// - `engines`: the engine layer's CLI on this node (`cli`), a launch command per provider (`launch`, with `{model}`,
//   `{effort}`, `{account}` and `{lane}` filled from the pick and the op), and the Role a new lane runs on when its start
//   names neither a role nor an engine (`defaultRole`). Without `engines`, lane.start refuses a role or an engine.
// Memory (ADR-0031; docs/design/memory/README.md): `memory.skillDirs`, the engines' skill folders memory.sync writes
// Memory's skills into, at most 8, each absolute or under the node user's home as "~/…".
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { JOB_CLASS } from "@morndo/domain";
import { NODE_NAME, OP_NAMES, ROLE_NAME, fleetUrlOk, type OpName } from "@morndo/protocol";
import { MAX_TIMER_MS } from "./ops/job-limits.ts";
import { agentPaths } from "./paths.ts";

export type Launch = { command: string[]; via: "shell" | "direct" };
export type StatusContract = { mode: "ask" | "off"; exempt: string[] };
export type EnginesPolicy = { cli?: string; launch: Record<string, Launch>; defaultRole?: string };
export type JobClassPolicy = { limit: number; timeoutSec?: number };
export type JobGuardPolicy = { load1?: number; memAvailableMiB?: number };
export type JobsPolicy = { enabled: boolean; classes: Record<string, JobClassPolicy>; guard?: JobGuardPolicy };
export type MemoryPolicy = { skillDirs: string[] };
export type Policy = {
  ops: OpName[];
  session: string;
  repoRoots: string[];
  fileRoots?: string[];
  lockedPanes: Record<string, string>;
  tmuxSocket: string | null;
  launch: Launch;
  protected: string[];
  statusContract: StatusContract;
  engines?: EnginesPolicy;
  jobs: JobsPolicy;
  jobsWarning?: string;
  memory: MemoryPolicy;
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
// the tmux session "main", no repositories for worktrees until the owner names them, files under today's rules, lanes
// started as `claude` from the user's shell, the manager protected from lane.stop, and Memory's skills in the two skill
// folders the engines read (ADR-0031).
// Shipped jobs: one class, limit 2, and no guard. A policy file that omits `jobs` keeps this. A file that sets
// `jobs` without `guard` still reads nothing (design §5).
export const DEFAULT_JOBS: JobsPolicy = { enabled: true, classes: { default: { limit: 2 } } };
export const DEFAULT_POLICY: Policy = {
  ops: [...ALL_OPS], session: "main", repoRoots: [], lockedPanes: {}, tmuxSocket: null,
  launch: { command: ["claude"], via: "shell" }, protected: ["manager"], statusContract: { mode: "ask", exempt: ["manager"] }, jobs: DEFAULT_JOBS,
  memory: { skillDirs: ["~/.claude/skills", "~/.agents/skills"] },
};
// The defaults as a copy that a parse may change, never DEFAULT_POLICY itself.
const defaults = (): Policy => ({
  ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {},
  launch: { command: [...DEFAULT_POLICY.launch.command], via: DEFAULT_POLICY.launch.via }, protected: [...DEFAULT_POLICY.protected],
  statusContract: { mode: DEFAULT_POLICY.statusContract.mode, exempt: [...DEFAULT_POLICY.statusContract.exempt] },
  jobs: copyJobs(DEFAULT_JOBS), memory: { skillDirs: [...DEFAULT_POLICY.memory.skillDirs] },
});

const CLASS_LIMIT_MAX = 1000;
const SKILL_DIRS_MAX = 8;
const TIMEOUT_SEC_MAX = Math.floor(MAX_TIMER_MS / 1000);

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

type Obj = Record<string, unknown>;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// A launcher's word and a lane's name hold no control character (a window name may hold anything else, spec §4).
const WORD = /^[^\p{Cc}]{1,4096}$/u;
const LANE_NAME = /^[^\p{Cc}]{1,200}$/u;

function readJson(path: string): Obj {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${path} must hold a JSON object`);
  return value as Obj;
}

const absolutePaths = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => typeof p === "string" && isAbsolute(p));

// `launch`: a field it doesn't set keeps its default. The program comes first and is never an option.
function parseLaunch(v: unknown, where: string, name = "launch"): Launch {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: ${name} must be an object { command, via }`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter(k => k !== "command" && k !== "via");
  if (unknown.length) throw new ConfigError(`${where}: ${name} has an unknown field ${unknown.join(", ")} (known: command, via)`);
  const command = o.command ?? DEFAULT_POLICY.launch.command;
  if (!Array.isArray(command) || command.length < 1 || command.length > 32 || !command.every(w => typeof w === "string" && WORD.test(w))
    || String(command[0]).startsWith("-")) {
    throw new ConfigError(`${where}: ${name}.command must be 1 to 32 words without control characters, the program first (not an option)`);
  }
  const via = o.via ?? DEFAULT_POLICY.launch.via;
  if (via !== "shell" && via !== "direct") throw new ConfigError(`${where}: ${name}.via must be "shell" or "direct"`);
  return { command: command.map(String), via };
}

function parseStatusContract(v: unknown, where: string): StatusContract {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: statusContract must be an object { mode, exempt }`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter(k => k !== "mode" && k !== "exempt");
  if (unknown.length) throw new ConfigError(`${where}: statusContract has an unknown field ${unknown.join(", ")} (known: mode, exempt)`);
  const mode = o.mode ?? DEFAULT_POLICY.statusContract.mode;
  if (mode !== "ask" && mode !== "off") throw new ConfigError(`${where}: statusContract.mode must be "ask" or "off"`);
  const exempt = o.exempt ?? DEFAULT_POLICY.statusContract.exempt;
  if (!Array.isArray(exempt) || !exempt.every(n => typeof n === "string" && LANE_NAME.test(n))) {
    throw new ConfigError(`${where}: statusContract.exempt must be a list of lane names`);
  }
  return { mode, exempt: [...new Set(exempt as string[])] };
}

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const PLACEHOLDERS = ["{account}", "{model}", "{effort}", "{lane}"];

function parseEngines(v: unknown, where: string): EnginesPolicy {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: engines must be an object { cli, launch, defaultRole }`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter(k => k !== "cli" && k !== "launch" && k !== "defaultRole");
  if (unknown.length) throw new ConfigError(`${where}: engines has an unknown field ${unknown.join(", ")} (known: cli, launch, defaultRole)`);
  const engines: EnginesPolicy = { launch: {} };
  if (o.cli !== undefined) {
    if (typeof o.cli !== "string" || !isAbsolute(o.cli)) throw new ConfigError(`${where}: engines.cli must be the absolute path of the engine layer's CLI`);
    engines.cli = o.cli;
  }
  if (o.launch === null || typeof o.launch !== "object" || Array.isArray(o.launch)) {
    throw new ConfigError(`${where}: engines.launch must map each provider to its launch command { command, via }`);
  }
  for (const [provider, raw] of Object.entries(o.launch as Obj)) {
    if (!PROVIDER.test(provider)) throw new ConfigError(`${where}: engines.launch: ${provider} is not a provider name`);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || (raw as Obj).command === undefined) {
      throw new ConfigError(`${where}: engines.launch.${provider} must name its command`);
    }
    const launch = parseLaunch(raw, where, `engines.launch.${provider}`);
    // The program is the owner's, never a value an op fills.
    if (PLACEHOLDERS.some(p => (launch.command[0] ?? "").includes(p))) throw new ConfigError(`${where}: engines.launch.${provider}: the program can't be a placeholder`);
    engines.launch[provider] = launch;
  }
  if (o.defaultRole !== undefined) {
    if (typeof o.defaultRole !== "string" || !ROLE_NAME.test(o.defaultRole)) throw new ConfigError(`${where}: engines.defaultRole must be a role name`);
    if (engines.cli === undefined) throw new ConfigError(`${where}: engines.defaultRole needs engines.cli, the resolver that fills it`);
    engines.defaultRole = o.defaultRole;
  }
  return engines;
}

// A skill directory: absolute, or "~/" and a path under the node user's home (memory-ops.ts expands it). No control
// character and no ".." segment, so an entry names the directory it reads as.
const skillDirOk = (p: unknown): p is string =>
  typeof p === "string" && (isAbsolute(p) || (p.startsWith("~/") && p.length > 2)) && /^[^\p{Cc}]+$/u.test(p) && !p.split("/").includes("..");

function parseMemory(v: unknown, where: string): MemoryPolicy {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where}: memory must be an object { skillDirs }`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter(k => k !== "skillDirs");
  if (unknown.length) throw new ConfigError(`${where}: memory has an unknown field ${unknown.join(", ")} (known: skillDirs)`);
  const dirs = o.skillDirs ?? DEFAULT_POLICY.memory.skillDirs;
  if (!Array.isArray(dirs) || dirs.length > SKILL_DIRS_MAX || !dirs.every(skillDirOk)) {
    throw new ConfigError(`${where}: memory.skillDirs must be at most ${SKILL_DIRS_MAX} directories, each absolute or starting with "~/", without a ".." segment or a control character`);
  }
  return { skillDirs: [...new Set(dirs)] };
}

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
  const known = ["ops", "session", "repoRoots", "fileRoots", "lockedPanes", "tmuxSocket", "launch", "protected", "statusContract", "engines", "jobs", "memory"];
  const unknown = Object.keys(value).filter(k => !known.includes(k));
  if (unknown.length) throw new ConfigError(`${where}: unknown field ${unknown.join(", ")} (known: ${known.join(", ")})`);
  const policy: Policy = defaults();
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
  if (value.launch !== undefined) policy.launch = parseLaunch(value.launch, where);
  if (value.protected !== undefined) {
    if (!Array.isArray(value.protected) || !value.protected.every(n => typeof n === "string" && LANE_NAME.test(n))) {
      throw new ConfigError(`${where}: protected must be a list of lane names (window names without control characters)`);
    }
    policy.protected = [...new Set(value.protected as string[])];
  }
  if (value.statusContract !== undefined) policy.statusContract = parseStatusContract(value.statusContract, where);
  if (value.engines !== undefined) policy.engines = parseEngines(value.engines, where);
  if (value.jobs !== undefined) {
    try { policy.jobs = parseJobs(value.jobs, where); }
    catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      policy.jobs = { enabled: false, classes: {} };
      policy.jobsWarning = e.message;
    }
  }
  if (value.memory !== undefined) policy.memory = parseMemory(value.memory, where);
  return policy;
}

export function loadPolicy(path: string): Policy {
  return existsSync(path) ? parsePolicy(readJson(path), path) : defaults();
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
