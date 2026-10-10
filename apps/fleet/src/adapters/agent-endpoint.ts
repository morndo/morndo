// The agent endpoint, ws://<listen>/agent (spec 5): an HTTP server that takes only WebSocket upgrades on /agent.
// `ws` in noServer mode with the upgrade handled here, and maxPayload of LIMITS.maxPayload on every connection
// (https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-06). Authentication happens inside the
// connection (agent-session.ts), since a node proves its key by signing the fleet's challenge.
// Where a node connects from: the TCP peer, or, when the peer is this machine (Tailscale Serve proxies the tailnet to
// localhost), the X-Forwarded-For that Serve sets to the tailnet source address with Header.Set
// (tailscale/tailscale ipn/ipnlocal/serve.go, addProxyForwardedHeaders, read 2026-10-06).
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS } from "@morndo/protocol";
import { RateLimiter, type BucketConfig } from "./rate-limit.ts";
import { HANDSHAKE_MS, runSession, type SessionDeps } from "./agent-session.ts";

// Per node, for inventory and health (hook events and results are exempt): inventory comes at most every 2 s and
// health every 30 s, so 60 at once and 2 a second leave room for a reconnect's full inventory and any burst.
export const AGENT_MESSAGES: BucketConfig = { capacity: 60, refillPerSecond: 2 };
// Per source address, joins and hellos together, before any key work (plan Contracts, "Instances"): an agent dials at
// most every second after a failure, backing off to a minute, so 10 at once and one more every 6 s never refuse one.
export const HANDSHAKES: BucketConfig = { capacity: LIMITS.handshakeBurst, refillPerSecond: 1000 / LIMITS.handshakeRefillMs };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function sourceOf(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } }): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (LOOPBACK.has(peer) && typeof forwarded === "string" && forwarded.trim() !== "") return forwarded.split(",")[0]?.trim() ?? peer;
  return peer;
}

export type AgentEndpoint = { ready: Promise<void>; port(): number; close(): Promise<void> };

export function startAgentEndpoint(p: {
  host: string; port: number; deps: Omit<SessionDeps, "limiter" | "handshakes" | "handshakeMs" | "source">; limits?: BucketConfig;
  handshakeLimits?: BucketConfig; handshakeMs?: number;
}): AgentEndpoint {
  const limiter = new RateLimiter(p.limits ?? AGENT_MESSAGES);
  const bucket = new RateLimiter(p.handshakeLimits ?? HANDSHAKES);
  const warned = new Set<string>();                      // sources told about once, until their bucket lets one through
  const handshakes = {
    take: (source: string) => {
      if (bucket.take(source)) { warned.delete(source); return true; }
      if (!warned.has(source)) { warned.add(source); p.deps.log.warn(`agent endpoint: too many joins or hellos from ${source}; closing them with 1013`); }
      return false;
    },
  };
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
    res.end("the agent endpoint takes WebSocket connections at /agent\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });
  const sockets = new Set<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    let path: string;
    try { path = new URL(req.url ?? "/", "http://fleet").pathname; } catch { path = ""; }
    if (path !== "/agent") { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const source = sourceOf(req);
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      runSession(ws, { ...p.deps, limiter, handshakes, handshakeMs: p.handshakeMs ?? HANDSHAKE_MS, source });
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(p.port, p.host);
  return {
    ready,
    port: () => (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
