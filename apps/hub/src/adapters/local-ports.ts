// The hub's ports in legacy single-host mode (fleet core §10): this machine's tmux and Claude Code as the one node
// "local" (local-node.ts), as one set. main.ts takes these unless MORNDO_FLEET_SOCKET names a fleet (fleet-adapters.ts).
// No fleet means nobody to ask about a send in doubt (sendStatus) or about which nodes answer (nodeStates).
import { sessionRegistry, terminalAdapter, tmuxAdapter } from "@morndo/node-ops";
import type { HubPorts } from "../application/ports.ts";
import type { Config } from "../config.ts";
import type { Files } from "./files.ts";
import { localFiles, localSessions, localTmux, localTranscripts, localUploads } from "./local-node.ts";
import { readVncPassword, type DesktopTarget } from "./rfb.ts";

export function legacyPorts(config: Config, deps: { files: Pick<Files, "register"> }): HubPorts {
  const registry = config.claudeDir ? sessionRegistry(config.claudeDir) : null;
  return {
    tmux: localTmux(tmuxAdapter({ socket: config.tmuxSocket, session: config.tmuxSession })),
    terminal: terminalAdapter({ socket: config.tmuxSocket }),
    sessions: registry ? localSessions(registry) : null,
    transcripts: registry ? localTranscripts(registry) : null,
    files: localFiles(deps.files),
    uploads: localUploads(),
    sendStatus: null,
    nodeStates: null,
  };
}

// The office's desktop (VNC) for the remote view: the one MORNDO_VNC names, which this hub connects to itself, with or
// without a fleet. One machine holding both roles (fleet core §2) is the node whose desktop that is, so the fleet changes
// nothing about it (§16.1: the rollout to the PC kept its Desktop tab). Without MORNDO_VNC there is none, so the route
// answers no_desktop and the app shows no Desktop tab; a control plane apart from its nodes leaves it unset until the
// desktop op exists (§11). The password is read for each connection, so a changed vncpasswd file applies without a
// restart.
export function desktopTarget(config: Config): () => DesktopTarget | null {
  return () => {
    if (!config.vnc) return null;
    let password: string | null = null;
    try { password = readVncPassword(config.vnc.passwordFile); } catch { /* no password file: the server must allow None */ }
    return { host: config.vnc.host, port: config.vnc.port, password };
  };
}
