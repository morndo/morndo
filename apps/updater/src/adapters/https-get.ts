// One HTTPS fetch with a body cap, a redirect budget, an idle timeout and a total deadline: the piece the feed and
// the artifact adapters share (design §4.6), and how §10.2 step 5 reads — "Every download is capped before it
// starts" (the TUF endless-data note [U3]). The idle timeout alone measures silence, never progress, so every fetch
// also gets a wall of its own (`deadlineMs`): a host that dribbles one byte inside every idle window still meets it,
// and cannot hold the caller — the apply lock included (RL4) — as long as it likes. Node's own certificate checks
// always apply; `ca` is how the tests point the client at their throwaway authority ("If specified, the default list
// would be completely replaced", Node 24 tls.createSecureContext, https://nodejs.org/docs/latest-v24.x/api/tls.html,
// read 2026-10-21). Redirects are followed by hand — Node follows none — up to five hops and only to another https:
// URL: a GitHub release download lands on a second host, and nothing may fall back to cleartext. The result reports
// what the wire did (`overLimit`, `cut`) without judging it: whether any byte is trusted is the signature chain's
// decision, never the transport's.
import { request } from "node:https";
import type { Writable } from "node:stream";
import { FetchFailed } from "../application/ports.ts";

// GitHub's own download redirect is one hop; five leaves room for a CDN in front of a mirror.
const MAX_HOPS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// A 404 is kept apart from every other status (§4.6: keySet's "not published") — hence a union, not an error.
export type HttpsGet =
  | { status: 404 }
  | { status: 200; bytes?: Uint8Array; size: number; overLimit: boolean; cut: boolean };
export type HttpsGetOptions = { ca?: string; maxBytes: number; timeoutMs: number; deadlineMs: number; sink?: Writable };

export function httpsGet(url: string | URL, o: HttpsGetOptions): Promise<HttpsGet> {
  const askedFor = url instanceof URL ? url : new URL(url);
  return hop(askedFor, o, 0, Date.now() + o.deadlineMs, askedFor);
}

async function hop(url: URL, o: HttpsGetOptions, hops: number, deadlineAt: number, askedFor: URL): Promise<HttpsGet> {
  if (url.protocol !== "https:") throw new FetchFailed("network", `not an https: URL: ${url.href}`);
  if (hops > MAX_HOPS) throw new FetchFailed("network", `more than ${MAX_HOPS} redirects`);
  const answer = await once(url, o, deadlineAt, askedFor);
  return "redirect" in answer ? hop(new URL(answer.redirect, url), o, hops + 1, deadlineAt, askedFor) : answer;
}

// One request/response exchange. `done` holds the first answer, ours or the wire's; `finish` exists only once a 200's
// body has begun, and marks the point past which a socket death is `cut` (a fact to report) instead of a refusal.
// `deadlineAt` is the whole fetch's one wall — every redirect hop shares it, so a host that answers one byte inside
// every idle window (moving, never silent) still meets an end it cannot dribble past.
function once(url: URL, o: HttpsGetOptions, deadlineAt: number, askedFor: URL): Promise<HttpsGet | { redirect: string }> {
  return new Promise((resolve, reject) => {
    let done = false;
    let fail: FetchFailed | null = null;                 // what the timeout decided, so it wins over the destroy it causes
    let finish: ((cut: boolean) => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const expired = (): FetchFailed =>
      new FetchFailed("timeout", `${askedFor.href}: no complete answer within ${o.deadlineMs} ms`);
    const left = deadlineAt - Date.now();
    if (left <= 0) { reject(expired()); return; }        // a redirect already spent the whole wall: no next hop starts
    // Every settle stops the deadline's clock with the promise's: a timer left running would outlive its request.
    const stopDeadline = (): void => { if (deadline !== null) clearTimeout(deadline); };
    const answer = (r: HttpsGet | { redirect: string }): void => { stopDeadline(); resolve(r); };
    const refusal = (e: FetchFailed): void => { stopDeadline(); done = true; reject(e); };

    const req = request(url, o.ca === undefined ? {} : { ca: o.ca }, res => {
      // Attached before anything can destroy the transfer, so no response event is ever unhandled.
      res.on("error", () => {
        if (done) return;
        if (finish !== null) finish(true);
        else refusal(new FetchFailed("network", `${url.href}: the response broke off`));
      });
      res.on("close", () => { if (!done && finish !== null) finish(!res.complete); });

      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        done = true;
        const location = res.headers.location;
        if (typeof location !== "string" || location === "") {
          refusal(new FetchFailed("network", `${status} from ${url.href} without a Location`));
          return;
        }
        req.destroy();
        answer({ redirect: location });
        return;
      }
      if (status === 404) { done = true; req.destroy(); answer({ status: 404 }); return; }
      if (status !== 200) { done = true; req.destroy(); refusal(new FetchFailed("status", `HTTP ${status} from ${url.href}`)); return; }

      // A content-length alone over the cap: refuse before the first byte is read (§10.2 step 5).
      const header = res.headers["content-length"];
      const declared = Number(Array.isArray(header) ? header[0] : header);
      if (Number.isFinite(declared) && declared > o.maxBytes) {
        done = true;
        answer({ status: 200, ...(o.sink === undefined ? { bytes: new Uint8Array(0) } : {}), size: 0, overLimit: true, cut: false });
        req.destroy();
        return;
      }

      let size = 0;
      let overLimit = false;
      const chunks: Buffer[] = [];

      // The body's one answer, also reachable from the socket-level handlers above through `finish`.
      const settle = (cut: boolean) => {
        if (done) return;
        done = true;
        // A plain Uint8Array, not a Buffer: the port says bytes are bytes, and no caller should depend on which
        // of Node's views of them the transport happened to hand out.
        answer({ status: 200, ...(o.sink === undefined ? { bytes: new Uint8Array(Buffer.concat(chunks)) } : {}), size, overLimit, cut });
      };
      finish = settle;

      res.on("data", (chunk: Buffer) => {
        const room = o.maxBytes - size;
        if (chunk.length > room) overLimit = true;       // the server had more than the cap: stop, and keep none of it
        const take = Math.min(chunk.length, room);
        if (take > 0) {
          size += take;
          const part = chunk.subarray(0, take);
          if (o.sink === undefined) chunks.push(part);
          else if (!o.sink.write(part)) { res.pause(); o.sink.once("drain", () => res.resume()); }
        }
        if (overLimit) { settle(false); req.destroy(); }
      });
      // 'end' is the parser's word that the message is whole. Anything else — ECONNRESET, an abort, a body short of
      // its content-length — is `cut`: what arrived is reported and the caller decides what it is worth. The
      // deprecated 'aborted' event said the same; res.complete says it without a deprecation.
      res.on("end", () => { if (finish !== null) finish(false); });
    });

    // The total deadline, shared by every hop of the fetch (the clock started in httpsGet).
    deadline = setTimeout(() => {
      if (done) return;
      fail = expired();
      req.destroy(fail);
    }, left);

    // An idle timeout, not a total one: a slow transfer that is still moving is fine, a silent one is not.
    req.setTimeout(o.timeoutMs, () => {
      if (done) return;
      fail = new FetchFailed("timeout", `no data for ${o.timeoutMs} ms from ${url.href}`);
      req.destroy(fail);
    });

    req.on("error", error => {
      if (done) return;
      if (fail !== null) { done = true; reject(fail); return; }
      if (finish !== null) { finish(true); return; }
      done = true;
      // Names the cause — "self-signed certificate", "unable to get local issuer certificate", DNS, a refused socket.
      reject(new FetchFailed("network", `${url.href}: ${error.message}`));
    });

    req.end();
  });
}
