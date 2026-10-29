// A scripted fleet for the agent's tests (spec §9, "real agent against a scripted fake fleet"): a real ws server on a
// random port with its own Ed25519 key. It runs join and the mutual handshake the way the fleet service does, records
// every message the agent sends, and does what `script` says; a test changes `script` between connections. Every
// message is decoded with the protocol's own schemas (AgentFrames): one that doesn't fit is recorded in `malformed` and
// the connection is closed (1008), so an agent message a real fleet would refuse fails the test that sent it.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentFrames, LIMITS, decodeValue, fleetSigPayload, formatJoinString, nodeSigPayload, type RolloutWire } from "@morndo/protocol";
import { wsText } from "../src/ws-text.ts";
import { whenTrue } from "../../fleet/test/helpers/when-true.ts";

export type Script = {
  join: "welcome" | number;                                   // the answer to `join`: welcome, or close with this code
  hello: "challenge" | number;                                // the answer to `hello`
  tamperSig: boolean;                                         // sign something other than the payload
  // After a good proof, or a close code. `controlPlane`, `rollout` and `offer` (updates §7) ride the welcome as
  // the fleet's own would; absent, they stay absent — a fleet from before the updates design says neither.
  welcome: {
    connEpoch: number; ackSeq: number; streamKnown: boolean;
    controlPlane?: { version: string; commit: string | null };
    rollout?: RolloutWire | null;
    offer?: { version: string; attempt: string } | null;
  } | number;
  // As a real fleet keeps them: the highest seq accepted per stream. When set, a welcome's ackSeq and streamKnown are
  // those of the hello's streamId (unknown: 0 and false) instead of `welcome`'s.
  streams: Record<string, number> | null;
  // As a real fleet keeps them (fleet.db store_seqs): the highest store sequence seen per store. When set, a welcome to a
  // hello whose streamId is listed carries it as storeSeqSeen.
  storeSeqs: Record<string, number> | null;
  // Sent on the same socket right after the next welcome, in the same tick (once: then cleared).
  afterWelcome: Msg[];
  pingMs: number | null;                                      // ping the agent this often after welcome
  autoAck: boolean;                                           // acknowledge every hook event at once
};
export type Msg = Record<string, unknown>;
export type Received = { conn: number; msg: Msg };

export type FakeFleet = {
  url: string;
  fleetKey: string;                                           // SPKI DER base64: what a join string pins
  script: Script;
  received: Received[];
  malformed: Received[];                                      // messages that don't fit the protocol's schemas
  closes: { conn: number; code: number }[];                   // each socket's close, as the fleet saw it
  pongs: number[];                                            // when each pong to the fleet's pings arrived (Date.now)
  connections(): number;                                      // sockets accepted so far
  trust(node: string, publicKeySpki: string): void;           // as if the node had joined
  joinString(node: string, code?: string): string;            // a join string with a fresh one-time code
  send(msg: Msg): void;                                       // to the newest socket
  closeAgent(code: number, reason?: string): void;
  terminateAgent(): void;
  live(): boolean;
  waitFor(pred: (m: Msg) => boolean, ms?: number, from?: number): Promise<Msg>;
  whenReady(ready: () => boolean): Promise<void>;
  close(): Promise<void>;
};

export async function startFakeFleet(over: Partial<Script> = {}): Promise<FakeFleet> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const fleetKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const script: Script = {
    join: "welcome", hello: "challenge", tamperSig: false, welcome: { connEpoch: 1, ackSeq: 0, streamKnown: false }, streams: null, storeSeqs: null,
    afterWelcome: [], pingMs: null, autoAck: false, ...over,
  };
  const received: Received[] = [];
  const malformed: Received[] = [];
  const closes: { conn: number; code: number }[] = [];
  const pongs: number[] = [];
  const codes = new Map<string, string>();                    // code → node
  const nodeKeys = new Map<string, KeyObject>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: LIMITS.maxPayload });
  await new Promise<void>(resolve => wss.once("listening", () => resolve()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let count = 0;
  let current: WebSocket | null = null;
  const listeners = new Set<() => void>();
  const out = (ws: WebSocket, msg: Msg) => ws.send(JSON.stringify({ v: 1, ...msg }));

  wss.on("connection", ws => {
    const conn = ++count;
    current = ws;
    let node = "";
    let nonce = "";
    let stream = "";
    let ping: NodeJS.Timeout | null = null;
    ws.on("close", code => { if (ping) clearInterval(ping); closes.push({ conn, code }); });
    ws.on("pong", () => { pongs.push(Date.now()); });
    ws.on("message", raw => {
      const msg = JSON.parse(wsText(raw)) as Msg;
      received.push({ conn, msg });
      for (const l of listeners) l();
      if (decodeValue(AgentFrames, msg).kind !== "ok") {
        malformed.push({ conn, msg });
        ws.close(1008, "malformed");
        return;
      }
      switch (msg.t) {
        case "join": {
          const named = codes.get(String(msg.code));
          if (typeof script.join === "number" || named === undefined || named !== msg.node) {   // unknown, used, or another name's code
            ws.close(typeof script.join === "number" ? script.join : 4403, "refused");
            return;
          }
          codes.delete(String(msg.code));
          nodeKeys.set(named, createPublicKey({ key: Buffer.from(String(msg.publicKey), "base64"), format: "der", type: "spki" }));
          out(ws, { t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });   // placeholder values (plan Contracts)
          ws.close(1000, "joined");
          return;
        }
        case "hello": {
          node = String(msg.node);
          stream = String(msg.streamId);
          if (typeof script.hello === "number") { ws.close(script.hello, "refused"); return; }
          nonce = randomBytes(32).toString("base64url");
          const payload = fleetSigPayload(node, String(msg.clientNonce));
          const fleetSig = sign(null, Buffer.from(script.tamperSig ? `${payload}x` : payload), privateKey).toString("base64");
          out(ws, { t: "challenge", nonce, fleetSig });
          return;
        }
        case "proof": {
          const key = nodeKeys.get(node);
          const good = key !== undefined && verify(null, Buffer.from(nodeSigPayload(node, nonce)), key, Buffer.from(String(msg.sig), "base64"));
          if (!good) { ws.close(4401, "bad proof"); return; }
          const w = script.welcome;
          if (typeof w === "number") { ws.close(w, "refused"); return; }
          const known = script.streams;
          const seen = script.storeSeqs?.[stream];
          out(ws, { t: "welcome", ...w, ...(known ? { ackSeq: known[stream] ?? 0, streamKnown: Object.hasOwn(known, stream) } : {}), ...(seen === undefined ? {} : { storeSeqSeen: seen }) });
          for (const m of script.afterWelcome.splice(0)) out(ws, m);
          if (script.pingMs !== null) ping = setInterval(() => ws.ping(), script.pingMs);
          return;
        }
        case "ev.hook": {
          const e = msg.event as { streamId: string; seq: number };
          if (script.autoAck) out(ws, { t: "ack", streamId: e.streamId, seq: e.seq });
          return;
        }
        default:
          return;
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/agent`,
    fleetKey,
    script,
    received,
    malformed,
    closes,
    pongs,
    connections: () => count,
    trust: (node, spki) => { nodeKeys.set(node, createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" })); },
    joinString: (node, code = randomBytes(16).toString("base64url")) => {
      codes.set(code, node);
      return formatJoinString({ url: `ws://127.0.0.1:${port}/agent`, fleetKey, code, node });
    },
    send: msg => { if (current) out(current, msg); },
    closeAgent: (code, reason = "") => current?.close(code, reason),
    terminateAgent: () => current?.terminate(),
    live: () => current !== null && current.readyState === current.OPEN,
    whenReady: ready => whenTrue(ready, fn => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }),
    waitFor: (pred, ms = 5000, from = 0) => new Promise((resolve, reject) => {
      const check = () => {
        const hit = received.slice(from).find(r => pred(r.msg));
        if (!hit) return false;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(hit.msg);
        return true;
      };
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("the fake fleet never received the expected message")); }, ms);
      if (!check()) listeners.add(check);
    }),
    close: () => new Promise<void>(resolve => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}
