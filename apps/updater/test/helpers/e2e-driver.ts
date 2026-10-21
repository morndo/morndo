// The one-process e2e driver (design §13): on a machine where a spawned process cannot reach another process's
// server (this build box drops cross-process loopback — TCP connects, the data never arrives), the feed host and
// the updater's program share this one process. The driver binds the feed's HTTPS server on the port the documents
// already name, runs the real CLI (src/cli.ts's runUpdater, the same function src/main.ts runs) with the environment
// it was handed, and reports { code, out, err } as one JSON line — the same facts a spawned main.ts would leave in
// the shell: its exit status and both its streams. Nothing is faked below the CLI: the fetches are real HTTPS, the
// trust really is NODE_EXTRA_CA_CERTS at this process's startup, the refusals really are the chain's.
import { readFileSync } from "node:fs";
import { runUpdater } from "../../src/cli.ts";
import { serveHttps } from "./tls.ts";
import { diskFeed } from "./e2e-server.ts";

const must = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`the driver needs ${name}`);
  return value;
};

const [mode = "", ...args] = process.argv.slice(2);
if (mode !== "run") throw new Error("usage: e2e-driver.ts run <the updater's arguments>");

const feed = diskFeed(must("MORNDO_E2E_ROOT"));
const server = await serveHttps({
  key: readFileSync(must("MORNDO_E2E_TLS_KEY"), "utf8"),
  cert: readFileSync(must("MORNDO_E2E_TLS_CERT"), "utf8"),
  port: Number(must("MORNDO_E2E_PORT")),
  handler: (req, res) => feed.handler(req, res),
});

let out = "";
let err = "";
let code: number;
try {
  code = await runUpdater(args, process.env, {
    out: text => { out += text; },
    err: text => { err += text; },
  });
} catch (error) {
  code = 70;                                   // EX_SOFTWARE: a program that dies before it can answer
  err += `${error instanceof Error ? error.message : String(error)}\n`;
}

await server.close();
process.stdout.write(`${JSON.stringify({ code, out, err })}\n`);
