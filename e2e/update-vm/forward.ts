// A plain TCP pipe for the fleet run's stand-in transport (PR 6d, T-315): listen on one
// address, forward every byte to another, nothing else — no HTTP, no WebSocket, no
// logging but one line when it listens and one per refused dial. The run starts it
// inside each machine as the worker (docker exec -d):
//   cp:   forward.ts <cp's bridge address> 18791 127.0.0.1 8791   (the fleet's agent port)
//   cp:   forward.ts <cp's bridge address> 18790 127.0.0.1 18790  (the hub's own port)
//   node: forward.ts 127.0.0.1 8791 <cp's bridge address> 18791
// and once on the host, for the browser:
//   host: forward.ts 127.0.0.1 18790 <cp's bridge address> 18790
// The cp-side forwarders bind the bridge address only, never 0.0.0.0: the hub and the
// fleet already hold those ports on the loopback, and a wildcard bind would collide.
import { createConnection, createServer, type Socket } from "node:net";

const [listenHost, listenPortText, targetHost, targetPortText] = process.argv.slice(2);
if (listenHost === undefined || targetHost === undefined || !/^\d+$/.test(listenPortText ?? "") || !/^\d+$/.test(targetPortText ?? "")) {
  process.stderr.write("usage: forward.ts <listen host> <listen port> <target host> <target port>\n");
  process.exit(64);
}
const listenPort = Number(listenPortText);
const targetPort = Number(targetPortText);

const server = createServer({ allowHalfOpen: true }, (incoming: Socket) => {
  const outgoing = createConnection({ host: targetHost, port: targetPort }, () => {
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
  });
  // A dial the other end refuses (the service behind it not up yet) ends that one
  // connection; the listener stays up for the next.
  outgoing.on("error", error => { incoming.destroy(); log(`dial to ${targetHost}:${targetPort} failed: ${error.message}`); });
  incoming.on("error", () => outgoing.destroy());
  const gone = () => { incoming.destroy(); outgoing.destroy(); };
  incoming.on("close", gone);
  outgoing.on("close", gone);
});

const log = (line: string) => process.stdout.write(`forward: ${line}\n`);
server.on("error", error => { process.stderr.write(`forward.ts: listening on ${listenHost}:${listenPort} failed: ${error.message}\n`); process.exit(1); });
server.listen(listenPort, listenHost, () => log(`listening ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`));
