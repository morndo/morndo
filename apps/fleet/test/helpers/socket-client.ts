// A client of the fleet's Unix-socket API for tests: JSON requests, raw bodies (files) and the events WebSocket.
// ws connects over a Unix socket with a ws+unix: URL, "ws+unix:/absolute/path:/pathname"
// (https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-06).
import { request } from "node:http";
import { WebSocket } from "ws";
import { socketRequest } from "../../src/adapters/socket-request.ts";
import type { FleetEvent } from "../../src/application/events.ts";
import { parseFrame } from "./fake-agent.ts";
import { whenTrue } from "./when-true.ts";

export type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; complete: boolean };

export function client(socketPath: string, headers: Record<string, string> = {}) {
  return {
    get: (path: string) => socketRequest(socketPath, "GET", path, undefined, 3000, headers),
    post: (path: string, body?: unknown) => socketRequest(socketPath, "POST", path, body, 10_000, headers),
    raw: (path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Raw>((resolve, reject) => {
      const req = request({ socketPath, path, method: o.method ?? "GET", headers: o.headers ?? {} }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () => {});
        res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
      });
      req.on("error", reject);
      req.end(o.body);
    }),
    events: async (path = "/v1/events") => {
      const ws = new WebSocket(`ws+unix:${socketPath}:${path}`);
      const received: FleetEvent[] = [];
      const waiters = new Set<() => void>();
      ws.on("message", raw => {
        received.push(parseFrame<FleetEvent>(raw));
        for (const w of [...waiters]) w();
      });
      ws.on("error", () => {});
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("unexpected-response", (_q, r) => reject(new Error(`upgrade refused: ${r.statusCode}`))); });
      const when = (ready: () => boolean) => whenTrue(ready, fn => {
        waiters.add(fn);
        return () => { waiters.delete(fn); };
      });
      return { ws, received, when, close: () => ws.terminate() };
    },
  };
}
