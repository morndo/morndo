// The hook relay on 127.0.0.1:<relayPort> (8787; spec §5.5, ADR-0012 decision 8). Claude Code's HTTP hooks and the box's
// hook scripts POST here on every node, so settings.json is the same everywhere. Every answer goes out after the event
// is committed to the durable stream (spool.ts) and before any network I/O:
// - /cc and /sl (progress, coalesced to the latest per session): always 204 with no body, also when the spool can't be
//   written or the body is too big, because an HTTP hook's answer is read by Claude Code and a slow one stalls the
//   session (spec §1, hooks docs checked 2026-10-06);
// - /hook/stop: 200 {"ok":true,"queued":true}; /hook/failure, /notify and /file: 202; when the spool can't be written
//   they answer 503, so the calling script's own fallback runs;
// - /hook/stop that `ask` asks (status-ask.ts: the status ask, reliable lanes §3.1, or the waker ask, ADR-0032 W1): 200
//   {"decision":"block","reason":…}; the turn goes on, and its next Stop is the one that counts. The asked one, either
//   way, is spooled with `statusAsked: true` added to its body, so subscribers still get the answer it carried, and the
//   fleet makes no lane event of it;
// - /hook/stop or /hook/failure from a session that positively says it is headless (B6; window-of.ts foreignStop): the
//   Stop 200 {"ok":true,"queued":false}, the failure 202 (as a kept one, so the script's fallback stays off); neither is
//   spooled, never asked for a status; a lane's own and every unknown case go on as above;
// - /file {path, …}: the file is copied under today's confinement rules into relay-files and the event carries
//   {…, ref, name, size} instead of the path; 413 over 25 MiB, 403 where files are never shared, 404 when missing, 503
//   when the node's disk budget can't hold the copy (counted as a drop, like a spool that can't be written).
// A body is JSON when it parses, else kept as text. Bodies over 448 KiB are refused (413) or, for progress, dropped, so
// an event always fits one 512 KiB message. A request carrying an Origin header comes from a web page, never from a
// hook: the script paths refuse it (403) and progress drops it, so a page in the owner's browser can't post hooks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { Logger } from "../log.ts";
import type { RelayFiles } from "./relay-files.ts";
import { isProgress, type Appended, type Spool } from "./spool.ts";

export const HOOK_BODY_MAX = 448 * 1024;
const KEPT = new Set(["/hook/stop", "/hook/failure", "/notify", "/file"]);

export type RelayDeps = {
  port: number;
  host?: string;
  spool: Spool;
  files: RelayFiles;
  windowOf: (body: unknown) => string | null;
  ask?: (body: unknown, window: string | null) => string | null;
  // B6: a Stop or a StopFailure from a session that positively says it is headless, answered and dropped.
  foreign?: (body: unknown) => boolean;
  onAppended: () => void;
  log: Logger;
  now?: () => number;
};
export type Relay = { port: number; close(): Promise<void> };

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size <= max) chunks.push(b);
  }
  return size > max ? "too_large" : Buffer.concat(chunks);
}

function parse(raw: Buffer): unknown {
  const text = raw.toString("utf8");
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

const field = (body: unknown, name: string): unknown =>
  (body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined);

export async function startRelay(d: RelayDeps): Promise<Relay> {
  const now = d.now ?? Date.now;
  const after = () => setImmediate(d.onAppended);
  const answer = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => { res.writeHead(status, headers).end(); };

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (isProgress(path)) {
      const raw = req.headers.origin !== undefined ? "too_large" as const : await readBody(req, HOOK_BODY_MAX);
      const body = raw === "too_large" ? undefined : parse(raw);
      if (body === undefined || Buffer.byteLength(JSON.stringify(body)) > HOOK_BODY_MAX) d.spool.dropped();
      else {
        const session = field(body, "session_id");
        d.spool.append({ path: path as "/cc" | "/sl", at: now(), session: typeof session === "string" ? session : null, window: d.windowOf(body), body });
      }
      answer(res, 204);
      after();
      return;
    }
    if (!KEPT.has(path)) { answer(res, 404); return; }
    if (req.method !== "POST") { answer(res, 405, { Allow: "POST" }); return; }
    if (req.headers.origin !== undefined) { answer(res, 403); return; }
    const raw = await readBody(req, HOOK_BODY_MAX);
    if (raw === "too_large") { answer(res, 413); return; }
    let body = parse(raw);
    if (Buffer.byteLength(JSON.stringify(body)) > HOOK_BODY_MAX) { answer(res, 413); return; }
    if ((path === "/hook/stop" || path === "/hook/failure") && d.foreign?.(body)) {
      d.log.info("a Stop or a failure from a session that positively says it is headless is not a lane event: not passed on (B6)");
      if (path === "/hook/stop") res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"queued":false}');
      else answer(res, 202);                                        // 202, as a kept failure: the calling script's fallback stays off
      return;
    }
    const session = field(body, "session_id");
    const event = { path: path as "/hook/stop" | "/hook/failure" | "/notify" | "/file", at: now(), session: typeof session === "string" ? session : null, window: d.windowOf(body) };
    const asked = path === "/hook/stop" ? d.ask?.(body, event.window) ?? null : null;
    if (asked !== null) body = { ...(body as Record<string, unknown>), statusAsked: true };
    let appended: Appended;
    if (path === "/file") {
      const target = field(body, "path");
      if (typeof target !== "string" || !isAbsolute(target)) { answer(res, 400); return; }
      let copied: Awaited<ReturnType<RelayFiles["copy"]>>;
      try { copied = await d.files.copy(target); }
      catch (e) { d.log.warn("the relay could not copy a file", e); d.spool.dropped(); answer(res, 503); return; }
      if (!copied.ok) {
        if (copied.status === 503) d.spool.dropped();
        answer(res, copied.status);
        return;
      }
      const c = copied;
      const { path: _local, ...rest } = body as Record<string, unknown>;
      body = { ...rest, ref: c.ref, name: c.name, size: c.size };
      appended = d.spool.append({ ...event, body }, seq => d.files.record(c, seq));
      if (!appended.ok) d.files.discard(c.file);
    } else {
      appended = d.spool.append({ ...event, body });
    }
    if (!appended.ok) { answer(res, 503); return; }
    if (asked !== null) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ decision: "block", reason: asked }));
    else if (path === "/hook/stop") res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"queued":true}');
    else answer(res, 202);
    after();
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    handle(req, res, path).catch((e: unknown) => {
      d.log.error(`the hook relay failed on ${path.slice(0, 40)}`, e);
      if (!res.headersSent) answer(res, isProgress(path) ? 204 : 503);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(d.port, d.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : d.port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
