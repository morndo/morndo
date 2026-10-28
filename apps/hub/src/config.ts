import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MORNDO_REPO, REPO_NAME, DECISION_SETTLE_MS, WORKER_ASK_GRACE_MS, type ProofMode } from "@morndo/domain";

export type Config = {
  dataDir: string;
  port: number;
  origin: string;                  // what the browser shows in its address bar, e.g. https://host.example:8443
  rpId: string;                    // passkey relying party: the origin's host name
  rpName: string;
  requireProxyIdentity: boolean;   // refuse requests the private-network proxy didn't vouch for
  principalLogin: string | null;   // if set, the proxy's identity header must equal it
  tmuxSocket: string | null;       // tmux -L <name>; null = the default server
  tmuxSession: string | null;      // only this session's panes; null = all
  claudeDir: string | null;        // Claude Code's config dir (sessions, transcripts); null = don't read conversations
  webDir: string;
  officeName: string | null;       // the workspace name the app shows; default: the machine's host name
  pollMs: number;
  quietAfterMs: number;
  managerWindow: string;           // the window name of the manager's pane
  ledgerPath: string | null;       // the manager's needs-you list (JSON), read-only; null = no list
  // MORNDO_POOL_USAGE: the pool's usage file (JSON Lines), read-only, the one source of an account's label parts
  // (ADR-0034); unset or empty: none, every account shows its name alone.
  poolUsageFile?: string | null;
  paneLock: string | null;         // a lock file the box's other typists into the manager's pane take (flock); null = none
  vnc: { host: string; port: number; passwordFile: string } | null;   // the office's desktop (VNC); null = no Desktop tab
  enginesBin?: string | null;      // the engine layer's CLI (engine-layer bin/engines, ADR-0013); null = no Engines page
  filesDir: string;                // the hub's copies of files sent in conversations
  inboxDir: string;                // images the principal pastes, for workers to open (outside the data directory)
  // MORNDO_FLEET_SOCKET: the fleet service's client socket (ADR-0012, spec §5.6), an absolute path. Absent or null: the
  // legacy local adapters, this machine's tmux and Claude Code directly (spec §10).
  fleetSocket?: string | null;
  // MORNDO_MANAGER_QUEUE (fleet-clients §9.1): the manager's answers and messages through the fleet's delivery queue. On
  // by default with a fleet; "off" or "0" types them directly, as before (step 2's rollback, §13). Never without a fleet.
  managerQueue?: boolean;
  // MORNDO_ENGINE_SESSIONS: the engine-lane registry directory on this machine. Unset, empty, `0` or `off`: the hub
  // does not read it. MORNDO_ENGINE_NODE: this machine's fleet node name; required when a fleet is in use.
  engineSessions?: string | null;
  engineNode?: string | null;
  // MORNDO_CONTROL_PLANE_NODE: the fleet node name of the node agent that runs beside the hub on the control plane's own
  // machine (not MORNDO_ENGINE_NODE, which names where the engine lanes run, and may be another machine). The Updates
  // page folds that node into This machine. Trimmed and lower-cased (the fleet's node names are [a-z0-9-]{1,32}, compared
  // as written). Unset or empty: no node is folded in.
  controlPlaneNode?: string | null;
  // MORNDO_REPO (B11): a local Morndo checkout the board reads merge ancestry from (`git merge-base --is-ancestor`),
  // kept current by the operator; the board never fetches. Unset or null: no checkout, every answer unknown, so a
  // merge in morndo/morndo holds done until the nodes' builds carry it.
  morndoRepo?: string | null;
  // Web push (ADR-0008 phase F): the contact the push services see in the VAPID token (RFC 8292 "sub"), and push
  // services a test runs besides the browsers' own (never in production).
  pushContact?: string;
  pushExtraOrigins?: string[];
  // MORNDO_WORKER_ASK_GRACE_MS: how long a worker's question or menu waits before it is the principal's Ask (N2), for
  // tests only (the e2e offices); the default is WORKER_ASK_GRACE_MS (10 minutes). Never an app setting.
  workerAskGraceMs?: number;
  // MORNDO_DECISION_SETTLE_MS: how long a Decision waits, unbroken, before it raises its Notification (N2), for tests
  // only (the e2e offices); the default is DECISION_SETTLE_MS (a minute). Never an app setting.
  decisionSettleMs?: number;
  // MORNDO_USAGE_READINGS_GATE: a usage reading from a plain worker token. "warn" (default) accepts it and counts it
  // on the token; "enforce" refuses it. Unset or empty is warn.
  usageReadingsGate?: "warn" | "enforce";
  // MORNDO_PROOF_GATE (ADR-0035 step 3): the Done gate's mode — off, warn (the default) or on (a Done with a reference
  // that is not green is held). MORNDO_PROOF_REPOS: the repositories the hub's proof checks may read, owner/repository
  // names; a repository not on the list is never asked, so a lane cannot aim the credential at work of its own choosing.
  proofGate?: ProofMode;
  proofRepos?: string[];
  // MORNDO_GITHUB_TOKEN_FILE: an absolute path to a file holding a read-only forge token (adapters/token-file.ts reads
  // it at start; the token is never a setting). Optional: without it only public repositories answer, the
  // unauthenticated limit is 60 requests an hour, and a private repository's references read "not checked".
  githubTokenFile?: string | null;
  // MORNDO_FORGE_URL: a stand-in forge base (http(s) origin only), for tests and a scratch hub — never with a token.
  forgeUrl?: string | null;
};

const bool = (v: string | undefined) => v === "1" || v === "true";

// MORNDO_WORKER_ASK_GRACE_MS (tests only): a string of digits only — so "0" is accepted, and the grace is off — is that
// many milliseconds; anything else (unset, empty, negative, decimals, text) is the default, WORKER_ASK_GRACE_MS.
const graceOf = (v: string | undefined) => (/^\d+$/.test(v ?? "") ? Number(v) : WORKER_ASK_GRACE_MS);
// MORNDO_DECISION_SETTLE_MS (tests only): read as graceOf reads its variable; anything else is DECISION_SETTLE_MS.
const settleOf = (v: string | undefined) => (/^\d+$/.test(v ?? "") ? Number(v) : DECISION_SETTLE_MS);

// MORNDO_USAGE_READINGS_GATE: unset or empty is warn. A word that is neither warn nor enforce is refused — a typo must
// not leave the gate open.
const readingsGate = (v: string | undefined): "warn" | "enforce" => {
  if (v === undefined || v === "") return "warn";
  if (v === "warn" || v === "enforce") return v;
  throw new Error("MORNDO_USAGE_READINGS_GATE must be one of: warn, enforce");
};

// The contact a push service sees in the VAPID token (RFC 8292 section 2.1: a mailto or https URI). The project's own
// address by default, never the hub's.
export const DEFAULT_PUSH_CONTACT = "https://morndo.com";

// Special-use names can't hold a contact (RFC 6761 and its registry; .local is RFC 6762). Apple's push service refuses a
// token whose contact sits on one with 403 BadJwtToken: seen on 2026-10-03 for .invalid, .test and https://localhost,
// while morndo.com and example.com were accepted. The other names are refused here by the same rule, not by observation.
const SPECIAL_USE = /(^|\.)(invalid|test|example|localhost|local|onion|internal|alt|home\.arpa)$/;
// A host name: two or more labels of letters, digits and hyphens, none empty, none starting or ending with a hyphen.
const HOST_NAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// Whether a push service can take `v` as the contact: `https://host…` or `mailto:name@host`, exactly as written. The
// value goes into the token as it is, so it is printable ASCII only (no spaces, no hidden characters, no backslash),
// with no login and no query on a mail address, on a host that is a name of more than one label, not an address, and
// not a special-use one.
export function isPushContact(v: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(v) || v.includes("\\")) return false;
  let host: string;
  const mail = /^mailto:[^@:?]+@([A-Za-z0-9.-]+)$/.exec(v);
  if (mail) host = mail[1] ?? "";
  else {
    if (!v.startsWith("https://") || (v.slice(8).split(/[/?#]/)[0] ?? "").includes("@")) return false;
    try { host = new URL(v).hostname; } catch { return false; }
  }
  host = host.toLowerCase();
  return HOST_NAME.test(host) && !/^[\d.]+$/.test(host) && !SPECIAL_USE.test(host);
}

// The hub's data directory (morndo.db and the rest): MORNDO_HOME, else ~/.local/share/morndo. The console commands that
// open the hub's database without its other settings (`morndo lanes start --task`) find it here too.
export const dataDirOf = (env: NodeJS.ProcessEnv = process.env): string => env.MORNDO_HOME ?? join(homedir(), ".local/share/morndo");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.MORNDO_PORT ?? 8790);
  const origin = (env.MORNDO_ORIGIN ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`MORNDO_ORIGIN must be https (or http://localhost for development): ${origin}`);
  }
  return {
    dataDir: dataDirOf(env),
    port,
    origin,
    rpId: url.hostname,
    rpName: "Morndo",
    requireProxyIdentity: bool(env.MORNDO_REQUIRE_PROXY_IDENTITY),
    principalLogin: env.MORNDO_PRINCIPAL_LOGIN || null,
    tmuxSocket: env.MORNDO_TMUX_SOCKET || null,
    tmuxSession: env.MORNDO_TMUX_SESSION || null,
    // Pane IDs repeat across tmux servers, so a private server (-L) never reads the real Claude sessions by default:
    // only an explicit MORNDO_CLAUDE_DIR is used then.
    claudeDir: env.MORNDO_CLAUDE_DIR === "off" ? null
      : env.MORNDO_CLAUDE_DIR || (env.MORNDO_TMUX_SOCKET ? null : env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")),
    webDir: env.MORNDO_WEB_DIR ?? join(import.meta.dirname, "../../web/build"),
    officeName: env.MORNDO_OFFICE_NAME || null,
    pollMs: Number(env.MORNDO_POLL_MS ?? 1500),
    quietAfterMs: Number(env.MORNDO_QUIET_AFTER_MS ?? 15_000),
    managerWindow: env.MORNDO_MANAGER_WINDOW || "manager",
    ledgerPath: env.MORNDO_LEDGER || null,
    poolUsageFile: env.MORNDO_POOL_USAGE || null,
    paneLock: env.MORNDO_PANE_LOCK || null,
    vnc: vncTarget(env),
    // The engine layer's CLI, by path (it isn't on the box's PATH): its own ENGINES_CONFIG and ENGINES_STATE pass through.
    enginesBin: env.MORNDO_ENGINES || null,
    filesDir: env.MORNDO_FILES_DIR || join(env.MORNDO_HOME ?? join(homedir(), ".local/share/morndo"), "files"),
    inboxDir: env.MORNDO_INBOX || join(homedir(), ".cache/morndo/inbox"),
    fleetSocket: fleetSocket(env),
    managerQueue: fleetSocket(env) !== null && !/^(off|0)$/i.test(env.MORNDO_MANAGER_QUEUE ?? ""),
    engineSessions: engineSessions(env),
    engineNode: env.MORNDO_ENGINE_NODE || null,
    controlPlaneNode: env.MORNDO_CONTROL_PLANE_NODE?.trim().toLowerCase() || null,
    morndoRepo: env.MORNDO_REPO || null,
    // Not the hub's own address: the JWT travels in clear to the browser vendors' push services, and the origin would
    // name the private host (review L2). Set MORNDO_PUSH_CONTACT to give them a contact of your own; `serve` refuses
    // to start with one they wouldn't take (isPushContact).
    pushContact: env.MORNDO_PUSH_CONTACT || DEFAULT_PUSH_CONTACT,
    pushExtraOrigins: (env.MORNDO_PUSH_EXTRA_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean),
    workerAskGraceMs: graceOf(env.MORNDO_WORKER_ASK_GRACE_MS),
    decisionSettleMs: settleOf(env.MORNDO_DECISION_SETTLE_MS),
    usageReadingsGate: readingsGate(env.MORNDO_USAGE_READINGS_GATE),
    proofGate: proofGateOf(env),
    proofRepos: proofReposOf(env),
    githubTokenFile: tokenFileOf(env),
    forgeUrl: forgeUrlChecked(env),
  };
}

// MORNDO_PROOF_GATE: off, warn (the default) or on — anything else is refused in one sentence that says the three.
function proofGateOf(env: NodeJS.ProcessEnv): ProofMode {
  const v = env.MORNDO_PROOF_GATE;
  if (v === undefined || v === "") return "warn";
  if (v !== "off" && v !== "warn" && v !== "on")
    throw new Error(`MORNDO_PROOF_GATE must be off, warn or on: ${v}`);
  return v;
}

// A stand-in forge with the gate on would judge Dones on answers that are not GitHub's: refused, unless the hub is declared
// a scratch hub (MORNDO_SCRATCH_HUB=1: an end-to-end office or a QA hub, never the real board).
function forgeUrlChecked(env: NodeJS.ProcessEnv): string | null {
  const url = forgeUrlOf(env);
  if (url !== null && proofGateOf(env) === "on" && env.MORNDO_SCRATCH_HUB !== "1")
    throw new Error("MORNDO_FORGE_URL names a stand-in forge and cannot be used with MORNDO_PROOF_GATE=on: a Done would be judged on answers that are not GitHub's (a scratch hub that is not the real board says so with MORNDO_SCRATCH_HUB=1)");
  return url;
}

// The sentence the hub logs at start when its references are read from a stand-in forge (MORNDO_FORGE_URL): what it
// reads is not GitHub, so nobody mistakes a scratch hub's green for a real one.
export function standInNotice(config: Config): string | null {
  return config.forgeUrl ? `MORNDO_FORGE_URL names a stand-in forge (${config.forgeUrl}): proof references are read from it, not from GitHub` : null;
}

// MORNDO_FORGE_URL: unset or empty is none; otherwise an http(s) origin with no path beyond "/" and no credentials.
function forgeUrlOf(env: NodeJS.ProcessEnv): string | null {
  const v = env.MORNDO_FORGE_URL;
  if (v === undefined || v === "") return null;
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`MORNDO_FORGE_URL must be an http(s) URL: ${v}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error(`MORNDO_FORGE_URL must be an http(s) URL: ${v}`);
  if (u.username || u.password)
    throw new Error(`MORNDO_FORGE_URL must not include credentials: ${v}`);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/")
    throw new Error(`MORNDO_FORGE_URL must be a bare origin with no path: ${v}`);
  const token = tokenFileOf(env);
  if (token !== null)
    throw new Error("MORNDO_FORGE_URL names a stand-in forge and cannot be used with MORNDO_GITHUB_TOKEN_FILE: the token would be sent to it");
  return u.origin;
}

// MORNDO_GITHUB_TOKEN_FILE: unset or empty is none; otherwise an absolute path (a relative one would depend on where the
// hub was started).
function tokenFileOf(env: NodeJS.ProcessEnv): string | null {
  const v = env.MORNDO_GITHUB_TOKEN_FILE;
  if (v === undefined || v === "") return null;
  if (!isAbsolute(v)) throw new Error(`MORNDO_GITHUB_TOKEN_FILE must be an absolute path: ${v}`);
  return v;
}

// MORNDO_PROOF_REPOS: owner/repository names, comma-separated; unset or empty is the default, the project's own. Each
// name must be whole (owner/repo), so one that is not never passes as a checkable repository.
function proofReposOf(env: NodeJS.ProcessEnv): string[] {
  const v = env.MORNDO_PROOF_REPOS;
  if (v === undefined || v.trim() === "") return [MORNDO_REPO];
  const repos = v.split(",").map(s => s.trim()).filter(Boolean);
  for (const r of repos)
    if (!REPO_NAME.test(r))
      throw new Error(`MORNDO_PROOF_REPOS must be owner/repository names, like ${MORNDO_REPO}: ${r}`);
  return repos;
}

// MORNDO_VNC=host:port names the desktop's VNC server; its password comes from MORNDO_VNC_PASSWORD_FILE (default the
// vncpasswd file in ~/.vnc). Off unless named.
function vncTarget(env: NodeJS.ProcessEnv): Config["vnc"] {
  const m = /^([\w.:-]+):(\d{1,5})$/.exec(env.MORNDO_VNC ?? "");
  if (!m) return null;
  return { host: m[1] ?? "127.0.0.1", port: Number(m[2]), passwordFile: env.MORNDO_VNC_PASSWORD_FILE || join(homedir(), ".vnc/passwd") };
}

// MORNDO_FLEET_SOCKET, when set: an absolute path, since ws's IPC URL names the socket by it ("ws+unix:/absolute/path/to/
// uds_socket:/pathname", https://github.com/websockets/ws/blob/master/doc/ws.md#ipc-connections, read 2026-10-06), and a
// relative one would depend on where the service happened to start. Read here as it is: `serve` refuses one that isn't
// (fleetSocketOk) in one sentence with exit 78, and the console commands still work to put it right (Task 14c review:
// a throw here stopped every one of them with a stack trace).
function fleetSocket(env: NodeJS.ProcessEnv): string | null {
  return env.MORNDO_FLEET_SOCKET || null;
}

// Unset, empty, `0` or `off`: the feature is off and no reader is wired.
function engineSessions(env: NodeJS.ProcessEnv): string | null {
  const v = env.MORNDO_ENGINE_SESSIONS;
  if (v === undefined || v === "" || v === "0" || v === "off") return null;
  return v;
}
// A relative path would be read against wherever the service started (the same reason as MORNDO_FLEET_SOCKET).
// `serve` refuses one; reading it here never throws, so the console commands still work.
export const engineSessionsOk = (v: string) => isAbsolute(v);
export const fleetSocketOk = (v: string) => isAbsolute(v);
export const morndoRepoOk = (v: string) => isAbsolute(v);
