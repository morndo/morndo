// GET /v1/files/<node>/<ref|path> (spec 5.6): a node's file streamed to the client, read through file.stat and then
// chunked file.get (at most LIMITS.chunkBytes per request, at most LIMITS.maxFileBytes in all). The node applies
// today's confinement rules (spec 3.1); a refusal before the first byte is an HTTP status with { ok: false, error:
// OpError }, a failure after it ends the response early (the client sees a truncated body, never a wrong one). A value
// that starts with "/" or "~" is a path; anything else is a relay file's ref.
import type { ServerResponse } from "node:http";
import { LIMITS, type ErrorCode, type OpError } from "@morndo/protocol";
import type { Router } from "../application/router.ts";

const STATUS: Partial<Record<ErrorCode, number>> = {
  bad_args: 400, denied: 403, too_large: 413, node_offline: 503, timeout: 504, uncertain: 502, internal: 502,
};

function refuse(res: ServerResponse, error: OpError) {
  res.writeHead(STATUS[error.code] ?? 404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error }));
}

const drained = (res: ServerResponse) => new Promise<void>(resolve => {
  const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
  res.once("drain", done);
  res.once("close", done);
});

export async function streamFile(res: ServerResponse, router: Router, node: string, refOrPath: string): Promise<void> {
  const sel = refOrPath.startsWith("/") || refOrPath.startsWith("~") ? { path: refOrPath } : { ref: refOrPath };
  const stat = await router.op({ node }, "file.stat", sel);
  if (!stat.ok) return refuse(res, stat.error);
  const { size } = stat.result as { size: number };
  res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-file-size": String(size) });
  for (let offset = 0; ;) {
    const got = await router.op({ node }, "file.get", { ...sel, offset, max: LIMITS.chunkBytes });
    if (res.destroyed) return;                                       // the client left
    if (!got.ok) { res.destroy(new Error(`file.get failed: ${got.error.code}`)); return; }
    const r = got.result as { bytes: string; eof: boolean };
    const chunk = Buffer.from(r.bytes, "base64");
    offset += chunk.length;
    if (offset > LIMITS.maxFileBytes) { res.destroy(new Error("file over the limit")); return; }
    if (offset > size) { res.destroy(new Error("file grew past its stat size")); return; }            // never more than x-file-size
    if (chunk.length > 0 && !res.write(chunk)) await drained(res);
    if (r.eof) {
      if (offset !== size) { res.destroy(new Error("file shrank: eof before its stat size")); return; }   // never a clean short body
      break;
    }
    if (chunk.length === 0) { res.destroy(new Error("file.get made no progress")); return; }
  }
  res.end();
}
