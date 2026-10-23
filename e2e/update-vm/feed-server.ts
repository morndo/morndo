// The feed host of the throwaway-machine run (design §13), as its own process: scenario.ts starts it and then runs
// every command with spawnSync, which holds the scenario's own event loop — a server inside that process would
// never answer the updater it is waiting on. Static files under the feed link, HTTPS with the test certificate;
// a path that is not a plain file under the link is a 404, which the key-set walk needs to find its end (§10.2
// step 2). Each request is one line appended to the access log. It says "listening" on stdout once it is.
// usage: node feed-server.ts <feed link> <key.pem> <cert.pem> <access log> <port>
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const [feedLink, keyPath, certPath, logPath, port] = process.argv.slice(2);
if (feedLink === undefined || keyPath === undefined || certPath === undefined || logPath === undefined || port === undefined) {
  process.stderr.write("usage: feed-server.ts <feed link> <key.pem> <cert.pem> <access log> <port>\n");
  process.exit(64);
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  const url = new URL(req.url ?? "/", "https://127.0.0.1");
  const parts = url.pathname.split("/").filter(p => p !== "" && p !== "..");
  appendFileSync(logPath, `${new Date().toISOString()} ${req.method ?? ""} ${url.pathname}\n`);
  let bytes: Buffer;
  try { bytes = readFileSync(join(feedLink, ...parts)); } catch {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.statusCode = 200;
  res.end(bytes);
});
server.listen(Number(port), "127.0.0.1", () => { process.stdout.write("listening\n"); });
process.on("SIGTERM", () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
