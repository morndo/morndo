// A throwaway certificate authority and two server certificates for the HTTPS tests (design §13, contract: "`feed-https`
// against a local HTTPS server with a test certificate authority; without it, the fetch fails"). Everything is made
// with the openssl CLI at run time (openssl-req(1), openssl-x509(1); OpenSSL 3.0.13 here) inside a temporary directory
// the test removes, so no key or certificate is ever committed. The client under test keeps Node's own certificate
// checks: `ca` replaces the default root list for the length of a test ("If specified, the default list would be
// completely replaced", Node 24 tls.createSecureContext, https://nodejs.org/docs/latest-v24.x/api/tls.html and
// .../api/https.html, read 2026-10-21).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

export type TestCa = {
  /** The CA's certificate: passed as `ca`, so the client trusts exactly this hierarchy and nothing else. */
  ca: string;
  /** CN=localhost, signed by the CA, with the SANs a client at https://127.0.0.1 checks. */
  serverCert: string;
  serverKey: string;
  /** Self-signed by nobody in particular: the "untrusted certificate" case, trusted by no `ca` we hand out. */
  strangerCert: string;
  strangerKey: string;
};

// Every file is made in `dir`; the test owns the directory and removes it, keys included.
const run = (dir: string, args: string[]) => {
  const done = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`openssl ${args.join(" ")} failed (${done.status}): ${done.stderr}`);
  return done;
};

export function makeTestCa(dir: string): TestCa {
  // The CA: P-256, self-signed for two days, and allowed to do exactly one thing, sign certificates.
  run(dir, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=Morndo test CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  // The server certificate: a key and a CSR for localhost, signed by the CA with the SANs and the role of a server.
  run(dir, ["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
  run(dir, ["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "server.pem", "-days", "2", "-extfile", "ext.cnf"]);
  // An unrelated self-signed certificate: a hierarchy the client has never heard of.
  run(dir, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", "stranger.key", "-out", "stranger.pem", "-days", "2", "-subj", "/CN=stranger"]);
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  return { ca: read("ca.pem"), serverCert: read("server.pem"), serverKey: read("server.key"),
    strangerCert: read("stranger.pem"), strangerKey: read("stranger.key") };
}

export type TestServer = { url: string; close(): Promise<void> };

/** `https.createServer({ key, cert }, handler)` on 127.0.0.1 and an ephemeral port; `url` ends in "/" like a feed base. */
export function serveHttps(o: { key: string; cert: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): Promise<TestServer> {
  const server: Server = createServer({ key: o.key, cert: o.cert }, o.handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new Error("no port to listen on")); return; }
      resolve({
        url: `https://127.0.0.1:${address.port}/`,
        // Both connection sweepers first: a hung response (the timeout case) or an idle keep-alive socket would
        // otherwise keep close() waiting past the test run.
        close: async () => {
          server.closeAllConnections();
          server.closeIdleConnections();
          await new Promise<void>(done => server.close(() => done()));
        },
      });
    });
  });
}
