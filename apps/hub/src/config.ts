import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
  // MORNDO_REPO (B11): a local Morndo checkout the board reads merge ancestry from (`git merge-base --is-ancestor`),
  // kept current by the operator; the board never fetches. Unset or null: no checkout, every answer unknown, so a
  // merge in morndo/morndo holds done until the nodes' builds carry it.
  morndoRepo?: string | null;
  // Web push (ADR-0008 phase F): the contact the push services see in the VAPID token (RFC 8292 "sub"), and push
  // services a test runs besides the browsers' own (never in production).
  pushContact?: string;
  pushExtraOrigins?: string[];
};

const bool = (v: string | undefined) => v === "1" || v === "true";

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
    morndoRepo: env.MORNDO_REPO || null,
    // Not the hub's own address: the JWT travels in clear to the browser vendors' push services, and the origin would
    // name the private host (review L2). Set MORNDO_PUSH_CONTACT to give them a contact of your own; `serve` refuses
    // to start with one they wouldn't take (isPushContact).
    pushContact: env.MORNDO_PUSH_CONTACT || DEFAULT_PUSH_CONTACT,
    pushExtraOrigins: (env.MORNDO_PUSH_EXTRA_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean),
  };
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
