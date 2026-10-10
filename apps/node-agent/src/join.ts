// `morndo-node join '<join string>'` (spec §5.1), once per node:
// 1. the string is parsed whole (parseJoinString trims whitespace, a trailing newline and surrounding quotes);
// 2. a key pair is made in memory;
// 3. the fleet is asked to accept its public key with the one-time code, over a connection that closes after the
//    fleet's welcome;
// 4. only then are the private key (0600), a default policy.json (when there is none) and config.json written, each
//    atomically, config.json last: it is what makes the node joined.
// Any failure before step 4 (a truncated string, a plain ws:// URL to another machine, a bad fleet key, an unreachable
// fleet, a refused code) leaves nothing on disk, and says so. A fleet URL is wss://, or ws:// only to this machine
// (fleetUrlOk; parseJoinString already refuses any other): the agent never sends its key over a network in the clear.
import { existsSync, rmSync } from "node:fs";
import { WebSocket } from "ws";
import { CLOSE, LIMITS, NODE_NAME, Welcome, fleetUrlOk, parseBody, parseJoinString, type AgentMessage, type JoinString } from "@morndo/protocol";
import { writeFileAtomic } from "./atomic-write.ts";
import { DEFAULT_POLICY, RELAY_PORT, type StoredConfig } from "./config.ts";
import { createNodeKey, fleetPublicKey, type NodeKey } from "./identity.ts";
import { agentPaths } from "./paths.ts";
import { AGENT_VERSION, PROTO_VERSIONS } from "./version.ts";
import { wsText } from "./ws-text.ts";

export class JoinError extends Error {
  constructor(message: string) { super(message); this.name = "JoinError"; }
}

export type JoinOptions = { home: string; joinString: string; timeoutMs?: number };
export type Joined = { node: string; fleetUrl: string; configFile: string };

const NOTHING_WRITTEN = "Nothing was written.";

export async function join(o: JoinOptions): Promise<Joined> {
  const paths = agentPaths(o.home);
  if (existsSync(paths.configFile)) {
    throw new JoinError(`This machine already joined a fleet (${paths.configFile}). To join again, remove that file and ${paths.keyPath} first. ${NOTHING_WRITTEN}`);
  }
  const j = parseJoinString(o.joinString);
  if (!j) {
    throw new JoinError(`That is not a complete join string, or its fleet URL is plain ws:// to another machine (only wss://, or ws:// to this machine). Copy the whole line that \`morndo-fleet node add <name>\` printed (it starts with morndo-join:1:) and run this again. ${NOTHING_WRITTEN}`);
  }
  if (!NODE_NAME.test(j.node)) throw new JoinError(`The join string names the node ${JSON.stringify(j.node)}, which is not a valid node name. ${NOTHING_WRITTEN}`);
  if (!fleetUrlOk(j.url)) throw new JoinError(`The join string's fleet URL is plain ws:// to another machine: only wss://, or ws:// to this machine. ${NOTHING_WRITTEN}`);
  if (!fleetPublicKey(j.fleetKey)) throw new JoinError(`The join string's fleet key is not an Ed25519 public key. ${NOTHING_WRITTEN}`);

  const key = createNodeKey();
  await askFleet(j, key, o.timeoutMs ?? 15_000);

  const policyExisted = existsSync(paths.policyFile);
  const stored: StoredConfig = { node: j.node, fleetUrl: j.url, fleetKey: j.fleetKey, keyPath: paths.keyPath, dbPath: paths.dbPath, relayPort: RELAY_PORT };
  try {
    writeFileAtomic(paths.keyPath, key.pem(), 0o600);
    if (!policyExisted) writeFileAtomic(paths.policyFile, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, 0o600);
    writeFileAtomic(paths.configFile, `${JSON.stringify(stored, null, 2)}\n`, 0o600);
  } catch (e) {
    rmSync(paths.keyPath, { force: true });
    if (!policyExisted) rmSync(paths.policyFile, { force: true });
    throw new JoinError(`The fleet accepted this node, but its files could not be written (${(e as Error).message}). The code is used up: ask for a new one with \`morndo-fleet node add ${j.node}\`.`);
  }
  return { node: j.node, fleetUrl: j.url, configFile: paths.configFile };
}

// One connection: `join`, then the fleet's welcome (accepted) or a close code (refused).
function askFleet(j: JoinString, key: NodeKey, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(j.url, { maxPayload: LIMITS.maxPayload, handshakeTimeout: timeoutMs });
    let settled = false;
    let cause = "";
    const finish = (error: JoinError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new JoinError(`The fleet at ${j.url} did not answer within ${Math.round(timeoutMs / 1000)} s. ${NOTHING_WRITTEN}`));
      ws.terminate();
    }, timeoutMs);
    ws.on("open", () => {
      const msg: AgentMessage = { v: 1, t: "join", node: j.node, code: j.code, publicKey: key.publicKey, agent: { version: AGENT_VERSION }, proto: PROTO_VERSIONS };
      ws.send(JSON.stringify(msg));
    });
    ws.on("message", raw => {
      let value: unknown = null;
      try { value = JSON.parse(wsText(raw)); } catch { /* not JSON: refused below */ }
      if (parseBody(Welcome, value)) {
        finish(null);
        ws.close(1000, "joined");
      } else {
        finish(new JoinError(`The fleet answered something this agent does not understand. ${NOTHING_WRITTEN}`));
        ws.close(1002, "unexpected message");
      }
    });
    ws.on("error", e => { cause = (e as NodeJS.ErrnoException).code ?? e.message; });
    ws.on("close", code => {
      if (code === CLOSE.forbidden) {
        finish(new JoinError(`The fleet refused the code: it is unknown, expired (codes last 10 minutes) or already used. Ask for a new one with \`morndo-fleet node add ${j.node}\`. ${NOTHING_WRITTEN}`));
      } else if (code === CLOSE.unsupported) {
        finish(new JoinError(`The fleet does not speak this agent's protocol (versions ${PROTO_VERSIONS.join(", ")}). Update morndo-node or the fleet. ${NOTHING_WRITTEN}`));
      } else {
        finish(new JoinError(`Could not reach the fleet at ${j.url}${cause ? ` (${cause})` : ` (closed with ${code})`}. ${NOTHING_WRITTEN}`));
      }
    });
  });
}
