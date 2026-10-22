// The HTTPS feed adapter's contract (design §4.6 ReleaseFeed, §9.6, §10.2; §13: "`feed-https` against a local HTTPS
// server with a test certificate authority; without it, the fetch fails"). The helper in ./helpers/tls.ts makes the
// authority and the certificates at run time with the openssl CLI, and this test removes them with its temporary
// directory, so nothing secret is committed. Every case is a real request over real TLS on 127.0.0.1 — redirects,
// caps, timeouts and refusals included — because what is under test is what Node's own TLS and HTTP layers do.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchFailed } from "../src/application/ports.ts";
import { HttpsFeed } from "../src/adapters/feed-https.ts";
import { makeTestCa, serveHttps, type TestCa, type TestServer } from "./helpers/tls.ts";

// What a route serves: fixed bytes (with the content-length a real file has), a redirect, or a hand-written response
// for the shapes no plain body has — a stream over its cap, and headers that are never followed by a body.
type Route = { body?: Uint8Array; redirect?: string; serve?: (res: ServerResponse) => void };

// Filled in beforeAll, once the server's own URL is known (the http:// redirect needs its port).
const routes: Record<string, Route> = {};

const keysJson = Buffer.from('{"schema":1,"version":1}\n', "utf8");
const keysSig = Buffer.from("signature over keys/1.json\n", "utf8");
const stableJson = Buffer.from('{"schema":1,"channel":"stable","seq":42}\n', "utf8");
const stableSig = Buffer.from("signature over stable.json\n", "utf8");
const manifestJson = Buffer.from('{"schema":1,"version":"0.5.0"}\n', "utf8");
const manifestSig = Buffer.from("signature over the manifest\n", "utf8");

const serve = (req: IncomingMessage, res: ServerResponse): void => {
  const route = routes[req.url ?? ""];
  if (route === undefined) { res.writeHead(404, { "content-type": "text/plain" }); res.end("no such file\n"); return; }
  if (route.redirect !== undefined) { res.writeHead(302, { location: route.redirect }); res.end(); return; }
  if (route.serve !== undefined) { route.serve(res); return; }
  const body = route.body ?? Buffer.alloc(0);
  res.writeHead(200, { "content-length": String(body.length) });
  res.end(body);
};

let dir = "";
let tls!: TestCa;
let server!: TestServer;
let stranger!: TestServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-upd-"));
  tls = makeTestCa(dir);
  server = await serveHttps({ key: tls.serverKey, cert: tls.serverCert, handler: serve });
  stranger = await serveHttps({
    key: tls.strangerKey, cert: tls.strangerCert,
    handler: (_req, res) => { res.writeHead(200, { "content-length": "2" }); res.end("{}"); },
  });
  routes["/keys/1.json"] = { body: keysJson };
  routes["/keys/1.json.sig"] = { body: keysSig };
  // keys/2.json has no route: a 404, the one answer that means "this version was never published" (§10.2 step 2).
  routes["/stable.json"] = { body: stableJson };
  routes["/stable.json.sig"] = { body: stableSig };
  routes["/manifest.json"] = { body: manifestJson };
  routes["/manifest.json.sig"] = { body: manifestSig };
  // A redirect inside the server, and one that would leave HTTPS for cleartext.
  routes["/redirect.json"] = { redirect: "/manifest.json" };
  routes["/redirect.json.sig"] = { body: manifestSig };
  routes["/to-http.json"] = { redirect: `http://127.0.0.1:${new URL(server.url).port}/manifest.json` };
  routes["/to-http.json.sig"] = { body: manifestSig };
  // Over its cap with no content-length: 3 × 100 bytes, chunked, so the cap has to bite on the stream itself.
  routes["/big.json"] = {
    serve: res => {
      res.writeHead(200);
      for (let i = 0; i < 3; i++) res.write(Buffer.alloc(100, i));
      res.end();
    },
  };
  routes["/big.json.sig"] = { body: manifestSig };
  // Headers, then nothing at all: the idle timeout's case.
  routes["/hang.json"] = { serve: res => { res.writeHead(200, { "content-length": "64" }); res.flushHeaders(); } };
  routes["/hang.json.sig"] = { body: manifestSig };
});

afterAll(async () => {
  await server.close();
  await stranger.close();
  rmSync(dir, { recursive: true, force: true });
});

const feed = () => new HttpsFeed({ base: server.url, ca: tls.ca });

// The FetchFailed a refusal must be, with its reason — or a failure naming what happened instead.
async function refused(promise: Promise<unknown>): Promise<FetchFailed> {
  try { await promise; } catch (error) {
    if (error instanceof FetchFailed) return error;
    throw error;
  }
  throw new Error("the fetch succeeded where a refusal was expected");
}

describe("HttpsFeed against a local HTTPS server", () => {
  it("keySet returns the document and its signature; an unpublished version is a 404 and null", async () => {
    const signed = await feed().keySet(1);
    expect(signed).not.toBeNull();
    expect(signed!.bytes).toEqual(new Uint8Array(keysJson));
    expect(signed!.signature).toEqual(new Uint8Array(keysSig));
    expect(await feed().keySet(2)).toBeNull();
  });

  it("channel returns both files; a channel with no feed is a status refusal", async () => {
    const signed = await feed().channel("stable");
    expect(signed.bytes).toEqual(new Uint8Array(stableJson));
    expect(signed.signature).toEqual(new Uint8Array(stableSig));
    expect((await refused(feed().channel("latest"))).reason).toBe("status");
  });

  it("follows a redirect to another path on the same server, and refuses one that leaves HTTPS", async () => {
    const viaRedirect = await feed().manifest(`${server.url}redirect.json`, 1024);
    expect(viaRedirect.bytes).toEqual(new Uint8Array(manifestJson));
    expect(viaRedirect.signature).toEqual(new Uint8Array(manifestSig));
    expect((await refused(feed().manifest(`${server.url}to-http.json`, 1024))).reason).toBe("network");
  });

  it("refuses a manifest that grows past its cap with too_large", async () => {
    expect((await refused(feed().manifest(`${server.url}big.json`, 100))).reason).toBe("too_large");
  });

  it("refuses a certificate the CA never signed, and the test CA when no ca is given", async () => {
    const wrongHierarchy = await refused(new HttpsFeed({ base: stranger.url, ca: tls.ca }).channel("stable"));
    expect(wrongHierarchy.reason).toBe("network");
    expect(wrongHierarchy.message).toMatch(/cert|issuer|chain/i);
    const noTrustAnchor = await refused(new HttpsFeed({ base: server.url }).channel("stable"));
    expect(noTrustAnchor.reason).toBe("network");
  });

  it("times out when the server answers headers and then nothing", async () => {
    const hung = await refused(new HttpsFeed({ base: server.url, ca: tls.ca, timeoutMs: 300 }).manifest(`${server.url}hang.json`, 1024));
    expect(hung.reason).toBe("timeout");
  });
});
