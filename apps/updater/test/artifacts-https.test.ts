// The HTTPS artifact store's contract (design §4.6 ArtifactStore, §6.1 step 2, §10.2 step 5; §13 fault injection: "a
// truncated download: the server closes early; a size smaller or larger than the Manifest's (the download stops at
// the limit)"). The same throwaway TLS world as the feed tests; downloads land in a directory the test removes. A
// download is never trusted for being finished: the server's word (content-length, a clean end) is only ever
// reported, and the signed Manifest is what the application checks the bytes against.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchFailed } from "../src/application/ports.ts";
import { HttpsArtifacts } from "../src/adapters/artifacts-https.ts";
import { makeTestCa, serveHttps, type TestCa, type TestServer } from "./helpers/tls.ts";

type Route = { body?: Uint8Array; serve?: (res: ServerResponse) => void };
const routes: Record<string, Route> = {};

// Bytes a digest could check, not a constant run: every position differs.
const full = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 251));

const serve = (req: IncomingMessage, res: ServerResponse): void => {
  const route = routes[req.url ?? ""];
  if (route === undefined) { res.writeHead(404, { "content-type": "text/plain" }); res.end("no such file\n"); return; }
  if (route.serve !== undefined) { route.serve(res); return; }
  const body = route.body ?? Buffer.alloc(0);
  res.writeHead(200, { "content-length": String(body.length) });
  res.end(body);
};

let dir = "";
let downloads = "";
let tls!: TestCa;
let server!: TestServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  downloads = join(dir, "downloads");   // absent on purpose: the store must create it, 0700
  tls = makeTestCa(dir);
  server = await serveHttps({ key: tls.serverKey, cert: tls.serverCert, handler: serve });
  routes["/full.tar.gz"] = { body: full };
  // Half the promised body, then the connection ends cleanly. The FIN is what makes this deterministic: a FIN
  // delivers everything written before it, where a reset may drop its own buffered bytes (see /reset.tar.gz). And
  // the socket has to be ended by hand — res.end() with a short body makes the SERVER wait for its own missing
  // bytes, holding the connection open until the client's timeout (checked live: that path idles out).
  routes["/half.tar.gz"] = {
    serve: res => {
      res.writeHead(200, { "content-length": "4000" });
      res.write(full.subarray(0, 2000));
      res.socket?.end();
    },
  };
  // The abrupt version: half the body, then the socket is destroyed. A reset can drop the very bytes that were
  // sent before it (an unread receive queue is flushed on RST), so the client may see either half a body — cut —
  // or a connection that died before any response — a network refusal. Both are faults; neither may look whole.
  routes["/reset.tar.gz"] = {
    serve: res => {
      res.writeHead(200, { "content-length": "4000" });
      res.write(full.subarray(0, 2000));
      res.socket?.destroy();
    },
  };
  // No content-length, 5 × 50 bytes chunked, against a cap of 100: the store must stop reading at the cap.
  routes["/chunky.tar.gz"] = {
    serve: res => {
      res.writeHead(200);
      for (let i = 0; i < 5; i++) res.write(Buffer.alloc(50, i));
      res.end();
    },
  };
  // A content-length alone over the cap: refused before the first byte is written.
  routes["/huge.tar.gz"] = { body: Buffer.alloc(5000, 9) };
  // A name with build metadata, as the pipeline writes it when a Version carries any: '+' is a plain character.
  routes["/morndo-1.4.0+b7-linux-x64.tar.gz"] = { body: full };
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new HttpsArtifacts({ dir: downloads, ca: tls.ca });

describe("HttpsArtifacts against a local HTTPS server", () => {
  it("downloads an artifact whole, 0600, into a 0700 directory, and discard removes it", async () => {
    const one = store();
    const download = await one.fetch(`${server.url}full.tar.gz`, { name: "full.tar.gz", maxBytes: 4096, timeoutMs: 5000 });
    expect(download).toMatchObject({ path: join(downloads, "full.tar.gz.part"), size: 3000, overLimit: false, cut: false });
    expect(readFileSync(download.path).equals(full)).toBe(true);
    expect(statSync(download.path).mode & 0o777).toBe(0o600);
    expect(statSync(downloads).mode & 0o777).toBe(0o700);
    one.discard("full.tar.gz");
    expect(existsSync(download.path)).toBe(false);
  });

  it("reads a connection the server cut early as cut, with the bytes that arrived", async () => {
    const download = await store().fetch(`${server.url}half.tar.gz`, { name: "half.tar.gz", maxBytes: 4096, timeoutMs: 5000 });
    expect(download.cut).toBe(true);
    expect(download.overLimit).toBe(false);
    expect(download.size).toBe(2000);
    expect(readFileSync(download.path).equals(full.subarray(0, 2000))).toBe(true);
  });

  it("never reads a destroyed connection as a whole download: cut or refused, whichever the reset left", async () => {
    let outcome: { ok: true; download: unknown } | { ok: false; reason: string } | null = null;
    try {
      outcome = { ok: true, download: await store().fetch(`${server.url}reset.tar.gz`, { name: "reset.tar.gz", maxBytes: 4096, timeoutMs: 5000 }) };
    } catch (error) {
      if (error instanceof FetchFailed) outcome = { ok: false, reason: error.reason };
      else throw error;
    }
    if (outcome === null || (outcome.ok && (outcome.download as { cut: boolean }).cut !== true)) {
      throw new Error(`a destroyed connection came back as something other than a fault: ${JSON.stringify(outcome)}`);
    }
  });

  it("stops a body that grows past its cap at the cap, and no further", async () => {
    const download = await store().fetch(`${server.url}chunky.tar.gz`, { name: "chunky.tar.gz", maxBytes: 100, timeoutMs: 5000 });
    expect(download.overLimit).toBe(true);
    expect(download.cut).toBe(false);
    expect(download.size).toBe(100);
    expect(readFileSync(download.path).length).toBe(100);
  });

  it("refuses at once, writing nothing, when the content-length alone is over the cap", async () => {
    const download = await store().fetch(`${server.url}huge.tar.gz`, { name: "huge.tar.gz", maxBytes: 100, timeoutMs: 5000 });
    expect(download.overLimit).toBe(true);
    expect(download.size).toBe(0);
    expect(readFileSync(download.path).length).toBe(0);
  });

  it("refuses a name that is not a plain file name", async () => {
    const o = { maxBytes: 4096, timeoutMs: 5000 };
    await expect(store().fetch(`${server.url}full.tar.gz`, { name: "sub/full.tar.gz", ...o })).rejects.toThrow(/plain file name/);
    await expect(store().fetch(`${server.url}full.tar.gz`, { name: "..", ...o })).rejects.toThrow(/plain file name/);
    await expect(store().fetch(`${server.url}full.tar.gz`, { name: "./full.tar.gz", ...o })).rejects.toThrow(/plain file name/);
  });

  it("downloads an artifact whose name carries '+' (build metadata); a leading dot or a '/' is still refused", async () => {
    // The manifest's own name rule admits '+', so the download directory must too — one rule for both, or a
    // validly signed name crashes the check. The rule's other edges hold as before: no leading dot, no separator.
    const name = "morndo-1.4.0+b7-linux-x64.tar.gz";
    const one = store();
    const download = await one.fetch(`${server.url}${name}`, { name, maxBytes: 4096, timeoutMs: 5000 });
    expect(download).toMatchObject({ path: join(downloads, `${name}.part`), size: 3000, overLimit: false, cut: false });
    one.discard(name);
    expect(existsSync(download.path)).toBe(false);
    const o = { maxBytes: 4096, timeoutMs: 5000 };
    await expect(store().fetch(`${server.url}full.tar.gz`, { name: "sub/full.tar.gz", ...o })).rejects.toThrow(/plain file name/);
    await expect(store().fetch(`${server.url}full.tar.gz`, { name: ".full.tar.gz", ...o })).rejects.toThrow(/plain file name/);
  });
});
