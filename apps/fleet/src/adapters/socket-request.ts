// One JSON request to the running fleet service over its Unix socket (node:http `socketPath`,
// https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06). The console uses it
// to reach the service; null means nothing answered there (no socket, nobody listening, or no answer in time).
import { request } from "node:http";

export type SocketAnswer = { status: number; body: unknown };

export function socketRequest(socketPath: string, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<SocketAnswer | null> {
  return new Promise(resolve => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      socketPath, method, path, timeout: timeoutMs,
      headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", () => resolve(null));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON: the text as it is */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(payload);
  });
}
