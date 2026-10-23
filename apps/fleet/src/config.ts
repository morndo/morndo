// The fleet service's settings (ADR-0012; spec section 5.6): one JSON file, ~/.config/morndo-fleet/config.json, or the
// file MORNDO_FLEET_CONFIG names. Every setting has a default, so a missing file runs the single-host setup. A file
// that doesn't fit is refused with one sentence naming the setting: a typo never silently falls back to a default.
// Every default path derives from HOME (`HOME || os.homedir()`: a HOME set but empty counts as unset, never as a
// relative path), never from XDG_*, so a test or a QA run gives each process its own HOME.
// The agent endpoint never listens on the network itself (spec 8): `listen.host` must be a loopback address, and
// Tailscale Serve terminates TLS in front of it; `publicUrl`, which every node dials, must be wss://, or ws:// only to
// this machine (fleetUrlOk), so no proof or op ever crosses a network in clear text.
// `stickyLanes` (fleet clients spec §4.1, §4.6): lane names a delivery follows wherever their node runs them; while such a
// name's window is gone (the manager restarting), a delivery still goes to the node that last reported it.
// `laneEvents` (spec §7): lane events delivered to the lane `deliverTo` (null: not delivered, still published), batched
// for `batchMs`, as one message whose first line is `header`; lanes whose name matches a glob of `ignore` emit none.
// `laneWatch` (reliable lanes §3.2): the lease of a WAITING turn that names no `for`, and of one that ended with background
// work (`waitingMin`); the deadline of a turn with no status line (`noStatusMin`); whether a stale lane is nudged.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fleetUrlOk, type HookEvent } from "@morndo/protocol";
import { DEFAULT_LANE_WATCH, type LaneWatchConfig } from "./application/lane-watch.ts";

export type HookPath = HookEvent["path"];
export type Subscriber = { name: string; url: string; paths: HookPath[] };
export type FleetConfig = {
  listen: { host: string; port: number };   // the agent endpoint, /agent
  socketPath: string;                         // the client API's Unix socket; its directory must be 0700 and ours
  dbPath: string;
  keyPath: string;                            // the fleet's Ed25519 private key (PKCS#8 PEM, mode 0600)
  publicUrl: string;                          // the agent endpoint as nodes dial it; goes into every join string
  subscribers: Subscriber[];                  // the hook bus's static subscribers
  stickyLanes: string[];                      // lane names deliveries follow across restarts (spec §4.6)
  laneEvents: LaneEventsConfig;               // lane events to the manager (spec §7)
  laneWatch: LaneWatchConfig;                 // deadlines for a lane's last turn (reliable lanes §3.2)
  // The hub's public key (Ed25519's 32 raw bytes, base64 or base64url) pinned in the file: with it, resume and
  // update.apply open to the hub's signed assertion (updates §5.4); absent, they stay closed as today.
  principalKey?: string;
};
export type LaneEventsConfig = { deliverTo: string | null; header: string; ignore: string[]; batchMs: number };

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

// Every hook path, once: a Record over the union, so a path the protocol adds fails to compile here until listed.
// "/lane" is not one a subscriber names: it carries the node's own lane state events, from which the fleet builds lane
// events (fleet clients §7).
const PATHS: Record<Exclude<HookPath, "/lane">, true> = { "/cc": true, "/sl": true, "/hook/stop": true, "/hook/failure": true, "/notify": true, "/file": true };
export const HOOK_PATHS = Object.keys(PATHS) as HookPath[];
const SUBSCRIBER_NAME = /^[a-z0-9-]{1,32}$/;
// The public URL goes into every join string, which carries printable ASCII only (formatJoinString refuses the rest).
const JOIN_URL = /^wss?:\/\/[!-~]{1,2040}$/;
// The loopback names and addresses the agent endpoint may listen on.
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|::1)$/;
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers", "stickyLanes", "laneEvents", "laneWatch", "principalKey"]);
const LANE_WATCH_KEYS = new Set(["waitingMin", "noStatusMin", "nudge"]);
const LANE_EVENT_KEYS = new Set(["deliverTo", "header", "ignore", "batchMs"]);
// The header is the message's first line: printable, no line break; the batch window from 0.1 to 60 s.
const HEADER = /^[^\p{Cc}]{1,1000}$/u;
// A lane name as tmux reports it (the protocol's window name): 1 to 200 characters, none a control character.
const LANE_NAME = /^[^\p{Cc}]{1,200}$/u;

export const homeOf = (env: NodeJS.ProcessEnv = process.env): string => env.HOME || homedir();

export const configPath = (env: NodeJS.ProcessEnv = process.env, home: string = homeOf(env)) =>
  env.MORNDO_FLEET_CONFIG || join(home, ".config/morndo-fleet/config.json");

export function defaults(home: string): FleetConfig {
  return {
    listen: { host: "127.0.0.1", port: 8791 },
    socketPath: join(home, ".local/state/morndo-fleet/fleet.sock"),
    dbPath: join(home, ".local/share/morndo-fleet/fleet.db"),
    keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
    publicUrl: "ws://127.0.0.1:8791/agent",
    subscribers: [],
    stickyLanes: ["manager"],
    laneEvents: { deliverTo: "manager", header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 },
    laneWatch: { ...DEFAULT_LANE_WATCH },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function path(v: unknown, name: string, home: string): string {
  if (typeof v !== "string" || v === "") throw new ConfigError(`${name} must be a path`);
  const p = v === "~" ? home : v.startsWith("~/") ? join(home, v.slice(2)) : v;
  if (!isAbsolute(p)) throw new ConfigError(`${name} must be absolute or start with ~/: ${JSON.stringify(v)}`);
  return p;
}

function url(v: unknown, name: string, protocols: string[]): string {
  if (typeof v !== "string") throw new ConfigError(`${name} must be a URL`);
  let u: URL;
  try { u = new URL(v); } catch { throw new ConfigError(`${name} is not a URL: ${JSON.stringify(v)}`); }
  if (!protocols.includes(u.protocol)) throw new ConfigError(`${name} must start with ${protocols.join(" or ")}//: ${JSON.stringify(v)}`);
  return v;
}

function publicUrl(v: unknown): string {
  const u = url(v, "publicUrl", ["ws:", "wss:"]);
  if (!JOIN_URL.test(u)) throw new ConfigError(`publicUrl must be printable ASCII without spaces (a join string carries it): ${JSON.stringify(u)}`);
  if (!fleetUrlOk(u)) throw new ConfigError(`publicUrl must be wss://, or ws:// to this machine (127.0.0.1, localhost, [::1]): a node sends its proof and every op over it: ${JSON.stringify(u)}`);
  return u;
}

function subscribers(v: unknown): Subscriber[] {
  if (!Array.isArray(v)) throw new ConfigError("subscribers must be a list");
  const seen = new Set<string>();
  return v.map((s, i) => {
    const at = `subscribers[${i}]`;
    if (!isObject(s)) throw new ConfigError(`${at} must be an object with name, url and paths`);
    const extra = Object.keys(s).filter(k => k !== "name" && k !== "url" && k !== "paths");
    if (extra.length) throw new ConfigError(`${at} has unknown settings: ${extra.join(", ")}`);
    if (typeof s.name !== "string" || !SUBSCRIBER_NAME.test(s.name)) throw new ConfigError(`${at}.name must match ${SUBSCRIBER_NAME}`);
    if (seen.has(s.name)) throw new ConfigError(`${at}.name "${s.name}" is used twice`);
    seen.add(s.name);
    if (!Array.isArray(s.paths) || s.paths.length === 0) throw new ConfigError(`${at}.paths must list at least one of ${HOOK_PATHS.join(", ")}`);
    const paths = s.paths.map(p => {
      if (typeof p !== "string" || !Object.hasOwn(PATHS, p)) throw new ConfigError(`${at}.paths: ${JSON.stringify(p)} is not one of ${HOOK_PATHS.join(", ")}`);
      return p as HookPath;
    });
    return { name: s.name, url: url(s.url, `${at}.url`, ["http:", "https:"]), paths: [...new Set(paths)] };
  });
}

function laneNames(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || !v.every(n => typeof n === "string" && LANE_NAME.test(n))) {
    throw new ConfigError(`${name} must be a list of lane names (1 to 200 characters, no control characters)`);
  }
  return [...new Set(v as string[])];
}

// Each setting of laneEvents over its default; a key it doesn't know is refused.
function laneEvents(v: unknown, base: LaneEventsConfig): LaneEventsConfig {
  if (!isObject(v)) throw new ConfigError("laneEvents must be an object with deliverTo, header, ignore and batchMs");
  const extra = Object.keys(v).filter(k => !LANE_EVENT_KEYS.has(k));
  if (extra.length) throw new ConfigError(`laneEvents has unknown settings: ${extra.join(", ")}`);
  if (v.deliverTo !== undefined && v.deliverTo !== null && (typeof v.deliverTo !== "string" || !LANE_NAME.test(v.deliverTo))) {
    throw new ConfigError("laneEvents.deliverTo must be a lane name, or null to deliver lane events to no lane");
  }
  if (v.header !== undefined && (typeof v.header !== "string" || !HEADER.test(v.header))) {
    throw new ConfigError("laneEvents.header must be one line of 1 to 1000 characters");
  }
  if (v.batchMs !== undefined && (!Number.isInteger(v.batchMs) || (v.batchMs as number) < 100 || (v.batchMs as number) > 60_000)) {
    throw new ConfigError("laneEvents.batchMs must be a whole number of milliseconds from 100 to 60000");
  }
  return {
    deliverTo: v.deliverTo === undefined ? base.deliverTo : (v.deliverTo as string | null),
    header: v.header === undefined ? base.header : (v.header as string),
    ignore: v.ignore === undefined ? base.ignore : laneNames(v.ignore, "laneEvents.ignore"),
    batchMs: v.batchMs === undefined ? base.batchMs : (v.batchMs as number),
  };
}

// Each setting of laneWatch over its default: minutes from 1 to 1440 (a day), nudge true or false.
function laneWatch(v: unknown, base: LaneWatchConfig): LaneWatchConfig {
  if (!isObject(v)) throw new ConfigError("laneWatch must be an object with waitingMin, noStatusMin and nudge");
  const extra = Object.keys(v).filter(k => !LANE_WATCH_KEYS.has(k));
  if (extra.length) throw new ConfigError(`laneWatch has unknown settings: ${extra.join(", ")}`);
  for (const k of ["waitingMin", "noStatusMin"] as const) {
    if (v[k] !== undefined && (!Number.isInteger(v[k]) || (v[k] as number) < 1 || (v[k] as number) > 1440)) {
      throw new ConfigError(`laneWatch.${k} must be a whole number of minutes from 1 to 1440`);
    }
  }
  if (v.nudge !== undefined && typeof v.nudge !== "boolean") throw new ConfigError("laneWatch.nudge must be true or false");
  return {
    waitingMin: v.waitingMin === undefined ? base.waitingMin : (v.waitingMin as number),
    noStatusMin: v.noStatusMin === undefined ? base.noStatusMin : (v.noStatusMin as number),
    nudge: v.nudge === undefined ? base.nudge : (v.nudge as boolean),
  };
}

// The hub's public key, Ed25519's 32 raw bytes in base64 (base64url reads the same): absent means closed as today,
// so only its shape is checked here — what it opens is the authority's own check (§5.4).
function principalKey(v: unknown): string {
  if (typeof v !== "string" || v === "") throw new ConfigError("principalKey must be the hub's public key: 32 bytes, base64");
  const raw = Buffer.from(v, "base64");
  if (raw.length !== 32) throw new ConfigError(`principalKey must be 32 bytes, an Ed25519 public key, base64: this is ${raw.length}`);
  return v;
}

// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
export function loadConfig(o: { env?: NodeJS.ProcessEnv; home?: string } = {}): FleetConfig {
  const env = o.env ?? process.env;
  const home = o.home ?? homeOf(env);
  const file = configPath(env, home);
  const base = defaults(home);
  if (!existsSync(file)) return base;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (!isObject(raw)) throw new ConfigError(`${file} must hold a JSON object`);
  const unknown = Object.keys(raw).filter(k => !KEYS.has(k));
  if (unknown.length) throw new ConfigError(`${file} has unknown settings: ${unknown.join(", ")}`);
  let listen = base.listen;
  if (raw.listen !== undefined) {
    const l = raw.listen;
    if (!isObject(l) || typeof l.host !== "string" || l.host === "" || !Number.isInteger(l.port) || (l.port as number) < 0 || (l.port as number) > 65535) {
      throw new ConfigError("listen must be { host, port } with a port from 0 to 65535");
    }
    if (!LOOPBACK_HOST.test(l.host)) {
      throw new ConfigError(`listen.host must be a loopback address (127.0.0.1, ::1 or localhost); Tailscale Serve terminates TLS in front of it: ${JSON.stringify(l.host)}`);
    }
    listen = { host: l.host, port: l.port as number };
  }
  return {
    listen,
    socketPath: raw.socketPath === undefined ? base.socketPath : path(raw.socketPath, "socketPath", home),
    dbPath: raw.dbPath === undefined ? base.dbPath : path(raw.dbPath, "dbPath", home),
    keyPath: raw.keyPath === undefined ? base.keyPath : path(raw.keyPath, "keyPath", home),
    publicUrl: raw.publicUrl === undefined ? base.publicUrl : publicUrl(raw.publicUrl),
    subscribers: raw.subscribers === undefined ? base.subscribers : subscribers(raw.subscribers),
    stickyLanes: raw.stickyLanes === undefined ? base.stickyLanes : laneNames(raw.stickyLanes, "stickyLanes"),
    laneEvents: raw.laneEvents === undefined ? base.laneEvents : laneEvents(raw.laneEvents, base.laneEvents),
    laneWatch: raw.laneWatch === undefined ? base.laneWatch : laneWatch(raw.laneWatch, base.laneWatch),
    ...(raw.principalKey === undefined ? {} : { principalKey: principalKey(raw.principalKey) }),
  };
}
